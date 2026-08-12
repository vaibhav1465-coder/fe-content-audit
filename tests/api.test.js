import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import authHandler from "../api/auth.js";
import { verifyToken } from "../api/_verifyToken.js";
import { buildFallbackAnalysis, validateAnalysisResult } from "../api/analyze.js";

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
    findings: [{
      severity: "yellow",
      issue_name: "Missing context",
      evidence: "kept the policy rate unchanged",
      what_is_wrong: "The article does not explain the decision's effect.",
      why_it_hurts: "Readers may not understand why the decision matters.",
      fix: "Add one paragraph explaining the effect on borrowers.",
      optimization_steps: ["Explain the effect on loan rates.", "Attribute the explanation to a named expert."],
      expected_improvement: "This will make the article clearer and more useful.",
    }],
  };
  assert.equal(validateAnalysisResult(result, article), true);
  assert.equal(validateAnalysisResult({ ...result, findings: [{ ...result.findings[0], evidence: "invented quotation" }] }, article), false);
});

test("fallback analysis always returns a usable recommendation shape", () => {
  const article = {
    headline: "Markets react to new guidance",
    subheading: "Experts say investors should watch policy signals",
    byline: "FE Bureau",
    body_text: "Markets react to new guidance. Analysts said investors should watch policy signals closely. According to exchange data, volumes rose 12% after the announcement.",
  };

  const feResult = buildFallbackAnalysis(article, "fe", "Model output was unusable.");
  assert.equal(Array.isArray(feResult.findings), true);
  assert.equal(feResult.findings.length >= 1, true);
  assert.equal(typeof feResult.bottom_line, "string");
  assert.equal(feResult._fallback, true);

  const hcsResult = buildFallbackAnalysis(article, "hcs", "Model output was unusable.");
  assert.equal(Array.isArray(hcsResult.findings), true);
  assert.equal(hcsResult.findings.length >= 1, true);
  assert.equal(typeof hcsResult.bottom_line, "string");
  assert.equal(hcsResult._fallback, true);
});
