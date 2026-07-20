/**
 * User-facing outcome messages for POST /api/projects.
 *
 * Pure — no React, no fetch — so the created/updated/incomplete wording can be
 * asserted without a DOM harness. Shared by ProjectsPage and ProjectSelector so
 * the two forms cannot drift apart.
 */

export interface CreateProjectResponse {
  created?: boolean;
  automation_ready?: boolean;
}

export interface CreateOutcome {
  tone: 'success' | 'warning';
  text: string;
}

/**
 * Four cases: created / already-existed, each either automation-ready or not.
 * `automation_ready === false` always wins the tone, because the project will
 * be skipped by the audit runner until it has a homepage and article URL.
 */
export function describeCreateOutcome(data: CreateProjectResponse): CreateOutcome {
  const existed = data.created === false;

  if (data.automation_ready === false) {
    return {
      tone: 'warning',
      text: existed
        ? 'This domain already existed. The existing project was updated, but it needs a homepage and article URL before automated audits can run.'
        : 'Project created, but it needs a homepage and article URL before automated audits can run.',
    };
  }

  return {
    tone: 'success',
    text: existed
      ? 'This domain already existed. The existing project was updated.'
      : 'Project created successfully.',
  };
}

/**
 * Message for a failed create. Never collapses a real backend error into a
 * generic "could not reach the server".
 */
export function describeCreateError(status: number, error?: string): string {
  return error ?? `Failed to create project (HTTP ${status})`;
}

/**
 * Message for a failed project-list load. A failed request must never be
 * rendered as "No projects yet".
 */
export function describeListError(status: number, error?: string): string {
  if (status === 501) {
    return 'Project management is unavailable — the server has no database configured.';
  }
  return error ?? `Could not load projects (HTTP ${status})`;
}
