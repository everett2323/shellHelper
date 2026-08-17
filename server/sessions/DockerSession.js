'use strict';

const EventEmitter = require('events');

let Docker = null;
function loadDockerode() {
  if (Docker) return Docker;
  try {
    Docker = require('dockerode');
  } catch (err) {
    throw new Error(
      'dockerode is not installed. Run `npm install dockerode` to enable Docker-backed shells.',
    );
  }
  return Docker;
}

/**
 * Docker-backed session. Attaches an interactive exec (TTY) inside a running
 * container so keystrokes go to the container's PTY and output flows back.
 *
 * Definition fields consumed:
 *   - containerId (required) — id or name of an already-running container
 *   - command (optional)     — argv array or string; default ['/bin/sh']
 *   - user (optional)        — passed straight to exec User field
 *   - workingDir (optional)  — passed to exec WorkingDir
 *   - dockerHost (optional)  — { socketPath | host, port, protocol } for
 *                              dockerode; defaults to /var/run/docker.sock
 */
class DockerSession extends EventEmitter {
  constructor(def, opts = {}) {
    super();
    if (!def || !def.containerId) {
      throw new Error('docker session requires containerId');
    }
    this._def = def;
    this._opts = opts;
    this.containerId = def.containerId;
    this.command = Array.isArray(def.command)
      ? def.command.slice()
      : def.command
        ? String(def.command).trim().split(/\s+/)
        : ['/bin/sh'];
    this.pid = null; // dockerode doesn't expose the exec's pid to us
    this.exec = null;
    this.stream = null;
    this._exited = false;
    this._closeTimer = null;
  }

  describe() {
    const cmd = this.command.join(' ');
    const short = String(this.containerId).slice(0, 12);
    return `docker exec ${short} ${cmd}`;
  }

  start() {
    const DockerClass = loadDockerode();
    const cols = Math.max(2, Math.floor(this._opts.cols) || 120);
    const rows = Math.max(2, Math.floor(this._opts.rows) || 30);

    const docker = new DockerClass(this._def.dockerHost || undefined);
    this._docker = docker;

    setImmediate(() => {
      this.emit(
        'data',
        `\x1b[36m[shellHelper]\x1b[0m attaching to container ${String(
          this.containerId,
        ).slice(0, 12)} ...\r\n`,
      );
    });

    const container = docker.getContainer(this.containerId);
    const execOpts = {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: this.command,
    };
    if (this._def.user) execOpts.User = String(this._def.user);
    if (this._def.workingDir) execOpts.WorkingDir = String(this._def.workingDir);
    if (this._def.env && typeof this._def.env === 'object') {
      execOpts.Env = Object.entries(this._def.env).map(
        ([k, v]) => `${k}=${v}`,
      );
    }

    container.exec(execOpts, (err, exec) => {
      if (err) return this._fail(err);
      this.exec = exec;
      exec.start({ hijack: true, stdin: true, Tty: true }, (err2, stream) => {
        if (err2) return this._fail(err2);
        this.stream = stream;

        // Best-effort initial resize.
        try {
          exec.resize({ h: rows, w: cols }, () => {});
        } catch {
          /* older docker daemons may not support pre-start resize */
        }

        stream.on('data', (chunk) => this.emit('data', chunk.toString('utf8')));
        stream.on('error', (e) => {
          this.emit(
            'data',
            `\r\n\x1b[31m[shellHelper] docker stream error: ${e.message}\x1b[0m\r\n`,
          );
        });
        stream.on('end', () => this._finish());
        stream.on('close', () => this._finish());
      });
    });
  }

  write(data) {
    if (!this.stream) return;
    try {
      this.stream.write(data);
    } catch {
      /* stream gone */
    }
  }

  resize(cols, rows) {
    if (!this.exec) return;
    const c = Math.max(2, Math.floor(cols) || 80);
    const r = Math.max(2, Math.floor(rows) || 24);
    try {
      this.exec.resize({ h: r, w: c }, () => {});
    } catch {
      /* exec gone */
    }
  }

  kill() {
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        /* noop */
      }
      try {
        this.stream.destroy();
      } catch {
        /* noop */
      }
    }
    // Docker doesn't send us a close reliably if the underlying process is
    // still running; force the "exit" emission after a short grace period.
    if (!this._exited) {
      this._closeTimer = setTimeout(() => this._finish(), 1500);
    }
  }

  _fail(err) {
    this.emit(
      'data',
      `\r\n\x1b[31m[shellHelper] docker exec failed: ${err.message}\x1b[0m\r\n`,
    );
    this._finish(1);
  }

  _finish(exitCode = 0) {
    if (this._exited) return;
    this._exited = true;
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    // Try to fetch the real exit code from dockerode.
    const finalize = (code) => this.emit('exit', { exitCode: code, signal: null });
    if (!this.exec) return finalize(exitCode);
    this.exec.inspect((err, info) => {
      if (err || !info || typeof info.ExitCode !== 'number') return finalize(exitCode);
      finalize(info.ExitCode);
    });
  }
}

module.exports = DockerSession;
