/**
 * Runner-owned state access layer over the SQLite database (see db.js).
 *
 * Issue lifecycle rules (applied ONLY after a valid COMPLETED audit):
 *  - NEW:       fingerprint never seen for the project
 *  - UNCHANGED: fingerprint exists and was ACTIVE in the previous snapshot
 *  - REOPENED:  fingerprint existed but was RESOLVED before this audit
 *  - RESOLVED:  fingerprint was ACTIVE previously and is absent now
 *
 * The snapshot insert and all lifecycle transitions happen atomically in a
 * single SQLite transaction. Failed/timed-out/partial audits never reach
 * this code path (guarded by the notification pipeline), so a valid
 * previous snapshot is never replaced with bad data.
 */

export class StateStore {
  constructor(db) {
    this.db = db;
  }

  // ── Automation runs ───────────────────────────────────────────

  createRun({ id, startedAt }) {
    this.db
      .prepare('INSERT INTO automation_runs (id, started_at) VALUES (?, ?)')
      .run(id, startedAt);
  }

  finishRun(id, {
    completedAt,
    finalStatus,
    totalProjects = 0,
    successfulAudits = 0,
    failedAudits = 0,
    timedOutAudits = 0,
    deduplicatedProjects = 0,
    projectsWithCritical = 0,
    notificationStatus = null,
  }) {
    this.db
      .prepare(`
        UPDATE automation_runs SET
          completed_at = ?, final_status = ?, total_projects = ?,
          successful_audits = ?, failed_audits = ?, timed_out_audits = ?,
          deduplicated_projects = ?, projects_with_critical = ?, notification_status = ?
        WHERE id = ?
      `)
      .run(
        completedAt, finalStatus, totalProjects,
        successfulAudits, failedAudits, timedOutAudits,
        deduplicatedProjects, projectsWithCritical, notificationStatus,
        id,
      );
  }

  getLatestRun() {
    return this.db
      .prepare('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 1')
      .get() ?? null;
  }

  // ── Snapshots + issue lifecycle (atomic) ──────────────────────

  /**
   * Apply a COMPLETED audit's P0 issues to the stored issue state and
   * record the snapshot — all in one transaction.
   *
   * @param issues array of critical issues, each already carrying a
   *               `fingerprint` property
   * @returns {{ new: [], reopened: [], unchanged: [], resolved: [] }}
   */
  recordSnapshotAndLifecycle({
    projectId,
    normalizedDomain = null,
    auditRunId,
    auditCompletedAt = null,
    issues,
    now = new Date().toISOString(),
  }) {
    const db = this.db;
    const result = { new: [], reopened: [], unchanged: [], resolved: [] };

    db.exec('BEGIN IMMEDIATE');
    try {
      const existingRows = db
        .prepare('SELECT * FROM issue_states WHERE project_id = ?')
        .all(projectId);
      const existingByFp = new Map(existingRows.map((r) => [r.fingerprint, r]));
      const currentFps = new Set();

      const insertIssue = db.prepare(`
        INSERT INTO issue_states
          (project_id, fingerprint, area, normalized_url, message, fix_hint, page_type,
           first_seen_at, last_seen_at, last_audit_run_id, state, resolved_at, reopened_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, 0)
      `);
      const touchIssue = db.prepare(`
        UPDATE issue_states
        SET last_seen_at = ?, last_audit_run_id = ?, message = ?, fix_hint = ?
        WHERE project_id = ? AND fingerprint = ?
      `);
      const reopenIssue = db.prepare(`
        UPDATE issue_states
        SET state = 'ACTIVE', resolved_at = NULL, reopened_count = reopened_count + 1,
            last_seen_at = ?, last_audit_run_id = ?, message = ?, fix_hint = ?
        WHERE project_id = ? AND fingerprint = ?
      `);
      const resolveIssue = db.prepare(`
        UPDATE issue_states
        SET state = 'RESOLVED', resolved_at = ?, last_audit_run_id = ?
        WHERE project_id = ? AND fingerprint = ?
      `);

      for (const issue of issues) {
        const fp = issue.fingerprint;
        if (currentFps.has(fp)) continue; // same identity reported twice in one audit
        currentFps.add(fp);

        const existing = existingByFp.get(fp);
        if (!existing) {
          insertIssue.run(
            projectId, fp,
            issue.area ?? null, issue.normalizedUrl ?? issue.pageUrl ?? null,
            issue.message ?? null, issue.fixHint ?? null, issue.pageType ?? null,
            now, now, auditRunId,
          );
          result.new.push(issue);
        } else if (existing.state === 'ACTIVE') {
          touchIssue.run(now, auditRunId, issue.message ?? null, issue.fixHint ?? null, projectId, fp);
          result.unchanged.push(issue);
        } else {
          reopenIssue.run(now, auditRunId, issue.message ?? null, issue.fixHint ?? null, projectId, fp);
          result.reopened.push(issue);
        }
      }

      for (const row of existingRows) {
        if (row.state === 'ACTIVE' && !currentFps.has(row.fingerprint)) {
          resolveIssue.run(now, auditRunId, projectId, row.fingerprint);
          result.resolved.push({
            fingerprint: row.fingerprint,
            area: row.area,
            message: row.message,
            fixHint: row.fix_hint,
            pageUrl: row.normalized_url,
            pageType: row.page_type,
            source: row.normalized_url ? 'page' : 'site',
          });
        }
      }

      db.prepare(`
        INSERT INTO project_snapshots
          (project_id, normalized_domain, audit_run_id, audit_completed_at,
           snapshot_status, p0_count, created_at)
        VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)
      `).run(projectId, normalizedDomain, auditRunId, auditCompletedAt, currentFps.size, now);

      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      throw err;
    }
  }

  getLatestSnapshot(projectId) {
    return this.db
      .prepare('SELECT * FROM project_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT 1')
      .get(projectId) ?? null;
  }

  listActiveIssues(projectId) {
    return this.db
      .prepare("SELECT * FROM issue_states WHERE project_id = ? AND state = 'ACTIVE'")
      .all(projectId);
  }

  markIssuesAlerted(projectId, fingerprints, now = new Date().toISOString()) {
    const stmt = this.db.prepare(
      'UPDATE issue_states SET last_alerted_at = ? WHERE project_id = ? AND fingerprint = ?',
    );
    for (const fp of fingerprints) stmt.run(now, projectId, fp);
  }

  // ── Notifications ─────────────────────────────────────────────

  getNotification(id) {
    return this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) ?? null;
  }

  /** Insert the notification record if it does not already exist. */
  ensureNotification({
    id, runnerExecutionId = null, projectId = null, auditRunId = null,
    type, method = null, payloadHash, payloadJson,
    createdAt = new Date().toISOString(),
  }) {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO notifications
          (id, runner_execution_id, project_id, audit_run_id, type, method,
           payload_hash, payload_json, attempt_count, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'PENDING', ?)
      `)
      .run(id, runnerExecutionId, projectId, auditRunId, type, method, payloadHash, payloadJson, createdAt);
    return this.getNotification(id);
  }

  /** Atomically record one delivery attempt and its outcome. */
  recordNotificationAttempt(id, { status, error = null, deliveredAt = null, nextRetryAt = null }) {
    this.db
      .prepare(`
        UPDATE notifications
        SET attempt_count = attempt_count + 1, status = ?, last_error = ?,
            delivered_at = COALESCE(?, delivered_at), next_retry_at = ?
        WHERE id = ?
      `)
      .run(status, error, deliveredAt, nextRetryAt, id);
  }

  /**
   * Pending/retryable-failed notifications whose next_retry_at has passed.
   * Never returns DELIVERED or PERMANENT_FAILURE records.
   */
  listRetryableNotifications({ limit = 50, projectId = null, now = new Date().toISOString() } = {}) {
    const filters = ["status IN ('PENDING', 'FAILED')", '(next_retry_at IS NULL OR next_retry_at <= ?)'];
    const params = [now];
    if (projectId != null) {
      filters.push('project_id = ?');
      params.push(String(projectId));
    }
    params.push(limit);
    return this.db
      .prepare(`
        SELECT * FROM notifications
        WHERE ${filters.join(' AND ')}
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(...params);
  }

  // ── Status reporting (read-only) ──────────────────────────────

  statusSummary({ resolvedSinceDays = 7, snapshotLimit = 10 } = {}) {
    const db = this.db;
    const since = new Date(Date.now() - resolvedSinceDays * 86_400_000).toISOString();
    const count = (sql, ...params) => db.prepare(sql).get(...params)?.n ?? 0;
    return {
      latestRun: this.getLatestRun(),
      notificationQueueSize: count(
        "SELECT COUNT(*) AS n FROM notifications WHERE status IN ('PENDING', 'FAILED')",
      ),
      failedNotifications: count(
        "SELECT COUNT(*) AS n FROM notifications WHERE status IN ('FAILED', 'PERMANENT_FAILURE')",
      ),
      permanentlyFailedNotifications: count(
        "SELECT COUNT(*) AS n FROM notifications WHERE status = 'PERMANENT_FAILURE'",
      ),
      activeCriticalIssues: count(
        "SELECT COUNT(*) AS n FROM issue_states WHERE state = 'ACTIVE'",
      ),
      recentlyResolvedIssues: count(
        "SELECT COUNT(*) AS n FROM issue_states WHERE state = 'RESOLVED' AND resolved_at >= ?",
        since,
      ),
      latestSnapshots: db
        .prepare(`
          SELECT ps.* FROM project_snapshots ps
          JOIN (SELECT project_id, MAX(id) AS max_id FROM project_snapshots GROUP BY project_id) latest
            ON latest.max_id = ps.id
          ORDER BY ps.created_at DESC
          LIMIT ?
        `)
        .all(snapshotLimit),
    };
  }
}
