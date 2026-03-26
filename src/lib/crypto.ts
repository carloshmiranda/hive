import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

/** Current key — used for all encryption and as first decryption attempt. */
function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  }
  return Buffer.from(key, "hex");
}

/** All keys: [current, ...old]. Old keys from ENCRYPTION_KEY_OLD (comma-separated). */
function getAllKeys(): Buffer[] {
  const keys = [getKey()];
  const old = process.env.ENCRYPTION_KEY_OLD;
  if (old) {
    for (const k of old.split(",")) {
      const trimmed = k.trim();
      if (trimmed.length === 64) {
        keys.push(Buffer.from(trimmed, "hex"));
      }
    }
  }
  return keys;
}

function decryptWithKey(payload: string, key: Buffer): string {
  const [ivHex, tagHex, encrypted] = payload.split(":");
  if (!ivHex || !tagHex || !encrypted) throw new Error("Invalid encrypted payload");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function encrypt(text: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return iv.toString("hex") + ":" + tag + ":" + encrypted;
}

/** Decrypt with current key, falling back to old keys. Throws DecryptionError if none work. */
export function decrypt(payload: string): string {
  const keys = getAllKeys();
  for (const key of keys) {
    try {
      return decryptWithKey(payload, key);
    } catch {
      continue;
    }
  }
  throw new DecryptionError(
    `No ENCRYPTION_KEY can decrypt this value. Check ENCRYPTION_KEY and ENCRYPTION_KEY_OLD env vars.`
  );
}

/**
 * Decrypt and auto-migrate: if an old key decrypted the value, re-encrypt with the current key.
 * Returns { plaintext } if current key worked, { plaintext, migrated } if old key worked.
 */
export function decryptAndMigrate(payload: string): { plaintext: string; migrated?: string } {
  const keys = getAllKeys();
  for (let i = 0; i < keys.length; i++) {
    try {
      const plaintext = decryptWithKey(payload, keys[i]);
      if (i === 0) return { plaintext };
      return { plaintext, migrated: encrypt(plaintext) };
    } catch {
      continue;
    }
  }
  throw new DecryptionError(
    `No ENCRYPTION_KEY can decrypt this value. Check ENCRYPTION_KEY and ENCRYPTION_KEY_OLD env vars.`
  );
}
