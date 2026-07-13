/**
 * Stable critical-issue fingerprinting (v2).
 *
 * Identity component priority:
 *   1. stable application issue code / recommendation identifier, when the
 *      payload carries one (fields: code, issueCode, checkId, ruleId) — the
 *      current app's P0 recommendations expose no such code, but when one is
 *      present it REPLACES the message as the wording-independent identity
 *   2. recommendation area
 *   3. normalized affected URL
 *   4. page type + page/site scope
 *   5. normalized message identity — fallback ONLY when no stable code exists
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
 * Message identity normalization is CONSERVATIVE — each rule and its reason:
 *  - lowercase + trim + collapse whitespace      (formatting noise)
 *  - typographic quotes/dashes -> ASCII          (copy-editing noise)
 *  - repeated punctuation collapsed, trailing
 *    punctuation stripped                        (formatting noise)
 *  - NUMBERS ARE PRESERVED: HTTP status codes (404 vs 500), redirect codes
 *    (301 vs 302), heading/schema/pagination counts are all semantically
 *    meaningful and MUST produce distinct identities. No value in the
 *    current app's P0 message templates is proven volatile (timestamps and
 *    execution counters never appear in them), so nothing numeric is masked.
 */

import { createHash } from 'node:crypto';

const SEPARATOR = String.fromCharCode(1); // unambiguous component boundary
const VERSION = 'v2';

const STABLE_CODE_FIELDS = ['code', 'issueCode', 'checkId', 'ruleId'];

/** Stable application-provided issue code, when the payload carries one. */
export function stableIssueCode(issue) {
  for (const field of STABLE_CODE_FIELDS) {
    const value = issue?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return null;
}

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

/**
 * Conservative message normalization. Meaningful numeric values (HTTP status
 * codes, redirect codes, element counts) are PRESERVED — see module header.
 */
export function normalizeMessageIdentity(message) {
  return String(message ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'") // curly single quotes -> ASCII
    .replace(/[“”]/g, '"') // curly double quotes -> ASCII
    .replace(/[–—]/g, '-') // en/em dashes -> hyphen
    .replace(/([.!?,;:])\1+/g, '$1') // collapse repeated punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?\s]+$/, ''); // trailing punctuation is formatting noise
}

/**
 * @param projectId project the issue belongs to
 * @param issue critical issue as produced by criticalFilter.js
 *              ({ area, message, pageUrl, pageType, source, [code] })
 * @returns 64-char hex SHA-256 fingerprint
 */
export function fingerprintIssue(projectId, issue) {
  const code = stableIssueCode(issue);
  const parts = [
    VERSION,
    String(projectId ?? ''),
    code ?? '',
    String(issue?.area ?? '').toLowerCase().trim(),
    String(issue?.pageType ?? '').toLowerCase().trim(),
    issue?.source === 'site' ? 'site' : 'page',
    normalizeUrlForFingerprint(issue?.pageUrl),
    // A stable code is the wording-independent identity; the human-readable
    // message participates only when no code exists.
    code ? '' : normalizeMessageIdentity(issue?.message),
  ];
  return createHash('sha256').update(parts.join(SEPARATOR)).digest('hex');
}

/** Stable hash of an arbitrary string (used for payload hashes / identities). */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
