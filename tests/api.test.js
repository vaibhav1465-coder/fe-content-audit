import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import authHandler from "../api/auth.js";
import { verifyToken } from "../api/_verifyToken.js";
import { validateAnalysisResult } from "../api/analyze.js";

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

test("authentication rejects an incorrect password and issues a verifiable token for the correct password", async () => {
  const previous = { password: process.env.APP_PASSWORD, secret: process.env.SESSION_SECRET };
  process.env.APP_PASSWORD = "correct-password";
  process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  try {
    const rejected = responseRecorder();
    await authHandler({ method: "POST", body: { password: "incorrect" } }, rejected);
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.body.error, "Incorrect password.");

    const accepted = responseRecorder();
    await authHandler({ method: "POST", body: { password: "correct-password" } }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(verifyToken(`Bearer ${accepted.body.token}`).valid, true);
    assert.ok(accepted.body.expiresAt > Date.now());
  } finally {
    if (previous.password === undefined) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = previous.password;
    if (previous.secret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previous.secret;
  }
});

test("token verification rejects missing, malformed, and expired credentials", () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-secret";
  try {
    assert.equal(verifyToken(undefined).valid, false);
    assert.equal(verifyToken("Bearer malformed").valid, false);
    const expiresAt = Date.now() - 1;
    const signature = crypto.createHmac("sha256", "test-secret").update(String(expiresAt)).digest("hex");
    assert.equal(verifyToken(`Bearer ${expiresAt}.${signature}`).reason, "Session expired. Log in again.");
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previous;
  }
});

test("analysis validation accepts grounded recommendations and rejects invented evidence", () => {
  const article = { headline: "Rates remain unchanged", body_text: "The central bank kept the policy rate unchanged after its meeting." };
  const result = {
    page_classification: "Overhaul",
    hcs_info_gain: {
      mandate: "Google's mandate: Content must provide original reporting, research, or analysis, and must not leave users feeling they need to search again.",
      findings: [
        { title: "Thin explanation", analysis: "The article reports the decision but does not explain what readers should do next.", evidence: ["kept the policy rate unchanged"] },
        { title: "No added insight", analysis: "The copy stays at announcement level and does not add any deeper interpretation.", evidence: ["policy rate unchanged after its meeting"] },
      ],
    },
    eeat_trust: {
      mandate: "Google's mandate: High-quality YMYL (Your Money or Your Life) content must be written by experts, cite authoritative primary sources, and demonstrate first-hand experience.",
      findings: [
        { title: "Weak trust signals", analysis: "The article body shown here does not cite a primary document or named expert.", evidence: ["kept the policy rate unchanged"] },
        { title: "Reader impact missing", analysis: "The page does not translate the policy decision into borrower or saver impact.", evidence: ["policy rate unchanged after its meeting"] },
      ],
    },
    spam_scaled_abuse: {
      mandate: "Google's mandate: Pages must not be generated at scale to manipulate search rankings, nor should they lack depth, real examples, or specific data points.",
      findings: [
        { title: "Template-like execution", analysis: "The wording reads like a basic market update without distinctive analysis.", evidence: ["kept the policy rate unchanged"] },
        { title: "Low data depth", analysis: "No detailed figures or scenario examples are included in the supplied copy.", evidence: ["policy rate unchanged after its meeting"] },
      ],
    },
    editorial_leadership_recommendation: {
      summary: "This page needs a stronger explanatory layer before it is safe as a high-value search asset.",
      immediate_action_required: "Rewrite with reader-impact context and primary-source support.",
      next_steps: ["Add the central bank source document.", "Explain the borrower and saver impact.", "Include one quoted analyst view."],
    },
  };
  assert.equal(validateAnalysisResult(result, article), true);
  assert.equal(validateAnalysisResult({
    ...result,
    hcs_info_gain: {
      ...result.hcs_info_gain,
      findings: [{ ...result.hcs_info_gain.findings[0], evidence: ["invented quotation"] }, result.hcs_info_gain.findings[1]],
    },
  }, article), false);
});
