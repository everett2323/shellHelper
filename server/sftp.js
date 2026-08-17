'use strict';

const path = require('path');
const { Client } = require('ssh2');

/**
 * Opens a fresh SSH connection, runs `fn(sftp)`, and cleans up.
 * The connection is discarded after each operation so that SFTP work can't
 * bloat memory of long-lived interactive shells.
 */
function withSftp(config, hostVerifier, fn) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const settle = (err, val) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else resolve(val);
    };

    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) return settle(err);
        Promise.resolve()
          .then(() => fn(sftp))
          .then((result) => settle(null, result))
          .catch((e) => settle(e));
      });
    });
    client.on('error', (err) => settle(err));

    const connectOpts = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: 15_000,
    };
    if (config.privateKey) {
      connectOpts.privateKey = config.privateKey;
      if (config.passphrase) connectOpts.passphrase = config.passphrase;
    } else {
      connectOpts.password = config.password || '';
      connectOpts.tryKeyboard = true;
      client.on(
        'keyboard-interactive',
        (_n, _i, _l, _p, finish) => finish([config.password || '']),
      );
    }
    if (hostVerifier) connectOpts.hostVerifier = hostVerifier;

    client.connect(connectOpts);
  });
}

function normalizePath(p) {
  if (!p || p === '') return '.';
  // Reject clearly abusive things; we still trust the remote user knows their fs.
  if (p.includes('\0')) throw new Error('invalid path');
  return p;
}

async function list(config, verifier, remotePath) {
  const target = normalizePath(remotePath);
  return withSftp(
    config,
    verifier,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.readdir(target, (err, entries) => {
          if (err) return reject(err);
          const items = entries.map((entry) => ({
            name: entry.filename,
            isDir: entry.attrs.isDirectory(),
            isSymlink: entry.attrs.isSymbolicLink && entry.attrs.isSymbolicLink(),
            size: entry.attrs.size,
            mtime: entry.attrs.mtime * 1000,
            mode: entry.attrs.mode,
          }));
          items.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          resolve({ path: target, items });
        });
      }),
  );
}

async function stat(config, verifier, remotePath) {
  const target = normalizePath(remotePath);
  return withSftp(
    config,
    verifier,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.stat(target, (err, attrs) => {
          if (err) return reject(err);
          resolve({
            path: target,
            size: attrs.size,
            mtime: attrs.mtime * 1000,
            mode: attrs.mode,
            isDir: attrs.isDirectory(),
          });
        });
      }),
  );
}

/**
 * Downloads a file into `res` as a stream. Never buffers the whole file.
 */
function downloadTo(config, verifier, remotePath, res) {
  const target = normalizePath(remotePath);
  return withSftp(config, verifier, (sftp) => {
    return new Promise((resolve, reject) => {
      sftp.stat(target, (err, attrs) => {
        if (err) return reject(err);
        if (attrs.isDirectory()) {
          return reject(new Error('cannot download a directory'));
        }
        res.setHeader('Content-Length', String(attrs.size));
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(path.basename(target))}"`,
        );
        res.setHeader('Content-Type', 'application/octet-stream');
        const stream = sftp.createReadStream(target);
        stream.on('error', reject);
        stream.on('end', () => resolve());
        stream.pipe(res);
      });
    });
  });
}

/**
 * Consumes an incoming Readable (from busboy) and writes it to `remotePath`.
 */
function uploadFrom(config, verifier, remotePath, incoming) {
  const target = normalizePath(remotePath);
  return withSftp(config, verifier, (sftp) => {
    return new Promise((resolve, reject) => {
      const out = sftp.createWriteStream(target);
      let bytes = 0;
      incoming.on('data', (c) => (bytes += c.length));
      out.on('close', () => resolve({ path: target, bytes }));
      out.on('error', reject);
      incoming.on('error', reject);
      incoming.pipe(out);
    });
  });
}

async function mkdir(config, verifier, remotePath) {
  const target = normalizePath(remotePath);
  return withSftp(
    config,
    verifier,
    (sftp) =>
      new Promise((resolve, reject) =>
        sftp.mkdir(target, (err) => (err ? reject(err) : resolve({ path: target }))),
      ),
  );
}

async function unlink(config, verifier, remotePath) {
  const target = normalizePath(remotePath);
  return withSftp(
    config,
    verifier,
    (sftp) =>
      new Promise((resolve, reject) =>
        sftp.unlink(target, (err) => (err ? reject(err) : resolve({ path: target }))),
      ),
  );
}

async function rmdir(config, verifier, remotePath) {
  const target = normalizePath(remotePath);
  return withSftp(
    config,
    verifier,
    (sftp) =>
      new Promise((resolve, reject) =>
        sftp.rmdir(target, (err) => (err ? reject(err) : resolve({ path: target }))),
      ),
  );
}

module.exports = { list, stat, downloadTo, uploadFrom, mkdir, unlink, rmdir };
