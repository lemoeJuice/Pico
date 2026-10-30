import { collaborationPlugin } from '../collaboration.js';
import { projectContextPlugin } from '../project-context.js';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeModel, response, setupRuntime } from '../../../test/helpers.js';

describe('First-party plugin Runtime integration', () => {
  it('runs Chat Threads on Runtime coordination tools without attaching a workspace Executor', async () => {
    const model = new FakeModel(() => response('Ready for a conversation.'));
    const env = await setupRuntime(model, { plugins: [projectContextPlugin, collaborationPlugin] });
    const thread = env.createThread('runtime', 'Chat');
    try {
      const status = await env.runtime.executorStatus(thread.id);
      await env.runtime.submit(thread.id, 'chat-mode-message', 'Hello');
      await env.runtime.drain();

      expect(thread.workspacePath).toBe('');
      expect(status).toMatchObject({ connected: true, kind: 'runtime', label: 'Chat' });
      expect(model.prompts[0]?.tools.map((tool) => tool.name)).toEqual([
        'workspace_info',
        'project_memory_record',
        'project_memory_search',
        'spawn_thread',
        'list_models',
        'send_thread_message',
        'list_project_threads',
        'list_child_threads',
        'read_thread_history',
      ]);
      expect(env.runtime.getSnapshot(thread.id)?.executions.map((execution) => execution.status)).toEqual([
        'completed',
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it('loads a local plugin tool, slash command, semantic UI contribution, state, and canonical log', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'note', name: 'save_thread_note', arguments: { note: 'Keep the setup small.' } }])
        : response('Saved.'),
    );
    const env = await setupRuntime(model, { pluginDirectory: resolve(process.cwd(), 'plugins') });
    const thread = env.createThread();
    try {
      expect(env.runtime.pluginInfo().plugins.some((plugin) => plugin.id === 'pico.example-notes')).toBe(true);
      expect(env.runtime.availableCommands().some((command) => command.name === 'notes')).toBe(true);
      expect(env.runtime.availableCommands().some((command) => command.name === 'project-context')).toBe(true);
      expect(env.runtime.pluginInfo().ui.some((contribution) => contribution.id === 'pico.example-notes:notes')).toBe(
        true,
      );
      expect(
        env.runtime
          .pluginInfo()
          .ui.some(
            (contribution) =>
              contribution.id === 'pico.project-context:project-context' &&
              contribution.entry === 'webui' &&
              contribution.component === 'ProjectContextPanel',
          ),
      ).toBe(true);

      await env.runtime.submit(thread.id, 'plugin-tool-message', 'Save a note');
      await env.runtime.drain();
      expect(
        env.store.getPluginState<Record<string, Array<{ note: string }>>>('pico.example-notes', 'notesByThread', {})[
          thread.id
        ]?.[0]?.note,
      ).toBe('Keep the setup small.');
      expect(
        env.store
          .listRecords(thread.id)
          .some((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.example-notes'),
      ).toBe(true);
      const command = await env.runtime.submit(thread.id, 'plugin-command', '/notes');
      expect(command.command?.text).toContain('Keep the setup small.');
    } finally {
      await env.cleanup();
    }
  });
});
