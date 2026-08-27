'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Busboy = require('busboy');
const { Server: SocketIOServer } = require('socket.io');

const TaskManager = require('./TaskManager');
const WorkspaceManager = require('./WorkspaceManager');
const ResourceMonitor = require('./ResourceMonitor');
const LogWatcher = require('./LogWatcher');
const TunnelManager = require('./TunnelManager');
const HttpInspector = require('./HttpInspector');
const { GitWatcher, ACTIONS: GIT_ACTIONS } = require('./GitWatcher');
const { checkPort, killPid } = require('./portInspector');
const {
  proxyHttp: proxyVncHttp,
  proxyWebSocket: proxyVncWebSocket,
  parseWorkspaceProxyPath,
} = require('./vncProxy');
const { reapOrphanedWorkspaces } = require('./sessions/WorkspaceSession');
const {
  UserStore,
  createSessionMiddleware,
  currentUser,
  requireAuth,
  requireAdmin,
  sanitizeTerminalPrefs,
} = require('./auth');
const { encrypt, decrypt } = require('./crypto');
const { KnownHostStore } = require('./knownHosts');
const {
  listRecordings,
  safeRecordingPath,
  deleteRecording,
} = require('./recorder');
const sftp = require('./sftp');
const {
  createScratchpadContainer,
  destroyScratchpadContainer,
  reapOrphanedScratchpads,
} = require('./scratchpadContainer');

const PORT = Number(process.env.PORT) || 3030;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_SCROLLBACK = Number(process.env.MAX_SCROLLBACK) || 200_000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SERVICES_FILE = path.join(__dirname, '..', 'services.json');

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[shellHelper] SESSION_SECRET not set — generated an ephemeral one. ' +
      'Sessions and stored SSH secrets will be invalidated on restart. ' +
      'Set SESSION_SECRET in .env to persist them.',
  );
}

// ---------- Persistence ----------

function loadServicesFromDisk() {
  if (!fs.existsSync(SERVICES_FILE)) return [];
  try {
    const raw = fs.readFileSync(SERVICES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.services) ? parsed.services : [];
  } catch (err) {
    console.error(`[shellHelper] failed to read services.json: ${err.message}`);
    return [];
  }
}

function saveServicesToDisk(defs) {
  fs.writeFileSync(
    SERVICES_FILE,
    JSON.stringify({ services: defs }, null, 2),
    { mode: 0o600 },
  );
  try {
    fs.chmodSync(SERVICES_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

// ---------- Bootstrap ----------

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 1e6,
});

const users = new UserStore();
const knownHosts = new KnownHostStore();

const manager = new TaskManager({
  maxScrollback: MAX_SCROLLBACK,
  decryptSecret: (ciphertext) => decrypt(ciphertext, SESSION_SECRET),
  hostVerifierFor: (def, onLearned) => (publicKey) => {
    const result = knownHosts.verify(def.host, def.port || 22, publicKey);
    if (result.status === 'match') return true;
    if (result.status === 'unknown') {
      // TOFU: pin on first connect.
      knownHosts.trust(def.host, def.port || 22, publicKey);
      try {
        onLearned(publicKey);
      } catch {
        /* noop */
      }
      return true;
    }
    // mismatch
    return false;
  },
  onHostKeyLearned: (def, key) => {
    console.log(
      `[shellHelper] pinned new host key for ${def.host}:${def.port || 22}`,
    );
  },
});

const watcher = new LogWatcher();
const tunnels = new TunnelManager();
const inspectors = new HttpInspector();
const gitWatcher = new GitWatcher({
  resolveCwd: (id) => {
    const entry = manager.services.get(id);
    if (!entry) return null;
    const def = entry.definition;
    // Git is only meaningful when there's a local filesystem path we can shell
    // into. SSH and docker services would need remote git, which is out of
    // scope here.
    if (def.type !== 'local') return null;
    // Mirror LocalSession's fallback so a service with no explicit cwd still
    // reports git status for the directory the shell actually opens in.
    return def.cwd || process.env.HOME || process.cwd();
  },
});

for (const def of loadServicesFromDisk()) {
  try {
    manager.registerService(def);
    watcher.setRules(def.id, def.alertRules || []);
    if (def.autostart) {
      try {
        manager.startService(def.id);
      } catch (err) {
        console.error(
          `[shellHelper] autostart failed for "${def.id}": ${err.message}`,
        );
      }
    }
  } catch (err) {
    console.error(`[shellHelper] skipping service definition: ${err.message}`);
  }
}

const monitor = new ResourceMonitor({ taskManager: manager });
monitor.start();

// Feed every output chunk through the alert watcher.
manager.on('data', (id, chunk) => {
  try {
    watcher.feed(id, chunk);
  } catch {
    /* watcher failures must not affect the shell */
  }
});

const workspaces = new WorkspaceManager();

const sessionMiddleware = createSessionMiddleware(SESSION_SECRET);

app.use(cors({ origin: true, credentials: true }));
app.use(sessionMiddleware);
// Workspace stream proxy MUST be mounted before express.json so request
// bodies (uploads, form posts inside the noVNC UI) reach the container
// unread. Its handler always terminates the request, never calls next().
app.use('/api/workspaces/:id/stream', workspaceStreamHandler);
app.use(express.json({ limit: '2mb' })); // room for pasted SSH keys
app.use(express.static(PUBLIC_DIR));

io.engine.use(sessionMiddleware);

// Intercept WebSocket upgrades destined for the workspace proxy before
// Socket.IO's default handler sees them. Everything else falls through to the
// listeners Socket.IO registered on the HTTP server.
(function installWorkspaceUpgradeDispatcher() {
  const priorListeners = server.listeners('upgrade').slice();
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req, socket, head) => {
    const wsPath = parseWorkspaceProxyPath(req.url || '');
    if (!wsPath) {
      for (const l of priorListeners) l.call(server, req, socket, head);
      return;
    }
    // Populate req.session via the express-session middleware. It only writes
    // to the response on session creation, which won't happen here — the
    // request already carries a valid cookie or we reject it.
    const dummyRes = new http.ServerResponse(req);
    dummyRes.assignSocket(socket);
    sessionMiddleware(req, dummyRes, () => {
      const user = req.session && req.session.user;
      if (!user || !workspaces.userCanAccess(user, wsPath.id)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const inst = workspaces.getInstance(wsPath.id);
      if (!inst) {
        socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      // Detach the socket from the ServerResponse before piping — otherwise
      // Node will try to write status lines to a socket we've handed off.
      try {
        dummyRes.detachSocket(socket);
      } catch {
        /* older Node builds silently no-op */
      }
      proxyVncWebSocket(
        { hostPort: inst.session.hostPort, useHttps: inst.session.useHttps },
        req,
        socket,
        head,
        wsPath.remainder,
      );
    });
  });
})();

function workspaceStreamHandler(req, res) {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  const id = req.params.id;
  if (!workspaces.userCanAccess(user, id)) {
    res.status(404).json({ error: 'workspace not found' });
    return;
  }
  const inst = workspaces.getInstance(id);
  if (!inst) {
    res.status(409).json({ error: 'workspace is not running' });
    return;
  }
  // req.url is already relative to the mount point (`/api/workspaces/:id/stream`).
  const remainder = req.url || '/';
  proxyVncHttp(
    { hostPort: inst.session.hostPort, useHttps: inst.session.useHttps },
    req,
    res,
    remainder,
  );
}

// ---------- Auth REST ----------

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = await users.verify(username, password);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  req.session.user = user;
  res.json({ user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'not authenticated' });
  res.json({ user });
});

app.get('/api/auth/preferences', requireAuth, (req, res) => {
  const user = currentUser(req);
  const fresh = users.findById(user.id);
  if (!fresh) return res.status(404).json({ error: 'user not found' });
  res.json({ terminalPrefs: sanitizeTerminalPrefs(fresh.terminalPrefs) });
});

app.put('/api/auth/preferences', requireAuth, (req, res) => {
  const user = currentUser(req);
  try {
    const updated = users.updateTerminalPrefs(user.id, req.body || {});
    // Keep the session's cached user object in sync so subsequent /me calls see it.
    req.session.user = updated;
    res.json({ user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const user = currentUser(req);
  const { currentPassword, newPassword } = req.body || {};
  const verified = await users.verify(user.username, currentPassword);
  if (!verified) return res.status(401).json({ error: 'current password is incorrect' });
  try {
    await users.changePassword(user.id, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Services REST ----------

app.get('/api/services', requireAuth, (req, res) => {
  res.json({ services: manager.listServicesForUser(currentUser(req)) });
});

function requireCanAccessService(req, res, next) {
  const user = currentUser(req);
  if (!manager.userCanAccess(user, req.params.id)) {
    return res.status(404).json({ error: 'service not found' });
  }
  next();
}

app.get('/api/services/:id', requireAuth, requireCanAccessService, (req, res) => {
  res.json(manager.getService(req.params.id));
});

app.post('/api/services/:id/start', requireAuth, requireCanAccessService, async (req, res) => {
  const entry = manager.services.get(req.params.id);
  const port = entry && entry.definition.servicePort;
  const force = !!(req.body && req.body.force);
  if (port && !force) {
    try {
      const check = await checkPort(port);
      if (check.inUse) {
        return res.status(409).json({
          error: `port ${port} is already in use`,
          conflict: { ...check, servicePort: port },
        });
      }
    } catch (err) {
      // Detection failed (e.g. lsof missing) — fall through and let the
      // service try to start. Better to attempt than to block.
      console.warn(`[shellHelper] port pre-flight failed: ${err.message}`);
    }
  }
  try {
    const status = manager.startService(req.params.id, req.body || {});
    res.json({ id: req.params.id, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/services/:id/stop', requireAuth, requireCanAccessService, (req, res) => {
  try {
    const status = manager.stopService(req.params.id, req.body || {});
    res.json({ id: req.params.id, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/services/:id/restart', requireAuth, requireCanAccessService, async (req, res) => {
  try {
    const status = await manager.restartService(req.params.id, req.body || {});
    res.json({ id: req.params.id, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post(
  '/api/services/:id/macros/:macroId/fire',
  requireAuth,
  requireCanAccessService,
  (req, res) => {
    const result = manager.fireMacro(req.params.id, req.params.macroId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, label: result.label });
  },
);

// ---------- Ephemeral public tunnels (cloudflared) ----------

app.get(
  '/api/services/:id/tunnel/status',
  requireAuth,
  requireCanAccessService,
  (req, res) => {
    res.json(tunnels.status(req.params.id));
  },
);

app.post(
  '/api/services/:id/tunnel/start',
  requireAuth,
  requireCanAccessService,
  async (req, res) => {
    const port = Number((req.body && req.body.port) || 0);
    try {
      const url = await tunnels.start(req.params.id, port);
      res.json({ ok: true, url, ...tunnels.status(req.params.id) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

app.post(
  '/api/services/:id/tunnel/stop',
  requireAuth,
  requireCanAccessService,
  (req, res) => {
    const stopped = tunnels.stop(req.params.id);
    res.json({ ok: true, stopped });
  },
);

// ---------- Port inspector + kill ----------

app.get('/api/tools/check-port', requireAuth, async (req, res) => {
  try {
    const info = await checkPort(req.query.port);
    res.json(info);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Killing arbitrary host pids is admin-only. `requireCanAccessService` isn't
// enough because the offending pid is by definition not one of ours.
app.post('/api/tools/kill-pid', requireAdmin, async (req, res) => {
  const { pid, signal } = req.body || {};
  try {
    const info = await killPid(pid, signal ? { signal } : {});
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Kill whoever is squatting on the service's configured port. Access is gated
// on the service (owner or admin), which is the closest we can get to a per-
// service authorisation for terminating an unrelated host process — because
// the service owner is who's trying to start it, we accept that they get to
// nuke a blocker on their own port.
app.post(
  '/api/services/:id/kill-blocker',
  requireAuth,
  requireCanAccessService,
  async (req, res) => {
    const entry = manager.services.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'service not found' });
    const port = entry.definition.servicePort;
    if (!port) return res.status(400).json({ error: 'service has no port configured' });
    try {
      const check = await checkPort(port);
      if (!check.inUse || !check.pid) {
        return res.json({ ok: true, killed: false, message: 'port already free' });
      }
      // Refuse to shoot the panel in the foot.
      if (check.pid === process.pid) {
        return res.status(400).json({ error: 'that PID is the shellHelper panel itself' });
      }
      const info = await killPid(check.pid);
      res.json({ ok: true, killed: true, ...info, port });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

// ---------- HTTP inspector (per-service proxy tap) ----------

app.get(
  '/api/services/:id/inspector/status',
  requireAuth,
  requireCanAccessService,
  (req, res) => {
    res.json(inspectors.status(req.params.id));
  },
);

app.get(
  '/api/services/:id/inspector/history',
  requireAuth,
  requireCanAccessService,
  (req, res) => {
    res.json({ history: inspectors.history(req.params.id) });
  },
);

app.post(
  '/api/services/:id/inspector/start',
  requireAuth,
  requireCanAccessService,
  async (req, res) => {
    const entry = manager.services.get(req.params.id);
    const targetPort =
      (req.body && Number(req.body.targetPort)) ||
      (entry && entry.definition.servicePort) ||
      0;
    const listenPort = req.body && req.body.listenPort;
    try {
      const status = await inspectors.start(req.params.id, {
        targetPort,
        listenPort,
      });
      res.json({ ok: true, ...status });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

app.post(
  '/api/services/:id/inspector/stop',
  requireAuth,
  requireCanAccessService,
  (req, res) => {
    inspectors.stop(req.params.id);
    res.json({ ok: true });
  },
);

app.post(
  '/api/services/:id/inspector/clear',
  requireAuth,
  requireCanAccessService,
  (req, res) => {
    inspectors.clearHistory(req.params.id);
    res.json({ ok: true });
  },
);

// ---------- Git status ----------

app.get(
  '/api/services/:id/git',
  requireAuth,
  requireCanAccessService,
  async (req, res) => {
    try {
      const snap = await gitWatcher.refresh(req.params.id);
      res.json(snap);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

app.post(
  '/api/services/:id/git/:action',
  requireAuth,
  requireCanAccessService,
  async (req, res) => {
    const action = req.params.action;
    if (!GIT_ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'unknown git action' });
    }
    try {
      const result = await gitWatcher.runAction(req.params.id, action);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

app.get('/api/metrics/host', requireAuth, (_req, res) => {
  res.json({ host: monitor.getLastHost() });
});

// ---------- Workspaces (graphical container streaming) ----------

app.get('/api/workspaces', requireAuth, (req, res) => {
  res.json({ workspaces: workspaces.listTemplatesForUser(currentUser(req)) });
});

function requireCanAccessWorkspace(req, res, next) {
  const user = currentUser(req);
  if (!workspaces.userCanAccess(user, req.params.id)) {
    return res.status(404).json({ error: 'workspace not found' });
  }
  next();
}

app.get(
  '/api/workspaces/:id',
  requireAuth,
  requireCanAccessWorkspace,
  (req, res) => {
    const template = workspaces.getTemplateForUser(
      req.params.id,
      currentUser(req),
    );
    if (!template) return res.status(404).json({ error: 'workspace not found' });
    // Include the vncPassword only when the caller owns/has access and the
    // instance is live — the frontend needs it to build the noVNC URL.
    const info = workspaces.instanceInfo(req.params.id);
    res.json({ workspace: template, instance: info });
  },
);

app.post(
  '/api/workspaces/:id/start',
  requireAuth,
  requireCanAccessWorkspace,
  async (req, res) => {
    try {
      const info = await workspaces.startInstance(req.params.id);
      broadcastWorkspaceList();
      res.json({ id: req.params.id, instance: info });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

app.post(
  '/api/workspaces/:id/stop',
  requireAuth,
  requireCanAccessWorkspace,
  async (req, res) => {
    try {
      await workspaces.stopInstance(req.params.id);
      broadcastWorkspaceList();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

// ---------- Admin: workspaces ----------

app.get('/api/admin/workspaces', requireAdmin, (_req, res) => {
  res.json({ workspaces: workspaces.listTemplates() });
});

app.post('/api/admin/workspaces', requireAdmin, (req, res) => {
  try {
    const created = workspaces.createTemplate(req.body || {});
    broadcastWorkspaceList();
    res.status(201).json({ workspace: created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/admin/workspaces/:id', requireAdmin, (req, res) => {
  try {
    const updated = workspaces.updateTemplate(req.params.id, req.body || {});
    broadcastWorkspaceList();
    res.json({ workspace: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/workspaces/:id', requireAdmin, async (req, res) => {
  try {
    await workspaces.deleteTemplate(req.params.id);
    broadcastWorkspaceList();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Ephemeral scratchpad sessions ----------
//
// Every scratchpad is a throwaway Docker container. The user's shell runs
// *inside* the container, so files they create never touch the host FS, and
// closing the scratchpad destroys the container (and everything in it).

// serviceId -> { docker, containerId } for containers we own. Kept out of the
// service definition so it isn't broadcast to clients, and available even
// after TaskManager has removed the entry (see teardown flow below).
const scratchpadContainers = new Map();

app.post('/api/scratchpad/create', requireAuth, async (req, res) => {
  const user = currentUser(req);
  const network = !!(req.body && req.body.network);
  try {
    const svc = await createScratchpad(user, { network });
    res.status(201).json(svc);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/scratchpad/:id', requireAuth, requireCanAccessService, async (req, res) => {
  const entry = manager.services.get(req.params.id);
  if (!entry || !entry.definition.ephemeral) {
    return res.status(404).json({ error: 'scratchpad not found' });
  }
  await destroyScratchpad(req.params.id);
  res.json({ ok: true });
});

async function createScratchpad(user, { network = false } = {}) {
  const id = 'scratch_' + crypto.randomBytes(4).toString('hex');
  const label = new Date()
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Spin up the sandbox container first — if Docker isn't available we want
  // to bail before registering any service state.
  const { docker, containerId, image } = await createScratchpadContainer({
    scratchpadId: id,
    network,
  });
  scratchpadContainers.set(id, { docker, containerId });

  const def = {
    id,
    name: `Scratchpad · ${label}${network ? '' : ' · offline'}`,
    type: 'docker',
    ephemeral: true,
    containerId,
    // Interactive login shell inside the container. bash exists on ubuntu;
    // falls back to /bin/sh via `command -v` so alpine-style images also work
    // if the operator points SCRATCHPAD_IMAGE elsewhere.
    dockerCommand: ['/bin/sh', '-c', 'exec "$(command -v bash || echo /bin/sh)" -l'],
    dockerWorkingDir: '/root',
    // Owner-only ACL; admins bypass via role check in userCanAccess.
    allowedUsers: [user.username],
    autoRestart: false,
    autostart: false,
    recording: false,
  };
  manager.registerService(def);
  try {
    manager.startService(id);
  } catch (err) {
    manager.removeService(id);
    scratchpadContainers.delete(id);
    destroyScratchpadContainer(docker, containerId).catch(() => {});
    throw err;
  }
  console.log(
    `[shellHelper] scratchpad ${id} started (image=${image}, network=${network ? 'on' : 'none'}, container=${containerId.slice(0, 12)})`,
  );
  // Broadcast so any panel connected as this user (or an admin) sees it appear.
  broadcastServiceList();
  return manager.getService(id);
}

async function destroyScratchpad(id) {
  const entry = manager.services.get(id);
  const container = scratchpadContainers.get(id);
  scratchpadContainers.delete(id);

  if (entry) {
    // Notify any viewer still in the room before we tear it down.
    io.to(roomFor(id)).emit('service-removed', { id });
    manager.removeService(id);
    watcher.removeService(id);
    broadcastServiceList();
  }
  if (container) {
    try {
      await destroyScratchpadContainer(container.docker, container.containerId);
    } catch (err) {
      console.error(
        `[shellHelper] failed to remove scratchpad container ${container.containerId.slice(0, 12)}: ${err.message}`,
      );
    }
  }
}

function maybeReapEphemeral(id) {
  const entry = manager.services.get(id);
  if (!entry || !entry.definition.ephemeral) return;
  const room = io.sockets.adapter.rooms.get(roomFor(id));
  if (room && room.size > 0) return; // still has viewers
  destroyScratchpad(id).catch((err) =>
    console.error(`[shellHelper] scratchpad reap failed: ${err.message}`),
  );
}

// ---------- Logs ----------

app.get('/api/services/:id/logs', requireAuth, requireCanAccessService, (req, res) => {
  const entry = manager.services.get(req.params.id);
  if (!entry || !entry.logger) return res.json({ log: '' });
  const bytes = Math.min(
    1_000_000,
    Math.max(1024, Number(req.query.bytes) || 128 * 1024),
  );
  res.json({ log: entry.logger.tail(bytes), bytes });
});

// ---------- Recordings (admin) ----------

app.get('/api/admin/services/:id/recordings', requireAdmin, (req, res) => {
  if (!manager.services.has(req.params.id)) {
    return res.status(404).json({ error: 'service not found' });
  }
  res.json({ recordings: listRecordings(req.params.id) });
});

app.get('/api/admin/recordings/:name', requireAdmin, (req, res) => {
  const fp = safeRecordingPath(req.params.name);
  if (!fp || !fs.existsSync(fp)) {
    return res.status(404).json({ error: 'recording not found' });
  }
  res.setHeader('Content-Type', 'application/x-asciicast');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${encodeURIComponent(req.params.name)}"`,
  );
  fs.createReadStream(fp).pipe(res);
});

app.delete('/api/admin/recordings/:name', requireAdmin, (req, res) => {
  try {
    deleteRecording(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- SFTP (per-service, users with access) ----------

function withSshService(req, res, cb) {
  const entry = manager.services.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'service not found' });
  if (entry.definition.type !== 'ssh') {
    return res.status(400).json({ error: 'not an ssh service' });
  }
  let cfg;
  try {
    cfg = manager.buildSshConfig(req.params.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const def = entry.definition;
  const verifier = (publicKey) => {
    const result = knownHosts.verify(def.host, def.port || 22, publicKey);
    if (result.status === 'match') return true;
    if (result.status === 'unknown') {
      knownHosts.trust(def.host, def.port || 22, publicKey);
      return true;
    }
    return false;
  };
  return cb(cfg, verifier, def);
}

app.get('/api/services/:id/sftp/list', requireAuth, requireCanAccessService, (req, res) => {
  withSshService(req, res, async (cfg, verifier) => {
    try {
      const result = await sftp.list(cfg, verifier, req.query.path || '.');
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
});

app.get('/api/services/:id/sftp/download', requireAuth, requireCanAccessService, (req, res) => {
  withSshService(req, res, async (cfg, verifier) => {
    try {
      await sftp.downloadTo(cfg, verifier, req.query.path, res);
    } catch (err) {
      if (!res.headersSent) res.status(400).json({ error: err.message });
      else res.end();
    }
  });
});

app.post('/api/services/:id/sftp/upload', requireAuth, requireCanAccessService, (req, res) => {
  withSshService(req, res, (cfg, verifier) => {
    const destDir = String(req.query.path || '.');
    const bb = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: 500 * 1024 * 1024 },
    });
    let responded = false;
    const finish = (status, body) => {
      if (responded) return;
      responded = true;
      res.status(status).json(body);
    };
    bb.on('file', (_field, file, info) => {
      const filename = info.filename || 'upload.bin';
      const target =
        destDir === '.' || destDir === ''
          ? filename
          : destDir.replace(/\/$/, '') + '/' + path.basename(filename);
      sftp
        .uploadFrom(cfg, verifier, target, file)
        .then((r) => finish(201, r))
        .catch((err) => finish(400, { error: err.message }));
    });
    bb.on('error', (err) => finish(400, { error: err.message }));
    req.pipe(bb);
  });
});

app.post('/api/services/:id/sftp/mkdir', requireAuth, requireCanAccessService, (req, res) => {
  withSshService(req, res, async (cfg, verifier) => {
    try {
      const result = await sftp.mkdir(cfg, verifier, req.body.path);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
});

app.post('/api/services/:id/sftp/delete', requireAuth, requireCanAccessService, (req, res) => {
  withSshService(req, res, async (cfg, verifier) => {
    try {
      const result = req.body.isDir
        ? await sftp.rmdir(cfg, verifier, req.body.path)
        : await sftp.unlink(cfg, verifier, req.body.path);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
});

// ---------- Admin: users ----------

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json({ users: users.list() });
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const created = await users.create(req.body || {});
    res.status(201).json({ user: created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  try {
    users.delete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Admin: services ----------

function normalizeIncomingService(input, existing) {
  const merged = { ...(existing || {}), ...(input || {}) };
  merged.type = ['ssh', 'docker'].includes(merged.type) ? merged.type : 'local';
  merged.allowedUsers = Array.isArray(merged.allowedUsers)
    ? merged.allowedUsers.map(String)
    : [];
  merged.autoRestart = !!merged.autoRestart;
  merged.recording = !!merged.recording;

  if (input && Array.isArray(input.alertRules)) {
    if (input.alertRules.length > 20) {
      throw new Error('too many alert rules (max 20)');
    }
    merged.alertRules = input.alertRules.map((r, i) => {
      if (!r || typeof r !== 'object') {
        throw new Error(`alert rule ${i} is not an object`);
      }
      const pattern = String(r.pattern == null ? '' : r.pattern);
      if (!pattern) throw new Error(`alert rule ${i} needs a pattern`);
      const flags = String(r.flags || '').replace(/[gy]/g, '');
      try {
        new RegExp(pattern, flags);
      } catch (err) {
        throw new Error(`alert rule ${i} has invalid regex: ${err.message}`);
      }
      return {
        id: r.id ? String(r.id) : 'rule_' + crypto.randomBytes(3).toString('hex'),
        name: String(r.name || pattern).slice(0, 80),
        pattern,
        flags,
        severity: r.severity === 'crit' ? 'crit' : 'warn',
        cooldownMs:
          Number.isFinite(r.cooldownMs) && r.cooldownMs >= 0
            ? Math.floor(r.cooldownMs)
            : 5000,
      };
    });
  }

  if (input && Array.isArray(input.macros)) {
    if (input.macros.length > 40) {
      throw new Error('too many macros (max 40)');
    }
    merged.macros = input.macros.map((m, i) => {
      if (!m || typeof m !== 'object') {
        throw new Error(`macro ${i} is not an object`);
      }
      const label = String(m.label || '').trim();
      const command = String(m.command == null ? '' : m.command);
      if (!label) throw new Error(`macro ${i} needs a label`);
      if (!command) throw new Error(`macro "${label}" needs a command`);
      if (label.length > 60) throw new Error(`macro "${label}" label too long`);
      if (command.length > 4000) throw new Error(`macro "${label}" command too long`);
      return {
        id: m.id ? String(m.id) : 'macro_' + crypto.randomBytes(3).toString('hex'),
        label,
        command,
      };
    });
  }

  if (!merged.name) throw new Error('name is required');
  if (!merged.id) {
    merged.id =
      'svc_' +
      crypto.randomBytes(4).toString('hex') +
      '_' +
      String(merged.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
  }
  if (merged.type === 'ssh') {
    if (!merged.host) throw new Error('ssh host is required');
    if (!merged.sshUser) throw new Error('ssh username is required');
    merged.port = Number(merged.port) || 22;
    merged.sshAuthMethod = merged.sshAuthMethod === 'key' ? 'key' : 'password';
    if (input && input.sshPassword != null && input.sshPassword !== '') {
      merged.sshPasswordEncrypted = encrypt(input.sshPassword, SESSION_SECRET);
    }
    if (input && input.sshPrivateKey != null && input.sshPrivateKey !== '') {
      merged.sshPrivateKeyEncrypted = encrypt(
        input.sshPrivateKey,
        SESSION_SECRET,
      );
    }
    if (input && input.sshPassphrase != null && input.sshPassphrase !== '') {
      merged.sshPassphraseEncrypted = encrypt(
        input.sshPassphrase,
        SESSION_SECRET,
      );
    } else if (input && input.sshPassphrase === '') {
      delete merged.sshPassphraseEncrypted;
    }
    // If auth method is password, drop any stored key material and vice-versa.
    if (merged.sshAuthMethod === 'password') {
      delete merged.sshPrivateKeyEncrypted;
      delete merged.sshPassphraseEncrypted;
    } else {
      delete merged.sshPasswordEncrypted;
    }
    delete merged.sshPassword;
    delete merged.sshPrivateKey;
    delete merged.sshPassphrase;
    delete merged.command;
    delete merged.args;
    delete merged.cwd;
    delete merged.servicePort;
  } else if (merged.type === 'docker') {
    if (!merged.containerId) throw new Error('docker containerId is required');
    merged.containerId = String(merged.containerId).trim();
    if (typeof merged.dockerCommand === 'string') {
      const raw = merged.dockerCommand.trim();
      merged.dockerCommand = raw ? raw.split(/\s+/) : ['/bin/sh'];
    } else if (!Array.isArray(merged.dockerCommand)) {
      merged.dockerCommand = ['/bin/sh'];
    }
    if (merged.dockerUser) merged.dockerUser = String(merged.dockerUser);
    else delete merged.dockerUser;
    if (merged.dockerWorkingDir)
      merged.dockerWorkingDir = String(merged.dockerWorkingDir);
    else delete merged.dockerWorkingDir;
    // Strip fields from other transport types.
    delete merged.host;
    delete merged.port;
    delete merged.servicePort;
    delete merged.sshUser;
    delete merged.sshPassword;
    delete merged.sshPasswordEncrypted;
    delete merged.sshPrivateKey;
    delete merged.sshPrivateKeyEncrypted;
    delete merged.sshPassphrase;
    delete merged.sshPassphraseEncrypted;
    delete merged.sshAuthMethod;
    delete merged.command;
    delete merged.args;
    delete merged.cwd;
  } else {
    if (typeof merged.args === 'string') {
      merged.args = merged.args.trim() ? merged.args.trim().split(/\s+/) : [];
    }
    merged.args = Array.isArray(merged.args) ? merged.args : [];
    if (!merged.cwd) merged.cwd = null;
    // Optional listening port — enables the port-conflict pre-flight and
    // gives the HTTP inspector a sensible default target.
    if (input && (input.servicePort === '' || input.servicePort == null)) {
      delete merged.servicePort;
    } else if (input && input.servicePort != null) {
      const sp = Number(input.servicePort);
      if (!Number.isInteger(sp) || sp < 1 || sp > 65535) {
        throw new Error('servicePort must be an integer between 1 and 65535');
      }
      merged.servicePort = sp;
    }
    delete merged.host;
    delete merged.port;
    delete merged.sshUser;
    delete merged.sshPassword;
    delete merged.sshPasswordEncrypted;
    delete merged.sshPrivateKey;
    delete merged.sshPrivateKeyEncrypted;
    delete merged.sshPassphrase;
    delete merged.sshPassphraseEncrypted;
    delete merged.sshAuthMethod;
    delete merged.containerId;
    delete merged.dockerCommand;
    delete merged.dockerUser;
    delete merged.dockerWorkingDir;
    delete merged.dockerHost;
  }
  return merged;
}

app.post('/api/admin/services', requireAdmin, (req, res) => {
  try {
    const def = normalizeIncomingService(req.body || {}, null);
    manager.registerService(def);
    watcher.setRules(def.id, def.alertRules || []);
    saveServicesToDisk(manager.persistentDefinitions());
    broadcastServiceList();
    res.status(201).json(manager.getService(def.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/admin/services/:id', requireAdmin, (req, res) => {
  const entry = manager.services.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'service not found' });
  try {
    const def = normalizeIncomingService(
      { ...req.body, id: req.params.id },
      entry.definition,
    );
    manager.registerService(def);
    watcher.setRules(def.id, def.alertRules || []);
    saveServicesToDisk(manager.persistentDefinitions());
    broadcastServiceList();
    res.json(manager.getService(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/services/:id', requireAdmin, (req, res) => {
  if (!manager.services.has(req.params.id)) {
    return res.status(404).json({ error: 'service not found' });
  }
  tunnels.stop(req.params.id);
  inspectors.stop(req.params.id);
  manager.removeService(req.params.id);
  watcher.removeService(req.params.id);
  saveServicesToDisk(manager.persistentDefinitions());
  broadcastServiceList();
  res.json({ ok: true });
});

// Alert rules can be edited by admins independently of the main service body.
app.get('/api/admin/services/:id/alerts', requireAdmin, (req, res) => {
  if (!manager.services.has(req.params.id)) {
    return res.status(404).json({ error: 'service not found' });
  }
  res.json({ rules: watcher.getRules(req.params.id) });
});

app.put('/api/admin/services/:id/alerts', requireAdmin, (req, res) => {
  const entry = manager.services.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'service not found' });
  try {
    const def = normalizeIncomingService(
      { alertRules: (req.body && req.body.rules) || [], id: req.params.id },
      entry.definition,
    );
    manager.registerService(def);
    watcher.setRules(def.id, def.alertRules || []);
    saveServicesToDisk(manager.persistentDefinitions());
    res.json({ rules: watcher.getRules(req.params.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Admin: known hosts ----------

app.get('/api/admin/known-hosts', requireAdmin, (_req, res) => {
  res.json({ hosts: knownHosts.list() });
});

app.delete('/api/admin/known-hosts', requireAdmin, (req, res) => {
  const { host, port } = req.query;
  if (!host) return res.status(400).json({ error: 'host required' });
  knownHosts.forget(host, Number(port) || 22);
  res.json({ ok: true });
});

// ---------- Socket.IO ----------

function roomFor(id) {
  return `service:${id}`;
}

function socketUser(socket) {
  const sess = socket.request.session;
  return sess && sess.user ? sess.user : null;
}

function broadcastServiceList() {
  for (const socket of io.sockets.sockets.values()) {
    const user = socketUser(socket);
    if (!user) continue;
    socket.emit('services', manager.listServicesForUser(user));
  }
}

function broadcastWorkspaceList() {
  for (const socket of io.sockets.sockets.values()) {
    const user = socketUser(socket);
    if (!user) continue;
    socket.emit('workspaces', workspaces.listTemplatesForUser(user));
  }
}

manager.on('data', (id, chunk) => {
  io.to(roomFor(id)).emit('service-output', { id, data: chunk });
});

manager.on('status', (id) => {
  const svc = manager.getService(id);
  if (!svc) return;
  io.to(roomFor(id)).emit('service-status', svc);
  broadcastServiceList();
});

manager.on('error', (id, err) => {
  console.error(`[shellHelper] service "${id}" error: ${err.message}`);
  io.to(roomFor(id)).emit('service-error', { id, message: err.message });
});

// A tunnel or inspector points at a port opened by a service. If the service
// exits, the port is gone — tear them down so we don't leave stale state
// hanging in the UI. restartService goes through stop → start, so this
// covers restarts too.
manager.on('exit', (id) => {
  if (tunnels.isActive(id)) tunnels.stop(id);
  if (inspectors.isActive(id)) inspectors.stop(id);
});

tunnels.on('status', (id, status) => {
  io.to(roomFor(id)).emit('tunnel-status', { id, ...status });
});
tunnels.on('stopped', (id, info) => {
  io.to(roomFor(id)).emit('tunnel-status', {
    id,
    active: false,
    url: null,
    ...info,
  });
});
tunnels.on('error', (id, err) => {
  io.to(roomFor(id)).emit('tunnel-error', { id, message: err.message });
});

inspectors.on('status', (id, status) => {
  io.to(roomFor(id)).emit('inspector-status', { id, ...status });
});
inspectors.on('capture', (id, record) => {
  io.to(roomFor(id)).emit('http-capture', { id, record });
});
inspectors.on('cleared', (id) => {
  io.to(roomFor(id)).emit('inspector-cleared', { id });
});

gitWatcher.on('status', (id, snapshot) => {
  io.to(roomFor(id)).emit('git-status', { id, snapshot });
});

// Ephemeral scratchpads self-destruct on shell exit — surface that to viewers
// and also tear down the backing container so the FS is wiped.
manager.on('removed', (id) => {
  io.to(roomFor(id)).emit('service-removed', { id });
  if (tunnels.isActive(id)) tunnels.stop(id);
  if (inspectors.isActive(id)) inspectors.stop(id);
  const container = scratchpadContainers.get(id);
  if (container) {
    scratchpadContainers.delete(id);
    destroyScratchpadContainer(container.docker, container.containerId).catch(
      (err) =>
        console.error(
          `[shellHelper] failed to remove scratchpad container ${container.containerId.slice(0, 12)}: ${err.message}`,
        ),
    );
  }
  broadcastServiceList();
});

monitor.on('host', (snapshot) => {
  for (const socket of io.sockets.sockets.values()) {
    if (socketUser(socket)) socket.emit('host-metrics', snapshot);
  }
});

monitor.on('service', (metrics) => {
  io.to(roomFor(metrics.id)).emit('service-metrics', metrics);
});

monitor.on('context', (metrics) => {
  io.to(roomFor(metrics.id)).emit('service-context-metrics', metrics);
});

watcher.on('alert', (alert) => {
  // Only viewers with access to the service (i.e. in its room) get the alert.
  io.to(roomFor(alert.serviceId)).emit('log-alert', alert);
});

workspaces.on('started', ({ id, info }) => {
  broadcastWorkspaceList();
  io.emit('workspace-status', { id, instance: info, state: 'starting' });
});
workspaces.on('ready', ({ id, info }) => {
  broadcastWorkspaceList();
  io.emit('workspace-status', { id, instance: info, state: 'ready' });
});
workspaces.on('exit', ({ id }) => {
  broadcastWorkspaceList();
  io.emit('workspace-status', { id, instance: null, state: 'stopped' });
});

io.on('connection', (socket) => {
  const user = socketUser(socket);
  if (!user) {
    socket.emit('auth-required');
    socket.disconnect(true);
    return;
  }

  socket.emit('services', manager.listServicesForUser(user));
  socket.emit('workspaces', workspaces.listTemplatesForUser(user));
  const lastHost = monitor.getLastHost();
  if (lastHost) socket.emit('host-metrics', lastHost);

  socket.on('service-macro', ({ id, macroId } = {}, ack) => {
    if (!manager.userCanAccess(user, id)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'access denied' });
      return;
    }
    const result = manager.fireMacro(id, macroId);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('subscribe-service', ({ id } = {}, ack) => {
    if (!manager.userCanAccess(user, id)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'access denied' });
      return;
    }
    socket.join(roomFor(id));
    const scrollback = manager.getScrollback(id);
    if (scrollback) socket.emit('service-output', { id, data: scrollback });
    socket.emit('service-status', manager.getService(id));
    socket.emit('tunnel-status', { id, ...tunnels.status(id) });
    socket.emit('inspector-status', { id, ...inspectors.status(id) });
    const cachedGit = gitWatcher.latest(id);
    if (cachedGit) socket.emit('git-status', { id, snapshot: cachedGit });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('unsubscribe-service', ({ id } = {}) => {
    if (id) socket.leave(roomFor(id));
    // If this socket was watching context metrics for it, drop its refcount.
    const set = socket.data && socket.data.contexts;
    if (set && set.has(id)) {
      set.delete(id);
      monitor.unwatchContext(id);
    }
    // Ephemeral scratchpads self-destruct when their last viewer leaves.
    maybeReapEphemeral(id);
  });

  socket.data = socket.data || {};
  socket.data.contexts = new Set();
  socket.data.gitWatched = new Set();

  socket.on('watch-git', ({ id } = {}, ack) => {
    if (!manager.userCanAccess(user, id)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'access denied' });
      return;
    }
    if (socket.data.gitWatched.has(id)) {
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }
    socket.data.gitWatched.add(id);
    gitWatcher.watch(id);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('unwatch-git', ({ id } = {}) => {
    if (id && socket.data.gitWatched.has(id)) {
      socket.data.gitWatched.delete(id);
      gitWatcher.unwatch(id);
    }
  });

  socket.on('watch-context', ({ id } = {}, ack) => {
    if (!manager.userCanAccess(user, id)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'access denied' });
      return;
    }
    // Idempotent per-socket — a viewer switching tabs quickly must not leak refs.
    if (socket.data.contexts.has(id)) {
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }
    socket.data.contexts.add(id);
    const type = monitor.watchContext(id);
    if (typeof ack === 'function') ack({ ok: true, contextType: type });
  });

  socket.on('unwatch-context', ({ id } = {}) => {
    if (id && socket.data.contexts.has(id)) {
      socket.data.contexts.delete(id);
      monitor.unwatchContext(id);
    }
  });

  // Snapshot service rooms before Socket.IO clears them on `disconnect` so we
  // can reap ephemerals whose last viewer vanished.
  socket.on('disconnecting', () => {
    const ephemeralIds = [];
    for (const r of socket.rooms) {
      if (!r.startsWith('service:')) continue;
      const id = r.slice('service:'.length);
      const entry = manager.services.get(id);
      if (entry && entry.definition.ephemeral) ephemeralIds.push(id);
    }
    // Deferred so the leave from disconnect has propagated to room sizes.
    setImmediate(() => ephemeralIds.forEach(maybeReapEphemeral));
  });

  socket.on('disconnect', () => {
    // Release every context / git watch this socket was holding.
    if (socket.data && socket.data.contexts) {
      for (const id of socket.data.contexts) monitor.unwatchContext(id);
      socket.data.contexts.clear();
    }
    if (socket.data && socket.data.gitWatched) {
      for (const id of socket.data.gitWatched) gitWatcher.unwatch(id);
      socket.data.gitWatched.clear();
    }
  });

  socket.on('service-input', ({ id, data } = {}) => {
    if (!manager.userCanAccess(user, id) || typeof data !== 'string') return;
    manager.writeToService(id, data);
  });

  socket.on('resize', ({ id, cols, rows } = {}) => {
    if (!manager.userCanAccess(user, id)) return;
    manager.resizeService(id, cols, rows);
  });

  socket.on('start-service', ({ id, overrides } = {}, ack) => {
    if (!manager.userCanAccess(user, id)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'access denied' });
      return;
    }
    try {
      const status = manager.startService(id, overrides || {});
      if (typeof ack === 'function') ack({ ok: true, status });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  socket.on('stop-service', ({ id, signal } = {}, ack) => {
    if (!manager.userCanAccess(user, id)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'access denied' });
      return;
    }
    try {
      const status = manager.stopService(id, signal ? { signal } : {});
      if (typeof ack === 'function') ack({ ok: true, status });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  socket.on('restart-service', async ({ id, overrides } = {}, ack) => {
    if (!manager.userCanAccess(user, id)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'access denied' });
      return;
    }
    try {
      const status = await manager.restartService(id, overrides || {});
      if (typeof ack === 'function') ack({ ok: true, status });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });
});

// ---------- Lifecycle ----------

function shutdown(signal) {
  console.log(`[shellHelper] received ${signal}, shutting down...`);
  monitor.stop();
  tunnels.shutdown();
  inspectors.shutdown();
  gitWatcher.stopAll();
  manager.shutdown();
  // Tear down any live scratchpad containers; don't block exit on it.
  for (const [id, { docker, containerId }] of scratchpadContainers) {
    destroyScratchpadContainer(docker, containerId).catch(() => {});
    scratchpadContainers.delete(id);
  }
  // Stop any running workspace containers too. Fire-and-forget: exit still
  // proceeds in 5s even if Docker is unresponsive.
  workspaces.shutdown().catch(() => {});
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log(`[shellHelper] listening on http://${HOST}:${PORT}`);
  // Sweep any scratchpad containers left behind by a previous run (crash,
  // kill -9, etc.). Best-effort — silently no-ops if Docker isn't around.
  reapOrphanedScratchpads().catch(() => {});
  reapOrphanedWorkspaces().catch(() => {});
});
