/**
 * Configuration loading and validation.
 *
 * Pure function over an env object so tests never touch process.env.
 * The application API has no authentication — we deliberately do NOT
 * invent a token header. Instead we validate that the API endpoint is
 * a trusted private address (or explicitly overridden for development).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, '..');

export class ConfigError extends Error {
  constructor(problems) {
    const list = Array.isArray(problems) ? problems : [problems];
    super(`Invalid configuration:\n  - ${list.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = list;
  }
}

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

const DEFAULTS = {
  SEO_API_BASE_URL: 'http://localhost:3000',
  RUNNER_CONCURRENCY: '1',
  POLL_INTERVAL_MS: '5000',
  POLL_TIMEOUT_MS: '900000',
  HTTP_REQUEST_TIMEOUT_MS: '30000',
  RUNNER_LOG_LEVEL: 'info',
  NOTIFICATIONS_ENABLED: 'false',
  ALLOW_INSECURE_PUBLIC_API: 'false',
};

// Hostnames considered private/trusted for plain-http transport.
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^\[?::1\]?$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
];

export function isPrivateHostname(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  if (!h) return false;
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(h))) return true;
  // Single-label names (docker-compose service names, bare intranet hosts).
  if (!h.includes('.')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  return false;
}

/** Redact credentials embedded in a URL so it is safe to log. */
export function redactUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch {
    return String(raw).replace(/\/\/[^@/\s]+@/g, '//***:***@');
  }
}

function parseBool(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/**
 * Load KEY=VALUE pairs from an env file into `target` WITHOUT overriding
 * values that are already set. Missing file is not an error.
 */
export function loadEnvFile(filePath, target = process.env) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in target && String(target[key]).length > 0)) {
      target[key] = value;
    }
  }
  return true;
}

export function loadConfig(env = process.env) {
  const problems = [];
  const raw = (key) => String(env[key] ?? DEFAULTS[key] ?? '').trim();

  // ── API base URL ────────────────────────────────────────────────
  const allowInsecurePublicApi = parseBool(raw('ALLOW_INSECURE_PUBLIC_API'));
  const rawBase = raw('SEO_API_BASE_URL');
  let apiBaseUrl = null;
  let parsedBase = null;
  if (!rawBase) {
    problems.push('SEO_API_BASE_URL is required');
  } else {
    try {
      parsedBase = new URL(rawBase);
    } catch {
      problems.push(`SEO_API_BASE_URL is not a valid URL: ${redactUrl(rawBase)}`);
    }
  }
  if (parsedBase) {
    if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
      problems.push(`SEO_API_BASE_URL must be http(s), got: ${parsedBase.protocol}`);
    } else if (
      parsedBase.protocol === 'http:' &&
      !isPrivateHostname(parsedBase.hostname) &&
      !allowInsecurePublicApi
    ) {
      problems.push(
        `SEO_API_BASE_URL points to a public host over plain http (${redactUrl(rawBase)}). ` +
          'The application API is unauthenticated — use localhost, a private network address, ' +
          'or https. Set ALLOW_INSECURE_PUBLIC_API=true only for development.',
      );
    } else {
      apiBaseUrl = parsedBase.toString().replace(/\/+$/, '');
    }
  }

  // ── Numeric settings ────────────────────────────────────────────
  const parsePositiveInt = (key, { min = 1 } = {}) => {
    const value = Number.parseInt(raw(key), 10);
    if (!Number.isInteger(value) || value < min) {
      problems.push(`${key} must be an integer >= ${min}, got: ${raw(key) || '(empty)'}`);
      return null;
    }
    return value;
  };
  const runnerConcurrency = parsePositiveInt('RUNNER_CONCURRENCY');
  const pollIntervalMs = parsePositiveInt('POLL_INTERVAL_MS', { min: 100 });
  const pollTimeoutMs = parsePositiveInt('POLL_TIMEOUT_MS', { min: 1000 });
  const httpRequestTimeoutMs = parsePositiveInt('HTTP_REQUEST_TIMEOUT_MS', { min: 1000 });

  // ── Logging ─────────────────────────────────────────────────────
  const logLevel = raw('RUNNER_LOG_LEVEL').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) {
    problems.push(`RUNNER_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${logLevel}`);
  }

  // ── State directory ─────────────────────────────────────────────
  const stateDir = String(env.RUNNER_STATE_DIR ?? '').trim() || path.join(PACKAGE_ROOT, 'state');

  // ── Notifications ───────────────────────────────────────────────
  const notificationsEnabled = parseBool(raw('NOTIFICATIONS_ENABLED'));
  const slackWebhookUrl = String(env.SLACK_WEBHOOK_URL ?? '').trim() || null;
  if (notificationsEnabled && !slackWebhookUrl) {
    problems.push('NOTIFICATIONS_ENABLED=true requires SLACK_WEBHOOK_URL to be set');
  }
  if (slackWebhookUrl && !slackWebhookUrl.startsWith('https://') && !allowInsecurePublicApi) {
    problems.push('SLACK_WEBHOOK_URL must be an https:// URL');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    apiBaseUrl,
    apiBaseUrlRedacted: redactUrl(apiBaseUrl).replace(/\/+$/, ''),
    runnerConcurrency,
    pollIntervalMs,
    pollTimeoutMs,
    httpRequestTimeoutMs,
    stateDir,
    logLevel,
    notificationsEnabled,
    slackWebhookUrl,
    allowInsecurePublicApi,
  };
}
