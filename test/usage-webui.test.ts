import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('uses project and Thread names in linked Usage filters and report rows', async () => {
  const source = readFileSync(new URL('../plugins/pico.usage/webui/usage.js', import.meta.url), 'utf8');
  const fields: Record<string, { value: string }> = Object.fromEntries(
    ['projectId', 'threadId', 'provider', 'model', 'purpose', 'from', 'to'].map((name) => [name, { value: '' }]),
  );
  const listeners = new Map<string, (event: any) => void>();
  let html = '';
  const form = { addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener) };
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
      if (selector === '#refresh' || selector === '#rate-form') return { addEventListener() {} };
      const match = selector.match(/^\[name="([^"]+)"\]$/);
      const name = match?.[1];
      if (!name) return null;
      const field = fields[name];
      if (!field) return null;
      return {
        get value() {
          return field.value;
        },
        set value(value: string) {
          field.value = value;
        },
        addEventListener(type: string, listener: (event: any) => void) {
          listeners.set(`${name}:${type}`, listener);
        },
      };
    },
    querySelectorAll: () => [],
  };
  let onWindowMessage: ((event: unknown) => void) | undefined;
  const parent = {};
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

  runInNewContext(source, {
    document: { getElementById: () => root },
    window: {
      parent,
      addEventListener(_type: string, listener: (event: unknown) => void) {
        onWindowMessage = listener;
      },
    },
    location: { search: '' },
    FormData: FakeFormData,
    URLSearchParams,
  });

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
    '/api/plugins/pico.usage/report',
  ]);

  const catalogRequest = requests[0];
  const reportRequest = requests[1];
  if (!catalogRequest || !reportRequest) throw new Error('Expected catalog and report requests');
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
    '<div class="card">Input tokens<strong>10</strong><span class="coverage">Partial · 1/2 calls</span></div>',
  );
  expect(html).toContain('Token totals include reported values only; missing values are excluded, never estimated.');
  expect(html).toContain('<div class="card">Estimated cost<strong>unknown</strong>');
  expect(html).not.toMatch(/<input[^>]+name="(?:projectId|threadId)"/);
  expect(html).not.toContain('>thread-1<');
  expect(html).not.toContain('>project-1<');

  const projectSelect = root.querySelector('[name="projectId"]') as { value: string };
  projectSelect.value = 'project-2';
  listeners.get('projectId:change')?.({ currentTarget: projectSelect });
  expect(html).toContain('<option value="thread-2" >Build notes</option>');
  expect(html.match(/<select name="threadId">.*?<\/select>/)?.[0]).not.toContain('thread-1');
  expect(requests.at(-1)?.path).toBe('/api/plugins/pico.usage/report?projectId=project-2');

  fields.provider!.value = 'provider-b';
  fields.from!.value = '2026-10-01';
  listeners.get('submit')?.({ preventDefault() {}, currentTarget: form });
  expect(requests.at(-1)?.path).toBe(
    '/api/plugins/pico.usage/report?projectId=project-2&provider=provider-b&from=2026-10-01',
  );
});
