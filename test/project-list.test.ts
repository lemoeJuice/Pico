import { describe, expect, it } from 'vitest';
import { upsertProject } from '../src/web/project-list.js';

const project = (id: string, name = id, workspacePath = '') => ({
  id,
  name,
  workspacePath,
  createdAt: '2026-10-30T00:00:00.000Z',
});

describe('Project list synchronization', () => {
  it('adds a newly-created Project once, even if the POST response follows its event', () => {
    const created = project('project-a', 'Alpha');
    const afterEvent = upsertProject([], created);

    expect(upsertProject(afterEvent, created)).toEqual([created]);
  });

  it('updates a Project in place without changing list order', () => {
    const first = project('project-a', 'Alpha');
    const second = project('project-b', 'Beta');
    const updated = project('project-a', 'Alpha', '/work/alpha');

    expect(upsertProject([first, second], updated)).toEqual([updated, second]);
  });

  it('prepends unknown Projects received from another window', () => {
    const existing = project('project-a', 'Alpha');
    const created = project('project-b', 'Beta');

    expect(upsertProject([existing], created)).toEqual([created, existing]);
  });
});
