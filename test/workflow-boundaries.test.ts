import { describe, expect, it } from 'vitest';
import type { PicoPlugin } from '../src/plugins/host.js';
import { FakeModel, response, setupRuntime } from './helpers.js';

describe('workflow plugin boundaries', () => {
  it('exposes and executes tools from any Runtime plugin in Chat mode', async () => {
    const customRuntimeTool: PicoPlugin = {
      id: 'test.runtime-tools',
      name: 'Runtime tool fixture',
      version: '1',
      defaultToolsEnabled: true,
      activate({ tools }) {
        tools.register(
          {
            name: 'runtime_echo',
            description: 'Return the supplied value from a Runtime plugin.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string', enum: ['chat-value'] } },
              required: ['value'],
              additionalProperties: false,
            },
          },
          async (args) => ({ echoed: args.value, source: 'runtime-plugin' }),
        );
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'chat-runtime-tool', name: 'runtime_echo', arguments: { value: 'chat-value' } }])
        : response('The Runtime plugin tool ran in Chat mode.'),
    );
    const env = await setupRuntime(model, { plugins: [customRuntimeTool] });
    const thread = env.createThread('runtime', 'Chat tools');
    try {
      await env.runtime.submit(thread.id, 'chat-runtime-plugin-message', 'Run the Runtime plugin tool.');
      await env.runtime.drain();

      expect(model.prompts[0]?.tools.map((tool) => tool.name)).toContain('runtime_echo');
      expect(
        env.store.listExecutions(thread.id).find((execution) => execution.toolName === 'runtime_echo'),
      ).toMatchObject({
        status: 'completed',
        result: { echoed: 'chat-value', source: 'runtime-plugin' },
      });
      expect(
        model.prompts[1]?.turns.some((turn) => turn.kind === 'tool_result' && turn.content.includes('runtime-plugin')),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });
});
