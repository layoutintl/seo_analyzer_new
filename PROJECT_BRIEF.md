# Project Brief: Technical SEO Analyzer

## 1. Project Overview

### What is the project?

Technical SEO Analyzer is an internal SEO audit tool for checking websites, especially news and publishing websites, against a standardized technical SEO checklist.

The current main workflow lets a user enter:

- A homepage URL.
- An article URL.
- Optional section, tag/topic, search, author, and video article URLs.

The tool fetches those pages, runs SEO checks, scores the results, highlights risks, and provides recommendations that can be copied into task tools or downloaded as a Markdown report.

### What problem does it solve?

It reduces the manual effort needed to inspect important SEO signals across multiple page types. Instead of checking each page by hand, the tool automates repeated checks such as robots.txt, sitemap discovery, canonical tags, metadata, headings, schema, indexability, pagination, social metadata, freshness, and performance indicators.

### Who is it built for?

The tool is built for:

- SEO specialists running technical audits.
- Content and editorial SEO teams working on news websites.
- Project managers who need a clear audit summary.
- Developers who need a structured list of SEO fixes.
- Internal teams that need repeatable audit history by project.

## 2. Why We Built It

### Pain points before this tool

- SEO audits required many manual checks across different pages.
- Teams had to inspect source HTML, robots.txt, sitemaps, canonicals, meta tags, schema, and performance signals separately.
- Different team members could interpret the same checklist differently.
- It was easy to miss issues when auditing several page types manually.
- Audit findings were harder to compare over time.
- Turning findings into clear developer tasks took extra effort.

### Why manual work was slow or inefficient

Manual auditing means opening pages, viewing source code, checking headers, testing sitemap URLs, reviewing structured data, checking canonical behavior, and writing recommendations one by one. This is repetitive work and becomes slower when the same website needs repeated audits after fixes, migrations, redesigns, or content changes.

### Why this matters for SEO audits and decisions

Technical SEO decisions depend on reliable evidence. This tool gives the team a consistent way to identify blockers, prioritize issues, and explain what should be fixed first. It also separates confirmed SEO issues from access problems such as bot protection, server errors, or crawler blocking.

## 3. What the Tool Does

### Main features currently implemented

- Technical SEO audit for a homepage and article page.
- Optional checks for section, tag/topic, search, author, and video article pages.
- Project management for storing websites as projects.
- Audit history for past runs when the database is enabled.
- Form prefill from the last audit values saved for a project.
- Audit result polling for database-backed runs.
- In-memory fallback mode when no database is configured.
- Summary score, pass/warning/fail counts, and critical issue count.
- Page-by-page checklist views.
- Site-level checks for robots.txt, general sitemap, and news sitemap.
- Recommendation panel with priority, area, message, and fix guidance.
- Export options:
  - Copy all issues for ClickUp-style task creation.
  - Copy critical-only issues.
  - Download a Markdown audit report.
- Crawl gate handling for pages that cannot be fully audited.
- Layered scoring model covering technical quality, content relevance, freshness, context, and anomaly signals.
- Optional Scrapling sidecar support for sites protected by JavaScript challenges or WAF systems.
- Optional PageSpeed Insights integration when `PAGESPEED_API_KEY` is configured.

### Website/page types it can analyze

The primary analyzer supports:

- Homepage.
- Article page.
- Section page.
- Tag/topic page.
- Search page.
- Author page.
- Video article page.

There are also additional backend/API capabilities for:

- Single-page SEO intelligence.
- Site crawling.
- News SEO module analysis.
- Unified technical/news audit.

Needs confirmation: `SiteCrawler` and `NewsSEO` frontend components exist, and their backend routes are registered, but the current top-level app navigation only exposes `Technical SEO Analyzer` and `Projects`.

### Current checks supported

#### Crawl and indexability

- HTTP status handling.
- Redirect chain tracking.
- Final URL tracking.
- Page state classification:
  - OK.
  - Bot protection challenge.
  - Crawler blocked.
  - Not found.
  - Server error.
  - Parse error.
  - Fetch error.
- Meta robots `noindex` and `nofollow`.
- X-Robots-Tag header checks.
- SSRF guard to block unsafe local/private URLs.
- Crawler access handling using multiple user-agent profiles.

#### robots.txt

- robots.txt discovery.
- HTTP status classification.
- Sitemap directive detection.
- Rule parsing.
- Detection of dangerous `Disallow: /` rules.
- Googlebot-News blocking warning.
- Bot-protection detection on robots.txt.

#### Sitemaps

- General sitemap discovery from robots.txt and priority paths.
- Sitemap XML validation.
- Sitemap index support.
- Child sitemap checking.
- XML namespace checks.
- Required `<loc>` checks.
- Invalid URL detection inside sitemap entries.
- `<lastmod>` format checks.
- Gzip sitemap handling.
- Classification for found, blocked, bot-protected, not found, soft 404, invalid XML, invalid format, and network/server error.
- Dedicated Google News sitemap probing.
- News sitemap namespace and required field checks:
  - `news:publication`.
  - `news:publication_date`.
  - `news:title`.

#### Canonicals

- Canonical tag detection.
- Attribute-order and unquoted-attribute handling.
- Self-referencing canonical checks.
- Canonical mismatch detection.
- Tracking query parameter tolerance.
- Query string warning on canonical URLs.
- Pagination canonical policy checks.
- AMP/canonical consistency in news/unified routes.

Recent change note: recent commits specifically hardened canonical, hreflang, AMP-link, pagination, and meta tag extraction so the parser is less dependent on quoted attributes or a fixed attribute order.

#### Metadata and headings

- Title tag presence and length.
- Meta description presence and length.
- H1 presence and count.
- Duplicate title detection across audited seed URLs.
- Charset detection.
- HTML `lang` attribute detection.
- Viewport meta tag detection.
- Hreflang tag detection, including `x-default`.

#### Structured data

- JSON-LD extraction.
- Microdata type detection.
- RDFa type detection.
- Rich Results eligible type detection.
- Non-eligible but valid schema detection.
- Article/NewsArticle checks.
- WebSite and Organization schema checks.
- Person/ProfilePage checks for author pages.
- VideoObject checks for video pages.
- Required and recommended schema field checks.
- ISO date format checks.
- Author object checks.

#### Content and news signals

- Word count.
- Thin content warning for articles.
- Author/byline detection.
- Publish date detection.
- Main image detection.
- Article published/modified Open Graph tags.
- Internal link count for articles.
- Freshness scoring in layered scoring and news modules.

#### Social metadata

- Open Graph title.
- Open Graph image.
- Open Graph type.
- Twitter card.

#### Pagination

- `rel=next` and `rel=prev` detection.
- URL pagination patterns such as `?page=N`, `?p=N`, and `/page/N`.
- Warning when paginated pages canonicalize to the base URL instead of self-referencing.

#### Performance

- Basic page load timing.
- HTML size.
- Optional PageSpeed Insights score when an API key is configured.
- Optional LCP, CLS, and INP values from PageSpeed Insights.
- Core Web Vitals estimates in news/unified modules.
- Viewport and mobile-friendly indicators in unified audit.

#### Security/access handling

- Unsafe private/local URL blocking through an SSRF guard.
- WAF/bot challenge detection for Cloudflare, Akamai, Imperva/Incapsula, DataDome, PerimeterX, AWS WAF, hCaptcha-style challenges, and generic challenge titles.
- Optional Scrapling sidecar to retry difficult pages using a headless browser-style fetch.

### Limitations

- The tool depends on being able to fetch the target page. Some sites may block automated crawlers or require JavaScript rendering.
- Scrapling helps with some protected pages, but it is optional and slower than normal fetches.
- Without `DATABASE_URL`, audits can run in in-memory mode but are not saved.
- PageSpeed Insights metrics only run when `PAGESPEED_API_KEY` is configured.
- Some performance and Core Web Vitals signals are estimates unless PageSpeed data is available.
- The checker is not a full browser audit unless the sidecar is configured and successful.
- The current README is minimal and does not yet describe the product for users.
- Needs confirmation: whether the standalone `SiteCrawler`, `NewsSEO`, and `Unified Audit` flows are intended to be exposed in the current UI.
- Needs review: the server currently contains a hard-coded database fallback. This should be reviewed before wider internal sharing or production deployment.

## 4. Why It Is Important

### Improves audit quality

The tool applies the same checks every time, across the same page types, with the same definitions of pass, warning, fail, and critical. This makes audits more consistent and easier to compare.

### Standardizes the SEO checklist

Instead of relying on personal memory or separate spreadsheets, the audit checklist is built directly into the tool. This helps the team align around one standard process.

### Reduces human error

The tool catches details that are easy to miss manually, such as:

- Missing or mismatched canonicals.
- Hidden `noindex` or X-Robots-Tag headers.
- Missing schema fields.
- Duplicate titles.
- Invalid sitemap XML.
- Bot-protected sitemap or robots.txt URLs.
- Missing article freshness signals.
- Pagination canonical mistakes.

### Helps faster decision-making

The summary score, critical count, page breakdown, and recommendations help the team quickly decide:

- Whether a site has major crawl/indexing risk.
- Which fixes should be prioritized first.
- Whether an issue is technical, content-related, schema-related, sitemap-related, or performance-related.
- Whether a page truly failed an SEO check or was simply blocked from being audited.

## 5. Time-Saving Value

### Tasks it automates

- Fetching and checking multiple representative URLs.
- Checking robots.txt.
- Discovering and validating sitemap URLs.
- Checking news sitemap presence and required fields.
- Reading canonical, meta robots, X-Robots-Tag, title, description, H1, lang, charset, viewport, hreflang, AMP, OG, and Twitter tags.
- Checking structured data and required schema fields.
- Estimating performance basics.
- Detecting crawl access problems.
- Producing priority recommendations.
- Saving project audit history.
- Preparing task-ready issue text.
- Downloading a reusable Markdown report.

### What used to take manual work

- Opening each page and inspecting source HTML.
- Manually testing sitemap and robots URLs.
- Copying page metadata into spreadsheets.
- Checking schema field completeness.
- Repeating checks after every fix.
- Writing audit recommendations from scratch.
- Comparing whether a new audit looks better or worse than a past one.

### Workflow friction removed

The tool gives SEO specialists a single place to run the audit, view the result, export issues, and return to previous project audits. This reduces context switching between browser tools, code viewers, validators, spreadsheets, and task management systems.

## 6. Current Project Structure

### Frontend overview

Main frontend stack:

- React 18.
- TypeScript.
- Vite.
- Tailwind CSS.
- Lucide React icons.

Main frontend files/folders:

- `src/main.tsx` - React entry point.
- `src/App.tsx` - top-level app navigation and state.
- `src/components/SEOAgent.tsx` - main Technical SEO Analyzer UI, checklist builder, scoring display, exports, and results rendering.
- `src/components/ProjectSelector.tsx` - project selector, create, rename, delete, and last form values integration.
- `src/components/ProjectsPage.tsx` - project list and project management view.
- `src/components/AuditHistoryPanel.tsx` - audit history display and past audit loading.
- `src/components/SiteCrawler.tsx` - site crawler UI component. Needs confirmation if currently exposed in the active UI.
- `src/components/NewsSEO.tsx` - news SEO UI component. Needs confirmation if currently exposed in the active UI.
- `src/index.css` - global styling.

Current top navigation:

- Technical SEO Analyzer.
- Projects.

### Backend overview

Main backend stack:

- Node.js 20.
- Express.
- TypeScript backend modules compiled into `backend/dist`.
- PostgreSQL via `pg`.
- Supabase-style migrations stored in `supabase/migrations`.
- Optional Python Scrapling sidecar for difficult pages.

Main backend files/folders:

- `server/index.js` - Express server, health checks, route mounting, static frontend serving, migration startup, backend route loading.
- `backend/src/routes/auditRunsSimple.ts` - main technical analyzer API and audit result polling.
- `backend/src/routes/projects.ts` - project management and audit history API.
- `backend/src/services/checks/siteChecks.ts` - robots.txt, sitemap, and news sitemap checks.
- `backend/src/services/checks/page/canonicalCheck.ts` - canonical and page type detection.
- `backend/src/services/checks/page/contentMetaCheck.ts` - title, description, headings, robots meta, social tags, hreflang, AMP, content signals.
- `backend/src/services/checks/page/structuredDataCheck.ts` - JSON-LD, microdata, RDFa, Rich Results eligibility, required schema fields.
- `backend/src/services/checks/page/paginationCheck.ts` - pagination pattern and canonical policy checks.
- `backend/src/services/checks/page/performanceCheck.ts` - basic performance and optional PageSpeed Insights.
- `backend/src/services/fetch/fetchEngine.ts` - multi-profile fetch engine and bot-protection classification.
- `backend/src/services/checks/scoring.ts` - recommendations and priority scoring.
- `backend/src/services/checks/scoring/` - layered scoring model.
- `server/routes/seo-site-crawler.js` - site crawler endpoint.
- `server/routes/news-seo.js` - news SEO endpoint and sitemap compliance check.
- `server/routes/seo-intelligence.js` - older single-page technical SEO endpoint.
- `server/routes/unified-audit.js` - combined technical/news audit endpoint.
- `server/lib/modules/` - supporting modules for sitemap discovery, article schema, core web vitals, AMP, freshness, migration checks, internal linking, crawl depth, duplicate protection, and canonical consistency.

### Database/storage

Database mode uses PostgreSQL. Main tables:

- `sites` - one row per audited domain/project.
- `seed_urls` - the URLs used in an audit, including page type.
- `audit_runs` - audit run status, timestamps, and site-level checks.
- `audit_results` - page-level audit data, status, and recommendations.
- `schema_migrations` - migration tracking table created by the migration runner.

Project-layer columns:

- `project_name`.
- `website_url`.
- `last_audit_at`.
- `last_form_values`.

Indexes and triggers:

- Indexes for audit runs, audit results, seed URLs, domain lookup, and last audit sorting.
- Trigger to update `sites.last_audit_at` when an audit run completes.
- Trigger to keep `sites.updated_at` current.

### APIs and integrations used

- Internal Express APIs under `/api`.
- PostgreSQL database through `DATABASE_URL`.
- Optional Scrapling sidecar through `SCRAPLING_SIDECAR_URL`.
- Optional Google PageSpeed Insights through `PAGESPEED_API_KEY`.
- Docker Compose can run PostgreSQL, the Node app, and the Scrapling sidecar together.

Main API routes:

- `GET /health`
- `GET /api/health`
- `POST /api/technical-analyzer/run`
- `GET /api/audit-runs/:id/results`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id`
- `PATCH /api/projects/:id`
- `DELETE /api/projects/:id`
- `GET /api/projects/:id/audits`
- `GET /api/projects/:id/audits/latest`
- `PATCH /api/projects/:id/form-values`
- `GET /api/audits/compare?a=<id>&b=<id>`
- `POST /api/seo-site-crawler`
- `POST /api/news-seo`
- `POST /api/news-seo/compliance`
- `POST /api/seo-intelligence`
- `POST /api/unified-audit`

## 7. Short Checklist

### Already working

- Main technical analyzer UI.
- Homepage and article audit flow.
- Optional URL inputs for section, tag/topic, search, author, and video article pages.
- Project creation, selection, rename, and deletion.
- Audit history loading for saved projects.
- Database-backed audit persistence when `DATABASE_URL` is configured.
- In-memory audit fallback when database is unavailable.
- robots.txt, sitemap, news sitemap, canonical, metadata, schema, pagination, social, content, and performance checks.
- Crawl gate handling for blocked or unavailable pages.
- Export to ClickUp-style issue text and Markdown report.
- Tests exist for important parsing and fetch-edge cases, including canonical parsing, metadata extraction, pagination, HTML attributes, fetch engine behavior, bot protection, and page-state classification.

### Needs review

- Confirm whether `SiteCrawler`, `NewsSEO`, and `Unified Audit` should be shown in the active frontend navigation.
- Review the hard-coded database fallback in `server/index.js` before wider deployment.
- Confirm intended authentication/access model for projects and audit history.
- Review public database policies if the tool will be exposed beyond a trusted internal environment.
- Confirm whether PageSpeed Insights should be enabled for production audits.
- Confirm whether Scrapling should be required for news sites with WAF/Cloudflare protection.
- Expand the README so non-developers and operators understand how to run and use the tool.

### Can be improved next

- Add a user-facing guide for running audits and interpreting results.
- Add a clearer dashboard for comparing audit runs over time.
- Expose the audit comparison endpoint in the UI.
- Add role-based access if multiple teams or clients will use the same deployment.
- Add clearer labels for in-memory vs database mode in the UI.
- Add more export formats if needed, such as CSV or PDF.
- Add a navigation decision for crawler/news/unified audit modules.
- Add deployment notes and environment setup documentation.

### Should not be changed without careful review

- Existing checklist logic in `SEOAgent.tsx`.
- Scoring thresholds and recommendation priorities in `backend/src/services/checks/scoring.ts`.
- Page state classification in `backend/src/routes/auditRunsSimple.ts`.
- Bot-protection detection in `backend/src/services/fetch/fetchEngine.ts`.
- Canonical, metadata, hreflang, AMP, and pagination parsing helpers.
- Sitemap classification rules in `backend/src/services/checks/siteChecks.ts`.
- Database schema and migration order.
- Export text structure used for task creation.

Changing these areas could affect the existing audit checklist, scoring consistency, or historical comparability of audit results.

## 8. Presentation Summary

Technical SEO Analyzer is an internal tool that helps our team audit websites faster and more consistently.

Instead of manually checking every page, sitemap, canonical tag, schema field, and indexing signal, the tool runs a structured SEO checklist automatically. It reviews the homepage, article pages, and optional page types such as sections, tags, search pages, author pages, and video articles.

The business value is speed and consistency. The team gets a clear audit result, priority issues, and ready-to-use recommendations without spending hours repeating the same manual checks.

The SEO value is better quality control. The tool helps catch indexing blockers, sitemap problems, missing schema, canonical mistakes, metadata issues, pagination risks, and news-specific signals that can affect search visibility.

The workflow value is that audits become easier to repeat and track. Projects can store past audits, load previous results, and keep the last-used URLs, so the team can re-check a website after fixes and quickly see what still needs attention.

The tool does not replace SEO judgment. It gives the team a reliable first pass, highlights risks, and creates a shared checklist so specialists can focus on decisions, prioritization, and strategy.

## Internal Presenter Notes

Use this simple explanation:

"This tool is our technical SEO audit assistant. We give it the key pages from a website, and it checks the main SEO signals that we normally inspect manually: crawlability, indexing, sitemaps, canonicals, metadata, headings, schema, news signals, and basic performance. It then gives us a score, a clear list of issues, and recommendations we can turn into tasks. The goal is not to replace the SEO team, but to remove repetitive checking, reduce missed issues, and make every audit follow the same standard."

## Needs Confirmation

- Whether standalone crawler and news SEO screens should be considered active user-facing features.
- Whether the unified audit endpoint is planned for the current UI or only kept as an API capability.
- Whether the project is intended only for internal trusted use or for broader client/team access.
- Whether database persistence is required in every deployment or optional by design.
- Whether Scrapling and PageSpeed Insights should be standard production dependencies or optional enhancements.
