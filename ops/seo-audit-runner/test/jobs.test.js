import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStateDb } from '../src/db.js';
import { JobStore, JobError, JOB_STATUS, sanitizeErrorText } from '../src/jobs.js';
import { ScheduleStore } from '../src/schedules.js';

const DEAD_PID = 2147483647;

function freshStore() {
  const db = openStateDb(':memory:');
  return { db, store: new JobStore(db) };
}

test('job lifecycle: create -> claim -> finish(0) = SUCCEEDED with timestamps', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  assert.equal(job.status, JOB_STATUS.QUEUED);
  assert.ok(job.created_at && job.updated_at);
  assert.equal(job.started_at, null);

  const claimed = store.claimNext();
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, JOB_STATUS.RUNNING);
  assert.equal(claimed.attempts, 1);
  assert.ok(claimed.started_at);

  const finished = store.finish(job.id, { exitCode: 0 });
  assert.equal(finished.status, JOB_STATUS.SUCCEEDED);
  assert.equal(finished.exit_code, 0);
  assert.ok(finished.finished_at);
  db.close();
});

test('a job is never SUCCEEDED unless the process exited 0', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  store.claimNext();
  const finished = store.finish(job.id, { exitCode: 2, error: 'audits failed' });
  assert.equal(finished.status, JOB_STATUS.FAILED);
  assert.equal(finished.exit_code, 2);
  assert.equal(finished.error, 'audits failed');
  db.close();
});

test('exit 4 (lock busy) re-queues the job and refunds the attempt', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  store.claimNext();
  const deferred = store.finish(job.id, { exitCode: 4 });
  assert.equal(deferred.status, JOB_STATUS.QUEUED);
  assert.equal(deferred.attempts, 0);
  assert.equal(deferred.started_at, null);
  // It can be claimed again later.
  assert.equal(store.claimNext().id, job.id);
  db.close();
});

test('claims are FIFO and a claimed job cannot be claimed again', () => {
  const { db, store } = freshStore();
  const first = store.create({ projectId: 'a' });
  const second = store.create({ projectId: 'b' });
  assert.equal(store.claimNext().id, first.id);
  assert.equal(store.claimNext().id, second.id);
  assert.equal(store.claimNext(), null);
  db.close();
});

test('two stores over the same database never claim the same job', () => {
  const { db, store } = freshStore();
  const other = new JobStore(db);
  store.create({ projectId: 'only' });
  const a = store.claimNext();
  const b = other.claimNext();
  assert.ok(a);
  assert.equal(b, null, 'second concurrent claim must find nothing');
  db.close();
});

test('retry is allowed only from FAILED', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  assert.throws(() => store.retry(job.id), JobError);
  store.claimNext();
  store.finish(job.id, { exitCode: 1, error: 'boom' });
  const retried = store.retry(job.id);
  assert.equal(retried.status, JOB_STATUS.QUEUED);
  assert.equal(retried.exit_code, null);
  db.close();
});

test('cancel is allowed only from QUEUED', () => {
  const { db, store } = freshStore();
  const job = store.create({ projectId: 'p1' });
  const cancelled = store.cancel(job.id);
  assert.equal(cancelled.status, JOB_STATUS.CANCELLED);
  assert.throws(() => store.cancel(job.id), JobError);
  const running = store.create({ projectId: 'p2' });
  store.claimNext();
  assert.throws(() => store.cancel(running.id), JobError);
  db.close();
});

test('crash recovery fails dead-pid RUNNING jobs and leaves live ones alone', () => {
  const { db, store } = freshStore();
  const dead = store.create({ projectId: 'dead' });
  const live = store.create({ projectId: 'live' });
  store.claimNext({ workerPid: DEAD_PID });
  store.claimNext({ workerPid: process.pid });

  const recovered = store.recoverInterrupted();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, dead.id);
  assert.equal(recovered[0].status, JOB_STATUS.FAILED);
  assert.match(recovered[0].error, /interrupted/);
  assert.equal(store.get(live.id).status, JOB_STATUS.RUNNING);
  db.close();
});

test('one schedule occurrence creates at most one job', () => {
  const { db, store } = freshStore();
  const schedule = new ScheduleStore(db).create({ frequency: 'daily', atHour: 3, atMinute: 0 });
  const first = store.createForOccurrence({ schedule, occurrenceKey: '2026-07-21' });
  const second = store.createForOccurrence({ schedule, occurrenceKey: '2026-07-21' });
  assert.ok(first);
  assert.equal(second, null);
  const other = store.createForOccurrence({ schedule, occurrenceKey: '2026-07-22' });
  assert.ok(other, 'a different occurrence still creates a job');
  db.close();
});

test('error text is sanitized: redacted, token-masked, flattened, truncated', () => {
  const redact = (s) => s.replaceAll('super-secret-webhook', '[redacted]');
  const raw = 'failed:\n  super-secret-webhook\n  token xoxb-123-abc\n  ' + 'x'.repeat(1000);
  const clean = sanitizeErrorText(raw, redact);
  assert.ok(!clean.includes('super-secret-webhook'));
  assert.ok(!clean.includes('xoxb-123-abc'));
  assert.ok(clean.includes('***'));
  assert.ok(!clean.includes('\n'));
  assert.ok(clean.length <= 500);
  assert.equal(sanitizeErrorText(''), null);
});

test('history helpers: list, counts, lastError, lastSuccessful', () => {
  const { db, store } = freshStore();
  const ok = store.create({ projectId: 'ok' });
  store.claimNext();
  store.finish(ok.id, { exitCode: 0 });
  const bad = store.create({ projectId: 'bad' });
  store.claimNext();
  store.finish(bad.id, { exitCode: 1, error: 'exploded' });

  assert.equal(store.list().length, 2);
  assert.equal(store.list({ status: JOB_STATUS.FAILED }).length, 1);
  assert.deepEqual(store.counts(), { SUCCEEDED: 1, FAILED: 1 });
  assert.equal(store.lastError().id, bad.id);
  assert.equal(store.lastSuccessful().id, ok.id);
  db.close();
});

test('job project ids are validated', () => {
  const { db, store } = freshStore();
  assert.throws(() => store.create({ projectId: 'x; rm -rf /' }), JobError);
  assert.throws(() => store.create({ projectId: 'a'.repeat(200) }), JobError);
  db.close();
});
