import { describe, it, expect } from 'vitest';
import { analyzeNewsSitemapXml } from '../newsSitemapAnalyzer.js';

const NOW = Date.parse('2026-06-18T12:00:00+04:00');

function ctx(extra: Record<string, unknown> = {}) {
  return {
    url: 'https://www.emirates247.com/news-sitemap.xml',
    finalUrl: 'https://www.emirates247.com/news-sitemap.xml',
    httpStatus: 200,
    contentType: 'application/xml',
    options: { now: NOW, ...extra },
  };
}

const VALID = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://www.emirates247.com/uae/maktoum-strategic-plan/2722</loc>
    <news:news>
      <news:publication>
        <news:name>Emirates24|7</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>2026-06-18T10:55:00+04:00</news:publication_date>
      <news:title>Maktoum bin Mohammed launches the Ministry of Finance's strategic plan 2027-2029</news:title>
    </news:news>
    <image:image>
      <image:loc>https://api.emirates247.com/uploads/2026/06/18/4151.webp</image:loc>
      <image:caption><![CDATA[ Sheikh Maktoum bin Mohammed ]]></image:caption>
    </image:image>
  </url>
</urlset>`;

describe('analyzeNewsSitemapXml', () => {
  it('scores a valid Google News sitemap as Excellent with no critical issues', () => {
    const r = analyzeNewsSitemapXml(VALID, ctx({ expectedPublicationName: 'Emirates24|7' }));
    expect(r.summary.totalUrls).toBe(1);
    expect(r.summary.validNewsUrls).toBe(1);
    expect(r.summary.criticalIssues).toBe(0);
    expect(r.score).toBe(100);
    expect(r.status).toBe('Excellent');
    expect(r.publicationNames).toEqual(['Emirates24|7']);
    expect(r.languages).toEqual(['en']);
    // CDATA caption must parse without error and not be treated as a problem.
    expect(r.summary.imageIssues).toBe(0);
    // All three namespaces (sitemap + news + image) must be recognised.
    expect(r.scoreBreakdown.namespaces).toBe(15);
    expect(r.summary.namespaceIssues).toBe(0);
    expect(r.issues.some(i => i.type === 'missing_image_namespace')).toBe(false);
  });

  it('flags a missing news:title as a critical issue with the spec issue shape', () => {
    const xml = VALID.replace(/<news:title>.*?<\/news:title>/s, '');
    const r = analyzeNewsSitemapXml(xml, ctx());
    const issue = r.issues.find(i => i.type === 'missing_news_title');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('critical');
    expect(issue!.field).toBe('news:title');
    expect(issue!.url).toContain('emirates247.com');
    expect(typeof issue!.recommendation).toBe('string');
    expect(r.summary.validNewsUrls).toBe(0);
    expect(r.score).toBeLessThan(90);
  });

  it('detects a missing news namespace as critical', () => {
    const xml = VALID.replace(/\s+xmlns:news="[^"]*"/, '');
    const r = analyzeNewsSitemapXml(xml, ctx());
    expect(r.issues.some(i => i.type === 'missing_news_namespace' && i.severity === 'critical')).toBe(true);
    expect(r.summary.namespaceIssues).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid XML with a critical issue and zero structure score', () => {
    const r = analyzeNewsSitemapXml('<urlset><url><loc>oops', ctx());
    expect(r.issues.some(i => i.type === 'invalid_xml' && i.severity === 'critical')).toBe(true);
    expect(r.scoreBreakdown.xmlValidity).toBe(0);
  });

  it('treats an empty response as critical', () => {
    const r = analyzeNewsSitemapXml('   ', ctx());
    expect(r.issues.some(i => i.type === 'empty_response')).toBe(true);
    expect(r.score).toBeLessThan(50);
  });

  it('detects duplicate <loc> values', () => {
    const dup = VALID.replace('</urlset>', `
      <url>
        <loc>https://www.emirates247.com/uae/maktoum-strategic-plan/2722</loc>
        <news:news>
          <news:publication><news:name>Emirates24|7</news:name><news:language>en</news:language></news:publication>
          <news:publication_date>2026-06-18T10:50:00+04:00</news:publication_date>
          <news:title>Duplicate entry</news:title>
        </news:news>
      </url></urlset>`);
    const r = analyzeNewsSitemapXml(dup, ctx());
    expect(r.summary.duplicateUrls).toBe(1);
    expect(r.issues.some(i => i.type === 'duplicate_loc')).toBe(true);
  });

  it('warns on a publication_date without timezone and on stale dates', () => {
    const noTz = VALID.replace('2026-06-18T10:55:00+04:00', '2026-06-18T10:55:00');
    const r1 = analyzeNewsSitemapXml(noTz, ctx());
    expect(r1.issues.some(i => i.type === 'publication_date_no_timezone')).toBe(true);

    const old = VALID.replace('2026-06-18T10:55:00+04:00', '2026-06-01T10:55:00+04:00');
    const r2 = analyzeNewsSitemapXml(old, ctx());
    expect(r2.issues.some(i => i.type === 'publication_date_old')).toBe(true);
    expect(r2.summary.oldOrInvalidDates).toBeGreaterThanOrEqual(1);
  });

  it('flags a sitemap index instead of analyzing it directly', () => {
    const index = `<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://www.emirates247.com/news-sitemap-1.xml</loc></sitemap>
      </sitemapindex>`;
    const r = analyzeNewsSitemapXml(index, ctx());
    expect(r.isSitemapIndex).toBe(true);
    expect(r.childSitemaps).toContain('https://www.emirates247.com/news-sitemap-1.xml');
    expect(r.issues.some(i => i.type === 'sitemap_index_provided')).toBe(true);
  });

  it('flags escaped raw HTML inside a news:title', () => {
    // A real sitemap would escape embedded HTML; the parser decodes the
    // entities back to "<b>...</b>", which is what we flag as raw HTML.
    const html = VALID.replace(
      "Maktoum bin Mohammed launches the Ministry of Finance's strategic plan 2027-2029",
      'Breaking &lt;b&gt;news&lt;/b&gt; story',
    );
    const r = analyzeNewsSitemapXml(html, ctx());
    expect(r.issues.some(i => i.type === 'news_title_contains_html')).toBe(true);
  });
});
