/**
 * Single-instance process lock.
 *
 * An exclusive lock file (O_EXCL create) inside the state directory prevents
 * two runner processes from executing simultaneously. A lock whose recorded
 * PID is no longer alive is treated as stale and reclaimed once.
 */

import fs from 'node:fs';
import path from 'node:path';

export class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockError';
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err.code === 'EPERM';
  }
}

/**
 * @returns {{ path: string, release: () => void }}
 * @throws {LockError} when another live runner instance holds the lock
 */
export function acquireLock({ stateDir, name = 'seo-audit-runner.lock', pid = process.pid }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, name);
  const payload = JSON.stringify({ pid, startedAt: new Date().toISOString() });

  const tryCreate = () => {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
  };

  try {
    tryCreate();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;

    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      /* unreadable lock file — treated as stale below */
    }
    const otherPid = existing?.pid;
    if (otherPid && isProcessAlive(otherPid)) {
      throw new LockError(
        `another runner instance is already active (pid ${otherPid}, lock file: ${lockPath})`,
      );
    }

    // Stale lock — reclaim once.
    try {
      fs.unlinkSync(lockPath);
      tryCreate();
    } catch {
      throw new LockError(`could not reclaim stale lock file: ${lockPath}`);
    }
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* already gone — nothing to do */
      }
    },
  };
}
