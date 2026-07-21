import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  CHECK_NODE_SH,
  bashMissing,
  makeFakeNode,
  makeWorkspace,
  runScript,
  toPosix,
} from '../tools/shellHarness.js';

const skip = bashMissing() ? 'no bash available on this machine' : false;

const check = (nodeVersion) => {
  const work = makeWorkspace();
  const fakeNode = makeFakeNode(work, nodeVersion);
  return runScript(CHECK_NODE_SH, [toPosix(fakeNode)]);
};

test('check-node rejects Node 20 with a clear message', { skip }, () => {
  const r = check('20.11.1');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /20\.11\.1 is NOT supported/);
  assert.match(r.stderr, /node:sqlite/);
  assert.match(r.stderr, /do NOT upgrade the main application runtime/);
});

test('check-node rejects Node 18', { skip }, () => {
  const r = check('18.19.0');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /NOT supported/);
});

test('check-node rejects Node 22.4 (below the 22.5 sqlite floor)', { skip }, () => {
  const r = check('22.4.1');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /below the required minimum 22\.5\.0/);
});

test('check-node accepts Node 22.5.0 and requires --experimental-sqlite', { skip }, () => {
  const r = check('22.5.0');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^NODE_VERSION=22\.5\.0$/m);
  assert.match(r.stdout, /^NODE_MAJOR=22$/m);
  assert.match(r.stdout, /^NODE_SQLITE_FLAG=--experimental-sqlite$/m);
});

test('check-node accepts Node 23 with --experimental-sqlite', { skip }, () => {
  const r = check('23.6.0');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^NODE_SQLITE_FLAG=--experimental-sqlite$/m);
});

test('check-node accepts Node 24 with no experimental flag', { skip }, () => {
  const r = check('24.14.0');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^NODE_VERSION=24\.14\.0$/m);
  assert.match(r.stdout, /^NODE_SQLITE_FLAG=$/m);
});

test('check-node accepts the real Node running this test suite', { skip }, () => {
  const r = runScript(CHECK_NODE_SH, [toPosix(process.execPath)]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^NODE_VERSION=\d+\.\d+\.\d+$/m);
});

test('check-node fails cleanly on a missing binary', { skip }, () => {
  const work = makeWorkspace();
  const r = runScript(CHECK_NODE_SH, [toPosix(path.join(work, 'no-such-node'))]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot execute/);
});

test('check-node fails cleanly on unrecognizable version output', { skip }, () => {
  const work = makeWorkspace();
  const fake = makeFakeNode(work, 'banana');
  const r = runScript(CHECK_NODE_SH, [toPosix(fake)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unrecognized version output/);
});

test('check-node --help exits 0 and shows usage', { skip }, () => {
  const r = runScript(CHECK_NODE_SH, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: check-node\.sh/);
});

test('check-node without arguments is a usage error', { skip }, () => {
  const r = runScript(CHECK_NODE_SH, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: check-node\.sh/);
});
