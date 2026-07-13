/**
 * Notification interface.
 *
 * A notifier is: { name: string, enabled: boolean, sendRunReport(report): Promise<void> }
 *
 * Phase 2 ships two implementations:
 *  - noop (default — notifications are disabled by default)
 *  - Slack Incoming Webhook digest (opt-in via NOTIFICATIONS_ENABLED=true)
 *
 * Phase 3 will extend this interface with alert history, issue
 * fingerprinting, reopened/resolved detection, and persistent dedup —
 * those are intentionally NOT implemented here.
 */

import { summarize } from './report.js';

export function createNoopNotifier() {
  return {
    name: 'noop',
    enabled: false,
    async sendRunReport() {
      /* notifications disabled */
    },
  };
}

export function formatSlackText(report, { maxIssuesPerProject = 10 } = {}) {
  const s = summarize(report);
  const lines = [
    `*SEO Audit Runner* — ${report.finishedAt ?? new Date().toISOString()}`,
    `Audited: ${s.completed} | Critical (P0) issues: ${s.criticalIssues} | ` +
      `Failures: ${s.failures} | Skipped: ${s.skipped} | Deduplicated: ${s.deduplicated}`,
  ];

  const byProject = new Map();
  for (const issue of report.criticalIssues ?? []) {
    const key = issue.projectId ?? 'unknown';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(issue);
  }

  for (const [projectId, issues] of byProject) {
    const entry = (report.entries ?? []).find((e) => e.projectId === projectId);
    const label = entry?.projectName ?? projectId;
    const domain = entry?.domain ? ` (${entry.domain})` : '';
    lines.push('');
    lines.push(`*${label}*${domain} — ${issues.length} critical (P0)`);
    for (const issue of issues.slice(0, maxIssuesPerProject)) {
      const where = issue.source === 'site' ? 'site-wide' : issue.pageUrl ?? '';
      lines.push(`• [${issue.area ?? '—'}] ${issue.message ?? '(no message)'}${where ? ` — ${where}` : ''}`);
    }
    if (issues.length > maxIssuesPerProject) {
      lines.push(`… and ${issues.length - maxIssuesPerProject} more`);
    }
  }

  const failed = (report.entries ?? []).filter((e) =>
    ['FAILED', 'TIMED_OUT', 'TRIGGER_FAILED', 'TRIGGER_OUTCOME_UNKNOWN'].includes(e.outcome),
  );
  if (failed.length > 0) {
    lines.push('');
    lines.push('*Attention needed:*');
    for (const e of failed) {
      lines.push(`• ${e.projectName ?? e.projectId} (${e.domain ?? '?'}): ${e.outcome}`);
    }
  }

  return lines.join('\n');
}

export function createSlackWebhookNotifier({
  webhookUrl,
  fetchImpl = globalThis.fetch,
  logger = null,
  requestTimeoutMs = 15_000,
  maxIssuesPerProject = 10,
}) {
  return {
    name: 'slack-webhook',
    enabled: true,
    async sendRunReport(report) {
      const text = formatSlackText(report, { maxIssuesPerProject });
      const res = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!res.ok) {
        // Never include the webhook URL in the error path — it is a secret.
        throw new Error(`Slack webhook responded with HTTP ${res.status}`);
      }
      logger?.info?.('Slack notification sent');
    },
  };
}

/**
 * Factory honoring config + per-run override.
 * @param disabled force-disable (used by --no-notifications and --dry-run)
 */
export function createNotifier({ config, logger = null, disabled = false, fetchImpl = globalThis.fetch }) {
  if (disabled || !config.notificationsEnabled) return createNoopNotifier();
  if (!config.slackWebhookUrl) {
    logger?.warn?.('Notifications enabled but SLACK_WEBHOOK_URL is missing — notifications disabled');
    return createNoopNotifier();
  }
  return createSlackWebhookNotifier({ webhookUrl: config.slackWebhookUrl, logger, fetchImpl });
}
