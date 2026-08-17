'use strict';

const os = require('os');
const EventEmitter = require('events');
const pty = require('node-pty');

const DEFAULT_SHELL =
  process.env.DEFAULT_SHELL ||
  (os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash');

class LocalSession extends EventEmitter {
  constructor(def, opts = {}) {
    super();
    this._def = def || {};
    this._opts = opts;
    this.command = this._def.command || DEFAULT_SHELL;
    this.args = Array.isArray(this._def.args) ? this._def.args : [];
    this.pid = null;
    this.pty = null;
  }

  describe() {
    const trailing = this.args.join(' ');
    return trailing ? `${this.command} ${trailing}` : this.command;
  }

  start() {
    const cols = Math.max(2, Math.floor(this._opts.cols) || 120);
    const rows = Math.max(2, Math.floor(this._opts.rows) || 30);
    const cwd = this._def.cwd || process.env.HOME || process.cwd();
    const env = { ...process.env, ...(this._def.env || {}) };

    this.pty = pty.spawn(this.command, this.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
    this.pid = this.pty.pid;

    this.pty.onData((chunk) => this.emit('data', chunk));
    this.pty.onExit(({ exitCode, signal }) =>
      this.emit('exit', { exitCode, signal: signal || null }),
    );
  }

  write(data) {
    if (!this.pty) return;
    try {
      this.pty.write(data);
    } catch {
      /* pty gone */
    }
  }

  resize(cols, rows) {
    if (!this.pty) return;
    const c = Math.max(2, Math.floor(cols) || 80);
    const r = Math.max(2, Math.floor(rows) || 24);
    try {
      this.pty.resize(c, r);
    } catch {
      /* pty gone */
    }
  }

  kill(signal = 'SIGTERM') {
    if (!this.pty) return;
    try {
      this.pty.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

module.exports = LocalSession;
