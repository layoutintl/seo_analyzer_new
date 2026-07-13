/**
 * Stable critical-issue fingerprinting.
 *
 * Fingerprint = SHA-256 over stable identity components only:
 *   version tag | project ID | area | page type | source (page/site)
 *   | normalized affected URL | normalized message identity
 *
 * Deliberately EXCLUDED (volatile): audit run ID, timestamps, runner
 * execution ID, ordering position, response metadata.
 *
 * URL normalization (comparison identity only — never used to fetch):
 *  - lowercase hostname, trailing dot removed
 *  - fragment removed, scheme dropped, default ports 80/443 dropped
 *  - trailing slash removed except for the root path
 *  - meaningful path and query information preserved
 *
 * Message identity: lowercased, whitespace collapsed, digit runs replaced
 * with '#' so dynamic values (counts, HTTP codes) don't split identities.
 * The message is only ONE component — area, URL, and page type carry the
 * primary identity.
 */

import { createHash } from 'node:crypto';

const SEPARATOR = '';
const VERSION = 'v1';

export function normalizeUrlForFingerprint(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const trimmed = raw.trim().replace(/\s+/g, ' ');

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    // Not an absolute URL — use the whitespace-normalized, lowercased text.
    return trimmed.toLowerCase();
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';

  let pathname = url.pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  const query = url.search ?? '';
  return `${host}${port}${pathname}${query}`; // scheme and fragment dropped
}

export function normalizeMessageIdentity(message) {
  return String(message ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\d+/g, '#');
}

/**
 * @param projectId project the issue belongs to
 * @param issue critical issue as produced by criticalFilter.js
 *              ({ area, message, pageUrl, pageType, source })
 * @returns 64-char hex SHA-256 fingerprint
 */
export function fingerprintIssue(projectId, issue) {
  const parts = [
    VERSION,
    String(projectId ?? ''),
    String(issue?.area ?? '').toLowerCase().trim(),
    String(issue?.pageType ?? '').toLowerCase().trim(),
    issue?.source === 'site' ? 'site' : 'page',
    normalizeUrlForFingerprint(issue?.pageUrl),
    normalizeMessageIdentity(issue?.message),
  ];
  return createHash('sha256').update(parts.join(SEPARATOR)).digest('hex');
}

/** Stable hash of an arbitrary string (used for payload hashes / identities). */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
