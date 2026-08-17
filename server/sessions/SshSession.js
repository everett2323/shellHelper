'use strict';

const EventEmitter = require('events');
const { Client } = require('ssh2');

/**
 * SSH-backed session. Supports password and public-key auth. Verifies the
 * host key against a caller-supplied policy (TOFU + pinning).
 */
class SshSession extends EventEmitter {
  constructor(config, opts = {}) {
    super();
    if (!config || !config.host || !config.username) {
      throw new Error('ssh session requires host and username');
    }
    this._config = config;
    this._opts = opts;
    this.host = config.host;
    this.username = config.username;
    this.port = config.port || 22;
    this.pid = null;
    this.client = null;
    this._shell = null;
    this._exited = false;
  }

  describe() {
    return `ssh ${this.username}@${this.host}:${this.port}`;
  }

  start() {
    const cols = Math.max(2, Math.floor(this._opts.cols) || 120);
    const rows = Math.max(2, Math.floor(this._opts.rows) || 30);
    const client = new Client();
    this.client = client;

    setImmediate(() => {
      this.emit(
        'data',
        `\x1b[36m[shellHelper]\x1b[0m connecting to ${this.username}@${this.host}:${this.port} ...\r\n`,
      );
    });

    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          this.emit(
            'data',
            `\x1b[31m[shellHelper] shell request failed: ${err.message}\x1b[0m\r\n`,
          );
          this._exitOnce(1, null);
          try {
            client.end();
          } catch {
            /* noop */
          }
          return;
        }
        this._shell = stream;
        stream.on('data', (chunk) => this.emit('data', chunk.toString('utf8')));
        if (stream.stderr) {
          stream.stderr.on('data', (chunk) =>
            this.emit('data', chunk.toString('utf8')),
          );
        }
        stream.on('close', () => {
          try {
            client.end();
          } catch {
            /* noop */
          }
          this._exitOnce(0, null);
        });
      });
    });

    client.on('error', (err) => {
      this.emit(
        'data',
        `\x1b[31m[shellHelper] ssh error: ${err.message}\x1b[0m\r\n`,
      );
      this._exitOnce(1, null);
    });

    client.on('end', () => this._exitOnce(0, null));
    client.on('close', () => this._exitOnce(0, null));

    const connectOpts = {
      host: this.host,
      port: this.port,
      username: this.username,
      readyTimeout: 15_000,
      keepaliveInterval: 30_000,
    };

    if (this._config.privateKey) {
      connectOpts.privateKey = this._config.privateKey;
      if (this._config.passphrase) {
        connectOpts.passphrase = this._config.passphrase;
      }
    } else {
      connectOpts.password = this._config.password || '';
      connectOpts.tryKeyboard = true;
      client.on(
        'keyboard-interactive',
        (_name, _instr, _lang, _prompts, finish) =>
          finish([this._config.password || '']),
      );
    }

    if (this._opts.hostVerifier) {
      connectOpts.hostVerifier = (key, cb) => {
        let ok;
        try {
          ok = this._opts.hostVerifier(key);
        } catch (err) {
          this.emit(
            'data',
            `\x1b[31m[shellHelper] host key rejected: ${err.message}\x1b[0m\r\n`,
          );
          ok = false;
        }
        if (typeof cb === 'function') cb(ok);
        return ok;
      };
    }

    client.connect(connectOpts);
  }

  write(data) {
    if (!this._shell) return;
    try {
      this._shell.write(data);
    } catch {
      /* stream gone */
    }
  }

  resize(cols, rows) {
    if (!this._shell) return;
    const c = Math.max(2, Math.floor(cols) || 80);
    const r = Math.max(2, Math.floor(rows) || 24);
    try {
      this._shell.setWindow(r, c, 0, 0);
    } catch {
      /* stream gone */
    }
  }

  kill() {
    if (this._shell) {
      try {
        this._shell.end();
      } catch {
        /* noop */
      }
    }
    if (this.client) {
      try {
        this.client.end();
      } catch {
        /* noop */
      }
    }
  }

  _exitOnce(exitCode, signal) {
    if (this._exited) return;
    this._exited = true;
    this.emit('exit', { exitCode, signal });
  }
}

module.exports = SshSession;
