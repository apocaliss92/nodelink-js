import crypto from "node:crypto";

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function hashPassword(
  password: string,
  saltBase64?: string,
): {
  saltBase64: string;
  hashBase64: string;
} {
  const salt = saltBase64
    ? Buffer.from(saltBase64, "base64")
    : crypto.randomBytes(16);

  const hash = crypto.scryptSync(password, salt, 32);
  return {
    saltBase64: salt.toString("base64"),
    hashBase64: hash.toString("base64"),
  };
}

export function verifyPassword(
  password: string,
  saltBase64: string,
  hashBase64: string,
): boolean {
  const computed = hashPassword(password, saltBase64).hashBase64;
  return timingSafeEqualString(computed, hashBase64);
}
