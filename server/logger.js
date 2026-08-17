'use strict';

const fs = require('fs');
const path = require('path');

const LOGS_DIR =
  process.env.LOGS_DIR || path.join(__dirname, '..', 'data', 'logs');
const MAX_LOG_BYTES = Number(process.env.MAX_LOG_BYTES) || 5 * 1024 * 1024;
const MAX_LOG_FILES = Number(process.env.MAX_LOG_FILES) || 3;

/**
 * Append-only writer for a single service's stdout/stderr, with size-based
 * rotation. Files rotate through `<id>.log.1`, `.2`, ... up to MAX_LOG_FILES.
 */
class ServiceLogger {
  constructor(serviceId) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    this.serviceId = serviceId;
    this.file = path.join(LOGS_DIR, `${serviceId}.log`);
    this.stream = null;
    this.bytesWritten = 0;
    this._open();
  }

  _open() {
    try {
      this.bytesWritten = fs.existsSync(this.file)
        ? fs.statSync(this.file).size
        : 0;
    } catch {
      this.bytesWritten = 0;
    }
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best effort */
    }
  }

  append(chunk) {
    if (!this.stream) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    if (this.bytesWritten + buf.length > MAX_LOG_BYTES) {
      this._rotate();
    }
    this.stream.write(buf);
    this.bytesWritten += buf.length;
  }

  _rotate() {
    try {
      if (this.stream) this.stream.end();
    } catch {
      /* noop */
    }
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const src = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const dst = `${this.file}.${i}`;
      if (fs.existsSync(src)) {
        try {
          fs.renameSync(src, dst);
        } catch {
          /* noop */
        }
      }
    }
    this._open();
    this.bytesWritten = 0;
  }

  tail(bytes = 64 * 1024) {
    if (!fs.existsSync(this.file)) return '';
    const stat = fs.statSync(this.file);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(this.file, 'r');
    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  close() {
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

function purgeLogs(serviceId) {
  for (let i = 0; i <= MAX_LOG_FILES; i++) {
    const p =
      i === 0
        ? path.join(LOGS_DIR, `${serviceId}.log`)
        : path.join(LOGS_DIR, `${serviceId}.log.${i}`);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* noop */
    }
  }
}

module.exports = { ServiceLogger, purgeLogs, LOGS_DIR };
