import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RUNNER_ROOT } from '../tools/shellHarness.js';

const SYSTEMD_DIR = path.join(RUNNER_ROOT, 'deploy', 'systemd');
const SERVICES = ['seo-audit-runner.service', 'seo-runner-retry.service', 'seo-runner-tick.service'];
const TIMERS = ['seo-audit-runner.timer', 'seo-runner-retry.timer', 'seo-runner-tick.timer'];

const read = (name) => fs.readFileSync(path.join(SYSTEMD_DIR, name), 'utf8');

test('all six unit files exist with LF-only line endings', () => {
  for (const name of [...SERVICES, ...TIMERS]) {
    const bytes = fs.readFileSync(path.join(SYSTEMD_DIR, name));
    assert.ok(bytes.length > 0, `${name} missing or empty`);
    assert.ok(!bytes.includes(0x0d), `${name} contains CRLF`);
  }
});

test('services run as seo-runner, oneshot, via the wrapper, with the env file', () => {
  const execStart = {
    'seo-audit-runner.service': /^ExecStart=\/usr\/local\/bin\/seo-audit-runner run --all$/m,
    'seo-runner-retry.service': /^ExecStart=\/usr\/local\/bin\/seo-audit-runner retry-notifications$/m,
    'seo-runner-tick.service': /^ExecStart=\/usr\/local\/bin\/seo-audit-runner worker --once$/m,
  };
  for (const name of SERVICES) {
    const unit = read(name);
    assert.match(unit, /^Type=oneshot$/m, name);
    assert.match(unit, /^User=seo-runner$/m, name);
    assert.match(unit, /^Group=seo-runner$/m, name);
    assert.match(unit, /^EnvironmentFile=\/etc\/seo-audit-runner\/runner\.env$/m, name);
    assert.match(unit, execStart[name], name);
    assert.ok(!/^User=root/m.test(unit), `${name} must never run as root`);
  }
});

test('services are hardened and write-restricted to runner directories', () => {
  for (const name of SERVICES) {
    const unit = read(name);
    for (const directive of [
      'NoNewPrivileges=true',
      'ProtectSystem=strict',
      'ProtectHome=true',
      'ReadWritePaths=/var/lib/seo-audit-runner /var/log/seo-audit-runner',
      'PrivateTmp=true',
      'RestrictSUIDSGID=true',
      'CapabilityBoundingSet=',
      'RuntimeDirectory=seo-audit-runner',
      'UMask=0027',
      'KillSignal=SIGTERM',
    ]) {
      assert.ok(unit.includes(directive), `${name} is missing ${directive}`);
    }
    assert.match(unit, /^TimeoutStartSec=/m, name);
    assert.match(unit, /^TimeoutStopSec=/m, name);
    assert.match(unit, /^MemoryMax=/m, name);
    assert.match(unit, /^TasksMax=/m, name);
  }
});

test('timers: daily audit pinned to Africa/Cairo with catch-up; tick every 5 minutes', () => {
  const daily = read('seo-audit-runner.timer');
  assert.match(daily, /^OnCalendar=\*-\*-\* 03:00:00 Africa\/Cairo$/m);
  assert.match(daily, /^Persistent=true$/m);
  assert.match(daily, /^RandomizedDelaySec=/m);

  const retry = read('seo-runner-retry.timer');
  assert.match(retry, /^OnCalendar=hourly$/m);
  assert.match(retry, /^Persistent=true$/m);

  const tick = read('seo-runner-tick.timer');
  assert.match(tick, /^OnCalendar=\*:0\/5$/m);
  assert.match(tick, /^Persistent=false$/m);

  for (const name of TIMERS) {
    assert.match(read(name), /^WantedBy=timers\.target$/m, name);
  }
});

test('unit files contain no secrets and no shell constructs', () => {
  for (const name of [...SERVICES, ...TIMERS]) {
    const unit = read(name);
    assert.ok(!/xoxb-|hooks\.slack\.com\/services\/T/.test(unit), `${name} contains a credential-shaped value`);
    assert.ok(!/ExecStart=.*(\||&&|;|\$\(|`)/.test(unit), `${name} ExecStart must be a plain argv, no shell`);
  }
});
