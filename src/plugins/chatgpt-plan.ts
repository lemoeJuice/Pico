import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelStageInput } from '../runtime/stages.js';
import type { ModelResponse } from '../contracts/model.js';
import { ChatGptPlanAuth, RetryableChatGptAuthorizationExchange } from './chatgpt-plan/auth.js';
import { ChatGptResponsesAdapter } from './chatgpt-plan/model.js';
import type { PicoPlugin, PluginHttpRequest } from './host.js';

interface CallbackOperation {
  operationId: string;
  redirectUri: string;
  server: Server;
  handlingCallback: boolean;
  retryCallback: URLSearchParams | null;
  retryAttempted: boolean;
}

interface CallbackCompletionResult {
  status: 'connected' | 'failed';
  message: string;
  retryable: boolean;
  retryExchange: boolean;
}

function callbackForRetry(callback: URLSearchParams): URLSearchParams {
  const retry = new URLSearchParams();
  for (const name of ['state', 'code', 'client_id']) {
    const values = callback.getAll(name);
    if (values.length === 1 && values[0]) retry.set(name, values[0]);
  }
  return retry;
}

function promptCacheKeyFor(input: ModelStageInput): string {
  const call = input.pluginModelCall;
  if (!call) return input.thread.id;

  const digest = createHash('sha256')
    .update(JSON.stringify(['pico.chatgpt-plan.plugin-cache.v1', input.thread.id, call.pluginId, call.purpose]))
    .digest('hex');
  // Keep the affinity key bounded while deriving a stable namespace per Thread, plugin, and purpose.
  return `pico-plugin:${digest.slice(0, 52)}`;
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
  operationId: string,
  status: 'connected' | 'failed',
  message: string,
  retryable: boolean,
  retryExchange: boolean,
): string {
  const payload = JSON.stringify({
    type: 'pico:plugin-auth',
    pluginId: 'pico.chatgpt-plan',
    operationId,
    status,
    message,
    retryable,
    retryExchange,
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  // Sandboxed plugin UI frames have an opaque origin, so the popup cannot target the
  // host page's origin. The plugin frame validates callback origin, popup source, and
  // one-time operation ID before accepting this result.
  const closePopup = status === 'connected' || retryExchange;
  return `<!doctype html><meta charset="utf-8"><title>ChatGPT sign-in</title><p>${escapeHtml(message)}</p><p>You can close this tab and return to Pico.</p><script>if(window.opener){window.opener.postMessage(${payload},'*');if(${closePopup})window.close();}</script>`;
}

/** ChatGPT support is a normal first-party plugin: provider routing, account state, UI, and API live here. */
export function createChatGptPlanPlugin(): PicoPlugin {
  const callbackServers = new Set<Server>();
  const callbackTimeouts = new Map<Server, NodeJS.Timeout>();
  const callbackOperations = new Map<string, CallbackOperation>();
  let auth: ChatGptPlanAuth | null = null;

  const closeCallbackServer = (server: Server): Promise<void> => {
    const timeout = callbackTimeouts.get(server);
    if (timeout) clearTimeout(timeout);
    callbackTimeouts.delete(server);
    callbackServers.delete(server);
    for (const [operationId, operation] of callbackOperations) {
      if (operation.server === server) callbackOperations.delete(operationId);
    }
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  };

  const completeCallback = async (
    operation: CallbackOperation,
    callback: URLSearchParams,
    retryExchange = false,
  ): Promise<CallbackCompletionResult> => {
    if (operation.handlingCallback) {
      return {
        status: 'failed',
        message: 'Authorization is already being completed.',
        retryable: true,
        retryExchange: Boolean(operation.retryCallback),
      };
    }
    if (!auth!.hasPendingAuthorization(callback.get('state'), operation.redirectUri)) {
      return {
        status: 'failed',
        message: 'This ChatGPT sign-in attempt expired or did not match. Start again.',
        retryable: false,
        retryExchange: false,
      };
    }

    operation.handlingCallback = true;
    let result: CallbackCompletionResult;
    try {
      await auth!.completeSignIn(callback, operation.redirectUri, { allowTransportRetry: !retryExchange });
      operation.retryCallback = null;
      void auth!.refreshModels().catch(() => undefined);
      result = {
        status: 'connected',
        message: 'ChatGPT is connected. Return to Pico.',
        retryable: false,
        retryExchange: false,
      };
    } catch (error) {
      const pending = auth!.hasPendingAuthorization(callback.get('state'), operation.redirectUri);
      const canRetryExchange =
        !retryExchange &&
        pending &&
        error instanceof RetryableChatGptAuthorizationExchange &&
        !operation.retryAttempted;
      operation.retryCallback = canRetryExchange ? callbackForRetry(callback) : null;
      result = {
        status: 'failed',
        message:
          retryExchange && error instanceof RetryableChatGptAuthorizationExchange
            ? 'The retry did not return a response. Start a new ChatGPT sign-in.'
            : error instanceof Error
              ? error.message
              : 'ChatGPT sign-in failed.',
        retryable: pending,
        retryExchange: canRetryExchange,
      };
    }

    if (result.retryable) operation.handlingCallback = false;
    return result;
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
        return model.complete(
          input.prompt,
          input.signal,
          input.onText,
          input.requestTrace,
          input.onEvent,
          input.requestParameters,
          input.thread.id,
          promptCacheKeyFor(input),
        );
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
        providers: ['chatgpt-plan'],
      });

      context.http.register('GET', '/status', () => auth!.status());
      context.http.register('GET', '/models', async () => await auth!.listModels());
      context.http.register('POST', '/models/refresh', async () => await auth!.listModels(true));
      context.http.register('POST', '/sign-in', async (request: PluginHttpRequest) => {
        const uiOrigin = request.origin;
        if (!uiOrigin) throw new Error('ChatGPT sign-in must be started from the Pico Web UI.');
        const operationId = randomUUID();
        let server: Server;
        let operation: CallbackOperation | null = null;
        let redirectUri = '';

        server = createServer((callbackRequest, callbackResponse) => {
          const callbackUrl = new URL(callbackRequest.url ?? '/', 'http://127.0.0.1');
          if (callbackRequest.method !== 'GET' || callbackUrl.pathname !== '/auth/callback') {
            callbackResponse.writeHead(404).end('Not found');
            return;
          }
          if (!operation) {
            callbackResponse.writeHead(503).end('Sign-in is not ready. Start again from Pico.');
            return;
          }
          if (operation.handlingCallback) {
            callbackResponse.writeHead(409).end('Authorization is already being completed.');
            return;
          }
          if (operation.retryCallback) {
            callbackResponse.writeHead(409).end('Return to Pico and retry the ChatGPT token exchange there.');
            return;
          }
          void completeCallback(operation, callbackUrl.searchParams).then(async (result) => {
            callbackResponse.writeHead(200, {
              'cache-control': 'no-store',
              'content-type': 'text/html; charset=utf-8',
              'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
            });
            callbackResponse.end(
              pluginAuthResultHtml(operationId, result.status, result.message, result.retryable, result.retryExchange),
              () => {
                if (!result.retryable) void closeCallbackServer(server);
              },
            );
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
        operation = {
          operationId,
          redirectUri,
          server,
          handlingCallback: false,
          retryCallback: null,
          retryAttempted: false,
        };
        callbackOperations.set(operationId, operation);
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
      context.http.register('POST', '/sign-in/complete', async ({ body }: PluginHttpRequest) => {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('Paste the full ChatGPT callback URL from the browser address bar.');
        }
        const input = body as Record<string, unknown>;
        if (
          typeof input.operationId !== 'string' ||
          typeof input.callbackUrl !== 'string' ||
          input.callbackUrl.length > 8192
        ) {
          throw new Error('Paste the full ChatGPT callback URL from the browser address bar.');
        }
        const operation = callbackOperations.get(input.operationId);
        if (!operation) throw new Error('This ChatGPT sign-in attempt is no longer active. Start again.');

        if (operation.retryCallback) {
          return {
            status: 'failed',
            message: 'The previous token request was not confirmed. Retry the token exchange below.',
            retryable: true,
            retryExchange: true,
          } satisfies CallbackCompletionResult;
        }

        const callback = auth!.parseCallbackUrl(input.callbackUrl, operation.redirectUri);
        const result = await completeCallback(operation, callback);
        if (!result.retryable) await closeCallbackServer(operation.server);
        return result;
      });
      context.http.register('POST', '/sign-in/retry', async ({ body }: PluginHttpRequest) => {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('This ChatGPT sign-in cannot be retried. Start again.');
        }
        const input = body as Record<string, unknown>;
        if (Object.keys(input).length !== 1 || typeof input.operationId !== 'string') {
          throw new Error('This ChatGPT sign-in cannot be retried. Start again.');
        }
        const operation = callbackOperations.get(input.operationId);
        if (!operation || !operation.retryCallback || operation.retryAttempted) {
          throw new Error('The ChatGPT token retry is no longer available. Start a new sign-in.');
        }
        operation.retryAttempted = true;
        const callback = operation.retryCallback;
        const result = await completeCallback(operation, callback, true);
        if (!result.retryable) await closeCallbackServer(operation.server);
        return result;
      });
      context.http.register('DELETE', '/account', async () => await auth!.signOut());
    },
    async deactivate() {
      await Promise.all([...callbackServers].map((server) => closeCallbackServer(server)));
      auth = null;
    },
  };
}
