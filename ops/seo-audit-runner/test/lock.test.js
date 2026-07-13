import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, LockError, isProcessAlive } from '../src/lock.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seo-runner-lock-'));

test('acquires and releases the lock', () => {
  const dir = tmpDir();
  const lock = acquireLock({ stateDir: dir });
  assert.ok(fs.existsSync(lock.path));
  lock.release();
  assert.ok(!fs.existsSync(lock.path));
});

test('a second acquisition fails while the first is held', () => {
  const dir = tmpDir();
  const lock = acquireLock({ stateDir: dir });
  assert.throws(() => acquireLock({ stateDir: dir }), LockError);
  lock.release();
});

test('lock can be re-acquired after release', () => {
  const dir = tmpDir();
  const first = acquireLock({ stateDir: dir });
  first.release();
  const second = acquireLock({ stateDir: dir });
  assert.ok(fs.existsSync(second.path));
  second.release();
});

test('stale lock (dead pid) is reclaimed', () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, 'seo-audit-runner.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, startedAt: 'x' }));
  const lock = acquireLock({ stateDir: dir });
  assert.ok(fs.existsSync(lock.path));
  const written = JSON.parse(fs.readFileSync(lock.path, 'utf8'));
  assert.equal(written.pid, process.pid);
  lock.release();
});

test('unreadable lock file is treated as stale', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'seo-audit-runner.lock'), 'not-json');
  const lock = acquireLock({ stateDir: dir });
  assert.ok(fs.existsSync(lock.path));
  lock.release();
});

test('release is idempotent', () => {
  const dir = tmpDir();
  const lock = acquireLock({ stateDir: dir });
  lock.release();
  lock.release(); // must not throw
});

test('isProcessAlive: current process is alive, absurd pid is not', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(2147483647), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(null), false);
});
