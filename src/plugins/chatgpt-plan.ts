import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelStageInput } from '../runtime/stages.js';
import type { ModelResponse } from '../runtime/model.js';
import { ChatGptPlanAuth } from './chatgpt-plan/auth.js';
import { ChatGptResponsesAdapter } from './chatgpt-plan/model.js';
import {
  defaultChatGptPlanPreferences,
  type ChatGptPlanPreferences,
  type ChatGptReasoningEffort,
} from './chatgpt-plan/types.js';
import type { PicoPlugin, PluginHttpRequest } from './host.js';

const reasoningEfforts = new Set<ChatGptReasoningEffort>([
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readPreferences(get: <T>(key: string, fallback: T) => T): ChatGptPlanPreferences {
  const value: unknown = get('preferences', defaultChatGptPlanPreferences);
  if (!isObject(value)) return defaultChatGptPlanPreferences;
  return {
    reasoningEffort: reasoningEfforts.has(value.reasoningEffort as ChatGptReasoningEffort)
      ? (value.reasoningEffort as ChatGptReasoningEffort)
      : 'auto',
    fastMode: value.fastMode === true,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function pluginAuthResultHtml(
  uiOrigin: string,
  operationId: string,
  status: 'connected' | 'failed',
  message: string,
): string {
  const payload = JSON.stringify({
    type: 'pico:plugin-auth',
    pluginId: 'pico.chatgpt-plan',
    operationId,
    status,
    message,
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const target = JSON.stringify(uiOrigin).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>ChatGPT sign-in</title><p>${escapeHtml(message)}</p><p>You can close this tab and return to Pico.</p><script>if(window.opener){window.opener.postMessage(${payload},${target});window.close();}</script>`;
}

/** ChatGPT support is a normal first-party plugin: provider routing, account state, UI, and API live here. */
export function createChatGptPlanPlugin(): PicoPlugin {
  const callbackServers = new Set<Server>();
  const callbackTimeouts = new Map<Server, NodeJS.Timeout>();
  let auth: ChatGptPlanAuth | null = null;

  const closeCallbackServer = (server: Server): Promise<void> => {
    const timeout = callbackTimeouts.get(server);
    if (timeout) clearTimeout(timeout);
    callbackTimeouts.delete(server);
    callbackServers.delete(server);
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  };

  return {
    id: 'pico.chatgpt-plan',
    name: 'ChatGPT plan provider',
    version: '0.1.0',
    activate(context) {
      auth = new ChatGptPlanAuth(context.state);
      const model = new ChatGptResponsesAdapter(auth);

      context.models.registerProvider({
        id: 'chatgpt-plan',
        label: 'ChatGPT account',
        description: 'Use a ChatGPT plan account through OpenAI’s Responses API.',
      });

      context.pipelines.use<ModelStageInput, ModelResponse>('model', async (input, next) => {
        if (input.provider !== 'chatgpt-plan') return next();
        input.recordModelInput(input.prompt, input.provider);
        return model.complete(input.prompt, readPreferences(context.state.get), input.signal, input.onText);
      });

      context.commands.register({
        name: 'chatgpt-provider',
        description: 'Show whether the ChatGPT account provider is connected.',
        execute() {
          const status = auth?.status();
          return {
            text: status?.connected
              ? `ChatGPT account connected${status.accountLabel ? ` as ${status.accountLabel}` : ''}.`
              : 'No ChatGPT account is connected. Open the ChatGPT plugin settings to connect one.',
          };
        },
      });

      context.ui.registerPage({
        id: 'account',
        label: 'ChatGPT',
        description: 'Connect and configure a ChatGPT plan account.',
        entry: 'webui',
      });
      context.ui.contribute({
        slot: 'composer.model',
        id: 'model-controls',
        label: 'ChatGPT model controls',
        description: 'Choose the ChatGPT model, reasoning effort, and Fast mode for this provider.',
        entry: 'webui',
        component: 'ChatGptPlanComposerModel',
      });

      context.http.register('GET', '/status', () => auth!.status());
      context.http.register('GET', '/models', async () => await auth!.listModels());
      context.http.register('POST', '/sign-in', async (request: PluginHttpRequest) => {
        const uiOrigin = request.origin;
        if (!uiOrigin) throw new Error('ChatGPT sign-in must be started from the Pico Web UI.');
        const trustedUiOrigin = new URL(uiOrigin).origin;
        const operationId = randomUUID();
        let handlingCallback = false;
        let server: Server;
        let redirectUri = '';

        server = createServer((callbackRequest, callbackResponse) => {
          const callbackUrl = new URL(callbackRequest.url ?? '/', 'http://127.0.0.1');
          if (callbackRequest.method !== 'GET' || callbackUrl.pathname !== '/auth/callback') {
            callbackResponse.writeHead(404).end('Not found');
            return;
          }
          if (handlingCallback) {
            callbackResponse.writeHead(409).end('Authorization is already being completed.');
            return;
          }
          handlingCallback = true;
          void auth!
            .completeSignIn(callbackUrl.searchParams, redirectUri)
            .then(() => ({ status: 'connected' as const, message: 'ChatGPT is connected. Return to Pico.' }))
            .catch((error: unknown) => ({
              status: 'failed' as const,
              message: error instanceof Error ? error.message : 'ChatGPT sign-in failed.',
            }))
            .then(async (result) => {
              callbackResponse.writeHead(200, {
                'cache-control': 'no-store',
                'content-type': 'text/html; charset=utf-8',
                'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
                'referrer-policy': 'no-referrer',
                'x-content-type-options': 'nosniff',
              });
              callbackResponse.end(pluginAuthResultHtml(trustedUiOrigin, operationId, result.status, result.message));
              await closeCallbackServer(server);
            });
        });

        callbackServers.add(server);
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => reject(error);
          server.once('error', onError);
          server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', onError);
            resolve();
          });
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
          await closeCallbackServer(server);
          throw new Error('Could not start the local ChatGPT sign-in callback.');
        }

        redirectUri = `http://127.0.0.1:${(address as AddressInfo).port}/auth/callback`;
        try {
          const { authorizationUrl } = await auth!.beginSignIn(redirectUri);
          const timeout = setTimeout(() => void closeCallbackServer(server), 10 * 60_000);
          timeout.unref();
          callbackTimeouts.set(server, timeout);
          return {
            authorizationUrl,
            callbackOrigin: `http://127.0.0.1:${(address as AddressInfo).port}`,
            operationId,
          };
        } catch (error) {
          await closeCallbackServer(server);
          throw error;
        }
      });
      context.http.register('DELETE', '/account', async () => await auth!.signOut());
      context.http.register('GET', '/preferences', () => readPreferences(context.state.get));
      context.http.register('PUT', '/preferences', (request) => {
        if (!isObject(request.body)) throw new Error('Preferences must be a JSON object.');
        const effort = request.body.reasoningEffort;
        if (!reasoningEfforts.has(effort as ChatGptReasoningEffort)) {
          throw new Error('Unsupported ChatGPT reasoning effort.');
        }
        if (typeof request.body.fastMode !== 'boolean') throw new Error('fastMode must be a boolean.');
        const preferences: ChatGptPlanPreferences = {
          reasoningEffort: effort as ChatGptReasoningEffort,
          fastMode: request.body.fastMode,
        };
        context.state.set('preferences', preferences);
        return preferences;
      });
    },
    async deactivate() {
      await Promise.all([...callbackServers].map((server) => closeCallbackServer(server)));
      auth = null;
    },
  };
}
