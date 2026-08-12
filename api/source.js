import { verifyToken } from "./_verifyToken.js";

const PREPROD_WP_BASE = process.env.PREPROD_WP_BASE || "https://preprod.financialexpress.com/wp-json/wp/v2";
const PREPROD_COAUTHORS_BASE = process.env.PREPROD_COAUTHORS_BASE || "https://preprod.financialexpress.com/wp-json/coauthors/v1";

function jsonHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function buildUpstreamUrl(kind, query = {}) {
  const params = new URLSearchParams();
  const allowed = {
    categories: ["per_page", "page", "search", "slug"],
    posts: ["per_page", "page", "slug", "categories", "after", "before", "orderby", "order"],
    coauthors: ["include", "per_page"],
  };

  if (!allowed[kind]) {
    throw new Error("Unsupported source kind.");
  }

  allowed[kind].forEach((key) => {
    const value = query[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      params.set(key, String(value));
    }
  });

  if (kind === "coauthors") {
    return `${PREPROD_COAUTHORS_BASE}/coauthors?${params.toString()}`;
  }

  return `${PREPROD_WP_BASE}/${kind}?${params.toString()}`;
}

export default async function handler(req, res) {
  jsonHeaders(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const authResult = verifyToken(req.headers.authorization);
  if (!authResult.valid) return res.status(401).json({ error: authResult.reason });

  const kind = String(req.query.kind || "").trim().toLowerCase();
  if (!kind) return res.status(400).json({ error: "Missing source kind." });

  try {
    if (kind === "post") {
      const id = Number(req.query.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "A numeric post ID is required." });
      }
      const upstream = await fetch(`${PREPROD_WP_BASE}/posts/${id}`);
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.send(text);
    }

    const upstreamUrl = buildUpstreamUrl(kind, req.query);
    const upstream = await fetch(upstreamUrl);
    const text = await upstream.text();

    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    const total = upstream.headers.get("X-WP-Total");
    const totalPages = upstream.headers.get("X-WP-TotalPages");
    if (total) res.setHeader("X-WP-Total", total);
    if (totalPages) res.setHeader("X-WP-TotalPages", totalPages);

    return res.send(text);
  } catch (error) {
    return res.status(502).json({ error: "Could not reach the WordPress source.", detail: String(error).slice(0, 400) });
  }
}
