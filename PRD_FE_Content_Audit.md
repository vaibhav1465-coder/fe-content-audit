# PRD: FE Content Audit

Last updated: August 12, 2026

## 1. Product overview

FE Content Audit is an internal editorial operations tool for Financial Express that helps teams review large batches of FE content, identify quality gaps, and generate practical content-improvement recommendations.

The product is designed to let non-technical users:

- load FE segments from the source system
- choose a month or last-12-month view
- fetch pages for a selected segment
- import their own FE URL lists
- review and select pages for analysis
- generate actionable recommendations for content improvement
- export and save outputs for editorial follow-up

The product should feel simple, reliable, and operational for team use at scale.

## 2. Problem statement

The FE team needs a repeatable way to review a large number of pages across multiple segments and identify content-quality issues that may affect traffic, discoverability, trust, and usefulness.

Today, manual review is too slow and too inconsistent for the scale required. Teams need a workflow that can:

- retrieve the right pages by segment and month
- avoid missing pages because of weak source feeds
- reduce dependence on manual copy-paste
- generate recommendations in simple editorial language
- avoid technical confusion, dead-end errors, and unreliable outputs

## 3. Goals

### Primary goals

- Help SEO teams identify which FE pages need improvement
- Provide simple, clear, practical recommendations for each page
- Support monthly and segment-based content review workflows
- Work reliably across larger batches of pages
- Reduce user confusion by hiding backend/API complexity

### Secondary goals

- Support editorial teams reviewing and acting on SEO-led findings
- Support imported URL workflows for custom page sets
- Give teams cost-aware options for deeper AI analysis
- Save and export outputs for collaboration and follow-up

## 4. Non-goals

The product is not intended to:

- redesign FE pages automatically
- publish CMS changes directly
- replace human editorial judgment
- provide SEO ranking guarantees
- expose raw backend or WordPress API workflows to normal users
- act as a full CMS authoring tool

## 5. Target users

### Primary users

- SEO/content optimization team
- content strategy team
- internal reviewers working on segment-level audits

### Secondary users

- editorial team members
- managers reviewing output summaries
- team members importing custom FE URL sets for special reviews

## 6. Core use cases

### Use case 1: Segment and month review

User wants to review pages from a specific FE segment for a specific month.

Flow:

1. Log in
2. Load all active FE segments
3. Select a month or last 12 months
4. Choose a segment
5. Load one page or all available pages
6. Review selected pages
7. Run analysis
8. Export or save results

### Use case 2: Large-batch editorial review

User wants to review many pages from a segment and prioritize which pages need improvement.

Flow:

1. Load segment pages
2. Select recommendation count
3. Run analysis across selected pages
4. Review weak / needs work / borderline pages first
5. Export CSV for team action

### Use case 3: Imported FE URL review

User already has a list of FE URLs from Sheets, Drive, CSV, or manual curation.

Flow:

1. Paste or upload FE URLs
2. System imports and normalizes those pages
3. User reviews selected pages
4. Run analysis
5. Export or save the output

### Use case 4: Cost-controlled review

User wants to pre-screen many pages without using paid model credits for every step.

Flow:

1. Load pages
2. Use quick local screen or lower-cost model option
3. Run deeper analysis only on priority pages

## 7. Product principles

- Clear for non-technical users
- Reliable for team workflows
- Action-oriented output, not just scoring
- Safe against hallucinated recommendations
- Scalable for large FE page sets
- Cost-aware in AI usage
- Hidden technical complexity where possible

## 8. Functional requirements

### 8.1 Authentication

- Product must require login before use
- Session must expire safely
- Expired sessions must prompt re-login clearly

### 8.2 Segment loading

- Product must load all active FE segments from the source system
- Segment list must be searchable
- Product must flag segments that have no pages for the selected month
- Product must distinguish:
  - available segments
  - empty segments
  - segments that could not be loaded

### 8.3 Date filtering

- Product must support:
  - last 12 months
  - month-specific selection
- Month selection must include relevant months across current and prior year
- Changing month must refresh segment availability

### 8.4 Page loading

- Product must load pages for the selected segment and month
- Product must support:
  - load next page
  - load all available pages
- Product must handle larger page batches in controlled chunks
- Product must prevent duplicate page loading

### 8.5 Imported URL workflow

- Product must accept pasted FE URLs
- Product must accept CSV/TSV input
- Product must reject unsupported file input in a user-friendly way
- Imported FE URLs must be normalized into the same review flow as segment-loaded pages

### 8.6 Review and selection

- Product must show all loaded pages before analysis
- User must be able to:
  - select all loaded pages
  - clear selection
  - choose a recommendation count
  - review pages before analysis starts

### 8.7 Analysis modes

- Product must support multiple review modes:
  - FE YMYL / E-E-A-T mode
  - Google HCS / spam audit mode
  - quick local screen mode
- Product must support AI provider/model selection where configured
- Product must support lower-cost and higher-quality paths

### 8.8 Recommendation output

- Every analyzed page must return a usable recommendation object
- The system must avoid showing raw AI/API failure cards to end users
- If model output is invalid or unusable, product must return a grounded fallback recommendation
- Recommendations must be:
  - simple
  - practical
  - editorially actionable
  - safe from hallucinated specifics

### 8.9 Analysis control

- Product must support stopping a run in progress
- Product must stop automatically when repeated paid-provider failures would waste credits

### 8.10 Export and saved outputs

- Product must allow CSV export
- Product must allow saving analysis results locally for later review

## 9. Data and source requirements

### Primary source

- Preprod Financial Express WordPress REST source

Purpose:

- load categories / segments
- load posts by category and date range
- retrieve article content and metadata

### Source requirements

- source access must happen behind the app after login
- product should not require non-technical users to manually open protected backend routes
- category and post retrieval must support month filtering and pagination

### Imported source support

- pasted URLs
- CSV
- TSV
- Google Sheets / Drive exports

## 10. Recommendation quality requirements

Recommendations must:

- be grounded in page content
- avoid fabricated claims
- explain what is weak or missing
- explain how to improve the page in simple language
- focus on editorial actions, not abstract SEO theory

Recommendation structure should include:

- issue summary
- evidence or detected reason
- why it matters
- how to improve
- expected improvement

## 11. Reliability requirements

- Product must return a usable result for every analyzed page
- Product must degrade gracefully when AI output is invalid
- Product must avoid exposing raw backend errors in normal UI flows
- Product must remain operational for larger content batches

### Reliability strategy

- use WordPress source for page retrieval
- use AI output validation
- if AI output fails, use built-in grounded fallback recommendation
- show plain user-facing messages instead of technical failures

## 12. UX requirements

The UI must be understandable by non-technical editorial users.

### UX expectations

- no raw API language in normal workflows
- no need to understand category IDs or backend routes
- clear step-based flow
- clear labels for:
  - loaded
  - no pages
  - could not load
  - ready to review
  - ready to analyze

### UX problems to avoid

- raw JSON boxes in primary workflows
- protected backend links shown to normal users
- raw model/provider failure messages
- confusion between retrieval problems and analysis problems

## 13. Security and guardrails

- no secrets exposed in UI or commits
- server-side protected API access
- session-based access control
- Supabase-backed rate limiting
- daily usage cap support
- provider failures should not silently burn large numbers of requests

## 14. Success metrics

### Product success metrics

- percentage of selected pages that return a usable recommendation
- percentage of segments that load correctly for selected month
- reduction in user-facing technical failure states
- time taken for a user to complete one segment review workflow
- export completion rate

### Experience success metrics

- user can understand the workflow without technical knowledge
- user can retrieve FE pages by month/segment reliably
- user receives actionable output for the pages they review

## 15. Constraints

- Must preserve core FE Content Audit workflow
- Must keep Vercel deployment working
- Must not expose secrets
- Must remain usable on mobile and desktop
- Must support larger page-review workflows
- Must keep model usage cost-aware

## 16. Risks

### Risk 1: AI output inconsistency

Even with a strong retrieval source, model output may be incomplete or invalid.

Mitigation:

- validate output
- fall back to grounded built-in recommendations

### Risk 2: Source gaps by month or segment

Some segments may still return no pages for a selected month.

Mitigation:

- clearly flag empty segments
- distinguish empty vs unavailable

### Risk 3: User confusion

Users may misinterpret technical states as product failure.

Mitigation:

- simplify UX language
- hide backend complexity
- keep workflow step-based

### Risk 4: Cost growth

Large analysis runs can increase paid model usage.

Mitigation:

- lower-cost model options
- quick local screen mode
- rate limiting and daily caps
- selective review counts

## 17. Current product scope summary

In current scope, FE Content Audit should deliver:

- FE segment loading from the source system
- month-based page retrieval
- imported FE URL support
- page review and selection
- scalable analysis flow
- actionable output for every analyzed page
- export and save functionality
- non-technical user experience

## 18. Future opportunities

- better multi-page summaries by segment
- stronger prioritization scoring
- editorial workflow assignment / collaboration
- CMS write-back suggestions
- richer reporting dashboard
- bulk progress monitoring for large jobs

## 19. Product definition in one sentence

FE Content Audit is an internal FE editorial optimization tool that retrieves FE pages by segment or URL, analyzes them at scale, and returns practical content-improvement recommendations in a simple, team-friendly workflow.
