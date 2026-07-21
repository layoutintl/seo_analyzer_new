import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHECK_NODE_SH,
  ENV_EXAMPLE,
  INSTALL_SH,
  RUNNER_ROOT,
  WRAPPER_SH,
  bashMissing,
  findBash,
} from '../tools/shellHarness.js';

const SHELL_SCRIPTS = [INSTALL_SH, CHECK_NODE_SH, WRAPPER_SH];
const ALL_DEPLOY_FILES = [...SHELL_SCRIPTS, ENV_EXAMPLE];

test('deployment shell scripts and env template are LF-only (no CR bytes)', () => {
  for (const file of ALL_DEPLOY_FILES) {
    const bytes = fs.readFileSync(file);
    assert.ok(!bytes.includes(0x0d), `${path.basename(file)} contains CR bytes (CRLF line endings)`);
  }
});

test('deployment shell scripts start with a bash shebang', () => {
  for (const file of SHELL_SCRIPTS) {
    const firstLine = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    assert.equal(firstLine, '#!/usr/bin/env bash', `${path.basename(file)} shebang: ${firstLine}`);
  }
});

test('deployment shell scripts use strict mode', () => {
  for (const file of SHELL_SCRIPTS) {
    assert.match(
      fs.readFileSync(file, 'utf8'),
      /^set -Eeuo pipefail$/m,
      `${path.basename(file)} is missing set -Eeuo pipefail`,
    );
  }
});

test('no eval anywhere in the deployment scripts (comments excluded)', () => {
  for (const file of SHELL_SCRIPTS) {
    const code = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    assert.ok(!/\beval\b/.test(code), `${path.basename(file)} uses eval`);
  }
});

test('deployment scripts never reference systemctl, systemd units, or crontab', () => {
  for (const file of SHELL_SCRIPTS) {
    const code = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    assert.ok(!/\bsystemctl\b/.test(code), `${path.basename(file)} invokes systemctl`);
    assert.ok(!/\bcrontab\b/.test(code), `${path.basename(file)} invokes crontab`);
    assert.ok(!/\.service\b|\.timer\b/.test(code), `${path.basename(file)} references unit files`);
  }
});

test('env template contains no real credentials (all Slack values empty, private API URL)', () => {
  const content = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const value = (key) => {
    const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
    assert.ok(m, `${key} missing from the template`);
    return m[1].trim();
  };
  assert.equal(value('SLACK_BOT_TOKEN'), '');
  assert.equal(value('SLACK_CHANNEL_ID'), '');
  assert.equal(value('SLACK_WEBHOOK_URL'), '');
  assert.equal(value('SEO_API_BASE_URL'), 'http://127.0.0.1:3000');
  assert.equal(value('RUNNER_STATE_DIR'), '/var/lib/seo-audit-runner');
  assert.equal(value('RUNNER_STATE_DB_PATH'), '/var/lib/seo-audit-runner/runner-state.sqlite');
  assert.ok(!/xoxb-[0-9A-Za-z]/.test(content), 'template contains a bot-token-shaped value');
  assert.ok(!/hooks\.slack\.com\/services\/T/.test(content), 'template contains a webhook-shaped value');
});

test('env template does not pretend RUNNER_LOCK_DIR is supported (Phase 4F item)', () => {
  const content = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  assert.ok(!/RUNNER_LOCK_DIR/.test(content), 'RUNNER_LOCK_DIR is not implemented until Phase 4F');
});

test('all deployment scripts pass bash -n (syntax check)', { skip: bashMissing() ? 'no bash available' : false }, () => {
  for (const file of SHELL_SCRIPTS) {
    const rel = path.relative(RUNNER_ROOT, file).replace(/\\/g, '/');
    const r = spawnSync(findBash(), ['-n', file.replace(/\\/g, '/')], { encoding: 'utf8' });
    assert.equal(r.status, 0, `bash -n failed for ${rel}: ${r.stdout}${r.stderr}`);
  }
});
