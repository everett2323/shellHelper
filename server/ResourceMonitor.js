'use strict';

const EventEmitter = require('events');
const os = require('os');
const path = require('path');
const si = require('systeminformation');
const pidusage = require('pidusage');
const { Client: SshClient } = require('ssh2');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_INTERVAL_MS = 2500;
const CONTEXT_INTERVAL_MS = 3000;
const HISTORY_LEN = 60; // ~2.5 min at 2.5s

/**
 * Polls host and per-service resource metrics.
 *
 *   'host'    -> host-wide snapshot (broadcast to every authed socket)
 *   'service' -> per-service metrics (LOCAL only — pidusage of the pid tree);
 *                emitted continuously so the sidebar sparklines stay warm.
 *   'context' -> on-demand metrics for whichever service the UI is currently
 *                viewing, including SSH remotes and Docker containers. Enabled
 *                per service via {@link watchContext} / {@link unwatchContext}.
 *
 * Context polling for SSH runs a tiny bash snippet over a per-service SSH
 * connection (kept warm, reopened on failure). For Docker it uses the same
 * dockerode instance the session used.
 */
class ResourceMonitor extends EventEmitter {
  constructor({ taskManager, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    super();
    this.taskManager = taskManager;
    this.intervalMs = intervalMs;
    this.hostHistory = { cpu: [], mem: [] };
    this.serviceHistory = new Map();
    this._timer = null;
    this._busy = false;
    this._lastHost = null;

    // Per-service context tracking. Multiple viewers of the same service share
    // a single poller (refcounted).
    this.contexts = new Map(); // id -> { refs, timer, history, ssh, prevCpu, ... }
  }

  start() {
    if (this._timer) return;
    this._tick().catch(() => {});
    this._timer = setInterval(() => this._tick().catch((err) => {
      console.error('[ResourceMonitor]', err.message);
    }), this.intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    for (const id of Array.from(this.contexts.keys())) this._teardownContext(id);
  }

  getLastHost() {
    return this._lastHost;
  }

  /**
   * Request per-service context metrics. Refcounted so N viewers = 1 poller.
   * Returns the context type (`local` / `ssh` / `docker` / `none`) so callers
   * can UI-differentiate ("no metrics available for this type").
   */
  watchContext(serviceId) {
    const entry = this.taskManager.services.get(serviceId);
    if (!entry) return 'none';
    const type = entry.definition.type;
    if (!['local', 'ssh', 'docker'].includes(type)) return 'none';

    let ctx = this.contexts.get(serviceId);
    if (ctx) {
      ctx.refs += 1;
      // Push the last snapshot immediately so a late joiner sees something.
      if (ctx.last) this.emit('context', ctx.last);
      return type;
    }
    ctx = {
      refs: 1,
      type,
      history: { cpu: [], mem: [] },
      timer: null,
      ssh: null,
      last: null,
      pending: false,
    };
    this.contexts.set(serviceId, ctx);
    // Fire once immediately, then on interval.
    this._pollContext(serviceId).catch(() => {});
    ctx.timer = setInterval(
      () => this._pollContext(serviceId).catch(() => {}),
      CONTEXT_INTERVAL_MS,
    );
    return type;
  }

  unwatchContext(serviceId) {
    const ctx = this.contexts.get(serviceId);
    if (!ctx) return;
    ctx.refs = Math.max(0, ctx.refs - 1);
    if (ctx.refs === 0) this._teardownContext(serviceId);
  }

  _teardownContext(serviceId) {
    const ctx = this.contexts.get(serviceId);
    if (!ctx) return;
    if (ctx.timer) clearInterval(ctx.timer);
    if (ctx.ssh) {
      try {
        ctx.ssh.end();
      } catch {
        /* noop */
      }
    }
    this.contexts.delete(serviceId);
  }

  async _tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      await Promise.all([this._pollHost(), this._pollServices()]);
    } finally {
      this._busy = false;
    }
  }

  async _pollHost() {
    const [load, mem, fs] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize().catch(() => []),
    ]);

    const cpuPercent = Math.round(load.currentLoad * 10) / 10;
    const memUsed = mem.active;
    const memTotal = mem.total;
    const memPercent = memTotal
      ? Math.round((memUsed / memTotal) * 1000) / 10
      : 0;

    const candidates = (fs || [])
      .filter((f) => f.mount && DATA_DIR.startsWith(f.mount))
      .sort((a, b) => b.mount.length - a.mount.length);
    const disk =
      candidates[0] ||
      (fs || []).find((f) => f.mount === '/') ||
      (fs || [])[0] ||
      null;

    this._push(this.hostHistory.cpu, cpuPercent);
    this._push(this.hostHistory.mem, memPercent);

    const snapshot = {
      timestamp: Date.now(),
      cpu: {
        percent: cpuPercent,
        cores: Array.isArray(load.cpus) ? load.cpus.length : os.cpus().length,
      },
      mem: { used: memUsed, total: memTotal, percent: memPercent },
      disk: disk
        ? {
            used: disk.used,
            size: disk.size,
            percent: Math.round(disk.use * 10) / 10,
            mount: disk.mount,
          }
        : null,
      uptime: os.uptime(),
      history: {
        cpu: this.hostHistory.cpu.slice(),
        mem: this.hostHistory.mem.slice(),
      },
    };
    this._lastHost = snapshot;
    this.emit('host', snapshot);
  }

  async _pollServices() {
    const targets = [];
    for (const [id, entry] of this.taskManager.services) {
      if (
        entry.session &&
        entry.session.pid &&
        entry.definition.type === 'local'
      ) {
        targets.push({ id, pid: entry.session.pid });
      }
    }

    for (const id of Array.from(this.serviceHistory.keys())) {
      if (!targets.find((t) => t.id === id)) this.serviceHistory.delete(id);
    }

    if (!targets.length) return;

    let stats;
    try {
      stats = await pidusage(targets.map((t) => t.pid));
    } catch {
      return;
    }

    for (const { id, pid } of targets) {
      const s = stats[pid];
      if (!s) continue;
      const cpu = Math.max(0, Math.round(s.cpu * 10) / 10);
      const mem = s.memory;

      let hist = this.serviceHistory.get(id);
      if (!hist) {
        hist = { cpu: [], mem: [] };
        this.serviceHistory.set(id, hist);
      }
      this._push(hist.cpu, cpu);
      this._push(hist.mem, mem);

      this.emit('service', {
        id,
        pid,
        timestamp: Date.now(),
        cpu,
        mem,
        history: { cpu: hist.cpu.slice(), mem: hist.mem.slice() },
      });
    }
  }

  // ------------------------------------------------------------------
  //   Context (per-tab) metrics
  // ------------------------------------------------------------------
  async _pollContext(serviceId) {
    const ctx = this.contexts.get(serviceId);
    if (!ctx || ctx.pending) return;
    const entry = this.taskManager.services.get(serviceId);
    if (!entry) return this._teardownContext(serviceId);

    ctx.pending = true;
    try {
      let snapshot;
      if (ctx.type === 'local') {
        snapshot = await this._pollLocalContext(serviceId, entry);
      } else if (ctx.type === 'ssh') {
        snapshot = await this._pollSshContext(serviceId, entry, ctx);
      } else if (ctx.type === 'docker') {
        snapshot = await this._pollDockerContext(serviceId, entry);
      }
      if (!snapshot) return;
      this._push(ctx.history.cpu, snapshot.cpuPercent || 0);
      this._push(ctx.history.mem, snapshot.memPercent || 0);
      snapshot.history = {
        cpu: ctx.history.cpu.slice(),
        mem: ctx.history.mem.slice(),
      };
      ctx.last = snapshot;
      this.emit('context', snapshot);
    } catch (err) {
      this.emit('context', {
        id: serviceId,
        contextType: ctx.type,
        timestamp: Date.now(),
        error: err.message || String(err),
        history: {
          cpu: ctx.history.cpu.slice(),
          mem: ctx.history.mem.slice(),
        },
      });
    } finally {
      ctx.pending = false;
    }
  }

  async _pollLocalContext(serviceId, entry) {
    const pid = entry.session && entry.session.pid;
    if (!pid) {
      return {
        id: serviceId,
        contextType: 'local',
        timestamp: Date.now(),
        state: 'stopped',
      };
    }
    let stats;
    try {
      stats = await pidusage(pid);
    } catch {
      return null;
    }
    const cpu = Math.max(0, Math.round(stats.cpu * 10) / 10);
    const mem = stats.memory;
    const totalMem = os.totalmem();
    return {
      id: serviceId,
      contextType: 'local',
      timestamp: Date.now(),
      state: 'running',
      pid,
      cpuPercent: cpu,
      memBytes: mem,
      memTotalBytes: totalMem,
      memPercent: totalMem
        ? Math.round((mem / totalMem) * 1000) / 10
        : 0,
    };
  }

  async _pollSshContext(serviceId, entry, ctx) {
    const cfg = this.taskManager.buildSshConfig(serviceId);
    if (!ctx.ssh || ctx.ssh._brokenAt) {
      await this._connectSsh(ctx, cfg, entry.definition);
    }
    const out = await this._sshExec(
      ctx.ssh,
      "LC_ALL=C top -bn1 2>/dev/null | head -5; echo '---MEM---'; cat /proc/meminfo 2>/dev/null | head -5; echo '---DISK---'; df -PkT / 2>/dev/null | tail -1; echo '---UP---'; cat /proc/uptime 2>/dev/null",
    );
    const parsed = parseLinuxStats(out);
    return {
      id: serviceId,
      contextType: 'ssh',
      timestamp: Date.now(),
      host: entry.definition.host,
      ...parsed,
    };
  }

  _connectSsh(ctx, cfg, def) {
    return new Promise((resolve, reject) => {
      const client = new SshClient();
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) {
          try {
            client.end();
          } catch {
            /* noop */
          }
          reject(err);
        } else {
          ctx.ssh = client;
          resolve();
        }
      };
      client.on('ready', () => done());
      client.on('error', (err) => {
        if (settled) {
          client._brokenAt = Date.now();
        } else done(err);
      });
      client.on('end', () => {
        client._brokenAt = Date.now();
      });
      client.on('close', () => {
        client._brokenAt = Date.now();
      });
      client.connect({
        host: cfg.host,
        port: cfg.port || 22,
        username: cfg.username,
        password: cfg.password,
        privateKey: cfg.privateKey,
        passphrase: cfg.passphrase,
        readyTimeout: 10_000,
        keepaliveInterval: 15_000,
      });
    });
  }

  _sshExec(client, cmd) {
    return new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = '';
        stream.on('data', (chunk) => (out += chunk.toString('utf8')));
        stream.stderr && stream.stderr.on('data', () => {});
        stream.on('close', () => resolve(out));
        stream.on('error', reject);
      });
    });
  }

  async _pollDockerContext(serviceId, entry) {
    const session = entry.session;
    if (!session || !session._docker || !session.containerId) {
      // No live session — attempt a one-shot stats call on the configured
      // container so the UI still shows something useful.
      let Docker;
      try {
        Docker = require('dockerode');
      } catch {
        throw new Error('dockerode not installed');
      }
      const docker = new Docker(entry.definition.dockerHost || undefined);
      const cid = entry.definition.containerId;
      if (!cid) throw new Error('containerId not configured');
      const stats = await docker
        .getContainer(cid)
        .stats({ stream: false });
      return formatDockerStats(serviceId, cid, stats, 'stopped');
    }
    const stats = await session._docker
      .getContainer(session.containerId)
      .stats({ stream: false });
    return formatDockerStats(serviceId, session.containerId, stats, 'running');
  }

  _push(arr, value) {
    arr.push(value);
    while (arr.length > HISTORY_LEN) arr.shift();
  }
}

// ------------------- helpers -------------------

function parseLinuxStats(text) {
  const sections = text.split(/---(?:MEM|DISK|UP)---/);
  const topOut = sections[0] || '';
  const memOut = sections[1] || '';
  const diskOut = sections[2] || '';
  const upOut = sections[3] || '';

  // %CPU from top's summary line ("Cpu(s):  1.2 us,  0.3 sy, ... 98.4 id, ...")
  let cpuPercent = 0;
  const cpuLine = topOut.match(/%?Cpu\(s\):[^\n]+/i);
  if (cpuLine) {
    const idle = cpuLine[0].match(/([0-9.]+)\s*id/);
    if (idle) cpuPercent = Math.max(0, 100 - parseFloat(idle[1]));
  }

  // Memory from /proc/meminfo
  const memKV = {};
  for (const line of memOut.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) memKV[m[1]] = Number(m[2]) * 1024;
  }
  const memTotal = memKV.MemTotal || 0;
  const memAvail = memKV.MemAvailable != null
    ? memKV.MemAvailable
    : (memKV.MemFree || 0) + (memKV.Buffers || 0) + (memKV.Cached || 0);
  const memUsed = Math.max(0, memTotal - memAvail);
  const memPercent = memTotal ? Math.round((memUsed / memTotal) * 1000) / 10 : 0;

  // df -PkT / -> filesystem, type, blocks, used, avail, capacity, mount
  let disk = null;
  const dfCols = (diskOut.trim().split(/\s+/) || []).filter(Boolean);
  if (dfCols.length >= 6) {
    const sizeK = Number(dfCols[2]);
    const usedK = Number(dfCols[3]);
    const capacity = String(dfCols[5]).replace('%', '');
    disk = {
      size: sizeK * 1024,
      used: usedK * 1024,
      percent: Number(capacity) || 0,
      mount: dfCols[6] || '/',
    };
  }

  const uptime = Number((upOut.trim().split(/\s+/)[0] || '0')) || 0;

  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memBytes: memUsed,
    memTotalBytes: memTotal,
    memPercent,
    disk,
    uptime,
  };
}

function formatDockerStats(serviceId, containerId, stats, state) {
  // Docker CPU delta math (see docker CLI's `docker stats` implementation).
  let cpuPercent = 0;
  try {
    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage -
      stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta =
      stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cores =
      (stats.cpu_stats.online_cpus ||
        (stats.cpu_stats.cpu_usage.percpu_usage || []).length) || 1;
    if (cpuDelta > 0 && sysDelta > 0) {
      cpuPercent = (cpuDelta / sysDelta) * cores * 100;
    }
  } catch {
    cpuPercent = 0;
  }
  const memUsage =
    (stats.memory_stats && stats.memory_stats.usage) || 0;
  // Docker's raw `usage` includes cache; subtract it for a "real" number.
  const cache =
    (stats.memory_stats &&
      stats.memory_stats.stats &&
      (stats.memory_stats.stats.cache ||
        stats.memory_stats.stats.inactive_file)) ||
    0;
  const memBytes = Math.max(0, memUsage - cache);
  const memTotal = (stats.memory_stats && stats.memory_stats.limit) || 0;
  const memPercent = memTotal ? Math.round((memBytes / memTotal) * 1000) / 10 : 0;

  return {
    id: serviceId,
    contextType: 'docker',
    timestamp: Date.now(),
    containerId,
    state,
    cpuPercent: Math.max(0, Math.round(cpuPercent * 10) / 10),
    memBytes,
    memTotalBytes: memTotal,
    memPercent,
    pids:
      (stats.pids_stats && stats.pids_stats.current) || null,
  };
}

module.exports = ResourceMonitor;
