// api/auth.js
import crypto from "crypto";

const SESSION_HOURS = 12;

function signToken(expiresAt, secret) {
  const payload = String(expiresAt);
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const appPassword = process.env.APP_PASSWORD;
  const tokenSecret = process.env.SESSION_SECRET;

  if (!appPassword || !tokenSecret) {
    return res.status(500).json({ error: "Server misconfigured: APP_PASSWORD or SESSION_SECRET not set." });
  }

  const { password } = req.body || {};
  if (typeof password !== "string" || password.length === 0) {
    return res.status(400).json({ error: "Password required." });
  }

  const a = Buffer.from(password);
  const b = Buffer.from(appPassword);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!match) return res.status(401).json({ error: "Incorrect password." });

  const expiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const token = signToken(expiresAt, tokenSecret);

  return res.status(200).json({ token, expiresAt });
}
