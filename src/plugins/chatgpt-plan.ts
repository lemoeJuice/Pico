import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createSharedChatGptOAuthSecrets, type SharedChatGptOAuthSecrets } from './chatgpt-plan/oauth-store.js';
import { ChatGptPlanAuth, RetryableChatGptAuthorizationExchange } from './chatgpt-plan/auth.js';
import type { PicoPlugin, PluginHttpRequest } from './host.js';

interface CallbackOperation {
  operationId: string;
  instanceId: string;
  auth: ChatGptPlanAuth;
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
  const authByInstance = new Map<string, ChatGptPlanAuth>();
  let sharedOAuthSecrets: SharedChatGptOAuthSecrets | null = null;
  const instanceSharedSecrets = new Map<string, SharedChatGptOAuthSecrets>();
  let instanceAvailable: (id: string) => boolean = () => false;
  let refreshCatalog: (id: string) => Promise<unknown> = async () => undefined;

  const closeCallbackServer = (server: Server, force = false): Promise<void> => {
    const timeout = callbackTimeouts.get(server);
    if (timeout) clearTimeout(timeout);
    callbackTimeouts.delete(server);
    callbackServers.delete(server);
    for (const [operationId, operation] of callbackOperations) {
      if (operation.server === server) callbackOperations.delete(operationId);
    }
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (force) server.closeAllConnections();
    });
  };

  const completeCallback = async (
    operation: CallbackOperation,
    callback: URLSearchParams,
    retryExchange = false,
  ): Promise<CallbackCompletionResult> => {
    if (!instanceAvailable(operation.instanceId)) {
      return {
        status: 'failed',
        message: 'This ChatGPT account instance no longer exists.',
        retryable: false,
        retryExchange: false,
      };
    }
    if (operation.handlingCallback) {
      return {
        status: 'failed',
        message: 'Authorization is already being completed.',
        retryable: true,
        retryExchange: Boolean(operation.retryCallback),
      };
    }
    if (!operation.auth.hasPendingAuthorization(callback.get('state'), operation.redirectUri)) {
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
      await operation.auth.completeSignIn(callback, operation.redirectUri, { allowTransportRetry: !retryExchange });
      operation.retryCallback = null;
      void operation.auth
        .refreshModels()
        .then(() => refreshCatalog(operation.instanceId))
        .catch(() => undefined);
      result = {
        status: 'connected',
        message: 'ChatGPT is connected. Return to Pico.',
        retryable: false,
        retryExchange: false,
      };
    } catch (error) {
      const pending = operation.auth.hasPendingAuthorization(callback.get('state'), operation.redirectUri);
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
      const sharedOAuthPath =
        process.env.PICO_CHATGPT_OAUTH_DB_PATH?.trim() ||
        (process.env.NODE_ENV === 'production' ? join(process.cwd(), 'data', 'chatgpt-oauth.sqlite') : null);
      sharedOAuthSecrets = sharedOAuthPath
        ? createSharedChatGptOAuthSecrets(sharedOAuthPath, 'pico.chatgpt-plan')
        : null;
      instanceAvailable = (id) => context.providers.get(id)?.typeId === 'chatgpt-plan';
      refreshCatalog = (id) => context.providers.refresh(id);
      const providerConfig = { chatgpt: true, fetchRetries: 5, retryDelayMs: 2000, refreshOnUnauthorized: true };
      const sharedSecretsFor = (
        instance: import('../contracts/model-catalog.js').ProviderInstance,
      ): SharedChatGptOAuthSecrets | null => {
        if (sharedOAuthSecrets && instance.config.legacyShared === true) return sharedOAuthSecrets;
        if (!sharedOAuthPath) return null;
        let secrets = instanceSharedSecrets.get(instance.id);
        if (!secrets) {
          secrets = createSharedChatGptOAuthSecrets(sharedOAuthPath, `pico.chatgpt-plan:instance:${instance.id}`);
          instanceSharedSecrets.set(instance.id, secrets);
        }
        return secrets;
      };
      const secretsFor = (id: string) => {
        const instance = context.providers.get(id);
        if (!instance || instance.typeId !== 'chatgpt-plan') throw new Error('ChatGPT account instance not found.');
        const shared = sharedSecretsFor(instance);
        const raw = shared ?? context.providers.secrets(id);
        const ensureActive = (): void => {
          if (!instanceAvailable(id)) throw new Error('ChatGPT account instance no longer exists.');
        };
        const guarded = {
          get: <T>(key: string, fallback: T): T => {
            ensureActive();
            return raw.get(key, fallback);
          },
          set: <T>(key: string, value: T): void => {
            ensureActive();
            raw.set(key, value);
          },
        };
        return shared
          ? {
              ...guarded,
              withLock: async <T>(operation: () => Promise<T>): Promise<T> => {
                ensureActive();
                return shared.withLock(async () => {
                  ensureActive();
                  return operation();
                });
              },
            }
          : guarded;
      };
      const getAuth = (id: string): ChatGptPlanAuth => {
        const instance = context.providers.get(id);
        if (!instance || instance.typeId !== 'chatgpt-plan') throw new Error('ChatGPT account instance not found.');
        let auth = authByInstance.get(id);
        if (!auth) {
          const prefix = `instance:${id}:`;
          const cache = {
            get: <T>(key: string, fallback: T): T => context.cache.get(prefix + key, fallback),
            set: <T>(key: string, value: T): void => {
              if (!instanceAvailable(id)) throw new Error('ChatGPT account instance no longer exists.');
              context.cache.set(prefix + key, value);
            },
          };
          auth = new ChatGptPlanAuth(context.state, fetch, Date.now, secretsFor(id), cache);
          authByInstance.set(id, auth);
        }
        return auth;
      };
      const requireInstance = (request: PluginHttpRequest): { id: string; auth: ChatGptPlanAuth } => {
        const values = request.query.getAll('instanceId');
        if (values.length !== 1 || !values[0]) throw new Error('A ChatGPT account instance is required.');
        return { id: values[0], auth: getAuth(values[0]) };
      };
      context.providers.registerType(
        {
          id: 'chatgpt-plan',
          label: 'ChatGPT account',
          description: 'Use a ChatGPT plan account through OpenAI’s Responses API.',
          addPage: { pluginId: 'pico.chatgpt-plan', pageId: 'account' },
          editPage: { pluginId: 'pico.chatgpt-plan', pageId: 'account' },
        },
        {
          defaultConfig: providerConfig,
          listModels: async (instance) =>
            (await getAuth(instance.id).listModels()).map((model) => ({
              id: model.slug,
              name: model.slug,
              label: model.displayName,
              protocol: 'openai-responses',
              supportsImages: true,
              endpoint: 'https://api.openai.com/v1/responses',
            })),
          authorize: async (instance, forceRefresh, signal) => {
            if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            return { authorization: `Bearer ${await getAuth(instance.id).accessToken(forceRefresh)}` };
          },
          disposeInstance: async (instance) => {
            const operations = [...callbackOperations.values()].filter(
              (operation) => operation.instanceId === instance.id,
            );
            await Promise.all(operations.map((operation) => closeCallbackServer(operation.server, true)));
            authByInstance.delete(instance.id);
            context.cache.set(`instance:${instance.id}:modelCatalog`, null);
            const secrets = sharedSecretsFor(instance);
            if (secrets) {
              try {
                await secrets.withLock(async () => {
                  secrets.clear();
                });
              } finally {
                if (secrets !== sharedOAuthSecrets) {
                  instanceSharedSecrets.delete(instance.id);
                  secrets.close();
                }
              }
            }
            if (instance.config.legacyMigration === true) context.secrets?.delete('oauth');
          },
        },
      );
      // Only create a legacy instance when an old credential actually exists. The marker makes migration idempotent.
      const sharedLegacy = sharedOAuthSecrets?.get<unknown>('oauth', null) ?? null;
      const legacy = sharedLegacy ?? context.secrets?.get<unknown>('oauth', null) ?? null;
      const legacyId = context.state.get<string | null>('legacyInstanceId', null);
      if (legacy && !legacyId) {
        const instance =
          context.providers
            .list()
            .find((item) => item.typeId === 'chatgpt-plan' && item.config.legacyMigration === true) ??
          context.providers.add('chatgpt-plan', {
            label: 'ChatGPT account',
            config: { ...providerConfig, legacyMigration: true, legacyShared: Boolean(sharedLegacy) },
          });
        const secrets = secretsFor(instance.id);
        if (!secrets.get('oauth', null)) secrets.set('oauth', legacy);
        const catalog =
          context.cache.get<unknown>('modelCatalog', null) ?? context.state.get<unknown>('modelCatalog', null);
        if (catalog) context.cache.set(`instance:${instance.id}:modelCatalog`, catalog);
        context.state.set('legacyInstanceId', instance.id);
      }
      context.commands.register({
        name: 'chatgpt-provider',
        description: 'Show whether a ChatGPT account provider is connected.',
        execute() {
          const connected = context.providers
            .list()
            .filter((instance) => instance.typeId === 'chatgpt-plan')
            .some((instance) => getAuth(instance.id).status().connected);
          return {
            text: connected
              ? 'A ChatGPT account is connected.'
              : 'No ChatGPT account is connected. Open the ChatGPT plugin settings to connect one.',
          };
        },
      });

      context.ui.registerPage({
        id: 'account',
        label: 'ChatGPT',
        description: 'Connect and configure a ChatGPT plan account.',
        entry: 'webui',
        externalAuthOrigins: ['https://auth.openai.com'],
      });
      context.http.register('GET', '/instances', () =>
        context.providers.list().filter((instance) => instance.typeId === 'chatgpt-plan'),
      );
      context.http.register('POST', '/instances', (request) => {
        const body =
          request.body && typeof request.body === 'object' && !Array.isArray(request.body)
            ? (request.body as Record<string, unknown>)
            : {};
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        if (!label || label.length > 120) throw new Error('Enter an account label.');
        return context.providers.add('chatgpt-plan', { label, config: providerConfig });
      });
      context.http.register('GET', '/status', (request) => requireInstance(request).auth.status());
      context.http.register('GET', '/models', async (request) => await requireInstance(request).auth.listModels());
      context.http.register('POST', '/models/refresh', async (request) => {
        const { id, auth } = requireInstance(request);
        const models = await auth.listModels(true);
        await context.providers.refresh(id);
        return models;
      });
      context.http.register('POST', '/sign-in', async (request: PluginHttpRequest) => {
        const { id: instanceId, auth } = requireInstance(request);
        const uiOrigin = request.origin;
        if (!uiOrigin) throw new Error('ChatGPT sign-in must be started from the Pico Web UI.');
        const operationId = randomUUID();
        let server: Server;
        let operation: CallbackOperation | null = null;
        let redirectUri: string;

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
          instanceId,
          auth,
          redirectUri,
          server,
          handlingCallback: false,
          retryCallback: null,
          retryAttempted: false,
        };
        callbackOperations.set(operationId, operation);
        try {
          const { authorizationUrl } = await auth.beginSignIn(redirectUri);
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
      context.http.register('POST', '/sign-in/complete', async (request: PluginHttpRequest) => {
        const { id: instanceId, auth } = requireInstance(request);
        const { body } = request;
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
        if (!operation || operation.instanceId !== instanceId)
          throw new Error('This ChatGPT sign-in attempt is no longer active. Start again.');

        if (operation.retryCallback) {
          return {
            status: 'failed',
            message: 'The previous token request was not confirmed. Retry the token exchange below.',
            retryable: true,
            retryExchange: true,
          } satisfies CallbackCompletionResult;
        }

        const callback = auth.parseCallbackUrl(input.callbackUrl, operation.redirectUri);
        const result = await completeCallback(operation, callback);
        if (!result.retryable) await closeCallbackServer(operation.server);
        return result;
      });
      context.http.register('POST', '/sign-in/retry', async (request: PluginHttpRequest) => {
        const { id: instanceId } = requireInstance(request);
        const { body } = request;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('This ChatGPT sign-in cannot be retried. Start again.');
        }
        const input = body as Record<string, unknown>;
        if (Object.keys(input).length !== 1 || typeof input.operationId !== 'string') {
          throw new Error('This ChatGPT sign-in cannot be retried. Start again.');
        }
        const operation = callbackOperations.get(input.operationId);
        if (!operation || operation.instanceId !== instanceId || !operation.retryCallback || operation.retryAttempted) {
          throw new Error('The ChatGPT token retry is no longer available. Start a new sign-in.');
        }
        operation.retryAttempted = true;
        const callback = operation.retryCallback;
        const result = await completeCallback(operation, callback, true);
        if (!result.retryable) await closeCallbackServer(operation.server);
        return result;
      });
      context.http.register('DELETE', '/account', async (request) => await requireInstance(request).auth.signOut());
    },
    async deactivate() {
      await Promise.all([...callbackServers].map((server) => closeCallbackServer(server)));
      authByInstance.clear();
      instanceAvailable = () => false;
      refreshCatalog = async () => undefined;
      for (const secrets of instanceSharedSecrets.values()) secrets.close();
      instanceSharedSecrets.clear();
      sharedOAuthSecrets?.close();
      sharedOAuthSecrets = null;
    },
  };
}
