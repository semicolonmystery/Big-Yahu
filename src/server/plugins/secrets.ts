import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

let cachedKey: Buffer | null = null;

/**
 * PLUGIN_ENV_KEY if it is set, otherwise a key generated once and kept beside
 * the database. Losing the key means the stored values cannot be read back, so
 * anyone moving the deployment should carry it across explicitly.
 */
function key(): Buffer {
  if (cachedKey) return cachedKey;

  const configured = process.env.PLUGIN_ENV_KEY?.trim();
  if (configured) {
    const parsed = Buffer.from(configured, 'hex');
    if (parsed.length !== KEY_BYTES) {
      throw new Error(`PLUGIN_ENV_KEY must be ${KEY_BYTES} bytes of hex (${KEY_BYTES * 2} characters)`);
    }
    cachedKey = parsed;
    return parsed;
  }

  const keyPath = path.join(path.dirname(path.resolve(env.sqlitePath)), '.plugin-env-key');
  if (fs.existsSync(keyPath)) {
    cachedKey = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
    return cachedKey;
  }

  const generated = randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, generated.toString('hex'), { mode: 0o600 });
  console.warn(`[plugins] generated a plugin secret key at ${keyPath} — back it up, or set PLUGIN_ENV_KEY`);
  cachedKey = generated;
  return generated;
}

/** iv:tag:ciphertext, all hex. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':');
}

export function decryptSecret(stored: string): string {
  const [iv, tag, payload] = stored.split(':');
  if (!iv || !tag || !payload) throw new Error('Stored secret is malformed');
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(payload, 'hex')), decipher.final()]).toString('utf8');
}
