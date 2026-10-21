import { describe, expect, it } from 'vitest';
import {
  isPluginApiPath,
  isPluginModelSettingsUpdate,
  isPluginUiRequest,
  createPluginUiClient,
  pluginUiEventMatchesPlugin,
  pluginUiUrl,
  samePluginUiContext,
  type PluginUiContext,
} from '../src/plugins/ui-protocol.js';

describe('dynamic plugin UI boundary', () => {
  it('builds semantic entry URLs without exposing a host component contract', () => {
    expect(pluginUiUrl('pico.example', 'settings', 'page', 'account')).toBe(
      '/_pico/plugin-ui/pico.example/settings/index.html?viewType=page&viewId=account',
    );
    expect(pluginUiUrl('pico.example', 'web ui', 'component', 'model/picker')).toContain(
      'pico.example/web%20ui/index.html?viewType=component&viewId=model%2Fpicker',
    );
  });

  it('limits iframe API calls to the owning plugin and its registered API prefix', () => {
    expect(isPluginApiPath('/api/plugins/pico.example/preferences?view=1', 'pico.example')).toBe(true);
    expect(isPluginApiPath('/api/plugins/other/preferences', 'pico.example')).toBe(false);
    expect(isPluginApiPath('https://elsewhere.test/api/plugins/pico.example/preferences', 'pico.example')).toBe(false);
    expect(isPluginApiPath('//pico.invalid/api/plugins/pico.example/preferences', 'pico.example')).toBe(false);
    expect(isPluginApiPath('/api/plugins/pico.example/../other/preferences', 'pico.example')).toBe(false);
  });

  it('allows non-secret model selector updates and rejects arbitrary settings', () => {
    expect(isPluginModelSettingsUpdate({ provider: 'pico.example', model: 'gpt-6' })).toBe(true);
    expect(isPluginModelSettingsUpdate({ temperature: 0.3 })).toBe(true);
    expect(isPluginModelSettingsUpdate({ apiKey: 'secret' })).toBe(false);
    expect(isPluginModelSettingsUpdate({ provider: 'pico/example' })).toBe(false);
    expect(isPluginModelSettingsUpdate({ unexpected: true })).toBe(false);
  });

  it('validates the narrow MessagePort request protocol', () => {
    expect(
      isPluginUiRequest({
        type: 'pico:plugin-ui:request',
        id: 'plugin-ui-1',
        action: 'api',
        path: '/api/plugins/pico.example/status',
        init: { method: 'GET' },
      }),
    ).toBe(true);
    expect(
      isPluginUiRequest({
        type: 'pico:plugin-ui:request',
        id: 'plugin-ui-2',
        action: 'update-model-settings',
        update: { apiKey: 'secret' },
      }),
    ).toBe(false);
    expect(isPluginUiRequest({ type: 'pico:plugin-ui:request', id: 'x', action: 'invoke-host-function' })).toBe(false);
    expect(
      isPluginUiRequest({
        type: 'pico:plugin-ui:request',
        id: 'plugin-ui-3',
        action: 'command',
        command: '/permissions',
      }),
    ).toBe(true);
    expect(
      isPluginUiRequest({
        type: 'pico:plugin-ui:request',
        id: 'plugin-ui-4',
        action: 'command',
        command: 'x'.repeat(201),
      }),
    ).toBe(false);
  });

  it('exposes Thread and tool context and forwards context updates and plugin events', async () => {
    const messages: unknown[] = [];
    const port = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      start: () => undefined,
      close: () => undefined,
      postMessage: (message: unknown) => messages.push(message),
    } as unknown as MessagePort;
    const initialContext: PluginUiContext = { thread: { id: 'thread-a' } as PluginUiContext['thread'] };
    const client = createPluginUiClient(
      port,
      { baseUrl: '', model: '', temperature: 0.2, provider: '', hasApiKey: false },
      initialContext,
    );
    const contexts: PluginUiContext[] = [];
    const events: unknown[] = [];
    client.subscribeContext((context) => contexts.push(context));
    client.subscribeEvents((event) => events.push(event));

    const nextContext: PluginUiContext = {
      thread: { id: 'thread-b' } as PluginUiContext['thread'],
      toolCall: { id: 'call-1', name: 'read_file', arguments: { path: 'facts.txt' } },
      execution: { id: 'execution-1', threadId: 'thread-b', kind: 'tool', status: 'pending' } as NonNullable<
        PluginUiContext['execution']
      >,
      result: {
        executionId: 'execution-1',
        toolCallId: 'call-1',
        batchId: 'batch-1',
        toolName: 'read_file',
        status: 'completed',
        result: 'contents',
      },
    };
    port.onmessage?.({ data: { type: 'pico:plugin-ui:context', context: nextContext } } as MessageEvent<unknown>);
    port.onmessage?.({
      data: { type: 'pico:plugin-ui:event', event: { type: 'plugin.updated', pluginId: 'pico.permissions' } },
    } as MessageEvent<unknown>);
    expect(contexts).toEqual([nextContext]);
    expect(events).toEqual([{ type: 'plugin.updated', pluginId: 'pico.permissions' }]);
    const props = client.props({ baseUrl: '', model: '', temperature: 0.2, provider: '', hasApiKey: false });
    expect(props.context).toBe(nextContext);
    const response = props.executeCommand('/permissions');
    const request = messages[0] as { id: string; action: string; command: string };
    expect(request).toMatchObject({ type: 'pico:plugin-ui:request', action: 'command', command: '/permissions' });
    port.onmessage?.({
      data: { type: 'pico:plugin-ui:response', id: request.id, ok: true, value: { text: 'opened' } },
    } as MessageEvent<unknown>);
    await expect(response).resolves.toEqual({ text: 'opened' });
    client.close();
  });

  it('keeps context messages stable across unrelated renders and scopes plugin events by owner', () => {
    const threadA = { id: 'thread-a' } as PluginUiContext['thread'];
    const threadB = { id: 'thread-b' } as PluginUiContext['thread'];
    const selection = {
      provider: 'openai-compatible',
      connectionId: 'default',
      model: 'first',
      parameters: { temperature: 0.2, options: {} },
    };
    expect(samePluginUiContext({ thread: threadA }, { thread: threadA })).toBe(true);
    expect(samePluginUiContext({ thread: threadA }, { thread: threadB })).toBe(false);
    expect(
      samePluginUiContext(
        { thread: threadA, modelSelection: selection },
        { thread: threadA, modelSelection: { ...selection, model: 'second' } },
      ),
    ).toBe(false);
    expect(
      pluginUiEventMatchesPlugin({ type: 'plugin.updated', pluginId: 'pico.permissions' }, 'pico.permissions'),
    ).toBe(true);
    expect(pluginUiEventMatchesPlugin({ type: 'plugin.updated', pluginId: 'other.plugin' }, 'pico.permissions')).toBe(
      false,
    );
    expect(
      pluginUiEventMatchesPlugin({ type: 'execution.updated', pluginId: 'pico.permissions' }, 'pico.permissions'),
    ).toBe(false);
  });
});
