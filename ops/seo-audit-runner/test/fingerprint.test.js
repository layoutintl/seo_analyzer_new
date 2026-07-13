import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintIssue,
  normalizeUrlForFingerprint,
  normalizeMessageIdentity,
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

test('dynamic numbers in messages do not split the identity', () => {
  const a = fingerprintIssue('p1', issue({ message: 'Redirect chain has 3 hops' }));
  const b = fingerprintIssue('p1', issue({ message: 'Redirect chain has 5 hops' }));
  assert.equal(a, b);
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

test('message identity normalization', () => {
  assert.equal(normalizeMessageIdentity('  HTTP  404  returned '), 'http # returned');
});
