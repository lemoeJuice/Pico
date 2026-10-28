import { modelParametersPlugin } from '../index.js';
import { describe, expect, it } from 'vitest';
import { FakeModel, response, setupRuntime } from '../../../../test/helpers.js';

describe('Model Parameters Runtime integration', () => {
  it('marks a saved adapter unavailable when its plugin is disabled and keeps other adapters usable', async () => {
    const model = new FakeModel(() => response('completed without optional parameters'));
    const env = await setupRuntime(model, { plugins: [modelParametersPlugin] });
    try {
      const configured = env.createThread('runtime');
      const selection = env.runtime.threadModelSelection(configured.id);
      const selected = env.runtime.updateThreadModelSelection(configured.id, {
        modelId: selection.modelId,
        adapterId: 'pico.chat-completions',
        parameters: { options: {} },
      });
      await env.runtime.plugins.setEnabled('pico.model-parameters', false);
      expect(env.runtime.threadModelSelection(configured.id)).toMatchObject({
        modelId: selected.modelId,
        adapterId: selected.adapterId,
        unavailableReason: expect.stringContaining('unavailable'),
      });
      expect(() => env.runtime.modelCatalog.resolveSelection(selected)).toThrow('unavailable');
      await env.runtime.submit(configured.id, 'unavailable-adapter', 'Run with saved settings.');
      await env.runtime.drain();
      expect(model.calls).toBe(0);
      expect(env.runtime.getThread(configured.id)?.pauseRequested).toBe(true);

      const plain = env.createThread('runtime');
      await env.runtime.submit(plain.id, 'available-adapter', 'Run with default settings.');
      await env.runtime.drain();
      expect(model.calls).toBe(1);
      expect(env.store.getThread(plain.id)?.state).toBe('idle');
    } finally {
      await env.cleanup();
    }
  });
});
