import { describe, expect, it } from 'vitest';
import { FakeModel, response, setupRuntime } from '../../../../test/helpers.js';

describe('Project Context Runtime integration', () => {
  it('shares explicit Project context across Threads without changing canonical Messages', async () => {
    const model = new FakeModel(() => response('Ready.'));
    const env = await setupRuntime(model);
    const sourceThread = env.createThread('host', 'Context editor');
    const otherExecutorThread = env.runtime.createThread(env.project.id, 'host', 'Host continuation');
    const isolatedProject = await env.runtime.createProject('Separate Project', env.workspace);
    const isolatedThread = env.runtime.createThread(isolatedProject.id, 'host', 'Isolated context');
    const contextText = 'Keep canonical history append-only.\nUse Project Context for decisions shared across Threads.';
    try {
      const saved = await env.runtime.submit(
        sourceThread.id,
        'project-context-set',
        `/project-context set\n${contextText}`,
      );

      expect(saved.command?.text).toContain('Project context saved');
      expect(env.store.listRecords(sourceThread.id).filter((record) => record.kind === 'message')).toHaveLength(0);
      expect(
        env.store.getPluginState<{
          entries: Array<{ projectId: string; text: string; source: string; status: string }>;
        }>('pico.project-context', 'memory', { entries: [] }).entries,
      ).toContainEqual(
        expect.objectContaining({
          projectId: env.project.id,
          text: contextText,
          source: 'manual',
          status: 'active',
        }),
      );
      expect(
        env.store
          .listRecords(sourceThread.id)
          .find((record) => record.kind === 'plugin' && record.payload.action === 'memory.recorded')?.payload,
      ).toMatchObject({
        pluginId: 'pico.project-context',
        projectId: env.project.id,
        category: 'fact',
      });
      expect(
        env.store
          .listRecords(sourceThread.id)
          .some(
            (record) =>
              record.kind === 'plugin' && record.payload.action === 'memory.recorded' && 'text' in record.payload,
          ),
      ).toBe(false);

      await env.runtime.submit(
        otherExecutorThread.id,
        'context-shared-message',
        'Apply the guidance about keeping canonical history append-only across Threads.',
      );
      await env.runtime.drain();
      const sharedPrompt = model.prompts.find((prompt) =>
        prompt.turns.some(
          (turn) =>
            turn.kind === 'message' &&
            turn.content === 'Apply the guidance about keeping canonical history append-only across Threads.',
        ),
      );
      expect(sharedPrompt?.turns.some((turn) => turn.kind === 'message' && turn.content.includes(contextText))).toBe(
        true,
      );
      expect(
        sharedPrompt?.turns.some((turn) => turn.kind === 'message' && turn.content.includes('Relevant Project Memory')),
      ).toBe(true);

      await env.runtime.submit(isolatedThread.id, 'context-isolated-message', 'Check the other Project.');
      await env.runtime.drain();
      const isolatedPrompt = model.prompts.find((prompt) =>
        prompt.turns.some((turn) => turn.kind === 'message' && turn.content === 'Check the other Project.'),
      );
      expect(isolatedPrompt?.turns.some((turn) => turn.kind === 'message' && turn.content.includes(contextText))).toBe(
        false,
      );

      const cleared = await env.runtime.submit(sourceThread.id, 'project-context-clear', '/project-context clear');
      expect(cleared.command?.text).toContain('Manual Project Context cleared');
      expect(env.store.listRecords(sourceThread.id).filter((record) => record.kind === 'message')).toHaveLength(0);
      await env.runtime.submit(otherExecutorThread.id, 'context-cleared-message', 'Check the updated guidance.');
      await env.runtime.drain();
      const clearedPrompt = model.prompts.find((prompt) =>
        prompt.turns.some((turn) => turn.kind === 'message' && turn.content === 'Check the updated guidance.'),
      );
      expect(clearedPrompt?.turns.some((turn) => turn.kind === 'message' && turn.content.includes(contextText))).toBe(
        false,
      );
    } finally {
      await env.cleanup();
    }
  });
});
