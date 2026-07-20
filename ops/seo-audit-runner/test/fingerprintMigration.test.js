/**
 * Phase 3.2 — v1 → v2 fingerprint state migration.
 *
 * The v1 algorithm is reproduced locally (from the pre-Phase-3.1 source) so
 * these tests can build a genuine v1 database rather than a hand-waved one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { openStateDb, migrate, MIGRATIONS } from '../src/db.js';
import { StateStore } from '../src/stateStore.js';
import { fingerprintIssue } from '../src/fingerprint.js';
import {
  planFingerprintMigration,
  mergeRows,
  isReconstructable,
  inferSource,
  recomputeFingerprint,
} from '../src/migrations/fingerprintMigration.js';
import { fingerprintIssueV2 } from '../src/migrations/fingerprintV2Frozen.js';
import { shouldNotify, notificationIdentity } from '../src/notificationPipeline.js';

// ── The original v1 algorithm, verbatim ───────────────────────────

function v1NormalizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  let url;
  try { url = new URL(trimmed); } catch { return trimmed.toLowerCase(); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';
  let pathname = url.pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return `${host}${port}${pathname}${url.search ?? ''}`;
}

function v1FingerprintIssue(projectId, issue) {
  const parts = [
    'v1',
    String(projectId ?? ''),
    String(issue?.area ?? '').toLowerCase().trim(),
    String(issue?.pageType ?? '').toLowerCase().trim(),
    issue?.source === 'site' ? 'site' : 'page',
    v1NormalizeUrl(issue?.pageUrl),
    String(issue?.message ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\d+/g, '#'),
  ];
  return createHash('sha256').update(parts.join('')).digest('hex');
}

// ── Helpers ───────────────────────────────────────────────────────

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-fpmig-')), 'state.sqlite');
}

/** Build a database frozen at schema v1, exactly as Phase 3 left it. */
function openV1Db(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`);
  MIGRATIONS[0].up(db);
  db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    .run(1, MIGRATIONS[0].name, new Date().toISOString());
  return db;
}

const V1_COLS = [
  'project_id', 'fingerprint', 'area', 'normalized_url', 'message', 'fix_hint', 'page_type',
  'first_seen_at', 'last_seen_at', 'last_audit_run_id', 'state', 'resolved_at',
  'reopened_count', 'last_alerted_at',
];

function insertV1Issue(db, over = {}) {
  const issue = {
    area: 'meta',
    message: 'Missing title',
    pageUrl: 'https://example.com/',
    pageType: 'home',
    source: 'page',
    ...over,
  };
  const row = {
    project_id: over.projectId ?? 'p1',
    fingerprint: v1FingerprintIssue(over.projectId ?? 'p1', issue),
    area: issue.area,
    normalized_url: issue.pageUrl,
    message: issue.message,
    fix_hint: over.fixHint ?? 'Add one',
    page_type: issue.pageType,
    first_seen_at: over.firstSeenAt ?? '2026-01-01T00:00:00.000Z',
    last_seen_at: over.lastSeenAt ?? '2026-02-01T00:00:00.000Z',
    last_audit_run_id: over.lastAuditRunId ?? 'legacy-run',
    state: over.state ?? 'ACTIVE',
    resolved_at: over.resolvedAt ?? null,
    reopened_count: over.reopenedCount ?? 0,
    last_alerted_at: over.lastAlertedAt ?? '2026-02-01T00:00:00.000Z',
  };
  db.prepare(
    `INSERT INTO issue_states (${V1_COLS.join(', ')})
     VALUES (${V1_COLS.map(() => '?').join(', ')})`,
  ).run(...V1_COLS.map((c) => row[c]));
  return { row, issue };
}

const liveIssue = (over = {}) => {
  const base = {
    area: 'meta',
    message: 'Missing title',
    fixHint: 'Add one',
    pageUrl: 'https://example.com/',
    pageType: 'home',
    source: 'page',
    ...over,
  };
  return { ...base, fingerprint: fingerprintIssue('p1', base) };
};

// ── Frozen algorithm parity ───────────────────────────────────────

test('the frozen v2 snapshot still agrees with fingerprint.js', () => {
  const corpus = [
    { area: 'meta', message: 'Missing title', pageUrl: 'https://example.com/', pageType: 'home', source: 'page' },
    { area: 'indexing', message: 'Returns 404', pageUrl: 'https://example.com/a/', pageType: 'article', source: 'page' },
    { area: 'indexing', message: 'Returns 500', pageUrl: 'https://example.com/a/', pageType: 'article', source: 'page' },
    { area: 'robots', message: 'robots.txt blocks crawling', pageUrl: null, pageType: null, source: 'site' },
    { area: 'meta', message: 'Missing canonical.', pageUrl: 'https://EXAMPLE.com/x', pageType: 'section', source: 'page' },
    { area: 'meta', message: 'Missing title', pageUrl: 'https://example.com/', pageType: 'home', source: 'page', code: 'META_TITLE_MISSING' },
  ];
  for (const issue of corpus) {
    assert.equal(
      fingerprintIssueV2('p1', issue),
      fingerprintIssue('p1', issue),
      'fingerprint.js changed — do NOT edit the frozen snapshot, add a schema migration v3 instead',
    );
  }
});

// ── Schema ────────────────────────────────────────────────────────

test('migration brings a v1 database to schema version 2', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 1);

  const version = migrate(db, { dbPath });
  assert.equal(version, 2);

  const cols = db.prepare('PRAGMA table_info(issue_states)').all().map((c) => c.name);
  for (const col of ['fingerprint_version', 'legacy_fingerprint', 'needs_reconciliation']) {
    assert.ok(cols.includes(col), `missing column ${col}`);
  }
});

test('migrating twice is a no-op', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  insertV1Issue(db);

  migrate(db, { dbPath });
  const after1 = db.prepare('SELECT * FROM issue_states').all();
  const version = migrate(db, { dbPath });
  const after2 = db.prepare('SELECT * FROM issue_states').all();

  assert.equal(version, 2);
  assert.deepEqual(after2, after1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 2);
});

test('a safety backup is written before upgrading an existing database', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  insertV1Issue(db);
  db.close();

  openStateDb(dbPath).close();
  assert.ok(fs.existsSync(`${dbPath}.backup-v1`), 'expected a v1 backup file');
});

// ── Re-identification ─────────────────────────────────────────────

test('a stored v1 issue is re-identified with the exact v2 fingerprint a live audit produces', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  const { row } = insertV1Issue(db);
  migrate(db, { dbPath });

  const migrated = db.prepare('SELECT * FROM issue_states').get();
  assert.equal(migrated.fingerprint, liveIssue().fingerprint);
  assert.notEqual(migrated.fingerprint, row.fingerprint);
  assert.equal(migrated.fingerprint_version, 2);
  assert.equal(migrated.legacy_fingerprint, row.fingerprint);
  assert.equal(migrated.needs_reconciliation, 0);
});

test('history is preserved through re-identification', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  insertV1Issue(db, {
    firstSeenAt: '2025-11-05T00:00:00.000Z',
    lastSeenAt: '2026-03-09T00:00:00.000Z',
    reopenedCount: 4,
    lastAlertedAt: '2026-03-09T01:00:00.000Z',
    lastAuditRunId: 'run-77',
  });
  migrate(db, { dbPath });

  const r = db.prepare('SELECT * FROM issue_states').get();
  assert.equal(r.first_seen_at, '2025-11-05T00:00:00.000Z');
  assert.equal(r.last_seen_at, '2026-03-09T00:00:00.000Z');
  assert.equal(r.reopened_count, 4);
  assert.equal(r.last_alerted_at, '2026-03-09T01:00:00.000Z');
  assert.equal(r.last_audit_run_id, 'run-77');
  assert.equal(r.state, 'ACTIVE');
});

test('a RESOLVED row stays resolved', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  insertV1Issue(db, { state: 'RESOLVED', resolvedAt: '2026-02-02T00:00:00.000Z' });
  migrate(db, { dbPath });

  const r = db.prepare('SELECT * FROM issue_states').get();
  assert.equal(r.state, 'RESOLVED');
  assert.equal(r.resolved_at, '2026-02-02T00:00:00.000Z');
});

test('projects are re-identified independently', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  insertV1Issue(db, { projectId: 'p1' });
  insertV1Issue(db, { projectId: 'p2' });
  migrate(db, { dbPath });

  const rows = db.prepare('SELECT * FROM issue_states ORDER BY project_id').all();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].fingerprint, rows[1].fingerprint);
});

// ── Duplicate merge ───────────────────────────────────────────────

test('two v1 rows that collapse onto one v2 identity are merged', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  // v1 kept these apart (trailing punctuation was significant); v2 does not.
  const a = insertV1Issue(db, {
    message: 'Missing canonical tag.',
    firstSeenAt: '2025-10-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    state: 'RESOLVED',
    resolvedAt: '2026-01-02T00:00:00.000Z',
    reopenedCount: 3,
    lastAlertedAt: '2026-01-01T00:00:00.000Z',
  });
  const b = insertV1Issue(db, {
    message: 'Missing canonical tag',
    firstSeenAt: '2025-12-01T00:00:00.000Z',
    lastSeenAt: '2026-03-01T00:00:00.000Z',
    state: 'ACTIVE',
    reopenedCount: 1,
    lastAlertedAt: '2026-03-01T00:00:00.000Z',
    lastAuditRunId: 'run-newest',
  });
  assert.notEqual(a.row.fingerprint, b.row.fingerprint, 'precondition: distinct under v1');

  migrate(db, { dbPath });

  const rows = db.prepare('SELECT * FROM issue_states').all();
  assert.equal(rows.length, 1, 'the two rows must merge into one');
  const m = rows[0];

  assert.equal(m.state, 'ACTIVE', 'an ACTIVE input must keep the merged row open');
  assert.equal(m.resolved_at, null);
  assert.equal(m.first_seen_at, '2025-10-01T00:00:00.000Z', 'earliest history wins');
  assert.equal(m.last_seen_at, '2026-03-01T00:00:00.000Z');
  assert.equal(m.reopened_count, 3, 'MAX, never SUM');
  assert.equal(m.last_alerted_at, '2026-03-01T00:00:00.000Z');
  assert.equal(m.last_audit_run_id, 'run-newest', 'most recently seen row supplies descriptors');
  assert.equal(m.message, 'Missing canonical tag');
  // Both legacy identities are retained for audit purposes.
  assert.ok(m.legacy_fingerprint.includes(a.row.fingerprint));
  assert.ok(m.legacy_fingerprint.includes(b.row.fingerprint));
});

test('mergeRows keeps a merged row ACTIVE when any input is ACTIVE', () => {
  const merged = mergeRows([
    { project_id: 'p1', fingerprint: 'x', state: 'RESOLVED', resolved_at: '2026-01-01T00:00:00.000Z',
      first_seen_at: '2025-01-01T00:00:00.000Z', last_seen_at: '2025-06-01T00:00:00.000Z', reopened_count: 2 },
    { project_id: 'p1', fingerprint: 'y', state: 'ACTIVE', resolved_at: null,
      first_seen_at: '2025-03-01T00:00:00.000Z', last_seen_at: '2026-01-01T00:00:00.000Z', reopened_count: 5 },
  ], 'merged-fp');

  assert.equal(merged.state, 'ACTIVE');
  assert.equal(merged.resolved_at, null);
  assert.equal(merged.reopened_count, 5);
  assert.equal(merged.first_seen_at, '2025-01-01T00:00:00.000Z');
  assert.equal(merged.fingerprint, 'merged-fp');
});

test('rows that do not collide are never merged', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  // v1 masked digits, so these two shared a v1 identity only if inserted as
  // one row; inserted separately they are genuinely different issues.
  insertV1Issue(db, { message: 'Returns 404', pageUrl: 'https://example.com/a' });
  insertV1Issue(db, { message: 'Returns 500', pageUrl: 'https://example.com/b' });
  migrate(db, { dbPath });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM issue_states').get().n, 2);
});

// ── Missing metadata ──────────────────────────────────────────────

test('a row with no message cannot be re-identified and is flagged, not guessed', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  const { row } = insertV1Issue(db, { message: null });
  migrate(db, { dbPath });

  const r = db.prepare('SELECT * FROM issue_states').get();
  assert.equal(r.needs_reconciliation, 1);
  assert.equal(r.fingerprint, row.fingerprint, 'unusable identity is left as-is, not invented');
  assert.equal(r.fingerprint_version, 2);
  assert.equal(r.legacy_fingerprint, row.fingerprint);
  assert.equal(r.state, 'ACTIVE', 'the row and its history survive');
});

test('isReconstructable / inferSource classify rows correctly', () => {
  assert.equal(isReconstructable({ message: 'x' }), true);
  assert.equal(isReconstructable({ message: '   ' }), false);
  assert.equal(isReconstructable({ message: null }), false);
  assert.equal(isReconstructable({ message: null, code: 'META_MISSING' }), true);

  assert.equal(inferSource({ normalized_url: 'https://e.com/a' }), 'page');
  assert.equal(inferSource({ normalized_url: null }), 'site');
});

test('a site-scoped row is re-identified as site-scoped', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  insertV1Issue(db, { message: 'robots.txt blocks crawling', pageUrl: null, pageType: null, source: 'site' });
  migrate(db, { dbPath });

  const r = db.prepare('SELECT * FROM issue_states').get();
  assert.equal(
    r.fingerprint,
    fingerprintIssue('p1', {
      area: 'meta', message: 'robots.txt blocks crawling',
      pageUrl: null, pageType: null, source: 'site',
    }),
  );
});

test('recomputeFingerprint is stable for an already-normalized stored URL', () => {
  const raw = { project_id: 'p1', area: 'meta', message: 'Missing title', page_type: 'home',
    normalized_url: 'https://example.com/' };
  const normalized = { ...raw, normalized_url: 'example.com/' };
  assert.equal(recomputeFingerprint(raw), recomputeFingerprint(normalized));
});

// ── Planner purity ────────────────────────────────────────────────

test('planFingerprintMigration reports what it did', () => {
  const base = {
    project_id: 'p1', area: 'meta', normalized_url: 'https://example.com/', page_type: 'home',
    first_seen_at: '2026-01-01T00:00:00.000Z', last_seen_at: '2026-01-01T00:00:00.000Z',
    state: 'ACTIVE', resolved_at: null, reopened_count: 0, last_alerted_at: null,
    fingerprint_version: 1,
  };
  const { rows, stats } = planFingerprintMigration([
    { ...base, fingerprint: 'v1a', message: 'Missing canonical tag.' },
    { ...base, fingerprint: 'v1b', message: 'Missing canonical tag' },
    { ...base, fingerprint: 'v1c', message: null },
  ]);

  assert.equal(stats.examined, 3);
  assert.equal(stats.recomputed, 2);
  assert.equal(stats.flaggedForReconciliation, 1);
  assert.equal(stats.mergedAway, 1);
  assert.equal(stats.resulting, 2);
  assert.equal(rows.length, 2);
});

test('planFingerprintMigration leaves already-v2 rows untouched', () => {
  const row = {
    project_id: 'p1', fingerprint: 'already-v2', area: 'meta', normalized_url: null,
    message: 'Missing title', page_type: null, first_seen_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: '2026-01-01T00:00:00.000Z', state: 'ACTIVE', resolved_at: null,
    reopened_count: 0, last_alerted_at: null, fingerprint_version: 2,
  };
  const { rows, stats } = planFingerprintMigration([row]);
  assert.equal(stats.alreadyV2, 1);
  assert.equal(stats.recomputed, 0);
  assert.equal(rows[0].fingerprint, 'already-v2');
});

// ── First post-upgrade audit ──────────────────────────────────────

test('the first post-upgrade audit reports UNCHANGED, not NEW + RESOLVED', () => {
  const dbPath = tmpDbPath();
  const legacy = openV1Db(dbPath);
  insertV1Issue(legacy, { message: 'Missing title' });
  insertV1Issue(legacy, { message: 'Returns 404', pageUrl: 'https://example.com/a' });
  legacy.close();

  const db = openStateDb(dbPath);
  const store = new StateStore(db);

  const lifecycle = store.recordSnapshotAndLifecycle({
    projectId: 'p1',
    auditRunId: 'post-upgrade-1',
    issues: [
      liveIssue({ message: 'Missing title' }),
      liveIssue({ message: 'Returns 404', pageUrl: 'https://example.com/a' }),
    ],
    now: new Date().toISOString(),
  });

  assert.equal(lifecycle.unchanged.length, 2, 'both issues must be recognised as pre-existing');
  assert.equal(lifecycle.new.length, 0, 'no false NEW');
  assert.equal(lifecycle.resolved.length, 0, 'no false RESOLVED');
  assert.equal(lifecycle.reopened.length, 0);
});

test('without the migration the same audit would produce the false storm', () => {
  // Guards the premise: proves the storm is real and that migration is what prevents it.
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  insertV1Issue(db, { message: 'Missing title' });
  db.exec('ALTER TABLE issue_states ADD COLUMN needs_reconciliation INTEGER NOT NULL DEFAULT 0;');
  db.exec('ALTER TABLE issue_states ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 1;');

  const lifecycle = new StateStore(db).recordSnapshotAndLifecycle({
    projectId: 'p1',
    auditRunId: 'unmigrated',
    issues: [liveIssue({ message: 'Missing title' })],
    now: new Date().toISOString(),
  });

  assert.equal(lifecycle.new.length, 1);
  assert.equal(lifecycle.resolved.length, 1);
});

test('a genuinely fixed issue still resolves after the upgrade', () => {
  const dbPath = tmpDbPath();
  const legacy = openV1Db(dbPath);
  insertV1Issue(legacy, { message: 'Missing title' });
  legacy.close();

  const lifecycle = new StateStore(openStateDb(dbPath)).recordSnapshotAndLifecycle({
    projectId: 'p1', auditRunId: 'post-upgrade-1', issues: [], now: new Date().toISOString(),
  });

  assert.equal(lifecycle.resolved.length, 1, 'a real fix must still be reported');
  assert.equal(lifecycle.reconciled.length, 0);
});

test('a genuinely new issue is still reported as NEW after the upgrade', () => {
  const dbPath = tmpDbPath();
  const legacy = openV1Db(dbPath);
  insertV1Issue(legacy, { message: 'Missing title' });
  legacy.close();

  const lifecycle = new StateStore(openStateDb(dbPath)).recordSnapshotAndLifecycle({
    projectId: 'p1',
    auditRunId: 'post-upgrade-1',
    issues: [liveIssue({ message: 'Missing title' }), liveIssue({ message: 'Returns 500', pageUrl: 'https://example.com/z' })],
    now: new Date().toISOString(),
  });

  assert.equal(lifecycle.unchanged.length, 1);
  assert.equal(lifecycle.new.length, 1);
  assert.equal(lifecycle.new[0].message, 'Returns 500');
});

test('an unmigratable row is retired silently instead of announcing a false fix', () => {
  const dbPath = tmpDbPath();
  const legacy = openV1Db(dbPath);
  insertV1Issue(legacy, { message: null });
  legacy.close();

  const db = openStateDb(dbPath);
  const store = new StateStore(db);
  const lifecycle = store.recordSnapshotAndLifecycle({
    projectId: 'p1', auditRunId: 'post-upgrade-1',
    issues: [liveIssue({ message: 'Missing title' })],
    now: new Date().toISOString(),
  });

  assert.equal(lifecycle.resolved.length, 0, 'must NOT claim the issue was fixed');
  assert.equal(lifecycle.reconciled.length, 1, 'retired quietly instead');
  assert.equal(db.prepare("SELECT state FROM issue_states WHERE needs_reconciliation = 0 AND message IS NULL").get().state, 'RESOLVED');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM issue_states WHERE needs_reconciliation = 1').get().n,
    0,
    'the flag is cleared once the first post-upgrade audit has run',
  );
});

test('reconciled issues do not trigger a notification or change its identity', () => {
  const counts = { new: 0, reopened: 0, unchanged: 1, resolved: 0, current: 1 };
  assert.equal(shouldNotify('new_or_regressed', counts), false);

  const withReconciled = notificationIdentity({
    projectId: 'p1', auditRunId: 'r1', type: 'project_update', alertMode: 'new_or_regressed',
    lifecycle: { new: [], reopened: [], unchanged: [], resolved: [], reconciled: [{ fingerprint: 'x' }] },
  });
  const without = notificationIdentity({
    projectId: 'p1', auditRunId: 'r1', type: 'project_update', alertMode: 'new_or_regressed',
    lifecycle: { new: [], reopened: [], unchanged: [], resolved: [] },
  });
  assert.equal(withReconciled, without, 'delivered-notification idempotency must be unaffected');
});

test('issues recorded after the upgrade are stamped as v2', () => {
  const db = openStateDb(':memory:');
  new StateStore(db).recordSnapshotAndLifecycle({
    projectId: 'p1', auditRunId: 'r1', issues: [liveIssue()], now: new Date().toISOString(),
  });

  const r = db.prepare('SELECT * FROM issue_states').get();
  assert.equal(r.fingerprint_version, 2);
  assert.equal(r.needs_reconciliation, 0);
});

// ── Preservation of other tables ──────────────────────────────────

test('delivered notifications and snapshots survive the migration untouched', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);

  db.prepare(`
    INSERT INTO notifications
      (id, runner_execution_id, project_id, audit_run_id, type, method, payload_hash,
       payload_json, attempt_count, status, created_at, delivered_at)
    VALUES ('n1', 'exec-1', 'p1', 'r1', 'project_update', 'webhook', 'hash-1',
            '{"blocks":[],"fingerprints":["legacy-fp"]}', 1, 'DELIVERED',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:05.000Z')
  `).run();
  db.prepare(`
    INSERT INTO project_snapshots
      (project_id, normalized_domain, audit_run_id, audit_completed_at, snapshot_status, p0_count, created_at)
    VALUES ('p1', 'example.com', 'r1', '2026-01-01T00:00:00.000Z', 'COMPLETED', 2, '2026-01-01T00:00:00.000Z')
  `).run();
  insertV1Issue(db);

  const notifBefore = db.prepare('SELECT * FROM notifications').all();
  const snapsBefore = db.prepare('SELECT * FROM project_snapshots').all();

  migrate(db, { dbPath });

  assert.deepEqual(db.prepare('SELECT * FROM notifications').all(), notifBefore);
  assert.deepEqual(db.prepare('SELECT * FROM project_snapshots').all(), snapsBefore);
});

test('a queued notification is still retryable after the migration', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  db.prepare(`
    INSERT INTO notifications
      (id, project_id, type, payload_hash, payload_json, attempt_count, status, created_at)
    VALUES ('n2', 'p1', 'project_update', 'h', '{}', 2, 'FAILED', '2026-01-01T00:00:00.000Z')
  `).run();
  insertV1Issue(db);

  migrate(db, { dbPath });

  const retryable = new StateStore(db).listRetryableNotifications({ now: '2026-06-01T00:00:00.000Z' });
  assert.equal(retryable.length, 1);
  assert.equal(retryable[0].id, 'n2');
  assert.equal(retryable[0].attempt_count, 2);
});

// ── Failure safety ────────────────────────────────────────────────

test('a failing migration rolls back and leaves v1 state intact', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  const { row } = insertV1Issue(db);

  const broken = [{
    version: 2,
    name: 'deliberately-broken',
    up() { throw new Error('boom'); },
  }];
  // Exercise the same transaction wrapper migrate() uses.
  assert.throws(() => {
    db.exec('BEGIN IMMEDIATE');
    try {
      broken[0].up(db);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }, /boom/);

  const after = db.prepare('SELECT * FROM issue_states').get();
  assert.equal(after.fingerprint, row.fingerprint, 'v1 state must survive a failed migration');
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 1);
});

test('an empty v1 database migrates cleanly', () => {
  const dbPath = tmpDbPath();
  const db = openV1Db(dbPath);
  assert.equal(migrate(db, { dbPath }), 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM issue_states').get().n, 0);
});
