/**
 * contentMetaCheck.test.ts
 *
 * Focused tests for the attribute-parsing fixes in contentMetaCheck:
 *   - extractHreflangTags(): previously missed 3/6 attribute orderings and
 *     required quoted values; now uses walkLinkTags + getAttrValue.
 *   - extractAmpLink(): same bug class as the canonical false-negative;
 *     rel=amphtml (unquoted) was not detected.
 *
 * Tests are driven through the public runContentMetaCheck() function and
 * inspect the hreflangTags / hasAmpLink / ampUrl fields of the result.
 */

import { describe, it, expect } from 'vitest';
import { runContentMetaCheck } from '../contentMetaCheck.js';

// Minimal HTML wrapper so other checks don't fire errors we don't care about
function wrap(head: string): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<title>Test page title that is long enough</title>
<meta name="description" content="A sufficiently long meta description for testing purposes only here.">
<meta name="viewport" content="width=device-width">
<h1>Test heading</h1>
${head}
</head><body><p>content</p></body></html>`;
}

function run(head: string) {
  return runContentMetaCheck(wrap(head), 'home', new Set(), { pageUrl: 'https://example.com/' });
}

// ── extractHreflangTags ─────────────────────────────────────────────────────

describe('extractHreflangTags — attribute orderings', () => {
  it('order 1: rel → hreflang → href (standard)', () => {
    const r = run('<link rel="alternate" hreflang="en" href="https://example.com/en/">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('order 2: rel → href → hreflang', () => {
    const r = run('<link rel="alternate" href="https://example.com/en/" hreflang="en">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('order 3: hreflang → href → rel', () => {
    const r = run('<link hreflang="en" href="https://example.com/en/" rel="alternate">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('order 4: hreflang → rel → href', () => {
    const r = run('<link hreflang="en" rel="alternate" href="https://example.com/en/">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('order 5: href → rel → hreflang', () => {
    const r = run('<link href="https://example.com/en/" rel="alternate" hreflang="en">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('order 6: href → hreflang → rel', () => {
    const r = run('<link href="https://example.com/en/" hreflang="en" rel="alternate">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });
});

describe('extractHreflangTags — quoting styles', () => {
  it('single-quoted attribute values', () => {
    const r = run("<link rel='alternate' hreflang='en' href='https://example.com/en/'>");
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('unquoted hreflang and rel values', () => {
    const r = run('<link rel=alternate hreflang=en href="https://example.com/en/">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('uppercase attribute names', () => {
    const r = run('<LINK REL="alternate" HREFLANG="en" HREF="https://example.com/en/">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });
});

describe('extractHreflangTags — multiple tags and deduplication', () => {
  it('collects multiple hreflang entries', () => {
    const head = [
      '<link rel="alternate" hreflang="en" href="https://example.com/en/">',
      '<link rel="alternate" hreflang="ar" href="https://example.com/ar/">',
      '<link rel="alternate" hreflang="fr" href="https://example.com/fr/">',
    ].join('\n');
    const r = run(head);
    expect(r.hreflangTags).toHaveLength(3);
    expect(r.hreflangTags.map(t => t.hreflang).sort()).toEqual(['ar', 'en', 'fr']);
  });

  it('deduplicates identical hreflang + href pairs', () => {
    const head = [
      '<link rel="alternate" hreflang="en" href="https://example.com/en/">',
      '<link rel="alternate" hreflang="en" href="https://example.com/en/">',
    ].join('\n');
    const r = run(head);
    expect(r.hreflangTags).toHaveLength(1);
  });

  it('ignores non-alternate link tags', () => {
    const head = [
      '<link rel="canonical" href="https://example.com/">',
      '<link rel="stylesheet" href="style.css">',
      '<link rel="alternate" hreflang="en" href="https://example.com/en/">',
    ].join('\n');
    const r = run(head);
    expect(r.hreflangTags).toHaveLength(1);
    expect(r.hreflangTags[0].hreflang).toBe('en');
  });

  it('returns empty array when no hreflang tags present', () => {
    const r = run('<link rel="canonical" href="https://example.com/">');
    expect(r.hreflangTags).toEqual([]);
  });
});

// ── extractAmpLink ──────────────────────────────────────────────────────────

describe('extractAmpLink — quoting styles and attribute order', () => {
  it('standard: rel="amphtml" before href', () => {
    const r = run('<link rel="amphtml" href="https://example.com/amp/">');
    expect(r.hasAmpLink).toBe(true);
    expect(r.ampUrl).toBe('https://example.com/amp/');
  });

  it('reversed: href before rel="amphtml"', () => {
    const r = run('<link href="https://example.com/amp/" rel="amphtml">');
    expect(r.hasAmpLink).toBe(true);
    expect(r.ampUrl).toBe('https://example.com/amp/');
  });

  it('unquoted rel=amphtml', () => {
    const r = run('<link href="https://example.com/amp/" rel=amphtml>');
    expect(r.hasAmpLink).toBe(true);
    expect(r.ampUrl).toBe('https://example.com/amp/');
  });

  it('single-quoted values', () => {
    const r = run("<link rel='amphtml' href='https://example.com/amp/'>");
    expect(r.hasAmpLink).toBe(true);
    expect(r.ampUrl).toBe('https://example.com/amp/');
  });

  it('uppercase tag and attribute names', () => {
    const r = run('<LINK REL="amphtml" HREF="https://example.com/amp/">');
    expect(r.hasAmpLink).toBe(true);
    expect(r.ampUrl).toBe('https://example.com/amp/');
  });

  it('no AMP link returns false / null', () => {
    const r = run('<link rel="canonical" href="https://example.com/">');
    expect(r.hasAmpLink).toBe(false);
    expect(r.ampUrl).toBeNull();
  });
});
