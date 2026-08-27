'use strict';

// Read-only git status snapshot + a small set of quick actions (pull, stash,
// fetch) for a service's working directory. Snapshots are cached and polled
// on demand — refcounted, so N viewers on the same service share one poller.

const EventEmitter = require('events');
const { execFile } = require('child_process');
const fs = require('fs');

const POLL_INTERVAL_MS = 12_000;
const GIT_TIMEOUT_MS = 6_000;

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? err.code : 0,
          stdout: stdout || '',
          stderr: stderr || (err ? err.message : ''),
        });
      },
    );
  });
}

async function snapshot(cwd) {
  if (!cwd) return { repo: false, reason: 'no working directory configured' };
  if (!fs.existsSync(cwd)) {
    return { repo: false, reason: 'working directory does not exist' };
  }
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { repo: false, reason: 'not a git repository' };
  }
  const [top, branch, status, upstream, lastCommit] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']),
    git(cwd, ['branch', '--show-current']),
    git(cwd, ['status', '--porcelain=v1']),
    git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    git(cwd, ['log', '-1', '--pretty=%h|%an|%ar|%s']),
  ]);
  const files = status.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
  let staged = 0,
    modified = 0,
    untracked = 0,
    conflicted = 0;
  for (const f of files) {
    if (f.code === '??') untracked += 1;
    else if (f.code.includes('U') || f.code === 'AA' || f.code === 'DD') conflicted += 1;
    else {
      if (f.code[0] !== ' ' && f.code[0] !== '?') staged += 1;
      if (f.code[1] !== ' ') modified += 1;
    }
  }
  let ahead = 0,
    behind = 0,
    hasUpstream = false;
  if (upstream.ok && upstream.stdout.trim()) {
    hasUpstream = true;
    const counts = await git(cwd, [
      'rev-list',
      '--left-right',
      '--count',
      'HEAD...@{u}',
    ]);
    if (counts.ok) {
      const parts = counts.stdout.trim().split(/\s+/);
      ahead = Number(parts[0]) || 0;
      behind = Number(parts[1]) || 0;
    }
  }
  let lastCommitInfo = null;
  if (lastCommit.ok && lastCommit.stdout.trim()) {
    const [sha, author, when, subject] = lastCommit.stdout.trim().split('|');
    lastCommitInfo = { sha, author, when, subject };
  }
  return {
    repo: true,
    root: top.stdout.trim(),
    branch: branch.stdout.trim() || '(detached)',
    upstream: hasUpstream ? upstream.stdout.trim() : null,
    ahead,
    behind,
    staged,
    modified,
    untracked,
    conflicted,
    clean: files.length === 0,
    files: files.slice(0, 200),
    lastCommit: lastCommitInfo,
    fetchedAt: new Date().toISOString(),
  };
}

class GitWatcher extends EventEmitter {
  constructor({ resolveCwd }) {
    super();
    // resolveCwd(id) -> absolute path or null. Kept as an injected callback
    // so we don't need to know the TaskManager service-def shape here.
    this._resolveCwd = resolveCwd;
    this.watched = new Map(); // id -> { refs, timer, latest }
  }

  latest(id) {
    const w = this.watched.get(id);
    return w ? w.latest : null;
  }

  async refresh(id) {
    const cwd = this._resolveCwd(id);
    const snap = await snapshot(cwd);
    const w = this.watched.get(id);
    if (w) w.latest = snap;
    this.emit('status', id, snap);
    return snap;
  }

  watch(id) {
    let w = this.watched.get(id);
    if (!w) {
      w = { refs: 0, timer: null, latest: null };
      this.watched.set(id, w);
      // First refresh immediately; subsequent ones on the poller.
      this.refresh(id).catch(() => {});
      w.timer = setInterval(() => {
        this.refresh(id).catch(() => {});
      }, POLL_INTERVAL_MS);
      w.timer.unref();
    }
    w.refs += 1;
  }

  unwatch(id) {
    const w = this.watched.get(id);
    if (!w) return;
    w.refs = Math.max(0, w.refs - 1);
    if (w.refs === 0) {
      if (w.timer) clearInterval(w.timer);
      this.watched.delete(id);
    }
  }

  stopAll() {
    for (const [, w] of this.watched) {
      if (w.timer) clearInterval(w.timer);
    }
    this.watched.clear();
  }

  async runAction(id, action) {
    const cwd = this._resolveCwd(id);
    if (!cwd) throw new Error('service has no working directory');
    if (!fs.existsSync(cwd)) throw new Error('working directory missing');
    const cmd = ACTIONS[action];
    if (!cmd) throw new Error('unknown git action: ' + action);
    const result = await git(cwd, cmd);
    // Refresh so callers see the resulting state immediately.
    const snap = await this.refresh(id);
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr, snapshot: snap };
  }
}

const ACTIONS = {
  pull: ['pull', '--ff-only'],
  fetch: ['fetch', '--all', '--prune'],
  stash: ['stash', 'push', '-u', '-m', 'shellHelper stash'],
  'stash-pop': ['stash', 'pop'],
};

module.exports = { GitWatcher, snapshot, ACTIONS: Object.keys(ACTIONS) };
