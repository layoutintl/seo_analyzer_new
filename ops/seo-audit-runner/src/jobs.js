/**
 * Runner-owned job queue (SQLite).
 *
 * States and transitions:
 *
 *   QUEUED ──claim──▶ RUNNING ──exit 0──▶ SUCCEEDED
 *      ▲                 │────exit !=0──▶ FAILED ──job retry──▶ QUEUED
 *      │                 │────lock busy (exit 4)──▶ QUEUED (attempt refunded)
 *      └──job cancel (QUEUED only)──▶ CANCELLED
 *
 * A job is marked SUCCEEDED only when the audit process exited with code 0.
 * Crash recovery: a RUNNING job whose recorded worker pid is no longer
 * alive is marked FAILED ('interrupted…') on the next worker tick — it is
 * never silently succeeded. Claims are atomic single-statement UPDATEs
 * (SQLite serializes writers), so two concurrent workers can never both
 * claim the same job.
 *
 * The `error` column stores a SANITIZED message: redacted via the provided
 * redact function and truncated. Secrets never enter this table.
 */

import { randomUUID } from 'node:crypto';
import { isProcessAlive } from './lock.js';

export const JOB_STATUS = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

const MAX_ERROR_LENGTH = 500;

export class JobError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobError';
  }
}

export function sanitizeErrorText(text, redact = (s) => s) {
  if (!text) return null;
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const redacted = redact(flat)
    // Defense in depth: mask anything token-shaped even if the redactor
    // did not know about it.
    .replace(/xox[a-z]-[A-Za-z0-9-]+/g, '***')
    .replace(/hooks\.slack\.com\/services\/\S+/g, 'hooks.slack.com/services/***');
  return redacted.slice(0, MAX_ERROR_LENGTH) || null;
}

export class JobStore {
  constructor(db) {
    this.db = db;
  }

  create({ projectId = null, scheduleId = null, occurrenceKey = null, requestedBy = 'cli' }) {
    if (projectId != null && !/^[A-Za-z0-9._:-]{1,128}$/.test(String(projectId))) {
      throw new JobError('project id contains unsupported characters');
    }
    const id = randomUUID();
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs
           (id, type, project_id, schedule_id, occurrence_key, status, requested_by,
            attempts, created_at, updated_at)
         VALUES (?, 'audit', ?, ?, ?, 'QUEUED', ?, 0, ?, ?)`,
      )
      .run(id, projectId, scheduleId, occurrenceKey, requestedBy, nowIso, nowIso);
    return this.get(id);
  }

  /**
   * Create a job for a schedule occurrence unless one already exists.
   * Returns the job or null when the occurrence was already handled
   * (unique-index guarantee: at most one job per occurrence).
   */
  createForOccurrence({ schedule, occurrenceKey }) {
    const existing = this.db
      .prepare('SELECT id FROM jobs WHERE schedule_id = ? AND occurrence_key = ?')
      .get(schedule.id, occurrenceKey);
    if (existing) return null;
    try {
      return this.create({
        projectId: schedule.project_id,
        scheduleId: schedule.id,
        occurrenceKey,
        requestedBy: 'schedule',
      });
    } catch (err) {
      // Unique-index race with a concurrent worker: the occurrence is
      // already covered, which is exactly the guarantee we want.
      if (/UNIQUE constraint/i.test(err.message)) return null;
      throw err;
    }
  }

  /** Atomically claim the oldest QUEUED job. Returns the job or null. */
  claimNext({ workerPid = process.pid } = {}) {
    const nowIso = new Date().toISOString();
    const candidate = this.db
      .prepare("SELECT id FROM jobs WHERE status = 'QUEUED' ORDER BY created_at LIMIT 1")
      .get();
    if (!candidate) return null;
    const result = this.db
      .prepare(
        `UPDATE jobs SET status = 'RUNNING', started_at = ?, updated_at = ?,
                         attempts = attempts + 1, worker_pid = ?
         WHERE id = ? AND status = 'QUEUED'`,
      )
      .run(nowIso, nowIso, workerPid, candidate.id);
    if (result.changes === 0) return null; // lost the race to another worker
    return this.get(candidate.id);
  }

  /** Record a finished execution. SUCCEEDED requires exit code 0. */
  finish(id, { exitCode, error = null, redact = (s) => s }) {
    const job = this.get(id);
    if (!job) throw new JobError(`job not found: ${id}`);
    if (job.status !== JOB_STATUS.RUNNING) {
      throw new JobError(`job ${id} is ${job.status}, not RUNNING`);
    }
    const nowIso = new Date().toISOString();

    if (exitCode === 4) {
      // Another runner instance held the process lock: not a failure of
      // this job — refund the attempt and let a later tick retry it.
      this.db
        .prepare(
          `UPDATE jobs SET status = 'QUEUED', started_at = NULL, worker_pid = NULL,
                           attempts = attempts - 1, updated_at = ?,
                           error = 'deferred: another runner instance was active'
           WHERE id = ?`,
        )
        .run(nowIso, id);
      return this.get(id);
    }

    const status = exitCode === 0 ? JOB_STATUS.SUCCEEDED : JOB_STATUS.FAILED;
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, exit_code = ?, error = ?, finished_at = ?,
                         updated_at = ?, worker_pid = NULL
         WHERE id = ?`,
      )
      .run(status, exitCode, sanitizeErrorText(error, redact), nowIso, nowIso, id);
    return this.get(id);
  }

  /** FAILED -> QUEUED. Only failed jobs can be retried. */
  retry(id) {
    const job = this.get(id);
    if (!job) throw new JobError(`job not found: ${id}`);
    if (job.status !== JOB_STATUS.FAILED) {
      throw new JobError(`only FAILED jobs can be retried (job ${id} is ${job.status})`);
    }
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'QUEUED', exit_code = NULL, started_at = NULL,
                         finished_at = NULL, worker_pid = NULL, updated_at = ?
         WHERE id = ? AND status = 'FAILED'`,
      )
      .run(nowIso, id);
    return this.get(id);
  }

  /** QUEUED -> CANCELLED. Running jobs cannot be cancelled (documented). */
  cancel(id) {
    const job = this.get(id);
    if (!job) throw new JobError(`job not found: ${id}`);
    if (job.status !== JOB_STATUS.QUEUED) {
      throw new JobError(`only QUEUED jobs can be cancelled (job ${id} is ${job.status})`);
    }
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'CANCELLED', finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'QUEUED'`,
      )
      .run(nowIso, nowIso, id);
    return this.get(id);
  }

  /**
   * Crash recovery: RUNNING jobs whose worker pid is dead are marked FAILED.
   * Returns the recovered jobs. Never marks anything successful.
   */
  recoverInterrupted() {
    const running = this.db.prepare("SELECT * FROM jobs WHERE status = 'RUNNING'").all();
    const recovered = [];
    const nowIso = new Date().toISOString();
    for (const job of running) {
      if (job.worker_pid && isProcessAlive(job.worker_pid)) continue;
      this.db
        .prepare(
          `UPDATE jobs SET status = 'FAILED', finished_at = ?, updated_at = ?,
                           worker_pid = NULL,
                           error = 'interrupted: worker or host stopped before the job finished'
           WHERE id = ? AND status = 'RUNNING'`,
        )
        .run(nowIso, nowIso, job.id);
      recovered.push(this.get(job.id));
    }
    return recovered;
  }

  get(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
  }

  list({ status = null, limit = 50 } = {}) {
    if (status) {
      return this.db
        .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all(status, limit);
    }
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  lastError() {
    return (
      this.db
        .prepare("SELECT * FROM jobs WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 1")
        .get() ?? null
    );
  }

  lastSuccessful() {
    return (
      this.db
        .prepare("SELECT * FROM jobs WHERE status = 'SUCCEEDED' ORDER BY finished_at DESC LIMIT 1")
        .get() ?? null
    );
  }

  counts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}
