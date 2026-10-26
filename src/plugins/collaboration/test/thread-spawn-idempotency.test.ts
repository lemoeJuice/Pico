import { expect, it } from 'vitest';
import { PicoStore } from '../../../core/store.js';

it('creates a child Thread once for a stable plugin idempotency key', () => {
  const store = new PicoStore(':memory:');
  try {
    const project = store.createProject('Idempotent child', '/');
    const parent = store.createThread(project.id, 'runtime', 'Parent');
    const options = {
      parentThreadId: parent.id,
      createdByAgent: true,
      idempotencyKey: 'pico.collaboration:spawn:tool-call-1',
    };
    const first = store.createThread(project.id, 'runtime', 'Research', options);
    const retry = store.createThread(project.id, 'runtime', 'Research', options);

    expect(retry.id).toBe(first.id);
    expect(store.listThreads(project.id)).toHaveLength(2);
    expect(() => store.createThread(project.id, 'runtime', 'Different request', options)).toThrow(
      /already used with different parameters/,
    );
  } finally {
    store.close();
  }
});
