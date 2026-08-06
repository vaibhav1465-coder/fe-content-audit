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
    await route.fulfill({ json: { overall_health: "Needs Work", findings: [{ severity: "yellow", issue_name: "Sourcing", evidence: "Article body", what_is_wrong: "The article cites no expert.", why_it_hurts: "The claim lacks authority.", fix: "Add a qualified source.", optimization_steps: ["Identify the main claim.", "Ask a qualified expert to explain it."], expected_improvement: "This will make the article more authoritative and useful." }], bottom_line: "Add expert sourcing.", ymyl_score: 3, experience: 3, expertise: 2, authoritativeness: 2, trustworthiness: 3 } });
  });
  await page.route("**/wp-json/wp/v2/coauthors?**", async (route) => {
    await route.fulfill({ json: [{ id: 407, name: "fe-desk", slug: "cap-fe-desk" }] });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "FE Content Audit" })).toBeVisible();
  await page.getByPlaceholder("Password").fill("team-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Step 1 — Load segments")).toBeVisible();

  await page.getByPlaceholder("Paste the complete segment JSON here").fill(JSON.stringify([{ id: 5, slug: "markets" }]));
  await page.getByRole("button", { name: "Load segments" }).click();
  await expect(page.getByText("✓ 1 segments loaded.")).toBeVisible();
  await expect(page.getByLabel("Publication month")).toHaveValue("last-12-months");
  expect(await page.getByLabel("Publication month").locator("option").count()).toBeGreaterThanOrEqual(13);
  await expect(page.getByRole("link", { name: /Open the FE article page/ })).toHaveAttribute("href", /wp-json\/wp\/v2\/posts\?categories=5.*after=.*before=/);

  await page.getByPlaceholder("Paste the complete article JSON here").fill(JSON.stringify([articlePayload]));
  await page.getByRole("button", { name: /Add these articles/ }).click();
  await page.getByRole("button", { name: /Continue to review/ }).click();
  await expect(page.getByText("Market update")).toBeVisible();
  await expect(page.getByText(/FE Desk/)).toBeVisible();
  await page.getByRole("button", { name: "Analyse all 1 articles" }).click();
  await expect(page.getByText("Add expert sourcing.")).toBeVisible();
  await expect(page.getByText("Evidence:")).toBeVisible();
  await expect(page.getByText("Ask a qualified expert to explain it.")).toBeVisible();

  await page.getByRole("button", { name: "Save analysis" }).click();
  await expect(page.getByText("✓ Saved 1 articles in this browser.")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).last().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^fe-audit-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(authCalls).toBe(1);
  expect(analysisCalls).toBe(1);
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
  await expect(page.getByText("Step 1 — Load segments")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load segments" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
