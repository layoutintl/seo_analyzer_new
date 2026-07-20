/**
 * FROZEN copy of the v2 fingerprint algorithm, as of schema migration v2.
 *
 * WHY A COPY: a data migration must keep producing the same output forever.
 * If migration 2 imported ../fingerprint.js and that file later became v3,
 * the migration would silently start writing v3 fingerprints while claiming
 * to write v2 — and databases migrated before and after the change would
 * disagree. This file is therefore never edited.
 *
 * When fingerprint.js changes to v3, do NOT touch this file. Add a schema
 * migration v3 with its own frozen snapshot. The parity test in
 * test/fingerprintMigration.test.js fails loudly the moment fingerprint.js
 * stops agreeing with this snapshot, which is the signal to do exactly that.
 */

import { createHash } from 'node:crypto';

const SEPARATOR = String.fromCharCode(1);
const VERSION = 'v2';

const STABLE_CODE_FIELDS = ['code', 'issueCode', 'checkId', 'ruleId'];

export function stableIssueCodeV2(issue) {
  for (const field of STABLE_CODE_FIELDS) {
    const value = issue?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return null;
}

export function normalizeUrlForFingerprintV2(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const trimmed = raw.trim().replace(/\s+/g, ' ');

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';

  let pathname = url.pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  const query = url.search ?? '';
  return `${host}${port}${pathname}${query}`;
}

export function normalizeMessageIdentityV2(message) {
  return String(message ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/([.!?,;:])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?\s]+$/, '');
}

export function fingerprintIssueV2(projectId, issue) {
  const code = stableIssueCodeV2(issue);
  const parts = [
    VERSION,
    String(projectId ?? ''),
    code ?? '',
    String(issue?.area ?? '').toLowerCase().trim(),
    String(issue?.pageType ?? '').toLowerCase().trim(),
    issue?.source === 'site' ? 'site' : 'page',
    normalizeUrlForFingerprintV2(issue?.pageUrl),
    code ? '' : normalizeMessageIdentityV2(issue?.message),
  ];
  return createHash('sha256').update(parts.join(SEPARATOR)).digest('hex');
}
