import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CREDENTIAL_ENCRYPTION_VERSION = 1;
const ALGORITHM = "aes-256-gcm";

export interface EncryptedCredential {
  encryptionVersion: typeof CREDENTIAL_ENCRYPTION_VERSION;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Railway-only key material. This module never reads process.env and never logs plaintext. */
export function encryptCredential(plaintext: string, masterKey: Buffer): EncryptedCredential {
  if (masterKey.length !== 32) throw new Error("credential_master_key_length");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    encryptionVersion: CREDENTIAL_ENCRYPTION_VERSION,
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
  };
}

export function decryptCredential(secret: EncryptedCredential, masterKey: Buffer): string {
  if (masterKey.length !== 32 || secret.encryptionVersion !== CREDENTIAL_ENCRYPTION_VERSION) {
    throw new Error("credential_decrypt_refused");
  }
  const decipher = createDecipheriv(ALGORITHM, masterKey, secret.iv);
  decipher.setAuthTag(secret.authTag);
  return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString("utf8");
}

export function publicConnectionView<T extends Record<string, unknown>>(value: T): Omit<T, "encryptedPrivateKey" | "privateKey" | "privateKeyIv" | "privateKeyAuthTag"> {
  const copy = { ...value };
  delete copy.encryptedPrivateKey;
  delete copy.privateKey;
  delete copy.privateKeyIv;
  delete copy.privateKeyAuthTag;
  return copy;
}
