// api/analyze.js
// Protected: requires valid session token, rate-limited via Supabase,
// daily budget cap. Supports two analysis modes selected by the client.

import { createClient } from "@supabase/supabase-js";
import { verifyToken } from "./_verifyToken.js";

const SYSTEM_PROMPT_FE = `You are the FE Content Health Agent, a senior SEO & Content Head reviewing Financial Express articles against 13 YMYL/E-E-A-T guidelines. Score ONLY on what is actually present in the article given. Never guess. Every finding must reference something specific and real from THIS article.

GOOGLE UPDATES CONTEXT: E-E-A-T now applies broadly (Dec 2025/Mar 2026 core updates). YMYL expanded to Government/Civics/Society (Sept 2025). An author bio alone is not enough - body content must demonstrate expertise. First-hand experience is now decisive (May 2026). Scaled/duplicate content is targeted (Mar 2026 Spam Update). Never frame findings as "AI-written" - frame as "lacks first-hand expertise/sourcing."

GUIDELINES: G1 reader wellbeing, G2 verifiable expertise, G3 attribution/fact-check, G4 source quality (min 1 expert unless override/exception), G5 disclaimers, G6 safety/risk framing, G7 accurate headlines, G8 explainers need expert weigh-in, G9 no clickbait/curiosity-gap, G10 no unsourced trend-chasing, G11 no repeated/duplicate content, G12 comparisons need expert opinion, G13 unqualified advice-giving is HARD FAIL always red.

Score E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness) independently 1-5.

GROUNDING RULES: Never invent a fact, quote, source, performance result, or ranking outcome. Every finding must include a short verbatim evidence excerpt copied from the supplied headline, subheading, byline, or body text. If the article does not contain evidence for a concern, do not report that concern. Recommendations must be plain, specific editorial actions that follow directly from the evidence. Do not promise traffic or ranking gains.

CRITICAL LENGTH LIMIT: Respond with ONLY the JSON below, under 800 words total. AT MOST 2 findings. Keep every field concise. No markdown fences, no text outside the JSON object.

{
  "overall_health": "Strong|Needs Work|Weak",
  "findings": [{"severity":"red|yellow","issue_name":"short name","evidence":"short verbatim excerpt from this article","what_is_wrong":"ONE sentence, specific to this article","why_it_hurts":"ONE short sentence","fix":"ONE short concrete action","optimization_steps":["clear action 1","clear action 2"],"expected_improvement":"ONE cautious sentence describing the content-quality benefit, without promising rankings"}],
  "whats_working": ["one short strength, or omit if none"],
  "bottom_line": "ONE sentence verdict",
  "ymyl_score":1-5,"experience":1-5,"expertise":1-5,"authoritativeness":1-5,"trustworthiness":1-5,
  "flagged_guidelines": ["G1","G9"]
}`;

const SYSTEM_PROMPT_HCS = `You are an elite Google Search Quality Rater and Senior Technical SEO Auditor. Ruthlessly evaluate this webpage against Google's 2025-2026 Core Ranking Systems, where the Helpful Content System (HCS) is integrated into core ranking and spam policies heavily target scaled content, site reputation abuse, and unoriginal aggregation. Do not flatter the text - if it is generic, score it ruthlessly. Never guess about content not shown to you.

CONTEXT: FE's traffic dropped after the Aug 2025 core update, partially recovered Sep-Oct, then collapsed after the Dec 2025 core update. Some sections down 70-80%. Both Google Search and Discover collapsed. Your job is to identify "Dead Weight" content dragging down sitewide quality.

EVALUATE ON: 1) HCS & Information Gain - original reporting/analysis vs summarizing others; search-engine-first content; fluff/padding. 2) E-E-A-T - first-hand experience vs generic guide; YMYL claims backed by primary-source citations, objective tone; curiosity-gap headlines. 3) SPAM POLICIES - scaled/AI-generated feel adding little value; thin content lacking depth/data.

GROUNDING RULES: Never invent a fact, quote, source, performance result, or ranking outcome. Every finding must include a short verbatim evidence excerpt copied from the supplied headline, subheading, byline, or body text. If the article does not contain evidence for a concern, do not report that concern. Recommendations must be plain, specific editorial actions that follow directly from the evidence. Do not promise traffic or ranking gains.

CRITICAL LENGTH LIMIT: Respond with ONLY the JSON below, under 800 words total. AT MOST 2 findings. Keep every field concise. No markdown fences, no text outside the JSON.

{
  "verdict": "Dead Weight|Borderline|Healthy",
  "information_gain_score": 1-5,
  "experience_score": 1-5,
  "trust_score": 1-5,
  "spam_risk": "none|scaled-content-abuse|thin-content|syndicated-aggregation",
  "findings": [{"severity":"red|yellow","issue_name":"short name","evidence":"short verbatim excerpt from this article","what_is_wrong":"ONE sentence, specific to this article","why_it_hurts":"ONE sentence tied to HCS/E-E-A-T/spam policy","fix":"ONE concrete action","optimization_steps":["clear action 1","clear action 2"],"expected_improvement":"ONE cautious sentence describing the content-quality benefit, without promising rankings"}],
  "bottom_line": "ONE sentence: is this Dead Weight and why"
}`;

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const DAILY_BUDGET_CAP = Number(process.env.DAILY_REQUEST_CAP || 500);
const PER_MINUTE_LIMIT = Number(process.env.PER_MINUTE_LIMIT_PER_IP || 15);

function buildUserPrompt(article) {
  const headline = String(article.headline || "(missing)").slice(0, 500);
  const subheading = String(article.subheading || "(missing)").slice(0, 500);
  const byline = String(article.byline || "(missing)").slice(0, 200);
  const publishDate = String(article.publish_date || "(missing)").slice(0, 100);
  const segment = String(article.segment || "(missing)").slice(0, 100);
  const bodyText = String(article.body_text || "").slice(0, 8000);
  return `Headline: ${headline}\nSubheading: ${subheading}\nByline: ${byline}\nPublish date: ${publishDate}\nSegment: ${segment}\nBody text: ${bodyText}`;
}

function normalizeEvidence(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function validateAnalysisResult(result, article) {
  if (!result || typeof result !== "object" || !Array.isArray(result.findings) || result.findings.length > 2) return false;
  const articleText = normalizeEvidence([article.headline, article.subheading, article.byline, article.body_text].join(" "));
  return result.findings.every((finding) => {
    if (!finding || !["red", "yellow"].includes(finding.severity)) return false;
    const evidence = normalizeEvidence(finding.evidence);
    const steps = finding.optimization_steps;
    return evidence.length >= 8 && articleText.includes(evidence) &&
      typeof finding.issue_name === "string" && typeof finding.what_is_wrong === "string" &&
      typeof finding.why_it_hurts === "string" && typeof finding.fix === "string" &&
      Array.isArray(steps) && steps.length >= 1 && steps.length <= 3 && steps.every((step) => typeof step === "string" && step.trim().length > 0) &&
      typeof finding.expected_improvement === "string" && finding.expected_improvement.trim().length > 0;
  });
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server misconfigured: ANTHROPIC_API_KEY not set." });

  const article = req.body?.article;
  const mode = req.body?.mode === "hcs" ? "hcs" : "fe";
  if (!article || typeof article !== "object") return res.status(400).json({ error: "Missing or invalid 'article' in request body." });

  const systemPrompt = mode === "hcs" ? SYSTEM_PROMPT_HCS : SYSTEM_PROMPT_FE;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: buildUserPrompt(article) }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: "Upstream API error", detail: errText.slice(0, 500) });
    }

    const data = await response.json();
    const text = data.content?.find((b) => b.type === "text")?.text || "{}";
    const cleaned = text.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const repaired = tryRepairTruncatedJson(cleaned);
      if (repaired) {
        repaired._wasTruncated = true;
        if (!validateAnalysisResult(repaired, article)) {
          return res.status(502).json({ error: "The analysis response was incomplete or not grounded in the article. Please retry." });
        }
        return res.status(200).json(repaired);
      }
      return res.status(502).json({ error: "Could not parse model output as JSON", raw: cleaned.slice(0, 500) });
    }

    if (!validateAnalysisResult(parsed, article)) {
      return res.status(502).json({ error: "The analysis response was incomplete or not grounded in the article. Please retry." });
    }

    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: "Internal error", detail: String(e).slice(0, 500) });
  }
}
