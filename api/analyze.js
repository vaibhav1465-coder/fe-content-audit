// api/analyze.js
// Protected: requires valid session token, rate-limited via Supabase,
// daily budget cap. Supports two analysis modes selected by the client.

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { verifyToken } from "./_verifyToken.js";

const SYSTEM_PROMPT_AUDIT = `You are the Elite SEO Content Quality & Core Algorithm Auditor for Financial Express. The primary audience is SEO leadership, and the secondary audience is editorial leadership. Evaluate ONLY what is actually present in the supplied article. Never guess, never flatter, never hallucinate, and never use outside conversational context.

GOOGLE CONTEXT: Helpful Content System is integrated into core ranking. Spam enforcement heavily targets scaled content abuse, site reputation abuse, and unoriginal aggregation. Your job is to identify whether the page is original, useful, trustworthy, and safe for the wider domain quality signal.

NON-NEGOTIABLE RULES:
1. Every criticism must be grounded in the supplied article.
2. Use specific evidence excerpts copied from the supplied headline, subheading, byline, or body text.
3. Do not claim a missing source, missing expertise, or missing case study unless the article truly does not show it.
4. Use a professional, leadership-ready tone. Critical is allowed. Insulting is forbidden.
5. Do not mention rankings, traffic gains, or external FE history unless it directly follows from the supplied PRD logic.
6. Output must match the JSON schema exactly. No markdown fences. No text outside JSON.

RETURN THIS EXACT JSON SHAPE:
{
  "page_classification": "Keep|Overhaul|De-index",
  "hcs_info_gain": {
    "mandate": "Google's mandate: Content must provide original reporting, research, or analysis, and must not leave users feeling they need to search again.",
    "findings": [
      {
        "title": "short title",
        "analysis": "2-4 sentence grounded analysis",
        "evidence": ["short verbatim excerpt 1", "short verbatim excerpt 2"]
      }
    ]
  },
  "eeat_trust": {
    "mandate": "Google's mandate: High-quality YMYL (Your Money or Your Life) content must be written by experts, cite authoritative primary sources, and demonstrate first-hand experience.",
    "findings": [
      {
        "title": "short title",
        "analysis": "2-4 sentence grounded analysis",
        "evidence": ["short verbatim excerpt 1", "short verbatim excerpt 2"]
      }
    ]
  },
  "spam_scaled_abuse": {
    "mandate": "Google's mandate: Pages must not be generated at scale to manipulate search rankings, nor should they lack depth, real examples, or specific data points.",
    "findings": [
      {
        "title": "short title",
        "analysis": "2-4 sentence grounded analysis",
        "evidence": ["short verbatim excerpt 1", "short verbatim excerpt 2"]
      }
    ]
  },
  "editorial_leadership_recommendation": {
    "summary": "2-4 sentence leadership-ready summary",
    "immediate_action_required": "short action line",
    "next_steps": ["clear next step 1", "clear next step 2", "clear next step 3"]
  }
}

QUALITY BAR:
- Each section must have 2 to 4 findings.
- Each finding must be materially different.
- Prefer depth over filler.
- If the article is strong in a section, say so directly and explain why with evidence.
- Use plain business language, not vague SEO jargon.`;

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const DAILY_BUDGET_CAP = Number(process.env.DAILY_REQUEST_CAP || 500);
const PER_MINUTE_LIMIT = Number(process.env.PER_MINUTE_LIMIT_PER_IP || 15);
const MAX_BODY_TEXT_CHARS = Number(process.env.MAX_BODY_TEXT_CHARS || 8000);
const MAX_ARTICLE_PAYLOAD_CHARS = Number(process.env.MAX_ARTICLE_PAYLOAD_CHARS || 12000);
const DEFAULT_STANDARD_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const DEFAULT_LOW_COST_MODEL = process.env.ANTHROPIC_LOW_COST_MODEL || "claude-haiku-4-5-20251001";
const DEFAULT_OPENAI_STANDARD_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const DEFAULT_OPENAI_LOW_COST_MODEL = process.env.OPENAI_LOW_COST_MODEL || "gpt-5.6-luna";

function stripToPlainText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fingerprintKey(apiKey) {
  if (!apiKey) return "missing";
  return createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 10);
}

function buildUserPrompt(article) {
  const headline = String(article.headline || "(missing)").slice(0, 500);
  const subheading = String(article.subheading || "(missing)").slice(0, 500);
  const byline = String(article.byline || "(unavailable from source API - do not treat this as evidence that the article has no byline)").slice(0, 200);
  const publishDate = String(article.publish_date || "(missing)").slice(0, 100);
  const segment = String(article.segment || "(missing)").slice(0, 100);
  const bodyText = String(article.body_text || "").slice(0, MAX_BODY_TEXT_CHARS);
  return `Headline: ${headline}\nSubheading: ${subheading}\nByline: ${byline}\nPublish date: ${publishDate}\nSegment: ${segment}\nBody text: ${bodyText}`;
}

function validateArticleInput(article) {
  if (!article || typeof article !== "object") return "Missing or invalid 'article' in request body.";
  const headline = String(article.headline || "").trim();
  const bodyText = String(article.body_text || "").trim();
  if (!headline) return "Article headline is required.";
  if (bodyText.length < 80) return "Article body is too short to analyse safely.";
  if (JSON.stringify(article).length > MAX_ARTICLE_PAYLOAD_CHARS) return "Article payload is too large.";
  return "";
}

function resolveAiConfig(provider, model, costProfile) {
  if (provider === "openai") {
    return {
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      model: model || (costProfile === "low" ? DEFAULT_OPENAI_LOW_COST_MODEL : DEFAULT_OPENAI_STANDARD_MODEL),
    };
  }
  return {
    provider: "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: model || (costProfile === "low" ? DEFAULT_LOW_COST_MODEL : DEFAULT_STANDARD_MODEL),
  };
}

async function requestAnthropicAnalysis({ apiKey, model, systemPrompt, article }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: buildUserPrompt(article) }],
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Upstream API error: ${errText.slice(0, 500)}`);
  }
  const data = await response.json();
  return {
    text: data.content?.find((b) => b.type === "text")?.text || "{}",
    usage: data.usage || null,
  };
}

async function requestOpenAiAnalysis({ apiKey, model, systemPrompt, article }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: buildUserPrompt(article) }],
        },
      ],
      max_output_tokens: 1000,
      store: false,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Upstream API error: ${errText.slice(0, 500)}`);
  }
  const data = await response.json();
  return {
    text: data.output_text || "{}",
    usage: data.usage || null,
  };
}

async function requestDeepAnalysis({ config, systemPrompt, article, repairText = "" }) {
  const prompt = repairText
    ? `${systemPrompt}\n\nYour previous answer was invalid for this exact schema. Repair it now. Keep the same grounded analysis, but return valid JSON only.\nPrevious invalid output:\n${repairText.slice(0, 4000)}`
    : systemPrompt;
  return config.provider === "openai"
    ? requestOpenAiAnalysis({ apiKey: config.apiKey, model: config.model, systemPrompt: prompt, article })
    : requestAnthropicAnalysis({ apiKey: config.apiKey, model: config.model, systemPrompt: prompt, article });
}

function normalizeEvidence(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function tokenOverlapScore(needle, haystack) {
  const needleTokens = normalizeEvidence(needle).split(" ").filter(Boolean);
  if (!needleTokens.length) return 0;
  const haystackTokens = new Set(normalizeEvidence(haystack).split(" ").filter(Boolean));
  const matched = needleTokens.filter((token) => haystackTokens.has(token)).length;
  return matched / needleTokens.length;
}

function isGroundedEvidence(item, articleText) {
  const normalized = normalizeEvidence(item);
  if (normalized.length < 8) return false;
  if (articleText.includes(normalized)) return true;
  return tokenOverlapScore(normalized, articleText) >= 0.8;
}

function normalizeFinding(finding) {
  if (!finding || typeof finding !== "object") return null;
  const evidence = Array.isArray(finding.evidence)
    ? finding.evidence
    : typeof finding.evidence === "string" && finding.evidence.trim()
      ? [finding.evidence.trim()]
      : [];
  return {
    title: String(finding.title || "").trim(),
    analysis: stripToPlainText(finding.analysis || ""),
    evidence: evidence.map((item) => stripToPlainText(item)).filter(Boolean).slice(0, 3),
  };
}

function normalizeSection(section, fallbackMandate) {
  if (!section || typeof section !== "object") {
    return { mandate: fallbackMandate, findings: [] };
  }
  const findings = Array.isArray(section.findings)
    ? section.findings.map(normalizeFinding).filter(Boolean).slice(0, 4)
    : [];
  return {
    mandate: stripToPlainText(section.mandate || fallbackMandate) || fallbackMandate,
    findings,
  };
}

function normalizeModelResult(result) {
  if (!result || typeof result !== "object") return null;
  const pageClassification = ["Keep", "Overhaul", "De-index"].includes(result.page_classification)
    ? result.page_classification
    : "Overhaul";
  const normalized = {
    page_classification: pageClassification,
    hcs_info_gain: normalizeSection(
      result.hcs_info_gain,
      "Google's mandate: Content must provide original reporting, research, or analysis, and must not leave users feeling they need to search again.",
    ),
    eeat_trust: normalizeSection(
      result.eeat_trust,
      "Google's mandate: High-quality YMYL (Your Money or Your Life) content must be written by experts, cite authoritative primary sources, and demonstrate first-hand experience.",
    ),
    spam_scaled_abuse: normalizeSection(
      result.spam_scaled_abuse,
      "Google's mandate: Pages must not be generated at scale to manipulate search rankings, nor should they lack depth, real examples, or specific data points.",
    ),
    editorial_leadership_recommendation: {
      summary: stripToPlainText(result.editorial_leadership_recommendation?.summary || ""),
      immediate_action_required: stripToPlainText(result.editorial_leadership_recommendation?.immediate_action_required || ""),
      next_steps: Array.isArray(result.editorial_leadership_recommendation?.next_steps)
        ? result.editorial_leadership_recommendation.next_steps.map((step) => stripToPlainText(step)).filter(Boolean).slice(0, 6)
        : [],
    },
  };
  return normalized;
}

function validateFinding(finding, articleText) {
  if (!finding || typeof finding !== "object") return false;
  if (typeof finding.title !== "string" || !finding.title.trim()) return false;
  if (typeof finding.analysis !== "string" || finding.analysis.trim().length < 20) return false;
  if (!Array.isArray(finding.evidence) || finding.evidence.length < 1 || finding.evidence.length > 3) return false;
  return finding.evidence.every((item) => isGroundedEvidence(item, articleText));
}

export function validateAnalysisResult(result, article) {
  if (!result || typeof result !== "object") return false;
  if (!["Keep", "Overhaul", "De-index"].includes(result.page_classification)) return false;
  const articleText = normalizeEvidence([article.headline, article.subheading, article.byline, article.body_text].join(" "));
  const sections = ["hcs_info_gain", "eeat_trust", "spam_scaled_abuse"];
  for (const sectionName of sections) {
    const section = result[sectionName];
    if (!section || typeof section !== "object") return false;
    if (typeof section.mandate !== "string" || !section.mandate.trim()) return false;
    if (!Array.isArray(section.findings) || section.findings.length < 1 || section.findings.length > 4) return false;
    if (!section.findings.every((finding) => validateFinding(finding, articleText))) return false;
  }
  const recommendation = result.editorial_leadership_recommendation;
  if (!recommendation || typeof recommendation !== "object") return false;
  if (typeof recommendation.summary !== "string" || recommendation.summary.trim().length < 20) return false;
  if (typeof recommendation.immediate_action_required !== "string" || !recommendation.immediate_action_required.trim()) return false;
  if (!Array.isArray(recommendation.next_steps) || recommendation.next_steps.length < 1 || recommendation.next_steps.length > 6) return false;
  if (!recommendation.next_steps.every((step) => typeof step === "string" && step.trim().length > 0)) return false;
  return true;
}

function tryRepairTruncatedJson(text) {
  let base = text;
  const quoteCount = (base.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) base += '"';
  const opens = (base.match(/\{/g) || []).length;
  const closes = (base.match(/\}/g) || []).length;
  const openBrackets = (base.match(/\[/g) || []).length;
  const closeBrackets = (base.match(/\]/g) || []).length;
  const needBraces = Math.max(0, opens - closes);
  const needBrackets = Math.max(0, openBrackets - closeBrackets);
  const candidates = [
    base + "}".repeat(needBraces) + "]".repeat(needBrackets),
    base + "}" + "]".repeat(needBrackets) + "}".repeat(Math.max(0, needBraces - 1)),
    base + "]".repeat(needBrackets) + "}".repeat(needBraces),
  ];
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (e) { /* try next */ }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const authResult = verifyToken(req.headers.authorization);
  if (!authResult.valid) return res.status(401).json({ error: authResult.reason });

  const article = req.body?.article;
  const aiProvider = req.body?.ai_provider === "openai" ? "openai" : "anthropic";
  const aiModel = typeof req.body?.ai_model === "string" ? req.body.ai_model.trim() : "";
  const costProfile = req.body?.cost_profile === "low" ? "low" : "standard";
  const articleError = validateArticleInput(article);
  if (articleError) return res.status(400).json({ error: articleError });

  if (!supabase) {
    return res.status(500).json({ error: "Rate limiting not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Refusing to process requests until this is set up." });
  }

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";

  const { data: withinRateLimit, error: rateLimitError } = await supabase.rpc("check_and_increment_rate_limit", { p_key: `analyze:${ip}`, p_window_seconds: 60, p_limit: PER_MINUTE_LIMIT });
  if (rateLimitError) return res.status(500).json({ error: "Rate limit check failed", detail: rateLimitError.message });
  if (!withinRateLimit) return res.status(429).json({ error: "Rate limit exceeded. Wait a minute and try again." });

  const { data: withinDailyCap, error: dailyCapError } = await supabase.rpc("check_and_increment_daily_cap", { p_cap: DAILY_BUDGET_CAP });
  if (dailyCapError) return res.status(500).json({ error: "Daily cap check failed", detail: dailyCapError.message });
  if (!withinDailyCap) return res.status(429).json({ error: `Daily request cap reached (${DAILY_BUDGET_CAP}/day). Resets at midnight UTC.` });

  const systemPrompt = SYSTEM_PROMPT_AUDIT;
  const config = resolveAiConfig(aiProvider, aiModel, costProfile);
  if (!config.apiKey) {
    return res.status(500).json({ error: `Server misconfigured: ${config.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} not set.` });
  }
  const configSignal = {
    provider: config.provider,
    model: config.model,
    key_fingerprint: fingerprintKey(config.apiKey),
    key_env: config.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
  };

  try {
    let upstream = await requestDeepAnalysis({ config, systemPrompt, article });
    let cleaned = String(upstream.text || "{}").replace(/```json|```/g, "").trim();
    let parsed = null;
    let repaired = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      repaired = tryRepairTruncatedJson(cleaned);
      if (repaired) parsed = repaired;
    }

    parsed = normalizeModelResult(parsed);

    if (!validateAnalysisResult(parsed, article)) {
      upstream = await requestDeepAnalysis({ config, systemPrompt, article, repairText: cleaned });
      cleaned = String(upstream.text || "{}").replace(/```json|```/g, "").trim();
      parsed = null;
      repaired = null;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        repaired = tryRepairTruncatedJson(cleaned);
        if (repaired) parsed = repaired;
      }
    }

    parsed = normalizeModelResult(parsed);

    if (!validateAnalysisResult(parsed, article)) {
      return res.status(502).json({
        error: "Analysis request failed",
        detail: "The selected model did not return the required audit format for this page after two attempts. Please retry the page.",
        config_signal: configSignal,
      });
    }

    parsed._usage = upstream.usage || null;
    parsed._model = config.model;
    parsed._cost_profile = costProfile;
    parsed._provider = config.provider;
    parsed._config_signal = configSignal;
    if (repaired) parsed._was_truncated = true;
    return res.status(200).json(parsed);
  } catch (e) {
    if (String(e).startsWith("Error: Upstream API error:")) {
      const detail = String(e).replace(/^Error: Upstream API error:\s*/, "").slice(0, 500);
      return res.status(502).json({
        error: "Analysis request failed",
        detail: `The selected model could not complete the audit (${detail.slice(0, 180)}).`,
        config_signal: configSignal,
      });
    }
    return res.status(500).json({
      error: "Analysis request failed",
      detail: "The analysis service hit an internal issue before a valid audit could be returned.",
      config_signal: configSignal,
    });
  }
}
