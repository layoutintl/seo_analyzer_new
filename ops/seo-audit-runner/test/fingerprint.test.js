import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintIssue,
  normalizeUrlForFingerprint,
  normalizeMessageIdentity,
  stableIssueCode,
} from '../src/fingerprint.js';

const issue = (over = {}) => ({
  area: 'meta',
  message: 'Missing title tag',
  fixHint: 'Add a title',
  pageUrl: 'https://example.com/page',
  pageType: 'home',
  source: 'page',
  ...over,
});

test('same issue produces the same fingerprint', () => {
  assert.equal(fingerprintIssue('p1', issue()), fingerprintIssue('p1', issue()));
});

test('volatile fields (timestamps, run IDs, ordering) do not affect the fingerprint', () => {
  const a = fingerprintIssue('p1', issue());
  const b = fingerprintIssue('p1', {
    ...issue(),
    auditRunId: 'run-999',
    firstSeenAt: '2026-01-01T00:00:00Z',
    position: 42,
    elapsedMs: 1234,
  });
  assert.equal(a, b);
});

test('whitespace changes do not change the fingerprint', () => {
  const a = fingerprintIssue('p1', issue({ message: 'Missing   title \n tag ' }));
  const b = fingerprintIssue('p1', issue({ message: 'Missing title tag' }));
  assert.equal(a, b);
});

test('URL fragments and default ports do not change the fingerprint', () => {
  const base = fingerprintIssue('p1', issue({ pageUrl: 'https://example.com/page' }));
  assert.equal(fingerprintIssue('p1', issue({ pageUrl: 'https://example.com/page#section' })), base);
  assert.equal(fingerprintIssue('p1', issue({ pageUrl: 'https://EXAMPLE.com:443/page' })), base);
  assert.equal(fingerprintIssue('p1', issue({ pageUrl: 'https://example.com/page/' })), base);
});

test('different meaningful paths produce different fingerprints', () => {
  const a = fingerprintIssue('p1', issue({ pageUrl: 'https://example.com/page-a' }));
  const b = fingerprintIssue('p1', issue({ pageUrl: 'https://example.com/page-b' }));
  assert.notEqual(a, b);
  // meaningful query info is preserved
  const q1 = fingerprintIssue('p1', issue({ pageUrl: 'https://example.com/p?id=1' }));
  const q2 = fingerprintIssue('p1', issue({ pageUrl: 'https://example.com/p?id=2' }));
  assert.notEqual(q1, q2);
});

test('different projects produce different fingerprints', () => {
  assert.notEqual(fingerprintIssue('p1', issue()), fingerprintIssue('p2', issue()));
});

test('different areas or page types produce different fingerprints', () => {
  assert.notEqual(
    fingerprintIssue('p1', issue({ area: 'meta' })),
    fingerprintIssue('p1', issue({ area: 'schema' })),
  );
  assert.notEqual(
    fingerprintIssue('p1', issue({ pageType: 'home' })),
    fingerprintIssue('p1', issue({ pageType: 'article' })),
  );
});

test('HTTP 404 and HTTP 500 produce different fingerprints', () => {
  const notFound = fingerprintIssue('p1', issue({ message: 'Page returned HTTP 404' }));
  const serverError = fingerprintIssue('p1', issue({ message: 'Page returned HTTP 500' }));
  assert.notEqual(notFound, serverError);
});

test('301 and 302 redirect issues produce different fingerprints', () => {
  const permanent = fingerprintIssue('p1', issue({ area: 'canonical', message: 'Redirect uses 301' }));
  const temporary = fingerprintIssue('p1', issue({ area: 'canonical', message: 'Redirect uses 302' }));
  assert.notEqual(permanent, temporary);
});

test('different element counts do not silently collapse without a stable issue code', () => {
  const one = fingerprintIssue('p1', issue({ message: '1 missing H1' }));
  const two = fingerprintIssue('p1', issue({ message: '2 missing H1 elements' }));
  assert.notEqual(one, two);
});

test('a shared stable issue code proves two wordings are the same issue type', () => {
  const one = fingerprintIssue('p1', issue({ code: 'MISSING_H1', message: '1 missing H1' }));
  const two = fingerprintIssue('p1', issue({ code: 'MISSING_H1', message: '2 missing H1 elements' }));
  assert.equal(one, two, 'same code + same URL/area/pageType = same issue despite wording');
});

test('stable issue codes take priority over human-readable wording', () => {
  // Same message, different codes → different issues.
  const a = fingerprintIssue('p1', issue({ code: 'NOINDEX_PAGE', message: 'Indexing problem' }));
  const b = fingerprintIssue('p1', issue({ code: 'BLOCKED_BY_ROBOTS', message: 'Indexing problem' }));
  assert.notEqual(a, b);
  // Code recognized from any supported field name, case-insensitively.
  assert.equal(stableIssueCode({ code: ' Missing_H1 ' }), 'missing_h1');
  assert.equal(stableIssueCode({ issueCode: 'X1' }), 'x1');
  assert.equal(stableIssueCode({ checkId: 'c9' }), 'c9');
  assert.equal(stableIssueCode({ message: 'no code here' }), null);
});

test('site-wide issues fingerprint separately from page issues', () => {
  const sitewide = fingerprintIssue('p1', issue({ source: 'site', pageUrl: null }));
  const page = fingerprintIssue('p1', issue());
  assert.notEqual(sitewide, page);
});

test('URL normalization details', () => {
  assert.equal(normalizeUrlForFingerprint('HTTPS://Example.COM.:443/A/B/?x=1#f'), 'example.com/A/B?x=1');
  assert.equal(normalizeUrlForFingerprint('http://example.com:8080/'), 'example.com:8080/');
  assert.equal(normalizeUrlForFingerprint(''), '');
  assert.equal(normalizeUrlForFingerprint(null), '');
});

test('message identity normalization preserves meaningful numbers', () => {
  assert.equal(normalizeMessageIdentity('  HTTP  404  returned. '), 'http 404 returned');
  assert.equal(normalizeMessageIdentity('Found “3” H1’s!!'), 'found "3" h1\'s');
  assert.notEqual(normalizeMessageIdentity('HTTP 404'), normalizeMessageIdentity('HTTP 500'));
});
