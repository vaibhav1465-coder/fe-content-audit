// api/_verifyToken.js
import crypto from "crypto";

export function verifyToken(authHeader) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return { valid: false, reason: "Server misconfigured: SESSION_SECRET not set." };

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { valid: false, reason: "Missing Authorization header." };
  }

  const token = authHeader.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "Malformed token." };

  const [expiresAtStr, signature] = parts;
  const expectedSignature = crypto.createHmac("sha256", secret).update(expiresAtStr).digest("hex");

  const sigBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expectedSignature, "hex");
  const sigValid = sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);

  if (!sigValid) return { valid: false, reason: "Invalid token signature." };

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return { valid: false, reason: "Session expired. Log in again." };
  }

  return { valid: true };
}
