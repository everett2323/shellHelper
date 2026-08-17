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
const ResourceMonitor = require('./ResourceMonitor');
const LogWatcher = require('./LogWatcher');
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

const sessionMiddleware = createSessionMiddleware(SESSION_SECRET);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' })); // room for pasted SSH keys
app.use(sessionMiddleware);
app.use(express.static(PUBLIC_DIR));

io.engine.use(sessionMiddleware);

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

app.post('/api/services/:id/start', requireAuth, requireCanAccessService, (req, res) => {
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

app.get('/api/metrics/host', requireAuth, (_req, res) => {
  res.json({ host: monitor.getLastHost() });
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

// Ephemeral scratchpads self-destruct on shell exit — surface that to viewers
// and also tear down the backing container so the FS is wiped.
manager.on('removed', (id) => {
  io.to(roomFor(id)).emit('service-removed', { id });
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

io.on('connection', (socket) => {
  const user = socketUser(socket);
  if (!user) {
    socket.emit('auth-required');
    socket.disconnect(true);
    return;
  }

  socket.emit('services', manager.listServicesForUser(user));
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
    // Release every context watch this socket was holding.
    if (socket.data && socket.data.contexts) {
      for (const id of socket.data.contexts) monitor.unwatchContext(id);
      socket.data.contexts.clear();
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
  manager.shutdown();
  // Tear down any live scratchpad containers; don't block exit on it.
  for (const [id, { docker, containerId }] of scratchpadContainers) {
    destroyScratchpadContainer(docker, containerId).catch(() => {});
    scratchpadContainers.delete(id);
  }
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
});
