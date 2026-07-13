/**
 * Project deduplication.
 *
 * Identity is the project ID. The normalized domain key is used only to
 * prevent auditing the same effective domain twice in one runner execution.
 * Duplicate records are never deleted, updated, or merged — losers are
 * reported as "deduplicated: covered by <winner-project-id>".
 */

import { normalizeDomainKey } from './normalizeDomain.js';

function parseFormValues(project) {
  const fv = project?.last_form_values;
  if (fv == null) return null;
  if (typeof fv === 'object') return fv;
  if (typeof fv === 'string') {
    try {
      const parsed = JSON.parse(fv);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function hasUsableFormValues(project) {
  const fv = parseFormValues(project);
  return Boolean(
    fv &&
      typeof fv.homeUrl === 'string' &&
      fv.homeUrl.trim() &&
      typeof fv.articleUrl === 'string' &&
      fv.articleUrl.trim(),
  );
}

export function projectDedupeKey(project) {
  const key = normalizeDomainKey(project?.website_url || project?.domain || '');
  // Unparseable domains never merge with anything — each stays its own group.
  return key ?? `__unparsed__:${project?.id}`;
}

function timestamp(value) {
  if (!value) return -Infinity;
  const t = Date.parse(value);
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Deterministic winner ordering between duplicate projects:
 *  1. usable last_form_values (homeUrl + articleUrl)
 *  2. most recent last_audit_at
 *  3. most recent updated_at
 *  4. completed_count > 0
 *  5. lowest project ID lexicographically
 * Returns < 0 when `a` should win.
 */
export function compareCandidates(a, b) {
  const formA = hasUsableFormValues(a) ? 1 : 0;
  const formB = hasUsableFormValues(b) ? 1 : 0;
  if (formA !== formB) return formB - formA;

  const lastAuditA = timestamp(a?.last_audit_at);
  const lastAuditB = timestamp(b?.last_audit_at);
  if (lastAuditA !== lastAuditB) return lastAuditB - lastAuditA;

  const updatedA = timestamp(a?.updated_at);
  const updatedB = timestamp(b?.updated_at);
  if (updatedA !== updatedB) return updatedB - updatedA;

  const completedA = Number(a?.completed_count ?? 0) > 0 ? 1 : 0;
  const completedB = Number(b?.completed_count ?? 0) > 0 ? 1 : 0;
  if (completedA !== completedB) return completedB - completedA;

  const idA = String(a?.id ?? '');
  const idB = String(b?.id ?? '');
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

/**
 * @returns {{ winners: Array<{project, key}>, duplicates: Array<{project, key, winnerId}> }}
 */
export function dedupeProjects(projects) {
  const groups = new Map();
  for (const project of projects ?? []) {
    const key = projectDedupeKey(project);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(project);
  }

  const winners = [];
  const duplicates = [];
  for (const [key, group] of groups) {
    const sorted = [...group].sort(compareCandidates);
    const winner = sorted[0];
    winners.push({ project: winner, key });
    for (const loser of sorted.slice(1)) {
      duplicates.push({ project: loser, key, winnerId: winner.id });
    }
  }
  return { winners, duplicates };
}
