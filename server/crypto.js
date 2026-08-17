'use strict';

const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const IV_LEN = 12;

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(plaintext, secret) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, deriveKey(secret), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(payload, secret) {
  if (!payload) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('unsupported ciphertext format');
  }
  const [, ivB, tagB, encB] = parts;
  const iv = Buffer.from(ivB, 'base64');
  const tag = Buffer.from(tagB, 'base64');
  const enc = Buffer.from(encB, 'base64');
  const decipher = crypto.createDecipheriv(ALG, deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
