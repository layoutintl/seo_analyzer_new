/**
 * paginationCheck.test.ts
 *
 * Focused tests for the hasRelLink() fix in paginationCheck.
 *
 * Before the fix, hasRelLink() used a regex that required rel="next" or
 * rel='next' (quoted values only).  Unquoted rel=next (valid HTML5) was
 * silently missed, causing pagination to go undetected.
 *
 * Tests are driven through runPaginationCheck() on a page type that actually
 * triggers the pagination check ('search').
 */

import { describe, it, expect } from 'vitest';
import { runPaginationCheck } from '../paginationCheck.js';

const PAGE_URL = 'https://example.com/search/?q=test&page=2';
const CANONICAL = 'https://example.com/search/?q=test&page=2';

function run(html: string) {
  return runPaginationCheck(html, PAGE_URL, 'search', CANONICAL);
}

// ── rel=next detection ──────────────────────────────────────────────────────

describe('hasRelLink — rel=next detection', () => {
  it('double-quoted rel="next"', () => {
    const r = run('<link rel="next" href="https://example.com/search/?q=test&page=3">');
    expect(r.detectedPagination).toBe(true);
  });

  it('single-quoted rel=\'next\'', () => {
    const r = run("<link rel='next' href='https://example.com/search/?q=test&page=3'>");
    expect(r.detectedPagination).toBe(true);
  });

  it('unquoted rel=next (the bug class)', () => {
    const r = run('<link rel=next href="https://example.com/search/?q=test&page=3">');
    expect(r.detectedPagination).toBe(true);
  });

  it('reversed attribute order: href before rel', () => {
    const r = run('<link href="https://example.com/search/?q=test&page=3" rel="next">');
    expect(r.detectedPagination).toBe(true);
  });

  it('uppercase REL="NEXT"', () => {
    const r = run('<LINK REL="next" HREF="https://example.com/search/?q=test&page=3">');
    expect(r.detectedPagination).toBe(true);
  });
});

// ── rel=prev detection ──────────────────────────────────────────────────────

describe('hasRelLink — rel=prev detection', () => {
  it('double-quoted rel="prev"', () => {
    const r = run('<link rel="prev" href="https://example.com/search/?q=test&page=1">');
    expect(r.detectedPagination).toBe(true);
  });

  it('unquoted rel=prev (the bug class)', () => {
    const r = run('<link rel=prev href="https://example.com/search/?q=test&page=1">');
    expect(r.detectedPagination).toBe(true);
  });
});

// ── No pagination ───────────────────────────────────────────────────────────

describe('hasRelLink — no false positives', () => {
  it('does not detect pagination when only rel=canonical is present', () => {
    const r = runPaginationCheck(
      '<link rel="canonical" href="https://example.com/search/?q=test">',
      'https://example.com/search/?q=test',
      'search',
      'https://example.com/search/?q=test',
    );
    // No page param in URL, no rel=next/prev → no pagination
    expect(r.detectedPagination).toBe(false);
  });

  it('does not run pagination check for article pages', () => {
    const r = runPaginationCheck(
      '<link rel="next" href="https://example.com/page/2">',
      'https://example.com/article/foo',
      'article',  // not in the relevant types list
      null,
    );
    expect(r.detectedPagination).toBe(false);
  });
});

// ── Pattern label ───────────────────────────────────────────────────────────

describe('runPaginationCheck — pattern label', () => {
  it('records rel=next/prev as the pattern', () => {
    const r = run('<link rel="next" href="https://example.com/search/?q=test&page=3">');
    expect(r.pattern).toContain('rel=next/prev');
  });
});
