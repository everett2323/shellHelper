'use strict';

const EventEmitter = require('events');
const { spawn } = require('child_process');
const readline = require('readline');

const URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const READY_TIMEOUT_MS = 30_000;
const STARTUP_KILL_GRACE_MS = 2_000;

/**
 * TunnelManager wraps `cloudflared tunnel --url http://localhost:<port>`
 * and exposes one ephemeral public tunnel per service.
 *
 * Emits:
 *   'status' (serviceId, { active, url, port, pid })  — url present once parsed
 *   'stopped' (serviceId, { code, signal })
 *   'error'  (serviceId, Error)
 */
class TunnelManager extends EventEmitter {
  constructor({ binary = process.env.CLOUDFLARED_BIN || 'cloudflared' } = {}) {
    super();
    this.binary = binary;
    this.tunnels = new Map(); // serviceId -> { proc, url, port, startedAt }
  }

  isActive(serviceId) {
    return this.tunnels.has(serviceId);
  }

  status(serviceId) {
    const t = this.tunnels.get(serviceId);
    if (!t) return { active: false, url: null, port: null };
    return {
      active: true,
      url: t.url || null,
      port: t.port,
      pid: t.proc ? t.proc.pid : null,
      startedAt: t.startedAt,
    };
  }

  list() {
    return Array.from(this.tunnels.entries()).map(([id, t]) => ({
      serviceId: id,
      url: t.url || null,
      port: t.port,
      pid: t.proc ? t.proc.pid : null,
      startedAt: t.startedAt,
    }));
  }

  /**
   * Start (or return the already-running) tunnel for `serviceId` pointing at
   * localhost:port. Resolves with the parsed public URL when cloudflared has
   * printed it; rejects if the binary is missing, the child exits early, or
   * the URL doesn't appear within READY_TIMEOUT_MS.
   */
  start(serviceId, port) {
    if (!serviceId) return Promise.reject(new Error('serviceId is required'));
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return Promise.reject(new Error('port must be an integer between 1 and 65535'));
    }
    const existing = this.tunnels.get(serviceId);
    if (existing) {
      if (existing.url) return Promise.resolve(existing.url);
      // Startup already in flight — hand back the same promise.
      if (existing.readyPromise) return existing.readyPromise;
    }

    let proc;
    try {
      proc = spawn(this.binary, ['tunnel', '--url', `http://localhost:${p}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return Promise.reject(
        new Error(`failed to spawn "${this.binary}": ${err.message}`),
      );
    }

    const entry = {
      proc,
      url: null,
      port: p,
      startedAt: new Date().toISOString(),
      readyPromise: null,
    };
    this.tunnels.set(serviceId, entry);

    const readyPromise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        fn(arg);
      };

      const readyTimer = setTimeout(() => {
        finish(reject, new Error('tunnel did not report a URL within 30s'));
        // Kill the stalled child; the exit handler will clean the map.
        try {
          proc.kill('SIGTERM');
        } catch {
          /* noop */
        }
      }, READY_TIMEOUT_MS);

      // cloudflared prints startup logs to stderr, including the URL banner.
      // Watch stdout too in case a future release moves it.
      const rlErr = readline.createInterface({ input: proc.stderr });
      const rlOut = readline.createInterface({ input: proc.stdout });
      const onLine = (line) => {
        const m = URL_REGEX.exec(line);
        if (m && !entry.url) {
          entry.url = m[0];
          this.emit('status', serviceId, {
            active: true,
            url: entry.url,
            port: entry.port,
            pid: proc.pid,
            startedAt: entry.startedAt,
          });
          finish(resolve, entry.url);
        }
      };
      rlErr.on('line', onLine);
      rlOut.on('line', onLine);

      proc.once('error', (err) => {
        const wrapped =
          err.code === 'ENOENT'
            ? new Error(
                `cloudflared binary not found (looked for "${this.binary}"). ` +
                  'Install it or set CLOUDFLARED_BIN to its full path.',
              )
            : err;
        this.emit('error', serviceId, wrapped);
        finish(reject, wrapped);
      });

      proc.once('exit', (code, signal) => {
        try {
          rlErr.close();
        } catch {
          /* noop */
        }
        try {
          rlOut.close();
        } catch {
          /* noop */
        }
        const wasActive = this.tunnels.get(serviceId) === entry;
        if (wasActive) this.tunnels.delete(serviceId);
        this.emit('stopped', serviceId, { code, signal });
        // If we never surfaced a URL, treat this as a startup failure.
        finish(
          reject,
          new Error(
            `cloudflared exited before opening a tunnel (code=${code}${
              signal ? `, signal=${signal}` : ''
            })`,
          ),
        );
      });
    });

    entry.readyPromise = readyPromise;
    // Suppress unhandled-rejection noise; every caller path either awaits this
    // promise or listens on 'error'.
    readyPromise.catch(() => {});
    return readyPromise;
  }

  /**
   * Stop the tunnel for `serviceId`. Idempotent — returns true if a running
   * tunnel was signalled, false if there was nothing to do.
   */
  stop(serviceId) {
    const entry = this.tunnels.get(serviceId);
    if (!entry) return false;
    // Remove from the map immediately so subsequent status() calls report
    // "inactive" even before the process's 'exit' fires. Keep a local ref so
    // the exit handler still has something to compare against safely.
    this.tunnels.delete(serviceId);
    try {
      entry.proc.kill('SIGTERM');
    } catch {
      /* noop */
    }
    // SIGKILL fallback if cloudflared ignores SIGTERM.
    setTimeout(() => {
      if (!entry.proc.killed && entry.proc.exitCode === null) {
        try {
          entry.proc.kill('SIGKILL');
        } catch {
          /* noop */
        }
      }
    }, STARTUP_KILL_GRACE_MS).unref();
    this.emit('status', serviceId, { active: false, url: null, port: entry.port });
    return true;
  }

  shutdown() {
    for (const id of Array.from(this.tunnels.keys())) this.stop(id);
  }
}

module.exports = TunnelManager;
