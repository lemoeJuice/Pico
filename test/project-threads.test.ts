import { describe, expect, it } from 'vitest';
import { upsertProjectThread } from '../src/web/project-threads.js';

describe('selected Project Thread list', () => {
  it('ignores Thread events from another Project', () => {
    const current = [{ id: 'main', projectId: 'project-a', title: 'Main' }];
    const next = upsertProjectThread(current, { id: 'private', projectId: 'project-b', title: 'Other' }, 'project-a');

    expect(next).toBe(current);
  });

  it('adds new Threads and updates existing ones without changing list order', () => {
    const current = [
      { id: 'main', projectId: 'project-a', title: 'Main' },
      { id: 'child', projectId: 'project-a', title: 'Old child title' },
    ];

    expect(
      upsertProjectThread(current, { id: 'new', projectId: 'project-a', title: 'New' }, 'project-a').map((t) => t.id),
    ).toEqual(['new', 'main', 'child']);
    expect(
      upsertProjectThread(current, { id: 'child', projectId: 'project-a', title: 'Updated child title' }, 'project-a'),
    ).toEqual([current[0], { id: 'child', projectId: 'project-a', title: 'Updated child title' }]);
  });
});
