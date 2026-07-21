import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStateDb } from '../src/db.js';
import { JobStore, JOB_STATUS } from '../src/jobs.js';
import { ScheduleStore } from '../src/schedules.js';
import { workerTick, enqueueDueSchedules, jobArgs } from '../src/worker.js';

const DEAD_PID = 2147483647;

function fixture() {
  const db = openStateDb(':memory:');
  return { db, jobStore: new JobStore(db), scheduleStore: new ScheduleStore(db) };
}

/** An enabled daily schedule whose occurrence was `minutesAgo` minutes ago (UTC). */
function dueSchedule(scheduleStore, now, minutesAgo = 5) {
  const at = new Date(now.getTime() - minutesAgo * 60 * 1000);
  const s = scheduleStore.create({
    frequency: 'daily',
    atHour: at.getUTCHours(),
    atMinute: at.getUTCMinutes(),
    timezone: 'UTC',
  });
  return scheduleStore.setEnabled(s.id, true);
}

const stubExec = (exitCode, stderr = '') => {
  const calls = [];
  const fn = async (job) => {
    calls.push(job);
    return { exitCode: typeof exitCode === 'function' ? exitCode(job) : exitCode, stderr };
  };
  fn.calls = calls;
  return fn;
};

test('jobArgs builds structured argv only', () => {
  assert.deepEqual(jobArgs({ project_id: 'p 1' }), ['run', '--project', 'p 1']);
  assert.deepEqual(jobArgs({ project_id: null }), ['run', '--all']);
});

test('a tick enqueues a due schedule occurrence and executes it', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  dueSchedule(scheduleStore, now);
  const exec = stubExec(0);

  const summary = await workerTick({ scheduleStore, jobStore, now, executeJob: exec });
  assert.deepEqual(summary, { recovered: 0, enqueued: 1, executed: 1, succeeded: 1, failed: 0, deferred: 0 });
  assert.equal(exec.calls.length, 1);
  assert.equal(jobStore.list()[0].status, JOB_STATUS.SUCCEEDED);
  db.close();
});

test('a second tick for the same occurrence creates no duplicate job', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  dueSchedule(scheduleStore, now);
  const exec = stubExec(0);

  await workerTick({ scheduleStore, jobStore, now, executeJob: exec });
  const again = await workerTick({ scheduleStore, jobStore, now: new Date(now.getTime() + 60_000), executeJob: exec });
  assert.equal(again.enqueued, 0);
  assert.equal(again.executed, 0);
  assert.equal(jobStore.list().length, 1);
  db.close();
});

test('editing a schedule does not duplicate an already-handled occurrence', async () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  const s = dueSchedule(scheduleStore, now, 10);
  await workerTick({ scheduleStore, jobStore, now, executeJob: stubExec(0) });

  // Move the time to five minutes ago — same calendar bucket, same key.
  const at = new Date(now.getTime() - 5 * 60 * 1000);
  scheduleStore.update(s.id, { atHour: at.getUTCHours(), atMinute: at.getUTCMinutes() });
  const after = await workerTick({ scheduleStore, jobStore, now, executeJob: stubExec(0) });
  assert.equal(after.enqueued, 0, 'same-day occurrence must not be re-created after an edit');
  assert.equal(jobStore.list().length, 1);
  db.close();
});

test('occurrences older than the catch-up window are skipped', () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  // Weekly schedule that last fired 2 days ago — outside the 24h window.
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const s = scheduleStore.create({
    frequency: 'weekly',
    atHour: twoDaysAgo.getUTCHours(),
    atMinute: 0,
    dayOfWeek: twoDaysAgo.getUTCDay(),
    timezone: 'UTC',
  });
  scheduleStore.setEnabled(s.id, true);
  const created = enqueueDueSchedules({ scheduleStore, jobStore, now });
  assert.equal(created.length, 0);
  db.close();
});

test('disabled schedules never enqueue jobs', () => {
  const { db, jobStore, scheduleStore } = fixture();
  const now = new Date('2026-07-21T12:00:00Z');
  const at = new Date(now.getTime() - 5 * 60 * 1000);
  scheduleStore.create({ frequency: 'daily', atHour: at.getUTCHours(), atMinute: at.getUTCMinutes(), timezone: 'UTC' });
  assert.equal(enqueueDueSchedules({ scheduleStore, jobStore, now }).length, 0);
  db.close();
});

test('a failing job records FAILED with a sanitized error', async () => {
  const { db, jobStore } = fixture();
  const { scheduleStore } = { scheduleStore: new ScheduleStore(db) };
  jobStore.create({ projectId: 'p1' });
  const exec = stubExec(1, 'kaboom with xoxb-secret-token-999 inside');

  const summary = await workerTick({ scheduleStore, jobStore, executeJob: exec });
  assert.equal(summary.failed, 1);
  const job = jobStore.list()[0];
  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.equal(job.exit_code, 1);
  assert.ok(!job.error.includes('xoxb-secret-token-999'), 'token leaked into job error');
  db.close();
});

test('lock contention (exit 4) defers the job and stops the tick', async () => {
  const { db, jobStore } = fixture();
  const scheduleStore = new ScheduleStore(db);
  jobStore.create({ projectId: 'p1' });
  jobStore.create({ projectId: 'p2' });
  const exec = stubExec(4);

  const summary = await workerTick({ scheduleStore, jobStore, executeJob: exec });
  assert.equal(summary.deferred, 1);
  assert.equal(exec.calls.length, 1, 'tick must stop after detecting the busy lock');
  const statuses = jobStore.list().map((j) => j.status).sort();
  assert.deepEqual(statuses, [JOB_STATUS.QUEUED, JOB_STATUS.QUEUED], 'both jobs remain queued');
  db.close();
});

test('a tick recovers interrupted RUNNING jobs before executing', async () => {
  const { db, jobStore } = fixture();
  const scheduleStore = new ScheduleStore(db);
  const job = jobStore.create({ projectId: 'crashed' });
  jobStore.claimNext({ workerPid: DEAD_PID });

  const summary = await workerTick({ scheduleStore, jobStore, executeJob: stubExec(0) });
  assert.equal(summary.recovered, 1);
  assert.equal(jobStore.get(job.id).status, JOB_STATUS.FAILED);
  db.close();
});

test('maxJobs bounds one tick', async () => {
  const { db, jobStore } = fixture();
  const scheduleStore = new ScheduleStore(db);
  for (let i = 0; i < 5; i += 1) jobStore.create({ projectId: `p${i}` });
  const exec = stubExec(0);
  const summary = await workerTick({ scheduleStore, jobStore, executeJob: exec, maxJobs: 2 });
  assert.equal(summary.executed, 2);
  assert.equal(jobStore.list({ status: JOB_STATUS.QUEUED }).length, 3);
  db.close();
});
