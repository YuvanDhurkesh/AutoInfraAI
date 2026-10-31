import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function deriveKey(encryptionKey: string): Buffer {
  // ENCRYPTION_KEY is a 32+ byte hex/utf8 string from .env; hash it down to a
  // deterministic 32-byte AES-256 key regardless of the input's exact length
  // or encoding. Swap this for a KMS data-key call later without touching
  // callers (Sec. 4).
  return crypto.createHash("sha256").update(encryptionKey).digest();
}

/** `v1:<ivHex>:<authTagHex>:<ciphertextHex>` */
export function encryptSecret(plaintext: string, encryptionKey: string): string {
  const key = deriveKey(encryptionKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(stored: string, encryptionKey: string): string {
  const [version, ivHex, authTagHex, ciphertextHex] = stored.split(":");
  if (version !== "v1" || !ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Unrecognized encrypted secret format");
  }
  const key = deriveKey(encryptionKey);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
