import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

function createComposerHarness() {
  const summarySource = readFileSync(new URL('../plugins/pico.usage/webui/usage-summary.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../plugins/pico.usage/webui/usage.js', import.meta.url), 'utf8');
  let html = '';
  const root = {
    set innerHTML(value: string) {
      html = value;
    },
    get innerHTML() {
      return html;
    },
    scrollHeight: 24,
  };
  let onWindowMessage: ((event: any) => void) | undefined;
  const parent = {};
  const requests: Array<Record<string, any>> = [];
  const port = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    postMessage: (message: Record<string, any>) => {
      if (message.type === 'pico:plugin-ui:request') requests.push(message);
    },
    start() {},
  };
  const window = {
    parent,
    addEventListener(_type: string, listener: (event: any) => void) {
      onWindowMessage = listener;
    },
  };
  const globals = {
    document: { getElementById: () => root, body: { classList: { add() {} } } },
    window,
    location: { search: '' },
    URLSearchParams,
  };
  runInNewContext(summarySource, globals);
  runInNewContext(source, globals);
  onWindowMessage?.({
    source: parent,
    data: {
      type: 'pico:plugin-ui:init',
      protocolVersion: 1,
      pluginId: 'pico.usage',
      entry: 'webui',
      viewType: 'component',
      viewId: 'ComposerUsage',
      context: { thread: { id: 'thread-a' } },
    },
    ports: [port],
  });
  const sendContext = (threadId?: string) =>
    port.onmessage?.({
      data: {
        type: 'pico:plugin-ui:context',
        context: threadId ? { thread: { id: threadId } } : { thread: null },
      },
    });
  const respond = (request: Record<string, any>, inputTokens: number) =>
    port.onmessage?.({
      data: {
        type: 'pico:plugin-ui:response',
        id: request.id,
        ok: true,
        value: {
          totals: { inputTokens, outputTokens: 1, cachedInputTokens: 0 },
          coverage: {},
          rows: [],
        },
      },
    });
  const reject = (request: Record<string, any>) =>
    port.onmessage?.({
      data: { type: 'pico:plugin-ui:response', id: request.id, ok: false, error: 'stale failure' },
    });
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return { get html() { return html; }, requests, sendContext, respond, reject, flush };
}

it('keeps Composer Usage on the current Thread when reports finish out of order', async () => {
  const harness = createComposerHarness();
  const firstA = harness.requests[0];
  if (!firstA) throw new Error('Expected initial Thread A report');

  harness.sendContext('thread-b');
  const reportB = harness.requests[1];
  if (!reportB) throw new Error('Expected Thread B report');
  harness.respond(reportB, 222);
  await harness.flush();
  expect(harness.html).toContain('In 222');

  harness.respond(firstA, 111);
  await harness.flush();
  expect(harness.html).toContain('In 222');
  expect(harness.html).not.toContain('In 111');
});

it('ignores stale Composer Usage failures, same-Thread refreshes, and responses after clearing Thread context', async () => {
  const harness = createComposerHarness();
  const firstA = harness.requests[0];
  if (!firstA) throw new Error('Expected initial Thread A report');
  harness.sendContext('thread-b');
  const reportB = harness.requests[1];
  if (!reportB) throw new Error('Expected Thread B report');
  harness.respond(reportB, 222);
  await harness.flush();
  harness.reject(firstA);
  await harness.flush();
  expect(harness.html).toContain('In 222');

  harness.sendContext('thread-b');
  const olderRefresh = harness.requests[2];
  harness.sendContext('thread-b');
  const newerRefresh = harness.requests[3];
  if (!olderRefresh || !newerRefresh) throw new Error('Expected same-Thread refresh requests');
  harness.respond(newerRefresh, 333);
  await harness.flush();
  harness.respond(olderRefresh, 444);
  await harness.flush();
  expect(harness.html).toContain('In 333');
  expect(harness.html).not.toContain('In 444');

  harness.sendContext('thread-b');
  const pendingBeforeClear = harness.requests[4];
  if (!pendingBeforeClear) throw new Error('Expected report before clearing Thread context');
  harness.sendContext();
  expect(harness.html).toBe('');
  harness.respond(pendingBeforeClear, 555);
  await harness.flush();
  expect(harness.html).toBe('');
});

it('uses project and Thread names in linked Usage filters and report rows', async () => {
  const summarySource = readFileSync(new URL('../plugins/pico.usage/webui/usage-summary.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../plugins/pico.usage/webui/usage.js', import.meta.url), 'utf8');
  const fields: Record<string, { value: string; innerHTML: string; disabled: boolean }> = Object.fromEntries(
    ['projectId', 'threadId', 'provider', 'model', 'purpose', 'from', 'to'].map((name) => [
      name,
      { value: '', innerHTML: '', disabled: false },
    ]),
  );
  const listeners = new Map<string, (event: any) => void>();
  let html = '';
  const fieldElement = (name: string) => {
    const field = fields[name];
    if (!field) return null;
    return {
      get value() {
        return field.value;
      },
      set value(value: string) {
        field.value = value;
      },
      get innerHTML() {
        return field.innerHTML;
      },
      set innerHTML(value: string) {
        field.innerHTML = value;
      },
      get disabled() {
        return field.disabled;
      },
      set disabled(value: boolean) {
        field.disabled = value;
      },
      addEventListener(type: string, listener: (event: any) => void) {
        listeners.set(`${name}:${type}`, listener);
      },
    };
  };
  const makeForm = (id: string) => ({
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(`${id}:${type}`, listener),
    querySelector(selector: string) {
      const match = selector.match(/^\[name="([^"]+)"\]$/);
      return match?.[1] ? fieldElement(match[1]) : null;
    },
  });
  const form = makeForm('filters');
  const rateForm = makeForm('rate');
  let onWindowMessage: ((event: unknown) => void) | undefined;
  const parent = {};
  const root = {
    set innerHTML(value: string) {
      html = value;
      for (const [name, field] of Object.entries(fields)) {
        const select = value.match(new RegExp(`<select name="${name}">(.*?)</select>`));
        if (select) {
          const options = [...(select[1] ?? '').matchAll(/<option value="([^"]*)"([^>]*)>/g)];
          field.value = options.find((option) => option[2]?.includes('selected'))?.[1] ?? '';
          continue;
        }
        const input = value.match(new RegExp(`<input name="${name}"[^>]*value="([^"]*)"`));
        if (input) field.value = input[1] ?? '';
      }
    },
    querySelector(selector: string) {
      if (selector === '#filters') return form;
      if (selector === '#rate-form') return rateForm;
      if (selector === '#refresh') return { addEventListener() {} };
      const match = selector.match(/^\[name="([^"]+)"\]$/);
      const name = match?.[1];
      if (!name) return null;
      return fieldElement(name);
    },
    querySelectorAll: () => [],
  };
  const requests: Array<Record<string, unknown>> = [];
  const port = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    postMessage: (message: Record<string, unknown>) => requests.push(message),
    start() {},
  };
  class FakeFormData {
    entries() {
      return Object.entries(fields).map(([key, field]) => [key, field.value]);
    }
  }

  const window = {
    parent,
    addEventListener(_type: string, listener: (event: unknown) => void) {
      onWindowMessage = listener;
    },
  };
  const globals = {
    document: { getElementById: () => root },
    window,
    location: { search: '' },
    FormData: FakeFormData,
    URLSearchParams,
  };
  runInNewContext(summarySource, globals);
  runInNewContext(source, globals);

  onWindowMessage?.({
    source: parent,
    data: {
      type: 'pico:plugin-ui:init',
      protocolVersion: 1,
      pluginId: 'pico.usage',
      entry: 'webui',
      viewType: 'page',
      context: { thread: { id: 'thread-1', projectId: 'project-1' } },
    },
    ports: [port],
  });
  expect(requests.map((request) => request.path)).toEqual([
    '/api/plugins/pico.usage/catalog',
    '/api/plugins/pico.usage/options',
    '/api/plugins/pico.usage/report',
  ]);

  const catalogRequest = requests[0];
  const optionsRequest = requests[1];
  const reportRequest = requests[2];
  if (!catalogRequest || !optionsRequest || !reportRequest)
    throw new Error('Expected catalog, options, and report requests');
  const respond = (request: Record<string, unknown>, value: unknown) =>
    port.onmessage?.({
      data: { type: 'pico:plugin-ui:response', id: request.id, ok: true, value },
    });
  respond(catalogRequest, {
    projects: [
      { id: 'project-1', name: 'Garden project' },
      { id: 'project-2', name: 'Workshop project' },
    ],
    threads: [
      { id: 'thread-1', projectId: 'project-1', title: 'Planning session' },
      { id: 'thread-2', projectId: 'project-2', title: 'Build notes' },
    ],
  });
  respond(optionsRequest, { providerModels: [], purposes: [] });
  respond(reportRequest, {
    rows: [
      {
        createdAt: '2026-10-15T12:00:00.000Z',
        kind: 'main',
        purpose: 'main-model',
        provider: 'provider-a',
        model: 'model-a',
        threadId: 'thread-1',
        status: 'completed',
        usage: { inputTokens: 10, outputTokens: 2 },
        estimatedCost: null,
        currency: null,
        attempts: [],
      },
      {
        createdAt: '2026-10-15T12:01:00.000Z',
        kind: 'auxiliary',
        purpose: 'todo-review',
        provider: 'provider-a',
        model: 'reviewer-a',
        threadId: 'thread-1',
        status: 'failed',
        usage: null,
        estimatedCost: null,
        currency: null,
        attempts: [],
      },
    ],
    totals: { inputTokens: 10, outputTokens: 2 },
    coverage: {
      inputTokens: { reported: 1, total: 2 },
      outputTokens: { reported: 1, total: 2 },
      cachedInputTokens: { reported: 0, total: 2 },
      cacheWriteTokens: { reported: 0, total: 2 },
      reasoningTokens: { reported: 0, total: 2 },
    },
    counts: { completedMainCalls: 1, auxiliaryCalls: 0, providerAttempts: 0 },
    groups: {
      thread: [
        {
          key: 'thread-1',
          totals: { inputTokens: 10, outputTokens: 2 },
          coverage: {
            inputTokens: { reported: 1, total: 2 },
            outputTokens: { reported: 1, total: 2 },
          },
        },
      ],
      project: [
        {
          key: 'project-1',
          totals: { inputTokens: 10, outputTokens: 2 },
          coverage: {
            inputTokens: { reported: 1, total: 2 },
            outputTokens: { reported: 1, total: 2 },
          },
        },
      ],
      provider: [],
      model: [],
      purpose: [],
      day: [],
    },
    rates: [],
    limitations: [],
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(html).toContain('<option value="" selected>All projects</option>');
  expect(html).toContain('<option value="" selected>All threads</option>');
  expect(html).toContain('<option value="project-1" >Garden project</option>');
  expect(html).toContain('<option value="thread-1" >Planning session</option>');
  expect(html).toContain('By Thread');
  expect(html).toContain('Planning session');
  expect(html).toContain('By Project');
  expect(html).toContain('Garden project');
  expect(html).toContain(
    '<div class="card metric-card pico-ui-metric-card">Input tokens<strong>10</strong><span class="coverage">Partial · 1/2 calls</span></div>',
  );
  expect(html).toContain('Token totals include reported values only; missing values are excluded, never estimated.');
  expect(html).toContain('<div class="card metric-card pico-ui-metric-card">Estimated cost<strong>unknown</strong>');
  expect(html).not.toMatch(/<input[^>]+name="(?:projectId|threadId)"/);
  expect(html).not.toContain('>thread-1<');
  expect(html).not.toContain('>project-1<');

  const projectSelect = root.querySelector('[name="projectId"]') as { value: string };
  projectSelect.value = 'project-2';
  listeners.get('projectId:change')?.({ currentTarget: projectSelect });
  expect(html).toContain('<option value="thread-2" >Build notes</option>');
  expect(html.match(/<select[^>]*name="threadId"[^>]*>.*?<\/select>/)?.[0]).not.toContain('thread-1');
  expect(requests.at(-1)?.path).toBe('/api/plugins/pico.usage/report?projectId=project-2');

  fields.provider!.value = 'provider-b';
  fields.from!.value = '2026-10-01';
  listeners.get('filters:submit')?.({ preventDefault() {}, currentTarget: form });
  expect(requests.at(-1)?.path).toBe(
    '/api/plugins/pico.usage/report?projectId=project-2&provider=provider-b&from=2026-10-01',
  );
});
