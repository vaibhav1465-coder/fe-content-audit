// api/analyze.js
// Protected: requires valid session token, rate-limited via Supabase,
// daily budget cap. Supports two analysis modes selected by the client.

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { verifyToken } from "./_verifyToken.js";

const SYSTEM_PROMPT_AUDIT = `You are the FE Content Portfolio Audit and Remediation System, adapted from the FE Master Prompt v4.0 package.

You are auditing a Financial Express article for:
1. Helpful Content System and information gain
2. E-E-A-T and trust
3. Google spam / scaled abuse risk
4. Editorial action recommendation

Critical rules:
- Evaluate ONLY what is present in the supplied article package.
- No web browsing. No external fetching assumptions.
- Never invent quotes, credentials, or sources.
- If evidence is unavailable, say it is unavailable instead of guessing.
- Be practical, direct, and editorially useful.
- Focus on genuine recommendations first, rigid formatting second.

Data availability rules:
- If full article text is provided, treat as FULL.
- If only short summary/excerpt exists, treat as SUMMARY and avoid quote-heavy claims.
- If only metadata exists, mark limitations clearly.

Use FE v4.0 logic:
- Assign a tier: T1 / T2 / T3
- Use one action tag only: [ACTION: RETAIN], [ACTION: REWORK], [ACTION: NOINDEX], [ACTION: DELETE — 410], [ACTION: 301 REDIRECT], or [NOT APPLICABLE]
- Flag unscorable content only when truly necessary
- Use the rework priority sequence where relevant:
  1. Data clarity
  2. Headline & excerpt
  3. Freshness
  4. Strengthen YMYL trust
  5. Source conflicts
  6. Original reporting
  7. Author credentials

Return plain text in this exact structure:

TIER: T1|T2|T3
DATA AVAILABILITY: FULL|SUMMARY|METADATA ONLY
UNSCORABLE: NONE | [UNSCORABLE: ...]
ACTION TAG: [ACTION: RETAIN|REWORK|NOINDEX|DELETE — 410|301 REDIRECT|NOT APPLICABLE]

HCS & INFORMATION GAIN
Core Issue: one-line finding
Evidence: grounded evidence from the article, or [Quote unavailable — summary input]
Verdict: Pass|Partial|Fail
Analysis: 2-4 sentence practical explanation

E-E-A-T & TRUST
Core Issue: one-line finding
Evidence: grounded evidence from the article, or [Unverifiable]
Verdict: Pass|Partial|Fail
Analysis: 2-4 sentence practical explanation

GOOGLE SPAM POLICIES
Core Issue: one-line finding
Evidence: grounded evidence from the article
Verdict: Pass|Partial|Fail
Analysis: 2-4 sentence practical explanation

EDITORIAL RECOMMENDATION
Core Issue: one-line summary
Ideally: short action line
Editorial Flag: optional one-line note, or NONE
Next steps:
1. clear next step
2. clear next step
3. clear next step`;


let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const DAILY_BUDGET_CAP = Number(process.env.DAILY_REQUEST_CAP || 500);
const PER_MINUTE_LIMIT = Number(process.env.PER_MINUTE_LIMIT_PER_IP || 15);
const MAX_BODY_TEXT_CHARS = Number(process.env.MAX_BODY_TEXT_CHARS || 6000);
const MAX_ARTICLE_PAYLOAD_CHARS = Number(process.env.MAX_ARTICLE_PAYLOAD_CHARS || 9000);
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
  const dataAvailability = deriveDataAvailability(article);
  return `Headline: ${headline}\nSubheading: ${subheading}\nByline: ${byline}\nPublish date: ${publishDate}\nSegment: ${segment}\nData availability: ${dataAvailability}\nBody text: ${bodyText}`;
}

function buildFormatterPrompt(article, rawDraft) {
  return `${buildUserPrompt(article)}\n\nRaw audit draft to salvage and reformat:\n${String(rawDraft || "").slice(0, 5000)}`;
}

function deriveDataAvailability(article) {
  const bodyLength = String(article?.body_text || "").trim().length;
  if (bodyLength >= 500) return "FULL";
  if (bodyLength >= 100) return "SUMMARY";
  return "METADATA ONLY";
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

async function fetchWithTimeout(url, options, timeoutMs = 22000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestAnthropicAnalysis({ apiKey, model, systemPrompt, article, userPrompt, maxTokens = 1100 }) {
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt || buildUserPrompt(article) }],
    }),
  }, 22000);
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

async function requestOpenAiAnalysis({ apiKey, model, systemPrompt, article, userPrompt, maxTokens = 1100 }) {
  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
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
          content: [{ type: "input_text", text: userPrompt || buildUserPrompt(article) }],
        },
      ],
      max_output_tokens: maxTokens,
      store: false,
    }),
  }, 22000);
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

async function requestDeepAnalysis({ config, systemPrompt, article, repairText = "", userPrompt = "", maxTokens = 1100 }) {
  const prompt = repairText
    ? `${systemPrompt}\n\nYour previous answer was invalid for this exact schema. Repair it now. Keep the same grounded analysis, but return valid JSON only.\nPrevious invalid output:\n${repairText.slice(0, 4000)}`
    : systemPrompt;
  return config.provider === "openai"
    ? requestOpenAiAnalysis({ apiKey: config.apiKey, model: config.model, systemPrompt: prompt, article, userPrompt, maxTokens })
    : requestAnthropicAnalysis({ apiKey: config.apiKey, model: config.model, systemPrompt: prompt, article, userPrompt, maxTokens });
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

function mapActionTagToClassification(actionTag) {
  const tag = String(actionTag || "").toUpperCase();
  if (tag.includes("RETAIN")) return "Keep";
  if (tag.includes("REWORK")) return "Overhaul";
  if (tag.includes("NOINDEX") || tag.includes("DELETE") || tag.includes("301 REDIRECT")) return "De-index";
  return "Overhaul";
}

function normalizeModelResult(result) {
  if (!result || typeof result !== "object") return null;
  const pageClassification = ["Keep", "Overhaul", "De-index"].includes(result.page_classification)
    ? result.page_classification
    : mapActionTagToClassification(result.action_tag);
  const normalized = {
    page_classification: pageClassification,
    action_tag: stripToPlainText(result.action_tag || ""),
    tier: stripToPlainText(result.tier || ""),
    data_availability: stripToPlainText(result.data_availability || ""),
    unscorable: stripToPlainText(result.unscorable || "NONE"),
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
      editorial_flag: stripToPlainText(result.editorial_leadership_recommendation?.editorial_flag || "NONE"),
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

function extractJsonCandidate(text) {
  const raw = String(text || "").replace(/```json|```/gi, "").trim();
  if (!raw) return "";
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }
  return raw;
}

function parseCandidateJson(text) {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return { parsed: null, repaired: false, cleaned: "" };
  try {
    return { parsed: JSON.parse(candidate), repaired: false, cleaned: candidate };
  } catch {
    const repaired = tryRepairTruncatedJson(candidate);
    return { parsed: repaired, repaired: Boolean(repaired), cleaned: candidate };
  }
}

function parseNaturalAuditToResult(text) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw) return null;
  const tier = raw.match(/TIER:\s*(T1|T2|T3)/i)?.[1] || "";
  const dataAvailability = raw.match(/DATA AVAILABILITY:\s*(FULL|SUMMARY|METADATA ONLY)/i)?.[1] || "";
  const unscorable = raw.match(/UNSCORABLE:\s*(.+)/i)?.[1]?.trim() || "NONE";
  const actionTag = raw.match(/ACTION TAG:\s*(.+)/i)?.[1]?.trim() || "[ACTION: REWORK]";
  const sectionChunk = (start, endList) => {
    const startRegex = new RegExp(start, "i");
    const startMatch = raw.match(startRegex);
    if (!startMatch || startMatch.index === undefined) return "";
    const from = startMatch.index + startMatch[0].length;
    let to = raw.length;
    for (const end of endList) {
      const endRegex = new RegExp(end, "i");
      const slice = raw.slice(from);
      const endMatch = slice.match(endRegex);
      if (endMatch && endMatch.index !== undefined) {
        to = Math.min(to, from + endMatch.index);
      }
    }
    return raw.slice(from, to).trim();
  };
  const parseFindings = (chunk) => {
    if (!chunk) return [];
    const title = chunk.match(/Core Issue:\s*([\s\S]*?)(?:\nEvidence:|$)/i)?.[1]?.trim() || "Audit finding";
    const evidenceLine = chunk.match(/Evidence:\s*([\s\S]*?)(?:\nVerdict:|$)/i)?.[1]?.trim() || "";
    const verdict = chunk.match(/Verdict:\s*(Pass|Partial|Fail)/i)?.[1]?.trim() || "";
    const analysis = chunk.match(/Analysis:\s*([\s\S]*?)$/i)?.[1]?.trim() || "";
    const evidence = evidenceLine
      ? evidenceLine.split(/\s*\|\s*|;\s*/).map((part) => stripToPlainText(part)).filter(Boolean).slice(0, 3)
      : [];
    const combinedAnalysis = [verdict ? `Verdict: ${verdict}.` : "", analysis].filter(Boolean).join(" ");
    return combinedAnalysis || title ? [{ title, analysis: combinedAnalysis || title, evidence }] : [];
  };

  const hcsChunk = sectionChunk("HCS\\s*&\\s*INFORMATION\\s*GAIN", ["E-E-A-T\\s*&\\s*TRUST", "GOOGLE\\s*SPAM\\s*POLICIES", "EDITORIAL\\s*RECOMMENDATION"]);
  const eeatChunk = sectionChunk("E-E-A-T\\s*&\\s*TRUST", ["GOOGLE\\s*SPAM\\s*POLICIES", "EDITORIAL\\s*RECOMMENDATION"]);
  const spamChunk = sectionChunk("GOOGLE\\s*SPAM\\s*POLICIES", ["EDITORIAL\\s*RECOMMENDATION"]);
  const recommendationChunk = sectionChunk("EDITORIAL\\s*RECOMMENDATION", []);

  return normalizeModelResult({
    action_tag: actionTag,
    tier,
    data_availability: dataAvailability,
    unscorable,
    hcs_info_gain: {
      mandate: "Google's mandate: Content must provide original reporting, research, or analysis, and must not leave users feeling they need to search again.",
      findings: parseFindings(hcsChunk),
    },
    eeat_trust: {
      mandate: "Google's mandate: High-quality YMYL (Your Money or Your Life) content must be written by experts, cite authoritative primary sources, and demonstrate first-hand experience.",
      findings: parseFindings(eeatChunk),
    },
    spam_scaled_abuse: {
      mandate: "Google's mandate: Pages must not be generated at scale to manipulate search rankings, nor should they lack depth, real examples, or specific data points.",
      findings: parseFindings(spamChunk),
    },
    editorial_leadership_recommendation: {
      summary: recommendationChunk.match(/Core Issue:\s*([\s\S]*?)(?:\nIdeally:|$)/i)?.[1]?.trim() || "",
      immediate_action_required: recommendationChunk.match(/Ideally:\s*([\s\S]*?)(?:\nEditorial Flag:|$)/i)?.[1]?.trim() || "",
      editorial_flag: recommendationChunk.match(/Editorial Flag:\s*([\s\S]*?)(?:\nNext steps:|$)/i)?.[1]?.trim() || "NONE",
      next_steps: Array.from(recommendationChunk.matchAll(/\n?\s*\d+\.\s*(.+)/g)).map((match) => stripToPlainText(match[1])).filter(Boolean).slice(0, 6),
    },
  });
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
    let upstream = await requestDeepAnalysis({ config, systemPrompt, article, maxTokens: 1100 });
    let repaired = false;
    let cleaned = String(upstream.text || "").trim();
    let parsed = parseNaturalAuditToResult(cleaned);

    if (!validateAnalysisResult(parsed, article)) {
      const jsonCandidate = parseCandidateJson(cleaned || "{}");
      repaired = jsonCandidate.repaired;
      cleaned = jsonCandidate.cleaned;
      parsed = normalizeModelResult(jsonCandidate.parsed);
    }

    if (!validateAnalysisResult(parsed, article)) {
      upstream = await requestDeepAnalysis({
        config,
        systemPrompt,
        article,
        repairText: cleaned || String(upstream.text || "").slice(0, 4000),
        maxTokens: 1000,
      });
      cleaned = String(upstream.text || "").trim();
      parsed = parseNaturalAuditToResult(cleaned);
      if (!validateAnalysisResult(parsed, article)) {
        const jsonCandidate = parseCandidateJson(cleaned || "{}");
        repaired = repaired || jsonCandidate.repaired;
        cleaned = jsonCandidate.cleaned;
        parsed = normalizeModelResult(jsonCandidate.parsed);
      }
    }

    if (!validateAnalysisResult(parsed, article)) {
      return res.status(502).json({
        error: "Analysis request failed",
        detail: "The page analysis response could not be converted into a usable recommendation in this run. Please retry this page.",
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
    if (String(e).includes("AbortError")) {
      return res.status(504).json({
        error: "Analysis request failed",
        detail: "The page analysis took too long for this run. Please retry the page, or run a smaller batch.",
        config_signal: configSignal,
      });
    }
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
