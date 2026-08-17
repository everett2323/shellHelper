'use strict';

const EventEmitter = require('events');
const LocalSession = require('./sessions/LocalSession');
const SshSession = require('./sessions/SshSession');
const DockerSession = require('./sessions/DockerSession');
const { ServiceLogger, purgeLogs } = require('./logger');
const { SessionRecorder } = require('./recorder');

const RESTART_STABLE_MS = 20_000; // running this long resets restart counter
const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_DELAY_MS = 2_000;

/**
 * TaskManager owns every managed service and its lifecycle. Supports:
 *  - local PTY-backed shells (node-pty)
 *  - remote SSH shells (ssh2), password or private key
 *  - persistent output logging (rotating file per service)
 *  - session recording (asciinema v2)
 *  - auto-restart on unexpected exit with exponential backoff
 *  - per-service ACLs
 */
class TaskManager extends EventEmitter {
  constructor({
    maxScrollback = 200_000,
    decryptSecret,
    hostVerifierFor,
    onHostKeyLearned,
  } = {}) {
    super();
    this.maxScrollback = maxScrollback;
    this._decryptSecret = decryptSecret || ((v) => v);
    this._hostVerifierFor = hostVerifierFor || (() => null);
    this._onHostKeyLearned = onHostKeyLearned || (() => {});
    this.services = new Map();
  }

  registerService(definition) {
    if (!definition || !definition.id) throw new Error('service id is required');
    if (!definition.name) throw new Error('service name is required');
    const type = definition.type || 'local';
    if (!['local', 'ssh', 'docker'].includes(type)) {
      throw new Error(`unsupported service type "${type}"`);
    }
    const normalized = {
      ...definition,
      type,
      allowedUsers: Array.isArray(definition.allowedUsers)
        ? definition.allowedUsers
        : [],
      ephemeral: !!definition.ephemeral,
      autoRestart: !!definition.autoRestart,
      maxRestartAttempts:
        Number.isFinite(definition.maxRestartAttempts) &&
        definition.maxRestartAttempts > 0
          ? Math.floor(definition.maxRestartAttempts)
          : DEFAULT_MAX_RESTARTS,
      restartDelayMs:
        Number.isFinite(definition.restartDelayMs) &&
        definition.restartDelayMs >= 0
          ? Math.floor(definition.restartDelayMs)
          : DEFAULT_RESTART_DELAY_MS,
      recording: !!definition.recording,
      sshAuthMethod: definition.sshAuthMethod === 'key' ? 'key' : 'password',
      macros: Array.isArray(definition.macros)
        ? definition.macros
            .filter((m) => m && m.id && m.label && typeof m.command === 'string')
            .map((m) => ({
              id: String(m.id),
              label: String(m.label),
              command: String(m.command),
            }))
        : [],
      alertRules: Array.isArray(definition.alertRules)
        ? definition.alertRules
            .filter((r) => r && typeof r.pattern === 'string' && r.pattern)
            .map((r) => ({
              id: r.id ? String(r.id) : undefined,
              name: r.name ? String(r.name) : String(r.pattern).slice(0, 60),
              pattern: String(r.pattern),
              flags: typeof r.flags === 'string' ? r.flags : '',
              severity: r.severity === 'crit' ? 'crit' : 'warn',
              cooldownMs:
                Number.isFinite(r.cooldownMs) && r.cooldownMs >= 0
                  ? Math.floor(r.cooldownMs)
                  : 5000,
            }))
        : [],
    };
    const existing = this.services.get(normalized.id);
    if (existing) {
      existing.definition = normalized;
      return;
    }
    this.services.set(normalized.id, {
      definition: normalized,
      session: null,
      status: this._buildStatus('stopped'),
      scrollback: [],
      scrollbackBytes: 0,
      logger: null,
      recorder: null,
      restartAttempts: 0,
      restartTimer: null,
      lastStartedAt: null,
      lastCols: 120,
      lastRows: 30,
    });
  }

  removeService(id) {
    const entry = this.services.get(id);
    if (!entry) return;
    this._clearRestartTimer(entry);
    if (entry.session) {
      try {
        entry.session.kill();
      } catch {
        /* noop */
      }
    }
    if (entry.logger) entry.logger.close();
    if (entry.recorder) entry.recorder.end();
    this.services.delete(id);
    try {
      purgeLogs(id);
    } catch {
      /* noop */
    }
  }

  listServices() {
    return Array.from(this.services.values()).map(({ definition, status }) => ({
      ...this._publicDefinition(definition),
      status,
    }));
  }

  listServicesForUser(user) {
    return this.listServices().filter((s) => this.userCanAccess(user, s.id));
  }

  getService(id) {
    const entry = this.services.get(id);
    if (!entry) return null;
    return { ...this._publicDefinition(entry.definition), status: entry.status };
  }

  getScrollback(id) {
    const entry = this.services.get(id);
    return entry ? entry.scrollback.join('') : '';
  }

  userCanAccess(user, id) {
    if (!user) return false;
    const entry = this.services.get(id);
    if (!entry) return false;
    if (user.role === 'admin') return true;
    const allowed = entry.definition.allowedUsers || [];
    return allowed.includes('*') || allowed.includes(user.username);
  }

  allDefinitions() {
    return Array.from(this.services.values()).map((e) => e.definition);
  }

  // Persistent definitions only — ephemeral scratchpads must never touch disk.
  persistentDefinitions() {
    return this.allDefinitions().filter((d) => !d.ephemeral);
  }

  buildSshConfig(id) {
    const entry = this.services.get(id);
    if (!entry) throw new Error(`unknown service "${id}"`);
    const def = entry.definition;
    if (def.type !== 'ssh') throw new Error(`service "${id}" is not ssh`);
    const cfg = {
      host: def.host,
      port: def.port || 22,
      username: def.sshUser,
    };
    if (def.sshPrivateKeyEncrypted) {
      cfg.privateKey = this._decryptSecret(def.sshPrivateKeyEncrypted);
    }
    if (def.sshPassphraseEncrypted) {
      cfg.passphrase = this._decryptSecret(def.sshPassphraseEncrypted);
    }
    if (def.sshPasswordEncrypted) {
      cfg.password = this._decryptSecret(def.sshPasswordEncrypted);
    }
    return cfg;
  }

  startService(id, overrides = {}) {
    const entry = this.services.get(id);
    if (!entry) throw new Error(`unknown service "${id}"`);
    if (entry.session) return entry.status;
    this._clearRestartTimer(entry);

    const def = entry.definition;
    const cols = Math.max(2, Math.floor(overrides.cols) || entry.lastCols || 120);
    const rows = Math.max(2, Math.floor(overrides.rows) || entry.lastRows || 30);
    entry.lastCols = cols;
    entry.lastRows = rows;
    const opts = { cols, rows };

    let session;
    if (def.type === 'ssh') {
      const cfg = this.buildSshConfig(id);
      opts.hostVerifier = this._hostVerifierFor(def, (learnedKey) => {
        this._onHostKeyLearned(def, learnedKey);
      });
      session = new SshSession(cfg, opts);
    } else if (def.type === 'docker') {
      session = new DockerSession(
        {
          containerId: def.containerId,
          command: def.dockerCommand || def.command,
          user: def.dockerUser,
          workingDir: def.dockerWorkingDir,
          env: def.env,
          dockerHost: def.dockerHost,
        },
        opts,
      );
    } else {
      session = new LocalSession(
        {
          command: def.command,
          args: def.args,
          cwd: def.cwd,
          env: def.env,
        },
        opts,
      );
    }

    entry.scrollback = [];
    entry.scrollbackBytes = 0;

    if (!entry.logger) entry.logger = new ServiceLogger(id);
    if (def.recording) {
      entry.recorder = new SessionRecorder(id, {
        cols,
        rows,
        title: def.name,
      });
    }

    session.on('data', (chunk) => {
      this._appendScrollback(entry, chunk);
      try {
        entry.logger.append(chunk);
      } catch {
        /* logging shouldn't kill session */
      }
      if (entry.recorder) {
        try {
          entry.recorder.writeOutput(chunk);
        } catch {
          /* noop */
        }
      }
      this.emit('data', id, chunk);
    });

    session.on('exit', ({ exitCode, signal }) => {
      const wasRunningSince = entry.lastStartedAt;
      entry.session = null;
      entry.status = this._buildStatus('stopped', {
        exitCode,
        signal: signal || null,
      });
      if (entry.recorder) {
        entry.recorder.end();
        entry.recorder = null;
      }
      const notice = `\r\n\x1b[1;33m[shellHelper]\x1b[0m session ended (code=${exitCode}${
        signal ? `, signal=${signal}` : ''
      })\r\n`;
      this._appendScrollback(entry, notice);
      try {
        entry.logger && entry.logger.append(notice);
      } catch {
        /* noop */
      }
      this.emit('data', id, notice);
      this.emit('status', id, entry.status);
      this.emit('exit', id, { exitCode, signal: signal || null });

      // Reset restart counter if the process ran long enough.
      if (
        wasRunningSince &&
        Date.now() - wasRunningSince > RESTART_STABLE_MS
      ) {
        entry.restartAttempts = 0;
      }
      if (entry.definition.ephemeral) {
        // Ephemeral scratchpads self-destruct on shell exit — the tab UI will
        // notice via 'services' broadcast and drop its tab.
        this.removeService(id);
        this.emit('removed', id);
        return;
      }
      this._maybeAutoRestart(id, entry, exitCode);
    });

    try {
      session.start();
    } catch (err) {
      session.removeAllListeners();
      const wrapped = new Error(
        `failed to start "${id}": ${err.message || err}`,
      );
      this.emit('error', id, wrapped);
      throw wrapped;
    }

    entry.session = session;
    entry.lastStartedAt = Date.now();
    entry.status = this._buildStatus('running', {
      pid: session.pid,
      startedAt: new Date(entry.lastStartedAt).toISOString(),
    });

    const banner = `\x1b[1;36m[shellHelper]\x1b[0m started ${session.describe()}${
      session.pid ? ` (pid ${session.pid})` : ''
    }\r\n`;
    this._appendScrollback(entry, banner);
    try {
      entry.logger.append(banner);
    } catch {
      /* noop */
    }
    this.emit('data', id, banner);
    this.emit('status', id, entry.status);
    return entry.status;
  }

  stopService(id, { signal = 'SIGTERM' } = {}) {
    const entry = this.services.get(id);
    if (!entry) throw new Error(`unknown service "${id}"`);
    this._clearRestartTimer(entry);
    // User-initiated stop should not trigger auto-restart.
    entry.restartAttempts = entry.definition.maxRestartAttempts;
    if (!entry.session) return entry.status;
    try {
      entry.session.kill(signal);
    } catch (err) {
      this.emit('error', id, err);
    }
    return entry.status;
  }

  restartService(id, overrides = {}) {
    const entry = this.services.get(id);
    if (!entry) throw new Error(`unknown service "${id}"`);
    if (!entry.session) return this.startService(id, overrides);
    return new Promise((resolve, reject) => {
      const onExit = (exitedId) => {
        if (exitedId !== id) return;
        this.off('exit', onExit);
        entry.restartAttempts = 0;
        try {
          resolve(this.startService(id, overrides));
        } catch (err) {
          reject(err);
        }
      };
      this.on('exit', onExit);
      try {
        this.stopService(id);
      } catch (err) {
        this.off('exit', onExit);
        reject(err);
      }
    });
  }

  writeToService(id, data) {
    const entry = this.services.get(id);
    if (!entry || !entry.session) return false;
    entry.session.write(data);
    return true;
  }

  fireMacro(id, macroId) {
    const entry = this.services.get(id);
    if (!entry) return { ok: false, error: 'unknown service' };
    if (!entry.session) return { ok: false, error: 'service is not running' };
    const macro = (entry.definition.macros || []).find((m) => m.id === macroId);
    if (!macro) return { ok: false, error: 'unknown macro' };
    entry.session.write(macro.command);
    return { ok: true, label: macro.label };
  }

  resizeService(id, cols, rows) {
    const entry = this.services.get(id);
    if (!entry) return false;
    entry.lastCols = Math.max(2, Math.floor(cols) || entry.lastCols);
    entry.lastRows = Math.max(2, Math.floor(rows) || entry.lastRows);
    if (!entry.session) return false;
    try {
      entry.session.resize(entry.lastCols, entry.lastRows);
      if (entry.recorder) entry.recorder.resize(entry.lastCols, entry.lastRows);
      return true;
    } catch (err) {
      this.emit('error', id, err);
      return false;
    }
  }

  shutdown() {
    for (const [id, entry] of this.services) {
      this._clearRestartTimer(entry);
      if (entry.session) {
        try {
          entry.session.kill('SIGTERM');
        } catch (err) {
          this.emit('error', id, err);
        }
      }
      if (entry.recorder) entry.recorder.end();
      if (entry.logger) entry.logger.close();
    }
  }

  _maybeAutoRestart(id, entry, exitCode) {
    const def = entry.definition;
    if (def.ephemeral) return;
    if (!def.autoRestart) return;
    if (entry.restartAttempts >= def.maxRestartAttempts) {
      const notice = `\x1b[31m[shellHelper]\x1b[0m auto-restart giving up after ${entry.restartAttempts} attempts.\r\n`;
      this._appendScrollback(entry, notice);
      this.emit('data', id, notice);
      return;
    }
    entry.restartAttempts += 1;
    const delay = Math.min(
      def.restartDelayMs * Math.pow(2, entry.restartAttempts - 1),
      60_000,
    );
    const notice = `\x1b[33m[shellHelper]\x1b[0m auto-restart #${entry.restartAttempts} in ${Math.round(delay / 100) / 10}s (exit=${exitCode}).\r\n`;
    this._appendScrollback(entry, notice);
    this.emit('data', id, notice);

    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      try {
        this.startService(id);
      } catch (err) {
        this.emit('error', id, err);
      }
    }, delay);
  }

  _clearRestartTimer(entry) {
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
  }

  _appendScrollback(entry, chunk) {
    entry.scrollback.push(chunk);
    entry.scrollbackBytes += Buffer.byteLength(chunk, 'utf8');
    while (
      entry.scrollbackBytes > this.maxScrollback &&
      entry.scrollback.length > 1
    ) {
      const dropped = entry.scrollback.shift();
      entry.scrollbackBytes -= Buffer.byteLength(dropped, 'utf8');
    }
  }

  _buildStatus(state, extra = {}) {
    return {
      state,
      pid: null,
      startedAt: null,
      exitCode: null,
      signal: null,
      ...extra,
    };
  }

  _publicDefinition(def) {
    // Never leak SSH credentials or key material to clients.
    const {
      sshPassword,
      sshPasswordEncrypted,
      sshPrivateKey,
      sshPrivateKeyEncrypted,
      sshPassphrase,
      sshPassphraseEncrypted,
      ...safe
    } = def;
    safe.hasSshPassword = !!sshPasswordEncrypted;
    safe.hasSshPrivateKey = !!sshPrivateKeyEncrypted;
    safe.ephemeral = !!def.ephemeral;
    return safe;
  }
}

module.exports = TaskManager;
