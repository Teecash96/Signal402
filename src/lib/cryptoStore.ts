import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ENVELOPE_VERSION = 'signal402-aes256gcm-v1';
const KEY_LENGTH = 32;

function keyFromSecret(secret: string, salt: Buffer): Buffer {
  if (Buffer.byteLength(secret, 'utf8') < 16 || /^(replace-with|changeme|change-me|your[-_]|example[-_])/i.test(secret)) throw new Error('A strong encryption secret is required');
  return scryptSync(secret, salt, KEY_LENGTH, {
    N: 32_768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function encode(value: Buffer): string {
  return value.toString('base64url');
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** Encrypt a small local secret or JSON document with an authenticated envelope. */
export function encryptText(plaintext: string, secret: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(secret, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [ENVELOPE_VERSION, encode(salt), encode(iv), encode(cipher.getAuthTag()), encode(ciphertext)].join('.');
}

/** Decrypt and authenticate a local secret or JSON document. */
export function decryptText(envelope: string, secret: string): string {
  const parts = envelope.trim().split('.');
  if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Unsupported or unencrypted Signal402 data envelope');
  }
  const [, saltText, ivText, tagText, ciphertextText] = parts;
  const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(secret, decode(saltText)), decode(ivText));
  decipher.setAuthTag(decode(tagText));
  return Buffer.concat([decipher.update(decode(ciphertextText)), decipher.final()]).toString('utf8');
}
