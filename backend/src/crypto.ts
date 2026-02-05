import crypto from 'node:crypto';

/**
 * Encrypts/decrypts short secrets (tokens) using AES-256-GCM.
 *
 * Key format: base64 encoded 32 bytes.
 */

function getKeyBytes(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be base64 encoded 32 bytes');
  }
  return key;
}

export function encryptIfConfigured(plain: string, keyBase64?: string): string {
  if (!keyBase64) return plain;
  const key = getKeyBytes(keyBase64);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // format: v1:<iv>:<tag>:<ciphertext> (base64)
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptIfConfigured(value: string, keyBase64?: string): string {
  if (!keyBase64) return value;
  if (!value.startsWith('v1:')) return value; // legacy/plaintext

  const parts = value.split(':');
  if (parts.length !== 4) throw new Error('Invalid encrypted token format');

  const [, ivB64, tagB64, ctB64] = parts;
  const key = getKeyBytes(keyBase64);
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString('utf8');
}

