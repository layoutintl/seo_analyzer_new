import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  WRAPPER_SH,
  bashMissing,
  makeFakeNode,
  makeWorkspace,
  readMockLog,
  runScript,
  toPosix,
  writeMock,
  writeRecordingMock,
} from '../tools/shellHarness.js';

const skip = bashMissing() ? 'no bash available on this machine' : false;

/** Build a fake installed tree + env for one wrapper invocation. */
function wrapperFixture({ nodeVersion = '24.14.0', envFileContent } = {}) {
  const work = makeWorkspace();
  const root = path.join(work, 'opt');
  const entrypoint = path.join(root, 'current', 'bin', 'seo-audit-runner.js');
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, '// fake entrypoint\n');

  const envFile = path.join(work, 'runner.env');
  if (envFileContent !== undefined) fs.writeFileSync(envFile, envFileContent);

  const fakeNode = makeFakeNode(work, nodeVersion);
  const argsFile = path.join(work, 'node-args.txt');
  const env = {
    SEO_AUDIT_RUNNER_ROOT: toPosix(root),
    SEO_AUDIT_RUNNER_NODE: toPosix(fakeNode),
    SEO_AUDIT_RUNNER_ENV_FILE: toPosix(envFile),
    SEO_AUDIT_RUNNER_USER: '',
    FAKE_NODE_ARGS_FILE: toPosix(argsFile),
  };
  const readArgs = () =>
    fs.readFileSync(argsFile, 'utf8').split('\n').filter((line) => line.length > 0);
  return { work, root, entrypoint, envFile, env, readArgs };
}

test('wrapper forwards all arguments in order, including spaces and shell metacharacters', { skip }, () => {
  const fx = wrapperFixture({ envFileContent: 'RUNNER_LOG_LEVEL=info\n' });
  const r = runScript(
    WRAPPER_SH,
    ['run', '--project', 'id with spaces', '--dry-run', '$(echo injected)', 'a;b|c'],
    { env: fx.env },
  );
  assert.equal(r.status, 0, r.output);
  const args = fx.readArgs();
  assert.deepEqual(args, [
    toPosix(fx.root) + '/current/bin/seo-audit-runner.js',
    '--env-file',
    toPosix(fx.envFile),
    'run',
    '--project',
    'id with spaces',
    '--dry-run',
    '$(echo injected)', // stays literal: nothing is eval'd or re-parsed
    'a;b|c',
  ]);
});

test('wrapper adds --experimental-sqlite on Node 22', { skip }, () => {
  const fx = wrapperFixture({ nodeVersion: '22.5.0' });
  const r = runScript(WRAPPER_SH, ['status'], { env: fx.env });
  assert.equal(r.status, 0, r.output);
  const args = fx.readArgs();
  assert.equal(args[0], '--experimental-sqlite');
  assert.equal(args[1], toPosix(fx.root) + '/current/bin/seo-audit-runner.js');
});

test('wrapper adds --experimental-sqlite on Node 23', { skip }, () => {
  const fx = wrapperFixture({ nodeVersion: '23.3.0' });
  const r = runScript(WRAPPER_SH, ['status'], { env: fx.env });
  assert.equal(r.status, 0, r.output);
  assert.equal(fx.readArgs()[0], '--experimental-sqlite');
});

test('wrapper adds no experimental flag on Node 24+', { skip }, () => {
  const fx = wrapperFixture({ nodeVersion: '24.14.0' });
  const r = runScript(WRAPPER_SH, ['status'], { env: fx.env });
  assert.equal(r.status, 0, r.output);
  const args = fx.readArgs();
  assert.ok(!args.includes('--experimental-sqlite'), `unexpected flag in ${args}`);
  assert.equal(args[0], toPosix(fx.root) + '/current/bin/seo-audit-runner.js');
});

test('wrapper rejects a Node runtime below 22.5', { skip }, () => {
  const fx = wrapperFixture({ nodeVersion: '20.11.1' });
  const r = runScript(WRAPPER_SH, ['status'], { env: fx.env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not supported .* requires >= 22\.5\.0/);
});

test('wrapper preserves the runner exit code', { skip }, () => {
  const fx = wrapperFixture();
  for (const code of [0, 2, 4, 7]) {
    const r = runScript(WRAPPER_SH, ['run', '--all'], {
      env: { ...fx.env, FAKE_NODE_EXIT: String(code) },
    });
    assert.equal(r.status, code, `expected exit ${code}: ${r.output}`);
  }
});

test('wrapper omits --env-file when the env file does not exist', { skip }, () => {
  const fx = wrapperFixture(); // no envFileContent -> file absent
  const r = runScript(WRAPPER_SH, ['status'], { env: fx.env });
  assert.equal(r.status, 0, r.output);
  assert.ok(!fx.readArgs().includes('--env-file'));
});

test('a caller-supplied --env-file wins over the wrapper default (last occurrence)', { skip }, () => {
  const fx = wrapperFixture({ envFileContent: 'RUNNER_LOG_LEVEL=info\n' });
  const r = runScript(WRAPPER_SH, ['status', '--env-file', '/custom/override.env'], {
    env: fx.env,
  });
  assert.equal(r.status, 0, r.output);
  const args = fx.readArgs();
  const occurrences = args.filter((a) => a === '--env-file').length;
  assert.equal(occurrences, 2);
  assert.equal(args[args.lastIndexOf('--env-file') + 1], '/custom/override.env');
});

test('wrapper fails clearly when the Node runtime is missing', { skip }, () => {
  const fx = wrapperFixture();
  const r = runScript(WRAPPER_SH, ['status'], {
    env: { ...fx.env, SEO_AUDIT_RUNNER_NODE: toPosix(path.join(fx.work, 'missing-node')) },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Node\.js runtime not found .*install\.sh/);
});

test('wrapper fails clearly when the runner entrypoint is missing', { skip }, () => {
  const fx = wrapperFixture();
  fs.rmSync(fx.entrypoint);
  const r = runScript(WRAPPER_SH, ['status'], { env: fx.env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /entrypoint not found/);
});

test('wrapper never prints environment values or secrets', { skip }, () => {
  const secret = 'xoxb-wrapper-secret-999-do-not-print';
  const fx = wrapperFixture({
    envFileContent: `SLACK_BOT_TOKEN=${secret}\nSLACK_CHANNEL_ID=C123\n`,
  });
  const r = runScript(WRAPPER_SH, ['status'], { env: fx.env });
  assert.equal(r.status, 0, r.output);
  assert.ok(!r.output.includes(secret), 'secret leaked to wrapper output');
  // Also in the failure paths:
  const r2 = runScript(WRAPPER_SH, ['status'], {
    env: { ...fx.env, SEO_AUDIT_RUNNER_NODE: toPosix(path.join(fx.work, 'nope')) },
  });
  assert.ok(!r2.output.includes(secret));
});

test('wrapper invoked as root re-executes as the seo-runner user (mocked id/runuser)', { skip }, () => {
  const fx = wrapperFixture();
  const mockBin = path.join(fx.work, 'mockbin');
  const mockLog = path.join(fx.work, 'mock.log');
  writeMock(mockBin, 'id', 'echo 0'); // pretend to be root
  writeRecordingMock(mockBin, 'runuser'); // record the privilege drop, do not re-exec
  const env = { ...fx.env, SEO_RUNNER_MOCK_LOG: toPosix(mockLog) };
  delete env.SEO_AUDIT_RUNNER_USER; // use the default run-as user (seo-runner)
  const r = runScript(WRAPPER_SH, ['status'], { env, mockBin });
  assert.equal(r.status, 0, r.output);
  const log = readMockLog(mockLog);
  assert.match(log, /^runuser -u seo-runner -- .* status$/m);
});
