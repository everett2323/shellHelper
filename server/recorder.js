'use strict';

const fs = require('fs');
const path = require('path');

const RECORDINGS_DIR =
  process.env.RECORDINGS_DIR ||
  path.join(__dirname, '..', 'data', 'recordings');

/**
 * asciinema v2 cast writer. Records terminal *output* only — deliberately not
 * user input, so keystrokes typed at non-echoing prompts (sudo passwords, etc.)
 * are never persisted.
 *
 * Spec: https://docs.asciinema.org/manual/asciicast/v2/
 */
class SessionRecorder {
  constructor(serviceId, opts = {}) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.serviceId = serviceId;
    this.filename = `${serviceId}__${ts}.cast`;
    this.filepath = path.join(RECORDINGS_DIR, this.filename);
    this.startedAt = Date.now();
    this.stream = fs.createWriteStream(this.filepath, { flags: 'w' });
    try {
      fs.chmodSync(this.filepath, 0o600);
    } catch {
      /* best effort */
    }
    const header = {
      version: 2,
      width: Math.max(2, Math.floor(opts.cols) || 120),
      height: Math.max(2, Math.floor(opts.rows) || 30),
      timestamp: Math.floor(this.startedAt / 1000),
      title: opts.title || serviceId,
      env: { TERM: 'xterm-256color', SHELL: opts.shell || '/bin/bash' },
    };
    this.stream.write(JSON.stringify(header) + '\n');
  }

  writeOutput(data) {
    if (!this.stream) return;
    const t = (Date.now() - this.startedAt) / 1000;
    this.stream.write(JSON.stringify([t, 'o', String(data)]) + '\n');
  }

  resize(cols, rows) {
    if (!this.stream) return;
    const t = (Date.now() - this.startedAt) / 1000;
    this.stream.write(
      JSON.stringify([t, 'r', `${Math.floor(cols)}x${Math.floor(rows)}`]) +
        '\n',
    );
  }

  end() {
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        /* noop */
      }
      this.stream = null;
    }
  }
}

function listRecordings(serviceId) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const files = fs.readdirSync(RECORDINGS_DIR);
  const prefix = `${serviceId}__`;
  return files
    .filter((f) => f.startsWith(prefix) && f.endsWith('.cast'))
    .map((f) => {
      const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
      return {
        name: f,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function safeRecordingPath(filename) {
  const safe = path.basename(String(filename || ''));
  if (!safe.endsWith('.cast')) return null;
  return path.join(RECORDINGS_DIR, safe);
}

function deleteRecording(filename) {
  const fp = safeRecordingPath(filename);
  if (!fp) throw new Error('invalid recording name');
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

module.exports = {
  SessionRecorder,
  listRecordings,
  safeRecordingPath,
  deleteRecording,
  RECORDINGS_DIR,
};
