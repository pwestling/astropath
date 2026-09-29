import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

// v1: AES-256-GCM, 96-bit random nonce, 128-bit authentication tag.
// AAD binds every ciphertext to its tenant, record and purpose.
export function seal(
  key: Buffer,
  context: string,
  plaintext: Uint8Array,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `v1.${Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url")}`;
}

export function open(key: Buffer, context: string, ciphertext: string): Buffer {
  if (!ciphertext.startsWith("v1."))
    throw new Error("Unsupported ciphertext version");
  const bytes = Buffer.from(ciphertext.slice(3), "base64url");
  if (bytes.length < 28) throw new Error("Invalid ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}

export function masterKey() {
  const encoded = process.env.ASTROPATH_MASTER_KEY || "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new Error(
      "ASTROPATH_MASTER_KEY must be a base64-encoded 32-byte key",
    );
  return key;
}

export function newTenantKey(tenantId: string) {
  return seal(masterKey(), `tenant-key:${tenantId}`, randomBytes(32));
}

export function unwrapTenantKey(tenantId: string, wrapped: string) {
  return open(masterKey(), `tenant-key:${tenantId}`, wrapped);
}

export interface ContentCipher {
  fingerprint(context: string, value: string): string;
  encrypt(context: string, value: unknown): string;
  decrypt<T>(context: string, value: string): T;
  encryptBytes(context: string, value: Uint8Array): Buffer;
  decryptBytes(context: string, value: Uint8Array): Buffer;
}

export function contentCipher(tenantId: string, key: Buffer): ContentCipher {
  return {
    // Private lookup keys reveal equality within a tenant, not plaintext names.
    fingerprint: (context, value) =>
      createHmac("sha256", key)
        .update(JSON.stringify([tenantId, context, value]))
        .digest("hex"),
    encrypt: (context, value) =>
      seal(key, `${tenantId}:${context}`, Buffer.from(JSON.stringify(value))),
    decrypt: (context, value) =>
      JSON.parse(open(key, `${tenantId}:${context}`, value).toString("utf8")),
    encryptBytes: (context, value) =>
      Buffer.from(seal(key, `${tenantId}:${context}`, value)),
    decryptBytes: (context, value) =>
      open(key, `${tenantId}:${context}`, Buffer.from(value).toString("utf8")),
  };
}
