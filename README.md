# FE Content Audit - Deployment Guide

## Project contents

- `index.html` - the password-protected interface
- `build.js` - compiles the interface JSX for production
- `api/auth.js` - authenticates users and issues session tokens
- `api/analyze.js` - runs authenticated, Supabase-rate-limited analyses
- `api/source.js` - proxies authenticated requests to the preprod WordPress source
- `api/_verifyToken.js` - verifies session tokens
- `supabase_setup.sql` - creates the Supabase rate-limit tables

## 1. Configure Supabase

1. Create a Supabase project and wait for it to be provisioned.
2. Open **SQL Editor > New Query**, paste the contents of `supabase_setup.sql`, and select **Run**.
3. Open **Settings > API** and copy the **Project URL** and **service_role key**. Do not use the anon key for server-side rate limiting.

## 2. Generate secrets

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run this command once for `SESSION_SECRET`. Set `APP_PASSWORD` to a strong shared password.

## 3. Push to GitHub

```bash
git init
git add .
git commit -m "Prepare FE Content Audit for production"
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git branch -M main
git push -u origin main
```

Check `git status` before committing - `.env` must never appear in the list.

## 4. Deploy to Vercel

1. In Vercel, select **Add New Project** and import the GitHub repository.
2. Add every environment variable below before selecting **Deploy**.

| Variable | Value | Source |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Anthropic Console |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Anthropic standard-review model |
| `ANTHROPIC_LOW_COST_MODEL` | `claude-haiku-4-5-20251001` | Anthropic lower-cost review model |
| `PREPROD_WP_BASE` | `https://preprod.financialexpress.com/wp-json/wp/v2` | Preprod WordPress REST base |
| `PREPROD_COAUTHORS_BASE` | `https://preprod.financialexpress.com/wp-json/coauthors/v1` | Preprod coauthors endpoint |
| `APP_PASSWORD` | Strong shared password | Your team |
| `SESSION_SECRET` | Generated random string | Step 2 |
| `SUPABASE_URL` | `https://xxxxx.supabase.co` | Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key | Supabase |
| `PER_MINUTE_LIMIT_PER_IP` | `15` | Default |
| `DAILY_REQUEST_CAP` | `500` | Adjust to expected usage |
| `MAX_BODY_TEXT_CHARS` | `8000` | Default |
| `MAX_ARTICLE_PAYLOAD_CHARS` | `12000` | Default |
| `ALLOWED_ORIGIN` | `*` for the first deployment | Step 5 |

## 5. Restrict CORS

After the first deployment, set `ALLOWED_ORIGIN` to the exact Vercel production URL and redeploy for the change to take effect.

## 6. Verify the deployment

Open the production URL, sign in with `APP_PASSWORD`, load segments, and run one small analysis end to end.

## Usage controls

Use a separate Anthropic API key for this product when possible. That keeps billing, usage alerts, and key rotation separate from other tools. Also set a monthly spending limit in the Anthropic Console as an independent safety control.

For large segment work, start with **Source-only pre-audit**. It uses the loaded FE article data and does not call Claude. Use Claude modes only for high-risk pages, samples, or pages selected for deeper editorial review.

When you do need Claude recommendations, the product supports two cost profiles:
- Lower cost: Haiku
- Higher quality: Sonnet

Paste or upload FE URL lists in Step 2 using plain text, CSV, TSV, or Google Sheets/Google Drive exports. The importer supports `url` and optional `segment` columns.

## Notes

- Saved analyses use browser `localStorage` - storage is per browser, not shared across devices or team members.
- The article picker defaults to the last 12 months and also offers each elapsed month in the current and previous calendar year.
- The frontend now loads categories and month-filtered posts from the preprod WordPress source through an authenticated backend proxy, then uses those category IDs and exact date boundaries for retrieval.
- FE WordPress caps each article API page at 100 records. Use **Load all available pages** to collect larger batches in controlled chunks.
- Large Claude analysis runs are paced below the configured per-minute rate limit.
- Recommendations are displayed only when each finding contains evidence found in the submitted article and one to three concrete optimisation steps.
