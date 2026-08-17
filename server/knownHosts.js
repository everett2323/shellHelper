'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOSTS_FILE =
  process.env.KNOWN_HOSTS_FILE ||
  path.join(__dirname, '..', 'data', 'known_hosts.json');

/**
 * Trust-on-first-use store of SSH host keys. First successful connection to a
 * host pins its public key fingerprint; any subsequent mismatch is rejected
 * (matching OpenSSH's StrictHostKeyChecking=yes behavior after TOFU).
 */
class KnownHostStore {
  constructor() {
    fs.mkdirSync(path.dirname(HOSTS_FILE), { recursive: true });
    this.hosts = {};
    if (fs.existsSync(HOSTS_FILE)) {
      try {
        this.hosts = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')) || {};
      } catch {
        this.hosts = {};
      }
    }
  }

  _key(host, port) {
    return `${host}:${port || 22}`;
  }

  _fingerprint(publicKey) {
    const buf = Buffer.isBuffer(publicKey)
      ? publicKey
      : Buffer.from(publicKey);
    return 'SHA256:' + crypto.createHash('sha256').update(buf).digest('base64');
  }

  get(host, port) {
    return this.hosts[this._key(host, port)] || null;
  }

  trust(host, port, publicKey) {
    this.hosts[this._key(host, port)] = {
      fingerprint: this._fingerprint(publicKey),
      trustedAt: new Date().toISOString(),
    };
    this._save();
  }

  forget(host, port) {
    delete this.hosts[this._key(host, port)];
    this._save();
  }

  /**
   * @returns {{status:'match'|'unknown'|'mismatch', fingerprint:string, trusted?:string}}
   */
  verify(host, port, publicKey) {
    const fp = this._fingerprint(publicKey);
    const rec = this.get(host, port);
    if (!rec) return { status: 'unknown', fingerprint: fp };
    if (rec.fingerprint === fp) return { status: 'match', fingerprint: fp };
    return {
      status: 'mismatch',
      fingerprint: fp,
      trusted: rec.fingerprint,
    };
  }

  list() {
    return Object.entries(this.hosts).map(([hostKey, rec]) => ({
      host: hostKey,
      fingerprint: rec.fingerprint,
      trustedAt: rec.trustedAt,
    }));
  }

  _save() {
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(this.hosts, null, 2), {
      mode: 0o600,
    });
    try {
      fs.chmodSync(HOSTS_FILE, 0o600);
    } catch {
      /* best effort */
    }
  }
}

module.exports = { KnownHostStore, HOSTS_FILE };
