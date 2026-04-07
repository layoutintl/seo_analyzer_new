/**
 * Google News Sitemap Compliance Detector
 *
 * Pure function — accepts sitemap data + optional GSC metrics and returns
 * a structured issue object (or null) describing non-compliance with
 * Google News sitemap requirements.
 *
 * Usage:
 *   import { detectNewsSitemapComplianceIssue } from './news-sitemap-compliance.js';
 *
 *   const issue = detectNewsSitemapComplianceIssue({
 *     sitemapType: 'news',           // 'news' | 'general' | null
 *     sitemapXml: '<urlset ...>',    // raw XML string (optional)
 *     submittedUrls: 500,            // from GSC (optional)
 *     indexedUrls: 80,               // total indexed from GSC (optional)
 *     newsIndexedUrls: 12,           // indexed in Google News from GSC (optional)
 *     webIndexedUrls: 68,            // indexed in web search from GSC (optional)
 *     newsSitemapResult: { ... },    // result from analyzeNewsSitemap() (optional)
 *   });
 *
 *   // Returns an issue object or null (no issue / not a news sitemap)
 */

const REQUIRED_NEWS_TAGS = [
  'news:publication',
  'news:publication_date',
  'news:title',
];

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Check whether the raw XML represents a Google News sitemap.
 * @param {string} xml
 * @returns {boolean}
 */
function xmlIsNewsSitemap(xml) {
  return xml.includes('xmlns:news=') || xml.includes('<news:');
}

/**
 * Check for presence of required news tags in raw XML.
 * Returns an array of tag names that are MISSING.
 * @param {string} xml
 * @returns {string[]}
 */
function findMissingNewsTags(xml) {
  return REQUIRED_NEWS_TAGS.filter(tag => {
    // Match opening tag (with or without attributes)
    const pattern = new RegExp(`<${tag.replace(':', ':')}[\\s>]`, 'i');
    return !pattern.test(xml);
  });
}

/**
 * Round a number to one decimal place.
 * @param {number} n
 * @returns {number}
 */
function round1(n) {
  return Math.round(n * 10) / 10;
}

// ── Main detector ─────────────────────────────────────────────────

/**
 * Detect Google News sitemap compliance issues.
 *
 * @param {object} params
 * @param {string|null}  params.sitemapType       - 'news' | 'general' | null
 * @param {string}       [params.sitemapXml]      - raw XML of the sitemap
 * @param {number}       [params.submittedUrls]   - total URLs in sitemap (GSC)
 * @param {number}       [params.indexedUrls]     - total indexed URLs (GSC)
 * @param {number}       [params.newsIndexedUrls] - URLs indexed in Google News (GSC)
 * @param {number}       [params.webIndexedUrls]  - URLs indexed in web search (GSC)
 * @param {object}       [params.newsSitemapResult] - output of analyzeNewsSitemap()
 *
 * @returns {object|null} Issue object, or null if no issue / not a news sitemap.
 */
export function detectNewsSitemapComplianceIssue({
  sitemapType = null,
  sitemapXml = null,
  submittedUrls = null,
  indexedUrls = null,
  newsIndexedUrls = null,
  webIndexedUrls = null,
  newsSitemapResult = null,
} = {}) {

  // ── Step 1: Confirm this is a news sitemap ────────────────────
  const isNewsByType   = sitemapType === 'news';
  const isNewsByXml    = typeof sitemapXml === 'string' && xmlIsNewsSitemap(sitemapXml);
  const isNewsByResult = newsSitemapResult != null && (newsSitemapResult.news_urls ?? 0) > 0;

  if (!isNewsByType && !isNewsByXml && !isNewsByResult) {
    return null; // Not a news sitemap — nothing to flag
  }

  // ── Step 2: Calculate indexation rate ────────────────────────
  let dataSource = 'sitemap_analysis';
  let effectiveSubmitted = submittedUrls;
  let effectiveIndexed   = indexedUrls;

  // Fall back to structural data when GSC figures are absent
  if (effectiveSubmitted == null && newsSitemapResult != null) {
    effectiveSubmitted = newsSitemapResult.total_urls ?? 0;
  }
  if (effectiveIndexed == null && newsSitemapResult != null) {
    // Use news_urls (fresh URLs) as an indexed-URL proxy
    effectiveIndexed = newsSitemapResult.news_urls ?? 0;
  }

  if (submittedUrls != null || indexedUrls != null) {
    dataSource = 'gsc';
  }

  // Guard: no usable numbers at all
  const hasUsableData = effectiveSubmitted != null && effectiveSubmitted > 0;

  let indexRate = null;
  if (hasUsableData && effectiveIndexed != null) {
    indexRate = (effectiveIndexed / effectiveSubmitted) * 100;
  }

  // ── Step 3: Determine severity ────────────────────────────────
  let severity = null;

  if (!hasUsableData) {
    // Cannot compute rate — check structural compliance only
    // If we at least confirmed it's a news sitemap, treat as warning unless
    // the existing result already flags it as fully passing.
    if (newsSitemapResult?.status === 'PASS') {
      // Structural analysis says it's fine — no GSC data to say otherwise
      // Only flag if XML tags are missing
    } else {
      severity = 'warning';
    }
  } else if (
    indexRate < 20 ||
    newsIndexedUrls === 0
  ) {
    severity = 'critical';
  } else if (indexRate < 50) {
    severity = 'warning';
  } else {
    // ≥ 50% indexed AND news_indexed > 0 (or unknown) — check structural tags
    // If tags are fine, no issue. Structural check happens below.
  }

  // ── Step 4: Structural validation ────────────────────────────
  let missingTags = [];

  if (typeof sitemapXml === 'string' && isNewsByXml) {
    missingTags = findMissingNewsTags(sitemapXml);
  } else if (newsSitemapResult != null) {
    // Infer structural issues from existing module issues
    const issueMessages = (newsSitemapResult.issues ?? []).map(i => i.message ?? '');
    if (issueMessages.some(m => /publication_date/i.test(m))) {
      missingTags.push('news:publication_date');
    }
    if (issueMessages.some(m => /news:title/i.test(m))) {
      missingTags.push('news:title');
    }
  }

  const hasStructuralIssues = missingTags.length > 0;

  // If indexRate ≥ 50 and no structural issues, return null (compliant)
  if (severity === null && !hasStructuralIssues) {
    return null;
  }

  // Promote to at least warning when there are structural problems but indexRate was fine
  if (severity === null && hasStructuralIssues) {
    severity = 'warning';
  }

  // ── Step 5: Build issue object ────────────────────────────────
  const displayRate = indexRate != null ? round1(indexRate) : null;
  const rateStr     = displayRate != null ? `${displayRate}%` : 'unknown';

  let description = `Google News sitemap is not properly structured or recognized.`;
  if (displayRate != null) {
    description += ` Only ${rateStr} of URLs are indexed.`;
  }
  if (hasStructuralIssues) {
    description += ` Non-compliant News Sitemap — missing required tags.`;
  }

  const recommendations = [];

  if (hasStructuralIssues) {
    if (missingTags.includes('news:publication')) {
      recommendations.push(
        'Add <news:publication><news:name>Your Publication Name</news:name><news:language>en</news:language></news:publication> to each <url> block.',
      );
    }
    if (missingTags.includes('news:publication_date')) {
      recommendations.push(
        'Add <news:publication_date> in W3C format (e.g. 2024-01-15T12:00:00Z) for every article — Google News uses this to determine freshness.',
      );
    }
    if (missingTags.includes('news:title')) {
      recommendations.push(
        'Add <news:title> matching the article headline to each <url> block.',
      );
    }
  }

  if (severity === 'critical') {
    recommendations.push(
      'Verify that your news sitemap is submitted in Google Search Console under Sitemaps.',
      'Ensure the sitemap uses the Google News namespace: xmlns:news="http://www.google.com/schemas/sitemap-news/0.9".',
      'Remove articles older than 48 hours from the news sitemap — Google News only indexes fresh content.',
    );
    if (newsIndexedUrls === 0) {
      recommendations.push(
        'Zero URLs are indexed in Google News. Check the Manual Actions report in GSC and ensure your publication is eligible for Google News.',
      );
    }
  } else {
    recommendations.push(
      'Improve sitemap freshness — only include articles published within the last 48 hours.',
      'Submit the news sitemap URL directly in Google Search Console → Sitemaps.',
      'Keep the sitemap under 1,000 URLs and update it continuously as new articles are published.',
    );
  }

  return {
    issue_title: 'News Sitemap Not Compliant with Google News',
    severity,
    category: 'Technical SEO',
    description,
    details: {
      submitted_urls:  effectiveSubmitted ?? null,
      indexed_urls:    effectiveIndexed   ?? null,
      index_rate:      displayRate,
      news_indexed:    newsIndexedUrls    ?? null,
      web_indexed:     webIndexedUrls     ?? null,
      missing_tags:    missingTags,
      data_source:     dataSource,
    },
    impact:
      'Low indexation prevents content from appearing in Google News, Top Stories, and Discover feeds. ' +
      'Structural non-compliance causes Google to ignore the sitemap entirely, resulting in delayed or zero ' +
      'indexation of published articles and significant loss of news-driven organic traffic.',
    recommendation: recommendations,
    priority_score: 'HIGH',
  };
}
