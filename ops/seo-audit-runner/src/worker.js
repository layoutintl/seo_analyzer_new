/**
 * Scheduler-tick worker.
 *
 * Designed for the systemd model "a timer starts the worker; the runner
 * determines due jobs from its own state database": the tick timer runs
 * `seo-audit-runner worker --once` every few minutes as the seo-runner
 * user. One tick:
 *
 *   1. crash recovery — dead RUNNING jobs become FAILED;
 *   2. enqueue — every enabled schedule whose latest occurrence is due
 *      (within the catch-up window) gets AT MOST one job, enforced by the
 *      unique (schedule_id, occurrence_key) index;
 *   3. execute — QUEUED jobs are claimed atomically and executed
 *      SEQUENTIALLY by spawning the runner CLI itself
 *      (`run --all|--project <id>`) with structured argv — no shell, no
 *      eval, no string interpolation. The child takes the runner's
 *      process lock, so a worker job can never overlap a manual run: the
 *      child exits 4 and the job returns to QUEUED for the next tick.
 *
 * The worker never runs as root (systemd User=seo-runner; the CLI refuses
 * root via the wrapper). Job exit codes map to job states in jobs.js.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestOccurrence, DEFAULT_CATCHUP_WINDOW_MS } from './schedules.js';
import { JOB_STATUS } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRYPOINT = path.resolve(__dirname, '..', 'bin', 'seo-audit-runner.js');

/** Build the argv for one job. Structured arguments only. */
export function jobArgs(job) {
  return job.project_id ? ['run', '--project', String(job.project_id)] : ['run', '--all'];
}

/**
 * Default executor: spawn this same runner CLI with the same Node binary
 * and flags (propagates --experimental-sqlite on Node 22/23). Captures
 * stderr for the sanitized failure message. Returns { exitCode, stderr }.
 */
export function spawnJobExecutor({ signal } = {}) {
  return (job) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [...process.execArgv, CLI_ENTRYPOINT, ...jobArgs(job)],
        { stdio: ['ignore', 'ignore', 'pipe'], signal, shell: false },
      );
      let stderrTail = '';
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });
      child.on('error', (err) => resolve({ exitCode: 1, stderr: err.message }));
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stderr: stderrTail }));
    });
}

/**
 * Enqueue due occurrences for all enabled schedules.
 * Returns the newly created jobs.
 */
export function enqueueDueSchedules({
  scheduleStore,
  jobStore,
  now = new Date(),
  catchupWindowMs = DEFAULT_CATCHUP_WINDOW_MS,
  logger = null,
}) {
  const created = [];
  for (const schedule of scheduleStore.list({ enabledOnly: true })) {
    const occurrence = latestOccurrence(schedule, now);
    if (!occurrence) continue;
    const age = now.getTime() - occurrence.at.getTime();
    if (age > catchupWindowMs) continue; // too old — skipped, never batched
    const job = jobStore.createForOccurrence({ schedule, occurrenceKey: occurrence.occurrenceKey });
    if (job) {
      created.push(job);
      logger?.info?.(
        `Enqueued scheduled job ${job.id} (schedule ${schedule.id}, occurrence ${occurrence.occurrenceKey})`,
      );
    }
  }
  return created;
}

/**
 * One worker tick. Returns a summary object.
 * `executeJob` is injectable for tests; production uses spawnJobExecutor().
 */
export async function workerTick({
  scheduleStore,
  jobStore,
  logger = null,
  redact = (s) => s,
  now = new Date(),
  catchupWindowMs = DEFAULT_CATCHUP_WINDOW_MS,
  maxJobs = 10,
  executeJob = null,
}) {
  const summary = { recovered: 0, enqueued: 0, executed: 0, succeeded: 0, failed: 0, deferred: 0 };
  const exec = executeJob ?? spawnJobExecutor();

  const recovered = jobStore.recoverInterrupted();
  summary.recovered = recovered.length;
  for (const job of recovered) {
    logger?.warn?.(`Recovered interrupted job ${job.id} -> FAILED`);
  }

  summary.enqueued = enqueueDueSchedules({ scheduleStore, jobStore, now, catchupWindowMs, logger }).length;

  for (let i = 0; i < maxJobs; i += 1) {
    const job = jobStore.claimNext();
    if (!job) break;
    logger?.info?.(`Executing job ${job.id} (${job.project_id ? `project ${job.project_id}` : 'all projects'})`);
    const { exitCode, stderr } = await exec(job);
    const finished = jobStore.finish(job.id, { exitCode, error: exitCode === 0 ? null : stderr, redact });
    summary.executed += 1;
    if (finished.status === JOB_STATUS.SUCCEEDED) summary.succeeded += 1;
    else if (finished.status === JOB_STATUS.QUEUED) {
      summary.deferred += 1;
      logger?.info?.(`Job ${job.id} deferred (runner lock was busy)`);
      break; // the lock holder is still active — stop this tick
    } else summary.failed += 1;
  }
  return summary;
}
