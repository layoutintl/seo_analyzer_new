#!/usr/bin/env node
/**
 * seo-audit-runner — standalone Linux automation command.
 *
 * Commands:
 *   validate-config
 *   list-projects
 *   run --all | --project <id> [--dry-run] [--max-concurrency <n>]
 *       [--no-notifications] [--fail-on-critical]
 *
 * Exit codes (precedence: 4 > 1 > 3 > 2 > 0):
 *   0  completed successfully
 *   1  configuration or runner-level failure (including aborted runs)
 *   2  one or more audits failed or timed out
 *   3  critical issues found when --fail-on-critical is enabled
 *   4  another runner instance is already active
 */

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnvFile, ConfigError, PACKAGE_ROOT, redactUrl } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { ApiClient } from '../src/apiClient.js';
import { acquireLock, LockError } from '../src/lock.js';
import { runAudits } from '../src/orchestrator.js';
import { createNotifier } from '../src/notifier.js';
import { computeExitCode, formatTextReport, EXIT_CODES } from '../src/report.js';
import { dedupeProjects, hasUsableFormValues } from '../src/dedupe.js';

const USAGE = `Usage: seo-audit-runner <command> [options]

Commands:
  validate-config           Validate configuration and the state directory
  list-projects             List projects with a dedupe preview (read-only)
  run --all                 Audit every project (after deduplication)
  run --project <id>        Audit a single project by ID

Run options:
  --dry-run                 Plan only: no audit started, no state written,
                            no notifications sent
  --max-concurrency <n>     Override RUNNER_CONCURRENCY for this run
  --no-notifications        Disable notifications for this run
  --fail-on-critical        Exit with code 3 when critical (P0) issues exist

Global options:
  --env-file <path>         Env file to load (default: <runner dir>/.env)
  --help                    Show this help

Exit codes: 0 ok | 1 config/runner failure | 2 audit failures/timeouts
            3 criticals with --fail-on-critical | 4 already locked
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  return EXIT_CODES.RUNNER_FAILURE;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        all: { type: 'boolean', default: false },
        project: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'max-concurrency': { type: 'string' },
        'no-notifications': { type: 'boolean', default: false },
        'fail-on-critical': { type: 'boolean', default: false },
        'env-file': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    return fail(`${err.message}\n\n${USAGE}`);
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? EXIT_CODES.OK : EXIT_CODES.RUNNER_FAILURE;
  }

  loadEnvFile(values['env-file'] ?? path.join(PACKAGE_ROOT, '.env'));

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message);
    throw err;
  }

  const logger = createLogger({
    level: config.logLevel,
    secrets: [config.slackWebhookUrl].filter(Boolean),
  });

  switch (command) {
    case 'validate-config':
      return validateConfigCommand(config);
    case 'list-projects':
      return listProjectsCommand(config, logger);
    case 'run':
      return runCommand(config, logger, values);
    default:
      return fail(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

// ── validate-config ─────────────────────────────────────────────

function validateConfigCommand(config) {
  const lines = [
    'Configuration OK',
    `  SEO_API_BASE_URL        = ${config.apiBaseUrlRedacted}`,
    `  RUNNER_CONCURRENCY      = ${config.runnerConcurrency}`,
    `  POLL_INTERVAL_MS        = ${config.pollIntervalMs}`,
    `  POLL_TIMEOUT_MS         = ${config.pollTimeoutMs}`,
    `  HTTP_REQUEST_TIMEOUT_MS = ${config.httpRequestTimeoutMs}`,
    `  RUNNER_STATE_DIR        = ${config.stateDir}`,
    `  RUNNER_LOG_LEVEL        = ${config.logLevel}`,
    `  NOTIFICATIONS_ENABLED   = ${config.notificationsEnabled}`,
    `  SLACK_WEBHOOK_URL       = ${config.slackWebhookUrl ? '[REDACTED — set]' : '(not set)'}`,
  ];
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.accessSync(config.stateDir, fs.constants.W_OK);
    lines.push(`  state directory writable: yes`);
  } catch (err) {
    process.stdout.write(lines.join('\n') + '\n');
    return fail(`State directory is not writable (${config.stateDir}): ${err.message}`);
  }
  lines.push('');
  lines.push('Note: connectivity is not tested here — use `seo-audit-runner list-projects`.');
  process.stdout.write(lines.join('\n') + '\n');
  return EXIT_CODES.OK;
}

// ── list-projects ───────────────────────────────────────────────

async function listProjectsCommand(config, logger) {
  const apiClient = new ApiClient({
    baseUrl: config.apiBaseUrl,
    requestTimeoutMs: config.httpRequestTimeoutMs,
    logger,
  });

  let projects;
  try {
    projects = await apiClient.listProjects();
  } catch (err) {
    return fail(`Failed to list projects from ${config.apiBaseUrlRedacted}: ${logger.redact(err.message)}`);
  }

  const { winners, duplicates } = dedupeProjects(projects);
  const winnerIds = new Set(winners.map((w) => String(w.project.id)));
  const duplicateById = new Map(duplicates.map((d) => [String(d.project.id), d.winnerId]));

  process.stdout.write(`${projects.length} project(s) — ${winners.length} unique domain(s)\n\n`);
  for (const p of projects) {
    const id = String(p.id);
    const role = winnerIds.has(id)
      ? 'winner'
      : `deduplicated: covered by ${duplicateById.get(id)}`;
    const usable = hasUsableFormValues(p) ? 'yes' : 'NO';
    process.stdout.write(
      `- ${id}\n` +
        `    name: ${p.project_name ?? p.name ?? '(unnamed)'} | domain: ${p.domain ?? '?'}\n` +
        `    website_url: ${p.website_url ? redactUrl(p.website_url) : '(none)'} | audit config usable: ${usable}\n` +
        `    last_audit_at: ${p.last_audit_at ?? 'never'} | audits: ${p.audit_count ?? 0} (completed: ${p.completed_count ?? 0})\n` +
        `    dedupe: ${role}\n`,
    );
  }
  return EXIT_CODES.OK;
}

// ── run ─────────────────────────────────────────────────────────

async function runCommand(config, logger, values) {
  const all = Boolean(values.all);
  const projectId = values.project ?? null;
  const dryRun = Boolean(values['dry-run']);

  if (!all && !projectId) return fail(`run requires --all or --project <id>\n\n${USAGE}`);
  if (all && projectId) return fail('run accepts either --all or --project <id>, not both');

  let maxConcurrency;
  if (values['max-concurrency'] !== undefined) {
    maxConcurrency = Number.parseInt(values['max-concurrency'], 10);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      return fail(`--max-concurrency must be an integer >= 1, got: ${values['max-concurrency']}`);
    }
  }

  // ── Single-instance process lock ──────────────────────────────
  let lock;
  try {
    lock = acquireLock({ stateDir: config.stateDir });
  } catch (err) {
    if (err instanceof LockError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_CODES.ALREADY_LOCKED;
    }
    throw err;
  }
  const releaseLockOnExit = () => lock.release();
  process.on('exit', releaseLockOnExit);

  // ── Graceful shutdown ─────────────────────────────────────────
  const controller = new AbortController();
  const onSignal = (sig) => {
    logger.warn(`Received ${sig} — aborting gracefully (lock will be released)`);
    controller.abort();
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const apiClient = new ApiClient({
    baseUrl: config.apiBaseUrl,
    requestTimeoutMs: config.httpRequestTimeoutMs,
    logger,
  });
  const notifier = createNotifier({
    config,
    logger,
    disabled: dryRun || Boolean(values['no-notifications']),
  });

  try {
    logger.info(
      `Run starting (${dryRun ? 'DRY RUN' : 'live'}; target: ${config.apiBaseUrlRedacted}; ` +
        `concurrency: ${maxConcurrency ?? config.runnerConcurrency})`,
    );

    const report = await runAudits({
      config,
      apiClient,
      logger,
      signal: controller.signal,
      options: { projectId, dryRun, maxConcurrency },
    });

    // Persist the run journal (never during dry run).
    if (!dryRun) {
      try {
        fs.mkdirSync(config.stateDir, { recursive: true });
        const stamp = report.startedAt.replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(config.stateDir, `run-${stamp}.json`),
          JSON.stringify(report, null, 2),
        );
        fs.writeFileSync(
          path.join(config.stateDir, 'last-run.json'),
          JSON.stringify(report, null, 2),
        );
      } catch (err) {
        logger.warn(`Could not write run journal to ${config.stateDir}: ${err.message}`);
      }
    }

    // Notifications (noop when disabled — the default).
    if (notifier.enabled) {
      try {
        await notifier.sendRunReport(report);
      } catch (err) {
        logger.warn(`Notification failed: ${logger.redact(err.message)}`);
      }
    }

    process.stdout.write(formatTextReport(report));

    const code = computeExitCode(report, { failOnCritical: Boolean(values['fail-on-critical']) });
    logger.info(`Run finished with exit code ${code}`);
    return code;
  } catch (err) {
    logger.error(`Runner failure: ${err.stack ?? err.message}`);
    return EXIT_CODES.RUNNER_FAILURE;
  } finally {
    lock.release();
    process.removeListener('exit', releaseLockOnExit);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Fatal: ${err.stack ?? err.message}\n`);
    process.exit(EXIT_CODES.RUNNER_FAILURE);
  });
