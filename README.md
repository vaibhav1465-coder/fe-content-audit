# FE Content Audit — Deploy Guide

## What's in this project
- `index.html` — the tool (password-gated, no build step needed)
- `api/auth.js` — login, issues session tokens
- `api/analyze.js` — runs the analysis (auth + rate-limited via Supabase)
- `api/_verifyToken.js` — shared token check
- `supabase_setup.sql` — run once in Supabase, creates rate-limit tables

## 1. Supabase (5 min, free tier)
1. supabase.com → New Project → wait for it to provision
2. SQL Editor → New Query → paste all of `supabase_setup.sql` → Run
3. Settings → API → copy **Project URL** and **service_role key** (not "anon")

## 2. Generate two secrets
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Run this once for `SESSION_SECRET`. For `APP_PASSWORD`, just pick a real password yourself (not generated).

## 3. Push to GitHub
```bash
git init
git add .
git commit -m "FE Content Audit"
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git branch -M main
git push -u origin main
```
Check `git status` before committing — `.env` should never appear in the list.

## 4. Deploy to Vercel
1. vercel.com → Add New Project → import your GitHub repo
2. **Before clicking Deploy**, add every environment variable below
3. Click Deploy

| Variable | Value | Source |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | console.anthropic.com |
| `APP_PASSWORD` | your chosen password | you decide |
| `SESSION_SECRET` | generated random string | Step 2 |
| `SUPABASE_URL` | `https://xxxxx.supabase.co` | Step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | long `eyJ...` string | Step 1 (service_role) |
| `PER_MINUTE_LIMIT_PER_IP` | `15` | default |
| `DAILY_REQUEST_CAP` | `500` | adjust to expected usage |
| `ALLOWED_ORIGIN` | `*` for now | fix in Step 5 |

## 5. After first deploy — lock down CORS
Vercel gives you a URL (e.g. `fe-content-audit.vercel.app`). Go back to
Environment Variables, set `ALLOWED_ORIGIN` to that exact URL, then
**redeploy** (Deployments tab → ⋯ → Redeploy) for it to take effect.

## 6. Test it
Open the URL → you should see a login screen → log in with `APP_PASSWORD`
→ load segments (Step 1 in the tool) → try one small analysis end to end.

## Set a spend alert (independent safety net)
console.anthropic.com → Billing/Usage → set a monthly limit, so unexpected
usage doesn't go unnoticed even if something bypasses the app-level caps.

## Notes
- "Saved analyses" uses browser `localStorage` — it's per-browser, not
  shared across devices or team members. Each person sees only their own
  saved runs.
- The frontend fetches FE's article data directly from the browser. If a
  segment fails at offset 0, it's flagged as genuinely unsupported by
  FE's API (not something this code can fix). If it fails at any later
  offset, the tool treats it as "end of available articles," not an error.
