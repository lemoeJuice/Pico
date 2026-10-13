import type { ModelSettings } from '../core/types.js';
import type { ChatGptAccountStatus } from '../runtime/chatgpt-auth.js';
import type { ModelAdapter, ModelResponse } from '../runtime/model.js';
import type { ModelStageInput } from '../runtime/stages.js';
import type { PicoPlugin } from './host.js';

export interface ChatGptPlanPluginDependencies {
  auth: { status(): ChatGptAccountStatus };
  model: ModelAdapter;
  getSettings(): ModelSettings;
}

/** First-party ChatGPT provider contribution, loaded through the normal PluginHost lifecycle. */
export function createChatGptPlanPlugin(dependencies: ChatGptPlanPluginDependencies): PicoPlugin {
  return {
    id: 'pico.chatgpt-plan',
    name: 'ChatGPT plan provider',
    version: '0.1.0',
    activate({ pipelines, commands, ui }) {
      pipelines.use<ModelStageInput, ModelResponse>('model', async (input, next) => {
        if (input.provider !== 'chatgpt-plan') return next();
        input.recordModelInput(input.prompt, input.provider);
        return dependencies.model.complete(input.prompt, dependencies.getSettings(), input.signal, input.onText);
      });

      commands.register({
        name: 'chatgpt-provider',
        description: 'Show whether the ChatGPT account provider is connected.',
        execute() {
          const status = dependencies.auth.status();
          return {
            text: status.connected
              ? `ChatGPT account connected${status.accountLabel ? ` as ${status.accountLabel}` : ''}.`
              : 'No ChatGPT account is connected. Open Settings to connect one.',
          };
        },
      });

      ui.contribute({
        slot: 'thread.toolbar',
        id: 'chatgpt-provider',
        label: 'ChatGPT',
        description: 'Inspect the ChatGPT account provider connection.',
        command: '/chatgpt-provider',
      });
    },
  };
}
