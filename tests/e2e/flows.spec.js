import { expect, test } from "@playwright/test";
import { server } from "../serve-dist.js";

const articlePayload = {
  id: 101, date: "2026-08-05T10:00:00", link: "https://example.com/market-update",
  title: { rendered: "Market update" }, excerpt: { rendered: "Summary" }, content: { rendered: "<p>Article body</p>" },
  coauthors: [407], class_list: ["post-101", "author-cap-fe-desk"],
};

test.beforeAll(async () => {
  await new Promise((resolve) => server.listen(4173, "127.0.0.1", resolve));
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("authentication, segment loading, article loading, saved analyses, CSV export, and API calls", async ({ page }) => {
  let authCalls = 0;
  let analysisCalls = 0;
  await page.route("**/api/auth", async (route) => {
    authCalls += 1;
    await route.fulfill({ json: { token: "test-token", expiresAt: Date.now() + 60_000 } });
  });
  await page.route("**/api/analyze", async (route) => {
    analysisCalls += 1;
    expect(route.request().headers().authorization).toBe("Bearer test-token");
    expect(route.request().postDataJSON().article.byline).toBe("FE Desk");
    expect(route.request().postDataJSON().cost_profile).toBe("standard");
    expect(route.request().postDataJSON().ai_provider).toBe("anthropic");
    expect(route.request().postDataJSON().ai_model).toBe("claude-sonnet-5");
    await route.fulfill({ json: { overall_health: "Needs Work", findings: [{ severity: "yellow", issue_name: "Sourcing", evidence: "Article body", what_is_wrong: "The article cites no expert.", why_it_hurts: "The claim lacks authority.", fix: "Add a qualified source.", optimization_steps: ["Identify the main claim.", "Ask a qualified expert to explain it."], expected_improvement: "This will make the article more authoritative and useful." }], bottom_line: "Add expert sourcing.", ymyl_score: 3, experience: 3, expertise: 2, authoritativeness: 2, trustworthiness: 3 } });
  });
  await page.route("**/wp-json/wp/v2/coauthors?**", async (route) => {
    await route.fulfill({ json: [{ id: 407, name: "fe-desk", slug: "cap-fe-desk" }] });
  });
  await page.route("**/wp-json/wp/v2/categories?**", async (route) => {
    await route.fulfill({
      headers: { "X-WP-Total": "1", "X-WP-TotalPages": "1" },
      json: [{ id: 5, slug: "markets", count: 10 }],
    });
  });
  await page.route("**/wp-json/wp/v2/posts?**", async (route) => {
    await route.fulfill({
      headers: { "X-WP-Total": "1", "X-WP-TotalPages": "1" },
      json: [articlePayload],
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "FE Content Audit" })).toBeVisible();
  await page.getByPlaceholder("Password").fill("team-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Load segments", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Load all segments" }).click();
  await expect(page.getByText("Loaded 1 active segments.")).toBeVisible();
  await expect(page.getByLabel("Publication month")).toHaveValue("last-12-months");
  expect(await page.getByLabel("Publication month").locator("option").count()).toBeGreaterThanOrEqual(13);
  await expect(page.getByRole("link", { name: /Open the FE article page/ })).toHaveAttribute("href", /wp-json\/wp\/v2\/posts\?categories=5.*after=.*before=/);

  await page.getByRole("button", { name: "Load next page" }).click();
  await page.getByRole("button", { name: /Continue to review/ }).click();
  await expect(page.getByText("Market update")).toBeVisible();
  await expect(page.getByText(/FE Desk/)).toBeVisible();
  await page.getByLabel("API: FE YMYL/E-E-A-T Guidelines").check();
  await page.getByLabel("Higher quality").check();
  await page.getByRole("button", { name: "Run recommendations for 1 selected pages" }).click();
  await expect(page.getByText("Add expert sourcing.")).toBeVisible();
  await expect(page.getByText("Evidence:")).toBeVisible();
  await expect(page.getByText("Ask a qualified expert to explain it.")).toBeVisible();

  await page.getByRole("button", { name: "Save analysis" }).click();
  await expect(page.getByText("Saved 1 articles in this browser.")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).last().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^fe-audit-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(authCalls).toBe(1);
  expect(analysisCalls).toBe(1);
});

test("quick local screen runs without calling paid APIs", async ({ page }) => {
  let analysisCalls = 0;
  await page.route("**/api/auth", async (route) => {
    await route.fulfill({ json: { token: "test-token", expiresAt: Date.now() + 60_000 } });
  });
  await page.route("**/api/analyze", async (route) => {
    analysisCalls += 1;
    await route.fulfill({ status: 500, json: { error: "Claude should not be called" } });
  });
  await page.route("**/wp-json/wp/v2/coauthors?**", async (route) => {
    await route.fulfill({ json: [{ id: 407, name: "fe-desk", slug: "cap-fe-desk" }] });
  });
  await page.route("**/wp-json/wp/v2/categories?**", async (route) => {
    await route.fulfill({
      headers: { "X-WP-Total": "1", "X-WP-TotalPages": "1" },
      json: [{ id: 5, slug: "markets", count: 10 }],
    });
  });
  await page.route("**/wp-json/wp/v2/posts?**", async (route) => {
    await route.fulfill({
      headers: { "X-WP-Total": "1", "X-WP-TotalPages": "1" },
      json: [articlePayload],
    });
  });

  await page.goto("/");
  await page.getByPlaceholder("Password").fill("team-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("button", { name: "Load all segments" }).click();
  await page.getByRole("button", { name: "Load next page" }).click();
  await page.getByRole("button", { name: /Continue to review/ }).click();
  await page.getByLabel("Quick local screen (no API cost)").check();
  await expect(page.getByText("This mode does not call Claude or OpenAI.")).toBeVisible();
  await page.getByRole("button", { name: "Run recommendations for 1 selected pages" }).click();
  await expect(page.getByText("Source-only pre-audit. No Claude tokens used.")).toBeVisible();
  expect(analysisCalls).toBe(0);
});

test("OpenAI provider selection sends the chosen model", async ({ page }) => {
  let analysisCalls = 0;
  await page.route("**/api/auth", async (route) => {
    await route.fulfill({ json: { token: "test-token", expiresAt: Date.now() + 60_000 } });
  });
  await page.route("**/api/analyze", async (route) => {
    analysisCalls += 1;
    expect(route.request().postDataJSON().ai_provider).toBe("openai");
    expect(route.request().postDataJSON().ai_model).toBe("gpt-4.1");
    expect(route.request().postDataJSON().cost_profile).toBe("standard");
    await route.fulfill({ json: { overall_health: "Needs Work", findings: [{ severity: "yellow", issue_name: "Clarity", evidence: "Article body", what_is_wrong: "The article needs one more example.", why_it_hurts: "Readers may need clearer context.", fix: "Add one example.", optimization_steps: ["Add one example.", "Keep the explanation concise."], expected_improvement: "This can make the advice easier to follow." }], bottom_line: "Add one practical example.", _model: "gpt-4.1", _provider: "openai" } });
  });
  await page.route("**/wp-json/wp/v2/coauthors?**", async (route) => {
    await route.fulfill({ json: [{ id: 407, name: "fe-desk", slug: "cap-fe-desk" }] });
  });
  await page.route("**/wp-json/wp/v2/categories?**", async (route) => {
    await route.fulfill({
      headers: { "X-WP-Total": "1", "X-WP-TotalPages": "1" },
      json: [{ id: 5, slug: "markets", count: 10 }],
    });
  });
  await page.route("**/wp-json/wp/v2/posts?**", async (route) => {
    await route.fulfill({
      headers: { "X-WP-Total": "1", "X-WP-TotalPages": "1" },
      json: [articlePayload],
    });
  });

  await page.goto("/");
  await page.getByPlaceholder("Password").fill("team-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("button", { name: "Load all segments" }).click();
  await page.getByRole("button", { name: "Load next page" }).click();
  await page.getByRole("button", { name: /Continue to review/ }).click();
  await page.getByLabel("API: FE YMYL/E-E-A-T Guidelines").check();
  await page.getByLabel("OpenAI API").check();
  await page.getByLabel("Higher quality").check();
  await page.getByLabel("AI model").selectOption("gpt-4.1");
  await page.getByRole("button", { name: "Run recommendations for 1 selected pages" }).click();
  await expect(page.getByText("Model used: gpt-4.1 via openai")).toBeVisible();
  expect(analysisCalls).toBe(1);
});

test("custom FE URL import supports pasted CSV-style rows", async ({ page }) => {
  await page.route("**/api/auth", async (route) => {
    await route.fulfill({ json: { token: "test-token", expiresAt: Date.now() + 60_000 } });
  });
  await page.route("**/wp-json/wp/v2/categories?**", async (route) => {
    await route.fulfill({
      headers: { "X-WP-Total": "1", "X-WP-TotalPages": "1" },
      json: [{ id: 5, slug: "markets", count: 10 }],
    });
  });
  await page.route("**/wp-json/wp/v2/posts/101", async (route) => {
    await route.fulfill({ json: articlePayload });
  });
  await page.route("**/wp-json/wp/v2/coauthors?**", async (route) => {
    await route.fulfill({ json: [{ id: 407, name: "fe-desk", slug: "cap-fe-desk" }] });
  });

  await page.goto("/");
  await page.getByPlaceholder("Password").fill("team-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("button", { name: "Load all segments" }).click();
  await page.getByPlaceholder(/Examples:/).fill("investing-abroad,https://www.financialexpress.com/business/example-story-101/");
  await page.getByRole("button", { name: "Import FE URLs" }).click();
  await expect(page.getByRole("button", { name: /Continue to review/ })).toBeVisible();
  await page.getByRole("button", { name: /Continue to review/ }).click();
  await expect(page.getByText("Market update")).toBeVisible();
  await expect(page.getByText("Selected: investing-abroad")).toBeVisible();
});

test("the authentication and audit workflow remain usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "FE Content Audit" })).toBeVisible();
  await expect(page.getByPlaceholder("Password")).toBeInViewport();
  await page.evaluate(() => {
    sessionStorage.setItem("fe_session_token", "mobile-token");
    sessionStorage.setItem("fe_session_expires", String(Date.now() + 60_000));
  });
  await page.reload();
  await expect(page.getByText("Load segments", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load all segments" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
