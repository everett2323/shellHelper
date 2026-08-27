'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const net = require('net');

let Docker = null;
function loadDockerode() {
  if (Docker) return Docker;
  try {
    Docker = require('dockerode');
  } catch (err) {
    throw new Error(
      'dockerode is not installed. Run `npm install dockerode` to enable workspace streaming.',
    );
  }
  return Docker;
}

// Label attached to every workspace container so we can find and reap them
// after a server crash.
const LABEL_KEY = 'com.shellhelper.workspace';

// Ask the kernel for a free ephemeral TCP port. We bind and immediately close
// so Docker can grab the same port for its container mapping.
async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function ensureImage(docker, image) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    /* not local; fall through to pull */
  }
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (finishErr) => (finishErr ? reject(finishErr) : resolve()),
      );
    });
  });
}

// Parse "512m" / "1g" into bytes for Docker's ShmSize field.
function parseShmSize(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
  const m = String(v || '512m')
    .trim()
    .match(/^(\d+)\s*([kmg]?)b?$/i);
  if (!m) return 512 * 1024 * 1024;
  const n = Number(m[1]);
  const unit = (m[2] || '').toLowerCase();
  const mult =
    unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return n * mult;
}

/**
 * WorkspaceSession — one graphical (KasmVNC/noVNC) container the user
 * connects to via an in-browser web-VNC viewer. Unlike shell sessions there is
 * no PTY stream; the container simply exposes a web port that gets proxied
 * back to the browser by server/vncProxy.js.
 *
 * Definition fields consumed:
 *   - workspaceId  string  logical id used for labels and event routing
 *   - image        string  Docker image (e.g. kasmweb/chrome:1.15.0)
 *   - internalPort number  port inside the container serving noVNC (default 6901)
 *   - useHttps     boolean backend is HTTPS (kasmweb/* images default true)
 *   - resolution   string  e.g. "1280x800" — passed as VNC_RESOLUTION env
 *   - shmSize      string  --shm-size argument, default "512m"
 *   - dockerHost   object  dockerode connection opts
 *   - env          object  extra environment variables (merged over defaults)
 */
class WorkspaceSession extends EventEmitter {
  constructor(def) {
    super();
    if (!def || !def.image) {
      throw new Error('workspace session requires an image');
    }
    this._def = def;
    this.workspaceId =
      def.workspaceId || 'ws_' + crypto.randomBytes(4).toString('hex');
    this.image = String(def.image);
    this.internalPort = Number(def.internalPort) || 6901;
    this.useHttps = def.useHttps !== false;
    this.resolution = def.resolution || '1280x800';
    this.shmSize = def.shmSize || '512m';
    this.extraEnv = def.env && typeof def.env === 'object' ? def.env : {};

    this.docker = null;
    this.container = null;
    this.containerId = null;
    this.hostPort = null;
    this.vncPassword = null;
    this.startedAt = null;
    this._stopped = false;
    this._ready = false;
  }

  async start() {
    const DockerClass = loadDockerode();
    this.docker = new DockerClass(this._def.dockerHost || undefined);
    try {
      await this.docker.ping();
    } catch (err) {
      throw new Error(
        `Docker daemon is not reachable (${err.message || err}). ` +
          'Start Docker Desktop / dockerd and try again.',
      );
    }
    await ensureImage(this.docker, this.image);

    this.hostPort = await pickFreePort();
    // URL-safe password so we can drop it straight into the iframe query string.
    this.vncPassword = crypto.randomBytes(12).toString('base64url');

    // Cover kasmweb/*, linuxserver/*, and generic accetto/* images with one
    // env block — each honours a different variable name.
    const env = {
      VNC_PW: this.vncPassword,
      VNC_PASSWORD: this.vncPassword,
      PASSWORD: this.vncPassword,
      VNC_RESOLUTION: this.resolution,
      RESOLUTION: this.resolution,
      ...this.extraEnv,
    };

    const portKey = `${this.internalPort}/tcp`;
    const createOpts = {
      Image: this.image,
      Labels: { [LABEL_KEY]: this.workspaceId },
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: { [portKey]: {} },
      HostConfig: {
        // Auto-remove ensures a crashed server leaves no zombies behind.
        AutoRemove: true,
        ShmSize: parseShmSize(this.shmSize),
        PortBindings: {
          // Bind to 127.0.0.1 only — the panel proxies from localhost, no
          // direct exposure of the workspace to the outside world.
          [portKey]: [{ HostIp: '127.0.0.1', HostPort: String(this.hostPort) }],
        },
      },
    };

    this.container = await this.docker.createContainer(createOpts);
    await this.container.start();
    this.containerId = this.container.id;
    this.startedAt = Date.now();

    // Fire-and-forget: emit 'ready' once the internal VNC port accepts TCP.
    this._waitReadyThenEmit();
    this._watchExit();

    return this.info();
  }

  _watchExit() {
    if (!this.container) return;
    // dockerode `wait` resolves when the container exits (or errors if the
    // container has already been removed).
    this.container.wait((err, data) => {
      if (this._stopped) return;
      this._stopped = true;
      this.emit('exit', {
        exitCode: data ? data.StatusCode : null,
        error: err ? err.message : null,
      });
    });
  }

  async _waitReadyThenEmit() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this._stopped) return;
      const ok = await this._probePort();
      if (ok) {
        this._ready = true;
        this.emit('ready');
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // Emit anyway — the iframe will show its own connection error if the
    // backend truly never came up.
    this._ready = true;
    this.emit('ready');
  }

  _probePort() {
    return new Promise((resolve) => {
      const sock = net.connect(this.hostPort, '127.0.0.1');
      const done = (ok) => {
        try {
          sock.destroy();
        } catch {
          /* noop */
        }
        resolve(ok);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(1500, () => done(false));
    });
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    if (this.container) {
      try {
        await this.container.stop({ t: 2 });
      } catch (err) {
        // Fallback for a stuck container: force-remove. AutoRemove usually
        // handles cleanup, but a wedged runtime can leave it behind.
        try {
          await this.container.remove({ force: true });
        } catch {
          /* already gone */
        }
      }
    }
    this.emit('exit', { exitCode: 0 });
  }

  info() {
    return {
      workspaceId: this.workspaceId,
      containerId: this.containerId,
      hostPort: this.hostPort,
      internalPort: this.internalPort,
      useHttps: this.useHttps,
      image: this.image,
      resolution: this.resolution,
      startedAt: this.startedAt,
      ready: this._ready,
      vncPassword: this.vncPassword,
    };
  }
}

// On boot, tear down any workspace containers left behind by a previous run.
// Matched by our label so we don't touch anything unrelated.
async function reapOrphanedWorkspaces() {
  let docker;
  try {
    const D = loadDockerode();
    docker = new D();
    await docker.ping();
  } catch {
    return;
  }
  let containers;
  try {
    containers = await docker.listContainers({
      all: true,
      filters: { label: [LABEL_KEY] },
    });
  } catch {
    return;
  }
  await Promise.all(
    containers.map((info) =>
      docker
        .getContainer(info.Id)
        .remove({ force: true })
        .catch(() => {}),
    ),
  );
}

module.exports = { WorkspaceSession, reapOrphanedWorkspaces, LABEL_KEY };
