import { describe, expect, it } from 'vitest';
import { FakeModel, response, setupRuntime } from '../../../../test/helpers.js';

describe('Model Parameters Runtime integration', () => {
  it('rejects stored semantic model options when their owner is disabled but permits empty options', async () => {
    const model = new FakeModel(() => response('completed without optional parameters'));
    const env = await setupRuntime(model);
    try {
      const configured = env.createThread();
      const selection = env.runtime.threadModelSelection(configured.id);
      env.store.setThreadModelSelection(configured.id, {
        ...selection,
        parameters: { ...selection.parameters, options: { legacySetting: 'keep' } },
      });
      await env.runtime.plugins.setEnabled('pico.model-parameters', false);
      await env.runtime.submit(configured.id, 'semantic-options-after-disable', 'Run with saved settings.');
      await env.runtime.drain();
      expect(model.calls).toBe(0);
      expect(env.store.listExecutions(configured.id)).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          error: expect.stringContaining('Model parameters are not supported'),
        }),
      );

      const plain = env.createThread();
      await env.runtime.submit(plain.id, 'empty-options-after-disable', 'Run with default settings.');
      await env.runtime.drain();
      expect(model.calls).toBe(1);
      expect(env.store.getThread(plain.id)?.state).toBe('idle');
    } finally {
      await env.cleanup();
    }
  });
});
