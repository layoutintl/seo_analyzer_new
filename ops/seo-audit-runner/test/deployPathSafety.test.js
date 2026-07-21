/**
 * Unit tests for deploy/path-safety.sh — the shared validation contract
 * behind every recursive deletion in purge.sh/uninstall.sh.
 *
 * The helper is exercised through its CLI:
 *   path-safety.sh validate <role> <mode> <path> [<destdir>]
 * All fixtures live in throwaway OS temp directories; nothing is deleted
 * by these tests (validate never deletes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RUNNER_ROOT,
  bashMissing,
  findBash,
  makeWorkspace,
  runScript,
  toPosix,
} from '../tools/shellHarness.js';

const skip = bashMissing() ? 'no bash available on this machine' : false;

const PATH_SAFETY = path.join(RUNNER_ROOT, 'deploy', 'path-safety.sh');
const SENTINEL = '.seo-audit-runner.owned';
const sentinelBody = (role) => `seo-audit-runner ownership sentinel v1\nrole=${role}\n`;

const validate = (args, opts = {}) => runScript(PATH_SAFETY, ['validate', ...args], opts);

/** destdir/var/lib/seo-audit-runner with a valid state sentinel. */
function stagedStateFixture() {
  const work = makeWorkspace();
  const destdir = path.join(work, 'stage');
  const state = path.join(destdir, 'var', 'lib', 'seo-audit-runner');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, SENTINEL), sentinelBody('state'));
  return { work, destdir, state };
}

/** True when bash's `test -L` recognizes the created link. */
function bashDetectsLink(p) {
  const r = spawnSync(findBash(), ['-c', `[ -L "${toPosix(p)}" ]`], { encoding: 'utf8' });
  return r.status === 0;
}

/** Create a directory symlink/junction detectable by bash; false otherwise. */
function tryDirLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'junction');
  } catch {
    try {
      fs.symlinkSync(target, linkPath, 'dir');
    } catch {
      return false;
    }
  }
  return bashDetectsLink(linkPath);
}

function tryFileLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'file');
  } catch {
    return false;
  }
  return bashDetectsLink(linkPath);
}

test('a valid staged state target passes and prints its canonical path', { skip }, () => {
  const fx = stagedStateFixture();
  const r = validate(['state', 'destdir', toPosix(fx.state), toPosix(fx.destdir)]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /seo-audit-runner/);
});

test('empty and relative targets are rejected', { skip }, () => {
  const fx = stagedStateFixture();
  for (const bad of ['', 'var/lib/seo-audit-runner', './x', '../x']) {
    const r = validate(['state', 'destdir', bad, toPosix(fx.destdir)]);
    assert.notEqual(r.status, 0, `accepted bad target: '${bad}'`);
  }
});

test('root, drive roots, and broad system parents are rejected in every mode', { skip }, () => {
  const fx = stagedStateFixture();
  const broad = ['/', '/etc', '/var', '/var/lib', '/var/log', '/opt', '/usr', '/usr/local', '/home', '/tmp'];
  if (process.platform === 'win32') broad.push('C:/', 'C:');
  for (const bad of broad) {
    for (const mode of [['production'], ['destdir', toPosix(fx.destdir)]]) {
      const r = validate(['state', mode[0], bad, ...(mode[1] ? [mode[1]] : [])]);
      assert.notEqual(r.status, 0, `accepted broad path '${bad}' in ${mode[0]} mode`);
    }
  }
});

test('the user home directory is rejected even with a sentinel planted', { skip }, () => {
  const home = os.homedir();
  const r = validate(['state', 'production', toPosix(home)]);
  assert.notEqual(r.status, 0, 'accepted the home directory as a deletion target');
});

test('traversal segments in the target are rejected lexically', { skip }, () => {
  const fx = stagedStateFixture();
  const sneaky = `${toPosix(fx.destdir)}/var/lib/../lib/seo-audit-runner`;
  const r = validate(['state', 'destdir', sneaky, toPosix(fx.destdir)]);
  assert.notEqual(r.status, 0, 'accepted a target containing ..');
  assert.match(r.stderr, /absolute|\.\.|clean/i);
});

test('a git repository root is never a valid deletion target', { skip }, () => {
  const work = makeWorkspace();
  const repo = path.join(work, 'sub', 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, SENTINEL), sentinelBody('state'));
  const r = validate(['state', 'production', toPosix(repo)]);
  assert.notEqual(r.status, 0, 'accepted a git repository root');
});

test('production mode accepts only the fixed approved path — arbitrary dirs refused', { skip }, () => {
  const fx = stagedStateFixture();
  // Perfectly runner-shaped, valid sentinel — but not /var/lib/seo-audit-runner.
  const r = validate(['state', 'production', toPosix(fx.state)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /approved path/);
});

test('destdir mode accepts only <destdir>+suffix — unrelated dirs refused', { skip }, () => {
  const fx = stagedStateFixture();
  const other = path.join(fx.work, 'elsewhere', 'var', 'lib', 'seo-audit-runner');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, SENTINEL), sentinelBody('state'));
  const r = validate(['state', 'destdir', toPosix(other), toPosix(fx.destdir)]);
  assert.notEqual(r.status, 0, 'accepted a target outside the validated destdir');
});

test('destdir itself must be valid: missing, relative, and root destdirs are refused', { skip }, () => {
  const fx = stagedStateFixture();
  for (const badDest of ['/', 'relative/stage', toPosix(path.join(fx.work, 'no-such-dir'))]) {
    const r = validate(['state', 'destdir', toPosix(fx.state), badDest]);
    assert.notEqual(r.status, 0, `accepted bad destdir '${badDest}'`);
  }
});

test('missing, malformed, and wrong-role sentinels are all refused', { skip }, () => {
  const fx = stagedStateFixture();
  const args = ['state', 'destdir', toPosix(fx.state), toPosix(fx.destdir)];
  const sentinelPath = path.join(fx.state, SENTINEL);

  fs.rmSync(sentinelPath);
  let r = validate(args);
  assert.notEqual(r.status, 0, 'accepted a target without a sentinel');
  assert.match(r.stderr, /sentinel/);

  fs.writeFileSync(sentinelPath, 'some other file entirely\n');
  r = validate(args);
  assert.notEqual(r.status, 0, 'accepted a malformed sentinel');

  fs.writeFileSync(sentinelPath, sentinelBody('etc'));
  r = validate(args);
  assert.notEqual(r.status, 0, 'accepted a wrong-role sentinel');
  assert.match(r.stderr, /role/);

  fs.writeFileSync(sentinelPath, sentinelBody('state'));
  r = validate(args);
  assert.equal(r.status, 0, `valid sentinel should pass again: ${r.output}`);
});

test('a sentinel that is only misplaced (in the parent) does not authorize deletion', { skip }, () => {
  const fx = stagedStateFixture();
  fs.rmSync(path.join(fx.state, SENTINEL));
  fs.writeFileSync(path.join(fx.destdir, 'var', 'lib', SENTINEL), sentinelBody('state'));
  const r = validate(['state', 'destdir', toPosix(fx.state), toPosix(fx.destdir)]);
  assert.notEqual(r.status, 0, 'a parent-directory sentinel authorized deletion');
});

test('symlinked target, target parent, and destdir are refused', { skip }, (t) => {
  const fx = stagedStateFixture();

  // Target itself is a link.
  const victim = path.join(fx.work, 'victim');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, SENTINEL), sentinelBody('state'));
  const linkTarget = path.join(fx.destdir, 'var', 'lib', 'seo-audit-runner-link');
  if (!tryDirLink(victim, linkTarget)) {
    t.skip('symlink creation not supported in this environment');
    return;
  }
  let r = validate(['state', 'destdir', toPosix(linkTarget), toPosix(fx.destdir)]);
  assert.notEqual(r.status, 0, 'accepted a symlink as deletion target');

  // A symlinked component in the middle of the path.
  const lib2 = path.join(fx.destdir, 'var', 'lib2');
  fs.renameSync(path.join(fx.destdir, 'var', 'lib'), lib2);
  assert.ok(tryDirLink(lib2, path.join(fx.destdir, 'var', 'lib')), 'link setup failed');
  r = validate([
    'state', 'destdir',
    `${toPosix(fx.destdir)}/var/lib/seo-audit-runner`,
    toPosix(fx.destdir),
  ]);
  assert.notEqual(r.status, 0, 'accepted a target behind a symlinked parent');
  assert.match(r.stderr, /symlink/);

  // A symlinked destdir.
  const destLink = path.join(fx.work, 'stage-link');
  assert.ok(tryDirLink(fx.destdir, destLink), 'link setup failed');
  r = validate([
    'state', 'destdir',
    `${toPosix(destLink)}/var/lib/seo-audit-runner`,
    toPosix(destLink),
  ]);
  assert.notEqual(r.status, 0, 'accepted a symlinked destdir');
});

test('a symlinked sentinel is refused', { skip }, (t) => {
  const fx = stagedStateFixture();
  const sentinelPath = path.join(fx.state, SENTINEL);
  const realFile = path.join(fx.work, 'real-sentinel');
  fs.writeFileSync(realFile, sentinelBody('state'));
  fs.rmSync(sentinelPath);
  if (!tryFileLink(realFile, sentinelPath)) {
    t.skip('file symlink creation not supported in this environment');
    return;
  }
  const r = validate(['state', 'destdir', toPosix(fx.state), toPosix(fx.destdir)]);
  assert.notEqual(r.status, 0, 'accepted a symlinked sentinel');
});
