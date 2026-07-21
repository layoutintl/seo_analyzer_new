import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openStateDb } from '../src/db.js';
import { JobStore } from '../src/jobs.js';
import { runHealthChecks, formatHealthReport, HEALTH_EXIT } from '../src/health.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-health-'));

function makeConfig(extraEnv = {}) {
  const stateDir = tmpDir();
  return loadConfig({
    SEO_API_BASE_URL: 'http://127.0.0.1:3999',
    RUNNER_STATE_DIR: stateDir,
    ...extraEnv,
  });
}

test('fresh state is DEGRADED (no successful run yet), never UNHEALTHY', () => {
  const config = makeConfig();
  const report = runHealthChecks(config);
  assert.equal(report.exitCode, HEALTH_EXIT.DEGRADED);
  const warns = report.checks.filter((c) => c.status === 'warn').map((c) => c.name);
  assert.deepEqual(warns, ['last-success']);
});

test('healthy once a successful job exists', () => {
  const config = makeConfig();
  const db = openStateDb(config.stateDbPath);
  const store = new JobStore(db);
  const job = store.create({ projectId: 'p1' });
  store.claimNext();
  store.finish(job.id, { exitCode: 0 });
  db.close();

  const report = runHealthChecks(config);
  assert.equal(report.exitCode, HEALTH_EXIT.HEALTHY, formatHealthReport(report));
});

test('a failed job surfaces as last-error but stays a warning', () => {
  const config = makeConfig();
  const db = openStateDb(config.stateDbPath);
  const store = new JobStore(db);
  const good = store.create({ projectId: 'good' });
  store.claimNext();
  store.finish(good.id, { exitCode: 0 });
  const bad = store.create({ projectId: 'bad' });
  store.claimNext();
  store.finish(bad.id, { exitCode: 1, error: 'exploded' });
  db.close();

  const report = runHealthChecks(config);
  assert.equal(report.exitCode, HEALTH_EXIT.DEGRADED);
  const lastError = report.checks.find((c) => c.name === 'last-error');
  assert.equal(lastError.status, 'warn');
  assert.match(lastError.detail, /exploded/);
});

test('an unopenable state database is UNHEALTHY (exit 1)', () => {
  const config = makeConfig();
  // Point the DB path at a directory — opening must fail.
  const asDir = path.join(config.stateDir, 'db-is-a-directory');
  fs.mkdirSync(asDir, { recursive: true });
  const broken = loadConfig({
    SEO_API_BASE_URL: 'http://127.0.0.1:3999',
    RUNNER_STATE_DIR: config.stateDir,
    RUNNER_STATE_DB_PATH: asDir,
  });
  const report = runHealthChecks(broken);
  assert.equal(report.exitCode, HEALTH_EXIT.UNHEALTHY);
});

test('an active lock is reported as a warning with the holder pid', () => {
  const config = makeConfig();
  fs.writeFileSync(
    path.join(config.stateDir, 'seo-audit-runner.lock'),
    JSON.stringify({ pid: process.pid, startedAt: 'now' }),
  );
  const report = runHealthChecks(config);
  const lock = report.checks.find((c) => c.name === 'lock');
  assert.equal(lock.status, 'warn');
  assert.match(lock.detail, new RegExp(String(process.pid)));
});

test('doctor level adds integrity and disk-space checks', () => {
  const config = makeConfig();
  const report = runHealthChecks(config, { level: 'doctor' });
  const names = report.checks.map((c) => c.name);
  assert.ok(names.includes('database-integrity'));
  assert.ok(names.includes('disk-space'));
  const integrity = report.checks.find((c) => c.name === 'database-integrity');
  assert.equal(integrity.status, 'ok');
});

test('health output never contains configured secret values', () => {
  const secret = 'xoxb-health-secret-42';
  const config = makeConfig({
    NOTIFICATIONS_ENABLED: 'true',
    SLACK_BOT_TOKEN: secret,
    SLACK_CHANNEL_ID: 'C0TEST',
  });
  const report = runHealthChecks(config, { level: 'doctor' });
  const text = formatHealthReport(report) + formatHealthReport(report, { json: true });
  assert.ok(!text.includes(secret), 'secret leaked into health output');
  const notifications = report.checks.find((c) => c.name === 'notifications');
  assert.equal(notifications.status, 'ok');
  assert.match(notifications.detail, /bot token \+ channel configured/);
});

test('notifications enabled without a method is UNHEALTHY', () => {
  // loadConfig would reject this combination, so simulate the config shape
  // directly (defense in depth for hand-edited state).
  const config = makeConfig();
  const broken = { ...config, notificationsEnabled: true, slackMethod: null };
  const report = runHealthChecks(broken);
  assert.equal(report.exitCode, HEALTH_EXIT.UNHEALTHY);
});
