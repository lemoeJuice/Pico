import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isPluginApiPath,
  isPluginModelSettingsUpdate,
  isPluginUiRequest,
  createPluginUiClient,
  pluginUiEventMatchesPlugin,
  pluginUiUrl,
  samePluginUiContext,
  validatePluginUiTree,
  type PluginUiContext,
} from '../src/plugins/ui-protocol.js';
import {
  reconcilePluginUiInputDraft,
  samePluginUiTextInputProps,
  sharePluginUiTree,
} from '../src/web/plugin-ui-tree.js';

describe('dynamic plugin UI boundary', () => {
  it('keeps multi-character host drafts through delayed and stale plugin snapshots', () => {
    let draft = '';
    let pendingEcho = false;
    for (const character of ['U', 'S', 'D']) {
      draft += character;
      pendingEcho = true;
      const result = reconcilePluginUiInputDraft(draft, '', true, pendingEcho);
      draft = result.draft;
      pendingEcho = result.pendingEcho;
    }
    expect(draft).toBe('USD');
    expect(reconcilePluginUiInputDraft(draft, '', true, pendingEcho)).toEqual({ draft: 'USD', pendingEcho: true });
    expect(reconcilePluginUiInputDraft('USD', 'USD', true, true)).toEqual({ draft: 'USD', pendingEcho: false });
    expect(reconcilePluginUiInputDraft('USD', '', false, true)).toEqual({ draft: 'USD', pendingEcho: true });
    expect(reconcilePluginUiInputDraft('USD', 'USD', false, true)).toEqual({ draft: 'USD', pendingEcho: false });
  });

  it('keeps unaffected text input components stable across unrelated tree snapshots', () => {
    const action = (): void => undefined;
    const previous = {
      node: { type: 'textInput' as const, label: 'Currency', value: 'USD', actionId: 'currency' },
      onAction: action,
      compact: false,
    };
    expect(samePluginUiTextInputProps(previous, { ...previous, node: { ...previous.node } })).toBe(true);
    expect(
      samePluginUiTextInputProps(previous, {
        ...previous,
        node: { ...previous.node, value: 'EUR' },
      }),
    ).toBe(false);
  });

  it('shares unchanged sibling and nested subtrees when one field changes', () => {
    const previous = [
      {
        type: 'group' as const,
        layout: 'stack-compact' as const,
        children: [
          { type: 'textInput' as const, label: 'Currency', value: 'USD', actionId: 'currency' },
          { type: 'card' as const, children: [{ type: 'text' as const, text: 'Unchanged' }] },
        ],
      },
      { type: 'paragraph' as const, text: 'Outside subtree' },
    ];
    const incoming = [
      {
        type: 'group' as const,
        layout: 'stack-compact' as const,
        children: [
          { type: 'textInput' as const, label: 'Currency', value: 'EUR', actionId: 'currency' },
          { type: 'card' as const, children: [{ type: 'text' as const, text: 'Unchanged' }] },
        ],
      },
      { type: 'paragraph' as const, text: 'Outside subtree' },
    ];
    const shared = sharePluginUiTree(previous, incoming);
    expect(shared).not.toBe(previous);
    const oldGroup = previous[0];
    const newGroup = shared[0];
    expect(newGroup).not.toBe(oldGroup);
    if (oldGroup?.type !== 'group' || newGroup?.type !== 'group') throw new Error('Expected group roots.');
    expect(newGroup.children[0]).not.toBe(oldGroup.children[0]);
    expect(newGroup.children[1]).toBe(oldGroup.children[1]);
    expect(shared[1]).toBe(previous[1]);
  });

  it('reuses select and table nodes whose nested values were rebuilt but unchanged', () => {
    const previousSelect = {
      type: 'select' as const,
      label: 'Provider',
      value: 'openai',
      actionId: 'provider',
      options: [
        { label: 'OpenAI', value: 'openai' },
        { label: 'Anthropic', value: 'anthropic' },
      ],
    };
    const selectTree = [previousSelect];
    const recreatedSelect = JSON.parse(JSON.stringify(selectTree)) as typeof selectTree;
    expect(sharePluginUiTree(selectTree, recreatedSelect)).toBe(selectTree);
    const changedSelect = JSON.parse(JSON.stringify(selectTree)) as typeof selectTree;
    changedSelect[0]!.options[1]!.label = 'Anthropic Models';
    expect(sharePluginUiTree(selectTree, changedSelect)[0]).not.toBe(previousSelect);

    const previousTable = { type: 'table' as const, columns: ['Name', 'Status'], rows: [['Goal', 'active']] };
    const tableTree = [previousTable];
    const recreatedTable = JSON.parse(JSON.stringify(tableTree)) as typeof tableTree;
    expect(sharePluginUiTree(tableTree, recreatedTable)).toBe(tableTree);
    const changedTable = JSON.parse(JSON.stringify(tableTree)) as typeof tableTree;
    changedTable[0]!.rows[0]![1] = 'paused';
    expect(sharePluginUiTree(tableTree, changedTable)[0]).not.toBe(previousTable);
  });

  it('keeps text area drafts through repeated edits and stale or matching echoes', () => {
    const sequence = (initial: string, entered: string): { draft: string; pending: boolean } => {
      let draft = initial;
      let pending = false;
      for (const character of entered) {
        draft += character;
        pending = true;
        const next = reconcilePluginUiInputDraft(draft, initial, true, pending);
        draft = next.draft;
        pending = next.pendingEcho;
      }
      return { draft, pending };
    };
    const state = sequence('', 'multi-line');
    expect(state).toEqual({ draft: 'multi-line', pending: true });
    expect(reconcilePluginUiInputDraft(state.draft, '', false, state.pending)).toEqual({
      draft: 'multi-line',
      pendingEcho: true,
    });
    expect(reconcilePluginUiInputDraft(state.draft, state.draft, false, state.pending)).toEqual({
      draft: 'multi-line',
      pendingEcho: false,
    });
  });

  it('accepts only bounded host-rendered components allowed by their semantic slot', () => {
    expect(validatePluginUiTree([{ type: 'text', text: '<b>literal</b>' }], 'composer.status')).toBe(true);
    expect(validatePluginUiTree([{ type: 'button', label: 'Refresh', actionId: 'refresh' }], 'thread.toolbar')).toBe(
      true,
    );
    expect(
      validatePluginUiTree(
        [{ type: 'button', label: 'Continue', actionId: 'connect', externalAuth: true }],
        'settings.page',
      ),
    ).toBe(true);
    expect(
      validatePluginUiTree(
        [{ type: 'button', label: 'Continue', actionId: 'connect', externalAuth: 'https://example.test' }],
        'settings.page',
      ),
    ).toBe(false);
    expect(validatePluginUiTree([{ type: 'button', label: 'Send', actionId: 'send' }], 'composer.status')).toBe(false);
    expect(validatePluginUiTree([{ type: 'text', text: 'x', className: 'arbitrary' }], 'sidebar.panel')).toBe(false);
    expect(validatePluginUiTree([{ type: 'image', src: 'https://example.test/a.png' }], 'settings.page')).toBe(false);
    expect(
      validatePluginUiTree(
        [
          {
            type: 'disclosure',
            label: 'History',
            open: false,
            actionId: 'history',
            children: [{ type: 'list', ordered: false, items: [{ type: 'text', text: 'Updated' }] }],
          },
        ],
        'thread.toolbar',
      ),
    ).toBe(true);
    expect(
      validatePluginUiTree(
        [{ type: 'table', columns: ['Name', 'Status'], rows: [['Goal', 'active']] }],
        'settings.page',
      ),
    ).toBe(true);
    expect(
      validatePluginUiTree([{ type: 'table', columns: ['Name', 'Status'], rows: [['Goal']] }], 'settings.page'),
    ).toBe(false);
  });

  it('accepts only framework-defined group layouts and safe common input types', () => {
    expect(
      validatePluginUiTree(
        [
          {
            type: 'group',
            layout: 'grid-2',
            children: [
              { type: 'textInput', label: 'From', inputType: 'date', actionId: 'from' },
              { type: 'textInput', label: 'Rate', inputType: 'number', min: 0, step: 'any', actionId: 'rate' },
            ],
          },
        ],
        'settings.page',
      ),
    ).toBe(true);
    expect(
      validatePluginUiTree(
        [{ type: 'group', layout: 'grid-arbitrary', children: [{ type: 'text', text: 'x' }] }],
        'settings.page',
      ),
    ).toBe(false);
    expect(
      validatePluginUiTree(
        [{ type: 'textInput', label: 'Rate', inputType: 'number', min: 0, actionId: 'rate' }],
        'settings.page',
      ),
    ).toBe(true);
    expect(
      validatePluginUiTree([{ type: 'textInput', label: 'Name', inputType: 'url', actionId: 'name' }], 'settings.page'),
    ).toBe(false);
    expect(
      validatePluginUiTree(
        [{ type: 'textInput', label: 'Name', inputType: 'text', step: 1, actionId: 'name' }],
        'settings.page',
      ),
    ).toBe(false);
  });

  it('fails closed on excessive trees, nesting, action values and invalid textarea sizing', () => {
    expect(
      validatePluginUiTree(
        Array.from({ length: 2049 }, () => ({ type: 'text', text: 'x' })),
        'settings.page',
      ),
    ).toBe(false);
    expect(validatePluginUiTree([{ type: 'button', label: 'Go', actionId: 'x'.repeat(81) }], 'settings.page')).toBe(
      false,
    );
    expect(
      validatePluginUiTree([{ type: 'textArea', label: 'Goal', actionId: 'goal', rows: 'small' }], 'settings.page'),
    ).toBe(false);
    expect(validatePluginUiTree([{ type: 'paragraph', text: 'x'.repeat(20001) }], 'settings.page')).toBe(false);
    expect(
      validatePluginUiTree(
        [
          {
            type: 'select',
            label: 'Model',
            actionId: 'model',
            options: Array.from({ length: 81 }, () => ({ label: 'x', value: 'x' })),
          },
        ],
        'composer.model',
      ),
    ).toBe(false);
  });

  it('enforces each slot allowlist and exact select option fields', () => {
    expect(
      validatePluginUiTree(
        [{ type: 'textInput', label: 'Temperature', value: '0.5', actionId: 'temperature' }],
        'composer.model',
      ),
    ).toBe(true);
    expect(
      validatePluginUiTree(
        [{ type: 'switch', label: 'Fast mode', checked: true, actionId: 'fast-mode' }],
        'composer.model',
      ),
    ).toBe(true);
    expect(
      validatePluginUiTree(
        [{ type: 'range', label: 'Reasoning budget', value: 16384, min: 0, max: 32768, step: 256, actionId: 'budget' }],
        'composer.model',
      ),
    ).toBe(true);
    expect(
      validatePluginUiTree(
        [{ type: 'range', label: 'Reasoning budget', value: 32769, min: 0, max: 32768, step: 256, actionId: 'budget' }],
        'composer.model',
      ),
    ).toBe(false);
    expect(
      validatePluginUiTree(
        [{ type: 'checkbox', label: 'Fast mode', checked: true, actionId: 'fast-mode' }],
        'composer.model',
      ),
    ).toBe(false);
    expect(
      validatePluginUiTree(
        [{ type: 'switch', label: 'Auto memory', checked: true, actionId: 'auto' }],
        'settings.page',
      ),
    ).toBe(true);
    expect(
      validatePluginUiTree([{ type: 'status', text: 'Connected as account', tone: 'success' }], 'settings.page'),
    ).toBe(true);
    expect(validatePluginUiTree([{ type: 'status', text: 'Connected', tone: 'success' }], 'composer.status')).toBe(
      false,
    );
    expect(
      validatePluginUiTree(
        [
          { type: 'button', label: 'Refresh', actionId: 'refresh', tone: 'soft' },
          { type: 'button', label: 'Disconnect', actionId: 'disconnect', tone: 'danger' },
        ],
        'settings.page',
      ),
    ).toBe(true);
    expect(
      validatePluginUiTree(
        [{ type: 'checkbox', label: 'Reasoning', checked: true, actionId: 'reasoning' }],
        'composer.action',
      ),
    ).toBe(false);
    expect(validatePluginUiTree([{ type: 'paragraph', text: 'Connected' }], 'composer.status')).toBe(false);
    expect(
      validatePluginUiTree(
        [{ type: 'disclosure', label: 'Details', open: false, actionId: 'details', children: [] }],
        'tool.result',
      ),
    ).toBe(false);
    expect(
      validatePluginUiTree(
        [{ type: 'select', label: 'Model', actionId: 'model', options: [{ label: 'A', value: 'a', disabled: true }] }],
        'settings.page',
      ),
    ).toBe(false);
    expect(
      validatePluginUiTree(
        [{ type: 'select', label: 'Model', actionId: 'model', options: [{ label: 'A' }] }],
        'settings.page',
      ),
    ).toBe(false);
    expect(
      validatePluginUiTree(
        [
          { type: 'button', label: 'A', actionId: 'same' },
          { type: 'button', label: 'B', actionId: 'same' },
        ],
        'settings.page',
      ),
    ).toBe(false);
  });

  it('keeps host input sizing semantic and supports six-row Goal fields', () => {
    const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');
    const renderer = readFileSync(new URL('../src/web/plugin-ui-tree.tsx', import.meta.url), 'utf8');
    expect(css).toMatch(/\.plugin-ui-text-input\s*\{[^}]*white-space:\s*nowrap;[^}]*overflow-x:\s*auto;/s);
    expect(css).toMatch(/\.plugin-ui-text-area\s*\{[^}]*line-height:\s*1\.5;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.plugin-ui-control\s*\{[^}]*padding:\s*8px 10px;/s);
    expect(css).toMatch(/\.plugin-ui-switch-control\s*\{[^}]*width:\s*30px;[^}]*height:\s*18px;[^}]*padding:\s*2px;/s);
    expect(css).toMatch(/\.plugin-ui-switch-thumb\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;[^}]*flex:\s*0 0 14px;/s);
    expect(css).not.toContain('.plugin-ui-switch-track');
    expect(css).toMatch(/\.plugin-ui-switch--compact\s*\{[^}]*border-radius:\s*10px;/s);
    expect(css).toMatch(/\.plugin-ui-range-control\s*\{[^}]*accent-color:\s*#698e70;/s);
    expect(renderer).toMatch(/className=\{`plugin-ui-switch/);
    expect(renderer).toMatch(/role="switch"/);
    expect(renderer).toContain('role="combobox"');
    expect(renderer).toContain('role="listbox"');
    expect(renderer).toContain("event.key === 'ArrowDown' || event.key === 'ArrowUp'");
    expect(renderer).not.toMatch(/<select\b/);
    expect(css).toContain('.plugin-ui-select-menu {\n  position: fixed;');
    expect(css).toMatch(/\.plugin-ui-status--success\s*\{[^}]*background:\s*color-mix\(/s);
    expect(css).toMatch(/\.composer-plugin-controls\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;/s);
    expect(css).toMatch(
      /\.composer-plugin-controls \.plugin-ui-host-rendered--component\s*\{[^}]*width:\s*max-content;[^}]*display:\s*block;[^}]*flex:\s*0 0 auto;[^}]*overflow:\s*visible;/s,
    );
    expect(css).toMatch(
      /\.composer-plugin-controls \.plugin-ui-host-rendered--component \.plugin-ui-tree--composer-scroll\s*\{[^}]*display:\s*block;[^}]*width:\s*max-content;[^}]*overflow:\s*visible;/s,
    );
    expect(renderer).toContain('plugin-ui-tree--composer-content');
    expect(renderer).toContain('plugin-ui-tree--composer-scroll');
    expect(css).toMatch(/\.plugin-ui-sr-only\s*\{[^}]*clip:\s*rect\(0, 0, 0, 0\);/s);
    expect(css).toMatch(/\.plugin-ui-button,\s*\.plugin-ui-control\s*\{[^}]*border:\s*1px solid var\(--line\);/s);
    expect(css).toMatch(/\.plugin-ui-text-area--compact\s*\{[^}]*calc\(2 \* 1\.5em \+ 18px\)/s);
    expect(css).toMatch(/\.plugin-ui-text-area--standard\s*\{[^}]*calc\(4 \* 1\.5em \+ 18px\)/s);
    expect(css).toMatch(/\.plugin-ui-text-area--large\s*\{[^}]*calc\(6 \* 1\.5em \+ 18px\)/s);
    expect(css).not.toMatch(/\.plugin-ui-text-area[^}]*max-height:/s);
    const pluginWebView = readFileSync(new URL('../src/web/plugin-web-view.tsx', import.meta.url), 'utf8');
    expect(pluginWebView).toContain(
      "setUiError('The plugin interface did not respond. Check Plugin UI diagnostics for details.')",
    );
    expect(pluginWebView).toContain("'load-timeout'");
    expect(pluginWebView).toContain('PLUGIN_UI_FRAME_LOAD_TIMEOUT_MS = 15_000');
    expect(pluginWebView).toContain('scheduleMissingRenderError(');
    expect(pluginWebView).toContain('          5000,');
    expect(pluginWebView).toMatch(/document\.body,[\s\S]*?\)\}\s*\{iframe\}\s*<\/>/);
    const developerSettings = readFileSync(new URL('../src/web/developer-settings.tsx', import.meta.url), 'utf8');
    expect(developerSettings).toContain("case 'load-timeout':");
    expect(
      validatePluginUiTree(
        [
          {
            type: 'textArea',
            label: 'Goal',
            value: 'A long goal that wraps',
            rows: 'large',
            actionId: 'goal',
            maxLength: 8000,
          },
        ],
        'thread.toolbar',
      ),
    ).toBe(true);
    expect(
      validatePluginUiTree(
        [{ type: 'textArea', label: 'Constraints', rows: 'standard', actionId: 'constraints', maxLength: 4000 }],
        'thread.toolbar',
      ),
    ).toBe(true);
  });

  it('builds semantic entry URLs without exposing a host component contract', () => {
    expect(pluginUiUrl('pico.example', 'settings', 'page', 'account')).toBe(
      '/_pico/plugin-ui/pico.example/settings/index.html?viewType=page&viewId=account',
    );
    expect(pluginUiUrl('pico.example', 'web ui', 'component', 'model/picker')).toContain(
      'pico.example/web%20ui/index.html?viewType=component&viewId=model%2Fpicker',
    );
    expect(pluginUiUrl('pico.example', 'web ui', 'component', 'model/picker', 'composer.model')).toContain(
      'viewType=component&viewId=model%2Fpicker&uiSlot=composer.model',
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

  it('sends host component trees and receives host actions through the MessagePort', () => {
    const sent: unknown[] = [];
    const port = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      start: () => undefined,
      close: () => undefined,
      postMessage: (message: unknown) => sent.push(message),
    } as unknown as MessagePort;
    const client = createPluginUiClient(port, {
      baseUrl: '',
      model: '',
      temperature: 0.2,
      provider: '',
      hasApiKey: false,
    });
    const actions: unknown[] = [];
    client.subscribeActions((action) => actions.push(action));
    const tree = [{ type: 'textArea', label: 'Goal', actionId: 'goal', rows: 'large' }] as const;
    client.render([...tree]);
    expect(sent).toEqual([{ type: 'pico:plugin-ui:render', tree }]);
    port.onmessage?.({
      data: { type: 'pico:plugin-ui:action', actionId: 'goal', value: 'Make progress' },
    } as MessageEvent<unknown>);
    expect(actions).toEqual([{ actionId: 'goal', value: 'Make progress' }]);
    port.onmessage?.({
      data: { type: 'pico:plugin-ui:action', actionId: 'connect', popupLeaseId: 'lease-once' },
    } as MessageEvent<unknown>);
    expect(actions.at(-1)).toEqual({ actionId: 'connect', popupLeaseId: 'lease-once' });
    client.close();
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
      data: { type: 'pico:plugin-ui:event', event: { type: 'plugin.updated', pluginId: 'pico.example' } },
    } as MessageEvent<unknown>);
    expect(contexts).toEqual([nextContext]);
    expect(events).toEqual([{ type: 'plugin.updated', pluginId: 'pico.example' }]);
    const props = client.props({ baseUrl: '', model: '', temperature: 0.2, provider: '', hasApiKey: false });
    expect(props.context).toBe(nextContext);
    const response = props.executeCommand('/example');
    const request = messages[0] as { id: string; action: string; command: string };
    expect(request).toMatchObject({ type: 'pico:plugin-ui:request', action: 'command', command: '/example' });
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
    expect(pluginUiEventMatchesPlugin({ type: 'plugin.updated', pluginId: 'pico.example' }, 'pico.example')).toBe(true);
    expect(pluginUiEventMatchesPlugin({ type: 'plugin.updated', pluginId: 'other.plugin' }, 'pico.example')).toBe(
      false,
    );
    expect(pluginUiEventMatchesPlugin({ type: 'execution.updated', pluginId: 'pico.example' }, 'pico.example')).toBe(
      false,
    );
  });
});

it('requests navigation only through the host-created popup lease bridge', async () => {
  const sent: unknown[] = [];
  const port = {
    onmessage: null,
    start() {},
    close() {},
    postMessage(message: unknown) {
      sent.push(message);
    },
  } as unknown as MessagePort;
  const client = createPluginUiClient(port, {
    baseUrl: '',
    model: '',
    temperature: 0.2,
    provider: '',
    hasApiKey: false,
  });
  const navigation = client.navigateAuthPopup(
    'one-shot-lease',
    'https://auth.example.test/authorize?state=runtime',
    'http://127.0.0.1:43210',
    'op-123',
  );
  const request = sent[0] as {
    id: string;
    action: string;
    leaseId: string;
    authorizationUrl: string;
    callbackOrigin: string;
    operationId: string;
  };
  expect(request).toMatchObject({
    type: 'pico:plugin-ui:request',
    action: 'auth-popup-navigate',
    leaseId: 'one-shot-lease',
    authorizationUrl: 'https://auth.example.test/authorize?state=runtime',
    callbackOrigin: 'http://127.0.0.1:43210',
    operationId: 'op-123',
  });
  port.onmessage?.({
    data: { type: 'pico:plugin-ui:response', id: request.id, ok: true, value: null },
  } as MessageEvent<unknown>);
  await navigation;
  client.close();
});
