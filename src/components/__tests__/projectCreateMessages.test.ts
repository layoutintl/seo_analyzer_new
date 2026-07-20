import { describe, it, expect } from 'vitest';
import {
  describeCreateOutcome,
  describeCreateError,
  describeListError,
} from '../projectCreateMessages';

describe('describeCreateOutcome', () => {
  it('reports a successfully created project', () => {
    expect(describeCreateOutcome({ created: true, automation_ready: true })).toEqual({
      tone: 'success',
      text: 'Project created successfully.',
    });
  });

  it('reports an updated existing project', () => {
    const out = describeCreateOutcome({ created: false, automation_ready: true });
    expect(out.tone).toBe('success');
    expect(out.text).toBe('This domain already existed. The existing project was updated.');
  });

  it('warns when a new project is not automation-ready', () => {
    const out = describeCreateOutcome({ created: true, automation_ready: false });
    expect(out.tone).toBe('warning');
    expect(out.text).toBe(
      'Project created, but it needs a homepage and article URL before automated audits can run.',
    );
  });

  it('warns when an updated project is still not automation-ready', () => {
    const out = describeCreateOutcome({ created: false, automation_ready: false });
    expect(out.tone).toBe('warning');
    expect(out.text).toContain('already existed');
    expect(out.text).toContain('needs a homepage and article URL');
  });

  it('falls back to the created wording when the server omits the flags', () => {
    expect(describeCreateOutcome({})).toEqual({
      tone: 'success',
      text: 'Project created successfully.',
    });
  });
});

describe('describeCreateError', () => {
  it('shows the backend error verbatim rather than hiding it', () => {
    expect(describeCreateError(400, 'articleUrl must belong to example.com')).toBe(
      'articleUrl must belong to example.com',
    );
  });

  it('falls back to the status code when the backend sent no message', () => {
    expect(describeCreateError(500)).toBe('Failed to create project (HTTP 500)');
  });
});

describe('describeListError', () => {
  it('explains a 501 as a missing database, not an empty list', () => {
    expect(describeListError(501, 'Database required for project management.')).toContain(
      'no database configured',
    );
  });

  it('shows a backend error message for other failures', () => {
    expect(describeListError(500, 'Failed to fetch projects')).toBe('Failed to fetch projects');
  });

  it('never returns a "no projects yet" style message', () => {
    for (const status of [500, 502, 503]) {
      expect(describeListError(status).toLowerCase()).not.toContain('no projects');
    }
  });
});
