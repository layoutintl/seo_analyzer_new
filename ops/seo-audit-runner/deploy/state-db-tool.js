#!/usr/bin/env node
/**
 * state-db-tool.js — minimal SQLite helper for the backup/restore scripts.
 *
 * Used when the sqlite3 CLI is not installed on the host. Runs with the
 * runner's isolated Node (>= 22.5, node:sqlite). Structured argv only.
 *
 * Commands:
 *   quick-check <db>          PRAGMA quick_check; exit 0 only on "ok"
 *   backup <db> <dest>        safe copy of <db> to <dest>:
 *                             - uses the SQLite online backup API when the
 *                               runtime provides it (safe alongside a live
 *                               runner);
 *                             - otherwise wal_checkpoint(TRUNCATE) + file
 *                               copy, which the CALLER must guard with the
 *                               runner lock (backup.sh does).
 *                             Prints "method=api" or "method=checkpoint".
 *
 * Never prints database contents or configuration values.
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [command, dbPath, dest] = process.argv.slice(2);

function fail(message, code = 1) {
  process.stderr.write(`state-db-tool: ${message}\n`);
  process.exit(code);
}

function quickCheck(path) {
  // Plain open (the readOnly option is not available on all supported
  // Node versions); quick_check performs no writes.
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('PRAGMA quick_check').get();
    const verdict = row ? String(Object.values(row)[0]) : 'unknown';
    return verdict;
  } finally {
    db.close();
  }
}

if (command === 'quick-check') {
  if (!dbPath) fail('usage: state-db-tool quick-check <db>');
  if (!fs.existsSync(dbPath)) fail(`database not found: ${dbPath}`);
  const verdict = quickCheck(dbPath);
  process.stdout.write(`quick_check=${verdict}\n`);
  process.exit(verdict === 'ok' ? 0 : 2);
} else if (command === 'backup') {
  if (!dbPath || !dest) fail('usage: state-db-tool backup <db> <dest>');
  if (!fs.existsSync(dbPath)) fail(`database not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  try {
    if (typeof db.backup === 'function') {
      // Online backup API: produces a consistent copy alongside live
      // readers/writers — the only method safe while the runner may run.
      await db.backup(dest);
      process.stdout.write('method=api\n');
    } else {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      db.close();
      fs.copyFileSync(dbPath, dest);
      process.stdout.write('method=checkpoint\n');
    }
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
  const verdict = quickCheck(dest);
  if (verdict !== 'ok') {
    try { fs.rmSync(dest); } catch { /* leave nothing behind */ }
    fail(`backup copy failed integrity check: ${verdict}`, 2);
  }
  process.stdout.write('copy_quick_check=ok\n');
} else {
  fail(`unknown command: ${command ?? '(none)'}`);
}
