import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError, redactUrl, isPrivateHostname } from '../src/config.js';
import { createLogger } from '../src/logger.js';

test('defaults apply when env is empty', () => {
  const config = loadConfig({});
  assert.equal(config.apiBaseUrl, 'http://localhost:3000');
  assert.equal(config.runnerConcurrency, 1);
  assert.equal(config.pollIntervalMs, 5000);
  assert.equal(config.pollTimeoutMs, 900000);
  assert.equal(config.httpRequestTimeoutMs, 30000);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.notificationsEnabled, false);
  assert.equal(config.slackWebhookUrl, null);
});

test('rejects a public plain-http API URL without the dev override', () => {
  assert.throws(
    () => loadConfig({ SEO_API_BASE_URL: 'http://203.0.113.10:3000' }),
    ConfigError,
  );
  assert.throws(
    () => loadConfig({ SEO_API_BASE_URL: 'http://seo.example.com' }),
    ConfigError,
  );
});

test('allows public plain-http with the explicit development override', () => {
  const config = loadConfig({
    SEO_API_BASE_URL: 'http://seo.example.com',
    ALLOW_INSECURE_PUBLIC_API: 'true',
  });
  assert.equal(config.apiBaseUrl, 'http://seo.example.com');
});

test('allows https public URLs and private http URLs', () => {
  assert.equal(
    loadConfig({ SEO_API_BASE_URL: 'https://seo.example.com' }).apiBaseUrl,
    'https://seo.example.com',
  );
  for (const url of [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://10.1.2.3:3000',
    'http://172.20.0.5:3000',
    'http://192.168.1.10:3000',
    'http://app:3000', // docker-compose service name
  ]) {
    assert.ok(loadConfig({ SEO_API_BASE_URL: url }).apiBaseUrl, url);
  }
});

test('invalid numbers and log level are rejected', () => {
  assert.throws(() => loadConfig({ RUNNER_CONCURRENCY: 'zero' }), ConfigError);
  assert.throws(() => loadConfig({ RUNNER_CONCURRENCY: '0' }), ConfigError);
  assert.throws(() => loadConfig({ POLL_INTERVAL_MS: '-5' }), ConfigError);
  assert.throws(() => loadConfig({ RUNNER_LOG_LEVEL: 'loud' }), ConfigError);
});

test('notifications enabled requires a webhook URL', () => {
  assert.throws(() => loadConfig({ NOTIFICATIONS_ENABLED: 'true' }), ConfigError);
  const config = loadConfig({
    NOTIFICATIONS_ENABLED: 'true',
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
  });
  assert.equal(config.notificationsEnabled, true);
});

test('notifications stay disabled by default even with a webhook set', () => {
  const config = loadConfig({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' });
  assert.equal(config.notificationsEnabled, false);
});

test('redactUrl masks embedded credentials', () => {
  assert.equal(
    redactUrl('https://user:secret@db.example.com:5432/db'),
    'https://***:***@db.example.com:5432/db',
  );
  assert.ok(!redactUrl('https://user:secret@x.com').includes('secret'));
});

test('isPrivateHostname classification', () => {
  assert.equal(isPrivateHostname('localhost'), true);
  assert.equal(isPrivateHostname('app'), true);
  assert.equal(isPrivateHostname('10.0.0.1'), true);
  assert.equal(isPrivateHostname('172.31.0.1'), true);
  assert.equal(isPrivateHostname('172.32.0.1'), false);
  assert.equal(isPrivateHostname('example.com'), false);
});

test('logger redacts registered secrets and URL credentials', () => {
  const stream = { data: '', write(chunk) { this.data += chunk; } };
  const webhook = 'https://hooks.slack.com/services/T0/B0/supersecrettoken';
  const logger = createLogger({ level: 'debug', stream, secrets: [webhook] });

  logger.info(`posting to ${webhook} with db postgresql://seo:hunter2@db:5432/x`);

  assert.ok(!stream.data.includes('supersecrettoken'), 'webhook token must be redacted');
  assert.ok(!stream.data.includes('hunter2'), 'URL credentials must be redacted');
  assert.ok(stream.data.includes('[REDACTED]'));
  assert.ok(stream.data.includes('//***:***@'));
});

test('logger respects level threshold', () => {
  const stream = { data: '', write(chunk) { this.data += chunk; } };
  const logger = createLogger({ level: 'warn', stream });
  logger.info('hidden');
  logger.debug('hidden');
  logger.warn('visible');
  logger.error('visible too');
  assert.ok(!stream.data.includes('hidden'));
  assert.ok(stream.data.includes('visible'));
  assert.ok(stream.data.includes('visible too'));
});
