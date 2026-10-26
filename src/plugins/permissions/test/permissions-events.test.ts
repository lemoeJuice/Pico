import { describe, expect, it } from 'vitest';
import { FakeModel, response, setupRuntime } from '../../../../test/helpers.js';

describe('Permission plugin events', () => {
  it('does not emit plugin.updated when the permissions Tool list is read', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('host');
    const events: Array<{ type: string; pluginId?: string }> = [];
    const unsubscribe = env.runtime.subscribe((event) => {
      if (event.type === 'plugin.updated') events.push(event);
    });
    try {
      const route = env.runtime.pluginHttpRoute('pico.permissions', 'GET', '/threads');
      expect(route).toBeDefined();
      const result = (await route!.handler({
        body: undefined,
        query: new URLSearchParams({ threadId: thread.id }),
        origin: null,
      })) as { threadId: string; tools: Array<{ name: string; policy: string }> };
      expect(result.threadId).toBe(thread.id);
      expect(result.tools.map((tool) => tool.name)).toContain('read_file');
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      await env.cleanup();
    }
  });
});
