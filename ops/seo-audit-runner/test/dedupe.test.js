import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeProjects, compareCandidates, hasUsableFormValues } from '../src/dedupe.js';

const base = (over = {}) => ({
  id: 'p1',
  domain: 'example.com',
  website_url: 'https://example.com',
  project_name: 'Example',
  last_form_values: null,
  last_audit_at: null,
  updated_at: null,
  completed_count: 0,
  ...over,
});

test('www and non-www projects deduplicate into one group', () => {
  const a = base({ id: 'a', domain: 'example.com', website_url: 'https://example.com' });
  const b = base({ id: 'b', domain: 'www.example.com', website_url: 'https://www.example.com' });
  const { winners, duplicates } = dedupeProjects([a, b]);
  assert.equal(winners.length, 1);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].winnerId, winners[0].project.id);
});

test('different subdomains stay separate', () => {
  const a = base({ id: 'a', domain: 'example.com' });
  const b = base({ id: 'b', domain: 'blog.example.com', website_url: 'https://blog.example.com' });
  const { winners, duplicates } = dedupeProjects([a, b]);
  assert.equal(winners.length, 2);
  assert.equal(duplicates.length, 0);
});

test('non-default port stays a separate group', () => {
  const a = base({ id: 'a', website_url: 'https://example.com' });
  const b = base({ id: 'b', website_url: 'https://example.com:8443', domain: 'example.com' });
  const { winners } = dedupeProjects([a, b]);
  assert.equal(winners.length, 2);
});

test('winner tier 1: usable form values beats everything else', () => {
  const noConfig = base({
    id: 'aaa',
    last_audit_at: '2026-07-10T00:00:00Z',
    updated_at: '2026-07-10T00:00:00Z',
    completed_count: 5,
  });
  const withConfig = base({
    id: 'zzz',
    domain: 'www.example.com',
    website_url: 'https://www.example.com',
    last_form_values: { homeUrl: 'https://www.example.com', articleUrl: 'https://www.example.com/a' },
  });
  const { winners, duplicates } = dedupeProjects([noConfig, withConfig]);
  assert.equal(winners[0].project.id, 'zzz');
  assert.equal(duplicates[0].project.id, 'aaa');
  assert.equal(duplicates[0].winnerId, 'zzz');
});

test('winner tier 2: most recent last_audit_at', () => {
  const older = base({ id: 'a', last_audit_at: '2026-01-01T00:00:00Z' });
  const newer = base({ id: 'b', domain: 'www.example.com', last_audit_at: '2026-06-01T00:00:00Z' });
  const { winners } = dedupeProjects([older, newer]);
  assert.equal(winners[0].project.id, 'b');
});

test('winner tier 3: most recent updated_at', () => {
  const older = base({ id: 'a', updated_at: '2026-01-01T00:00:00Z' });
  const newer = base({ id: 'b', domain: 'www.example.com', updated_at: '2026-06-01T00:00:00Z' });
  const { winners } = dedupeProjects([older, newer]);
  assert.equal(winners[0].project.id, 'b');
});

test('winner tier 4: completed_count > 0', () => {
  const without = base({ id: 'a' });
  const withCompleted = base({ id: 'b', domain: 'www.example.com', completed_count: 2 });
  const { winners } = dedupeProjects([without, withCompleted]);
  assert.equal(winners[0].project.id, 'b');
});

test('winner tier 5: lowest project ID lexicographically', () => {
  const a = base({ id: 'abc' });
  const b = base({ id: 'abd', domain: 'www.example.com' });
  const { winners } = dedupeProjects([b, a]);
  assert.equal(winners[0].project.id, 'abc');
});

test('comparator is deterministic and antisymmetric', () => {
  const a = base({ id: 'a', last_audit_at: '2026-06-01T00:00:00Z' });
  const b = base({ id: 'b' });
  assert.ok(compareCandidates(a, b) < 0);
  assert.ok(compareCandidates(b, a) > 0);
});

test('hasUsableFormValues requires both homeUrl and articleUrl', () => {
  assert.equal(hasUsableFormValues(base()), false);
  assert.equal(hasUsableFormValues(base({ last_form_values: { homeUrl: 'https://x' } })), false);
  assert.equal(
    hasUsableFormValues(base({ last_form_values: { homeUrl: 'https://x', articleUrl: ' ' } })),
    false,
  );
  assert.equal(
    hasUsableFormValues(base({ last_form_values: { homeUrl: 'https://x', articleUrl: 'https://x/a' } })),
    true,
  );
  // JSON-string form (defensive against driver differences)
  assert.equal(
    hasUsableFormValues(
      base({ last_form_values: '{"homeUrl":"https://x","articleUrl":"https://x/a"}' }),
    ),
    true,
  );
});

test('projects with unparseable domains never merge', () => {
  const a = base({ id: 'a', domain: '', website_url: '' });
  const b = base({ id: 'b', domain: '', website_url: '' });
  const { winners, duplicates } = dedupeProjects([a, b]);
  assert.equal(winners.length, 2);
  assert.equal(duplicates.length, 0);
});
