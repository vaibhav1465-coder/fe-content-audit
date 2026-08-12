// api/analyze.js
// Protected: requires valid session token, rate-limited via Supabase,
// daily budget cap. Supports two analysis modes selected by the client.

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
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
const MAX_BODY_TEXT_CHARS = Number(process.env.MAX_BODY_TEXT_CHARS || 8000);
const MAX_ARTICLE_PAYLOAD_CHARS = Number(process.env.MAX_ARTICLE_PAYLOAD_CHARS || 12000);
const DEFAULT_STANDARD_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const DEFAULT_LOW_COST_MODEL = process.env.ANTHROPIC_LOW_COST_MODEL || "claude-haiku-4-5-20251001";
const DEFAULT_OPENAI_STANDARD_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const DEFAULT_OPENAI_LOW_COST_MODEL = process.env.OPENAI_LOW_COST_MODEL || "gpt-5.6-luna";

function stripToPlainText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeSentence(value, fallback) {
  const cleaned = stripToPlainText(value);
  if (!cleaned) return fallback;
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned;
}

function articleEvidence(article, maxLength = 160) {
  const candidates = [
    article.subheading,
    article.headline,
    String(article.body_text || "").split(/[.!?]\s/)[0],
    String(article.body_text || "").slice(0, maxLength),
  ].map((item) => stripToPlainText(item)).filter(Boolean);
  const chosen = candidates[0] || "The page content was loaded successfully.";
  return chosen.length > maxLength ? `${chosen.slice(0, maxLength - 3)}...` : chosen;
}

function countMatches(text, regex) {
  return (String(text || "").match(regex) || []).length;
}

function clampScore(value, minimum = 1, maximum = 5) {
  return Math.max(minimum, Math.min(maximum, value));
}

function buildFallbackAnalysis(article, mode, reason, meta = {}) {
  const bodyText = String(article.body_text || "").slice(0, MAX_BODY_TEXT_CHARS);
  const headline = stripToPlainText(article.headline);
  const byline = stripToPlainText(article.byline);
  const evidence = articleEvidence(article);
  const wordCount = bodyText.trim() ? bodyText.trim().split(/\s+/).length : 0;
  const sourceSignals = countMatches(bodyText, /https?:\/\/|according to|said|told|data|report|survey|filing|statement|exchange|ministry|rbi|sebi|nse|bse/gi);
  const expertSignals = countMatches(bodyText, /said|told|according to|analyst|expert|economist|official|spokesperson|ceo|cfo|md|founder|research head/gi);
  const numericSignals = countMatches(bodyText, /\b\d+(?:\.\d+)?%?\b/g);
  const hasByline = Boolean(byline);
  const fallbackNote = safeSentence(reason, "The selected model did not return a usable recommendation, so this page was assessed using the product's built-in editorial rules.");
  const findings = [];

  if (wordCount < 350) {
    findings.push({
      severity: "red",
      issue_name: "Needs more useful depth",
      evidence,
      what_is_wrong: `The page currently has about ${wordCount} words, which is light for a content-improvement review.`,
      why_it_hurts: "Readers may not get enough context, proof points, or next-step guidance from the page.",
      fix: "Expand the article with more concrete context, named sourcing, and a practical takeaway section.",
      optimization_steps: [
        "Add one short background section explaining why this update matters.",
        "Add at least one named source, quote, or official data point.",
        "End with a clear takeaway for readers in simple language."
      ],
      expected_improvement: "A fuller article should make the page more useful, clearer, and easier for readers to trust.",
    });
  }

  if (sourceSignals < 2 || expertSignals < 1) {
    findings.push({
      severity: findings.length ? "yellow" : "red",
      issue_name: "Stronger sourcing is needed",
      evidence,
      what_is_wrong: "The page does not show enough visible sourcing, expert context, or supporting evidence for its main claims.",
      why_it_hurts: "Important business and YMYL-style pages are more useful when claims are clearly supported.",
      fix: "Add named attribution, official data, and one expert or company voice directly tied to the main claim.",
      optimization_steps: [
        "Identify the page's main claim and support it with one named source.",
        "Add one expert, company, or official quote that explains the claim.",
        "Include one concrete figure, date, or document reference where possible."
      ],
      expected_improvement: "Clearer sourcing should make the page feel more credible and more actionable for readers.",
    });
  }

  if (!hasByline && findings.length < 2) {
    findings.push({
      severity: "yellow",
      issue_name: "Author detail should be clearer",
      evidence: headline || evidence,
      what_is_wrong: "The loaded page does not include a strong visible byline or author context in the current payload.",
      why_it_hurts: "Readers benefit from knowing who reported or reviewed the content.",
      fix: "Confirm the byline and add stronger author context or profile linkage in the publishing workflow.",
      optimization_steps: [
        "Confirm the correct byline in the CMS.",
        "Link the byline to an author profile where available."
      ],
      expected_improvement: "Clearer authorship can improve trust and accountability for the page.",
    });
  }

  if (!findings.length) {
    findings.push({
      severity: "yellow",
      issue_name: "Add one stronger proof point",
      evidence,
      what_is_wrong: fallbackNote,
      why_it_hurts: "Without one stronger proof point, the page may feel less complete than it could be.",
      fix: "Add one concrete data point, source, or explanatory section tied to the main reader question.",
      optimization_steps: [
        "Add one supporting fact, number, or official reference.",
        "Explain the practical reader impact in one short paragraph."
      ],
      expected_improvement: "A clearer proof point should make the page more informative and more useful for readers.",
    });
  }

  const limitedFindings = findings.slice(0, 2);

  if (mode === "hcs") {
    const informationGainScore = clampScore(wordCount >= 700 ? 4 : wordCount >= 450 ? 3 : 2);
    const experienceScore = clampScore(expertSignals >= 2 ? 4 : expertSignals >= 1 ? 3 : 2);
    const trustScore = clampScore((hasByline ? 1 : 0) + (sourceSignals >= 2 ? 2 : 1) + (numericSignals >= 3 ? 1 : 0), 2, 5);
    const verdict = limitedFindings.some((item) => item.severity === "red") ? "Dead Weight" : "Borderline";
    return {
      verdict,
      information_gain_score: informationGainScore,
      experience_score: experienceScore,
      trust_score: trustScore,
      spam_risk: wordCount < 350 ? "thin-content" : "none",
      findings: limitedFindings,
      bottom_line: verdict === "Dead Weight"
        ? "This page needs stronger depth, sourcing, and explanation before it can be relied on as a strong content asset."
        : "This page has a usable base, but it still needs stronger proof points and clearer reader value.",
      _fallback: true,
      _fallback_reason: fallbackNote,
      _usage: meta.usage || null,
      _model: meta.model || "built-in-fallback",
      _cost_profile: meta.costProfile || null,
      _provider: meta.provider || "fallback",
      _config_signal: meta.configSignal || null,
    };
  }

  const ymylScore = clampScore(wordCount >= 700 ? 4 : wordCount >= 450 ? 3 : 2);
  const experience = clampScore(expertSignals >= 2 ? 4 : expertSignals >= 1 ? 3 : 2);
  const expertise = clampScore(sourceSignals >= 3 ? 4 : sourceSignals >= 2 ? 3 : 2);
  const authoritativeness = clampScore((hasByline ? 1 : 0) + (sourceSignals >= 2 ? 2 : 1), 2, 5);
  const trustworthiness = clampScore((hasByline ? 1 : 0) + (numericSignals >= 3 ? 1 : 0) + (sourceSignals >= 2 ? 2 : 1), 2, 5);
  const overallHealth = limitedFindings.some((item) => item.severity === "red") ? "Weak" : "Needs Work";
  return {
    overall_health: overallHealth,
    findings: limitedFindings,
    whats_working: sourceSignals >= 2 ? ["The page already includes some attributed or factual support."] : [],
    bottom_line: overallHealth === "Weak"
      ? "This page needs stronger sourcing, depth, and practical explanation before it can be treated as a strong content asset."
      : "This page has a workable base, but it still needs clearer proof points and reader guidance.",
    ymyl_score: ymylScore,
    experience,
    expertise,
    authoritativeness,
    trustworthiness,
    flagged_guidelines: limitedFindings.some((item) => item.issue_name.includes("sourcing")) ? ["G2", "G3", "G4"] : ["G1", "G2"],
    _fallback: true,
    _fallback_reason: fallbackNote,
    _usage: meta.usage || null,
    _model: meta.model || "built-in-fallback",
    _cost_profile: meta.costProfile || null,
    _provider: meta.provider || "fallback",
    _config_signal: meta.configSignal || null,
  };
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

export { buildFallbackAnalysis };

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
  const mode = req.body?.mode === "hcs" ? "hcs" : "fe";
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

  const systemPrompt = mode === "hcs" ? SYSTEM_PROMPT_HCS : SYSTEM_PROMPT_FE;
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
    const upstream = config.provider === "openai"
      ? await requestOpenAiAnalysis({ apiKey: config.apiKey, model: config.model, systemPrompt, article })
      : await requestAnthropicAnalysis({ apiKey: config.apiKey, model: config.model, systemPrompt, article });
    const text = upstream.text || "{}";
    const cleaned = text.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const repaired = tryRepairTruncatedJson(cleaned);
      if (repaired) {
        repaired._wasTruncated = true;
        if (!validateAnalysisResult(repaired, article)) {
          const fallback = buildFallbackAnalysis(article, mode, "The selected model returned an unusable recommendation, so the page was assessed using the product's built-in editorial rules.", {
            usage: upstream.usage || null,
            model: config.model,
            costProfile,
            provider: config.provider,
            configSignal,
          });
          return res.status(200).json(fallback);
        }
        repaired._usage = upstream.usage || null;
        repaired._model = config.model;
        repaired._cost_profile = costProfile;
        repaired._provider = config.provider;
        repaired._config_signal = configSignal;
        return res.status(200).json(repaired);
      }
      const fallback = buildFallbackAnalysis(article, mode, "The selected model did not return a usable structured recommendation, so the page was assessed using the product's built-in editorial rules.", {
        usage: upstream.usage || null,
        model: config.model,
        costProfile,
        provider: config.provider,
        configSignal,
      });
      return res.status(200).json(fallback);
    }

    if (!validateAnalysisResult(parsed, article)) {
      const fallback = buildFallbackAnalysis(article, mode, "The selected model returned an incomplete recommendation, so the page was assessed using the product's built-in editorial rules.", {
        usage: upstream.usage || null,
        model: config.model,
        costProfile,
        provider: config.provider,
        configSignal,
      });
      return res.status(200).json(fallback);
    }

    parsed._usage = upstream.usage || null;
    parsed._model = config.model;
    parsed._cost_profile = costProfile;
    parsed._provider = config.provider;
    parsed._config_signal = configSignal;
    return res.status(200).json(parsed);
  } catch (e) {
    if (String(e).startsWith("Error: Upstream API error:")) {
      const detail = String(e).replace(/^Error: Upstream API error:\s*/, "").slice(0, 500);
      const fallback = buildFallbackAnalysis(article, mode, `The selected model could not finish the recommendation (${detail.slice(0, 180)}). The page was assessed using the product's built-in editorial rules instead.`, {
        model: config.model,
        costProfile,
        provider: config.provider,
        configSignal,
      });
      return res.status(200).json(fallback);
    }
    const fallback = buildFallbackAnalysis(article, mode, "The analysis service hit an internal issue, so the page was assessed using the product's built-in editorial rules instead.", {
      model: config.model,
      costProfile,
      provider: config.provider,
      configSignal,
    });
    return res.status(200).json(fallback);
  }
}
