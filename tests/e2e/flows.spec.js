import { expect, test } from "@playwright/test";
import { server } from "../serve-dist.js";

const articlePayload = {
  list: [{ items: [{ id: 101, headline: "Market update", introduction: "Summary", byline: [{ name: "FE Desk" }], post_date: "2026-08-05 10:00:00", body_raw: "Article body", post_url: "https://example.com/market-update" }] }],
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
    await route.fulfill({ json: { overall_health: "Needs Work", findings: [{ severity: "yellow", issue_name: "Sourcing", what_is_wrong: "The article cites no expert.", why_it_hurts: "The claim lacks authority.", fix: "Add a qualified source." }], bottom_line: "Add expert sourcing.", ymyl_score: 3, experience: 3, expertise: 2, authoritativeness: 2, trustworthiness: 3 } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "FE Content Audit" })).toBeVisible();
  await page.getByPlaceholder("Password").fill("team-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Step 1 — Load segments")).toBeVisible();

  await page.getByPlaceholder("Paste the complete segment JSON here").fill(JSON.stringify([{ slug: "markets" }]));
  await page.getByRole("button", { name: "Load segments" }).click();
  await expect(page.getByText("✓ 1 segments loaded.")).toBeVisible();

  await page.getByPlaceholder("Paste the complete article JSON here").fill(JSON.stringify(articlePayload));
  await page.getByRole("button", { name: /Add these articles/ }).click();
  await page.getByRole("button", { name: /Continue to review/ }).click();
  await expect(page.getByText("Market update")).toBeVisible();
  await page.getByRole("button", { name: "Analyse all 1 articles" }).click();
  await expect(page.getByText("Add expert sourcing.")).toBeVisible();

  await page.getByRole("button", { name: "Save analysis" }).click();
  await expect(page.getByText("✓ Saved 1 articles in this browser.")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).last().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^fe-audit-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(authCalls).toBe(1);
  expect(analysisCalls).toBe(1);
});
