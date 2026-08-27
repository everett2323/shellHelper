'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WorkspaceSession } = require('./sessions/WorkspaceSession');

const WORKSPACES_FILE = path.join(__dirname, '..', 'workspaces.json');
// Instances shut down after this long with zero viewers. Long enough that a
// browser refresh doesn't kill the desktop, short enough that abandoned
// sessions don't hold GB of RAM forever.
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Owns the persistent workspace templates (workspaces.json) and the live
 * WorkspaceSession instances. Templates are what an admin defines; instances
 * are ephemeral containers spun up on demand.
 *
 * Access control mirrors TaskManager: admins see everything, users only see
 * templates whose `allowedUsers` contains their username (or "*").
 */
class WorkspaceManager extends EventEmitter {
  constructor({ idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}) {
    super();
    this.templates = new Map(); // id -> template def
    this.instances = new Map(); // id -> { session, template, refCount, idleTimer }
    this.idleTimeoutMs = idleTimeoutMs;
    this._load();
  }

  _load() {
    if (!fs.existsSync(WORKSPACES_FILE)) return;
    try {
      const raw = fs.readFileSync(WORKSPACES_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      for (const t of parsed.templates || []) {
        try {
          this.templates.set(t.id, this._normalize(t, null));
        } catch (err) {
          console.error(
            `[shellHelper] skipping workspace template "${t.id || '?'}": ${err.message}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[shellHelper] failed to read workspaces.json: ${err.message}`,
      );
    }
  }

  _save() {
    fs.writeFileSync(
      WORKSPACES_FILE,
      JSON.stringify(
        { templates: Array.from(this.templates.values()) },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    try {
      fs.chmodSync(WORKSPACES_FILE, 0o600);
    } catch {
      /* best effort */
    }
  }

  listTemplates() {
    return Array.from(this.templates.values());
  }

  listTemplatesForUser(user) {
    if (!user) return [];
    return this.listTemplates()
      .filter((t) => this._canAccess(user, t))
      .map((t) => this._publicTemplate(t, user));
  }

  userCanAccess(user, id) {
    const t = this.templates.get(id);
    return !!t && this._canAccess(user, t);
  }

  _canAccess(user, t) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const allowed = t.allowedUsers || [];
    return allowed.includes('*') || allowed.includes(user.username);
  }

  // The template object we ship to the frontend. Includes runtime status
  // derived from the live instance (if any) so the UI can show it in one shot.
  _publicTemplate(t, user) {
    const inst = this.instances.get(t.id);
    const status = inst
      ? {
          state: 'running',
          containerId: inst.session.containerId,
          hostPort: inst.session.hostPort,
          ready: inst.session._ready,
          startedAt: inst.session.startedAt,
        }
      : { state: 'stopped' };
    return {
      id: t.id,
      name: t.name,
      image: t.image,
      internalPort: t.internalPort,
      useHttps: t.useHttps,
      resolution: t.resolution,
      shmSize: t.shmSize,
      allowedUsers: t.allowedUsers,
      description: t.description || '',
      status,
    };
  }

  getTemplate(id) {
    return this.templates.get(id) || null;
  }

  getTemplateForUser(id, user) {
    const t = this.templates.get(id);
    if (!t || !this._canAccess(user, t)) return null;
    return this._publicTemplate(t, user);
  }

  createTemplate(input) {
    const t = this._normalize(input, null);
    this.templates.set(t.id, t);
    this._save();
    return this._publicTemplate(t);
  }

  updateTemplate(id, input) {
    const existing = this.templates.get(id);
    if (!existing) throw new Error('workspace not found');
    const merged = this._normalize({ ...input, id }, existing);
    this.templates.set(id, merged);
    this._save();
    return this._publicTemplate(merged);
  }

  async deleteTemplate(id) {
    if (this.instances.get(id)) {
      try {
        await this.stopInstance(id);
      } catch {
        /* stop failure shouldn't block template deletion */
      }
    }
    this.templates.delete(id);
    this._save();
  }

  _normalize(input, existing) {
    const merged = { ...(existing || {}), ...(input || {}) };
    if (!merged.name || typeof merged.name !== 'string') {
      throw new Error('name is required');
    }
    if (!merged.image || typeof merged.image !== 'string') {
      throw new Error('image is required');
    }
    if (!merged.id) {
      merged.id =
        'ws_' +
        crypto.randomBytes(4).toString('hex') +
        '_' +
        String(merged.name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 24);
    }
    merged.internalPort = Number(merged.internalPort) || 6901;
    merged.useHttps = merged.useHttps !== false;
    merged.resolution =
      typeof merged.resolution === 'string' && /^\d{3,4}x\d{3,4}$/.test(merged.resolution)
        ? merged.resolution
        : '1280x800';
    merged.shmSize =
      typeof merged.shmSize === 'string' && /^\d+[kmg]?b?$/i.test(merged.shmSize)
        ? merged.shmSize
        : '512m';
    merged.allowedUsers = Array.isArray(merged.allowedUsers)
      ? merged.allowedUsers.map(String)
      : [];
    if (merged.description != null) {
      merged.description = String(merged.description).slice(0, 300);
    }
    if (merged.env && typeof merged.env === 'object') {
      const clean = {};
      for (const [k, v] of Object.entries(merged.env)) {
        if (/^[A-Z_][A-Z0-9_]*$/i.test(k)) clean[k] = String(v);
      }
      merged.env = clean;
    } else {
      delete merged.env;
    }
    return merged;
  }

  getInstance(id) {
    return this.instances.get(id) || null;
  }

  instanceInfo(id) {
    const inst = this.instances.get(id);
    return inst ? inst.session.info() : null;
  }

  async startInstance(id) {
    const template = this.templates.get(id);
    if (!template) throw new Error('workspace not found');
    let inst = this.instances.get(id);
    if (inst) return inst.session.info();

    const session = new WorkspaceSession({
      workspaceId: template.id,
      image: template.image,
      internalPort: template.internalPort,
      useHttps: template.useHttps,
      resolution: template.resolution,
      shmSize: template.shmSize,
      env: template.env,
    });

    inst = { session, template, refCount: 0, idleTimer: null };
    this.instances.set(id, inst);

    session.on('exit', () => {
      const stillOurs = this.instances.get(id) === inst;
      if (stillOurs) this.instances.delete(id);
      if (inst.idleTimer) {
        clearTimeout(inst.idleTimer);
        inst.idleTimer = null;
      }
      this.emit('exit', { id });
    });
    session.on('ready', () =>
      this.emit('ready', { id, info: session.info() }),
    );

    try {
      await session.start();
    } catch (err) {
      this.instances.delete(id);
      throw err;
    }
    // Fresh instance with no viewers yet — arm the idle-reap countdown.
    this._resetIdleTimer(id);
    this.emit('started', { id, info: session.info() });
    return session.info();
  }

  async stopInstance(id) {
    const inst = this.instances.get(id);
    if (!inst) return;
    if (inst.idleTimer) {
      clearTimeout(inst.idleTimer);
      inst.idleTimer = null;
    }
    await inst.session.stop();
  }

  // Refcount is bumped per attached viewer. Zero viewers arms the idle timer;
  // any new viewer disarms it.
  acquire(id) {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.refCount += 1;
    if (inst.idleTimer) {
      clearTimeout(inst.idleTimer);
      inst.idleTimer = null;
    }
  }

  release(id) {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.refCount = Math.max(0, inst.refCount - 1);
    if (inst.refCount === 0) this._resetIdleTimer(id);
  }

  _resetIdleTimer(id) {
    const inst = this.instances.get(id);
    if (!inst || inst.refCount > 0) return;
    if (inst.idleTimer) clearTimeout(inst.idleTimer);
    inst.idleTimer = setTimeout(() => {
      this.stopInstance(id).catch((err) =>
        console.error(
          `[shellHelper] workspace ${id} idle-stop failed: ${err.message}`,
        ),
      );
    }, this.idleTimeoutMs);
    inst.idleTimer.unref && inst.idleTimer.unref();
  }

  async shutdown() {
    const stops = [];
    for (const id of Array.from(this.instances.keys())) {
      stops.push(this.stopInstance(id).catch(() => {}));
    }
    await Promise.all(stops);
  }
}

module.exports = WorkspaceManager;
