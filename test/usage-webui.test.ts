import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('initializes the Usage page with an active Thread and requests its report', async () => {
  const source = readFileSync(new URL('../plugins/pico.usage/webui/usage.js', import.meta.url), 'utf8');
  const fields = {
    threadId: { value: '' },
    projectId: { value: '' },
    provider: { value: '' },
    model: { value: '' },
    purpose: { value: '' },
    from: { value: '' },
    to: { value: '' },
  };
  type SubmitEvent = { preventDefault(): void; currentTarget: unknown };
  let submitFilters: ((event: SubmitEvent) => void) | undefined;
  let rendered = false;
  const root = {
    set innerHTML(value: string) {
      rendered = true;
      for (const name of Object.keys(fields)) {
        const match = value.match(new RegExp(`<input\\s+name="${name}"[^>]*value="([^"]*)"`));
        fields[name as keyof typeof fields].value = match?.[1] ?? '';
      }
    },
    querySelector(selector: string) {
      if (!rendered) return null;
      const fieldMatch = selector.match(/^\[name="([^"]+)"\]$/);
      if (fieldMatch) return fields[fieldMatch[1] as keyof typeof fields];
      if (selector === '#filters') {
        return {
          addEventListener(_type: string, listener: (event: SubmitEvent) => void) {
            submitFilters = listener;
          },
        };
      }
      return { addEventListener() {} };
    },
    querySelectorAll() {
      return [];
    },
  };
  let onWindowMessage: ((event: unknown) => void) | undefined;
  const parent = {};
  const requests: Array<Record<string, unknown>> = [];
  const port = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    postMessage(message: Record<string, unknown>) {
      requests.push(message);
    },
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

  expect(onWindowMessage).toBeTypeOf('function');
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

  expect(fields).toMatchObject({ threadId: { value: 'thread-1' }, projectId: { value: 'project-1' } });
  expect(requests[0]).toMatchObject({
    type: 'pico:plugin-ui:request',
    action: 'api',
    path: '/api/plugins/pico.usage/report?threadId=thread-1&projectId=project-1',
  });

  const reportRequest = requests.at(0);
  if (!reportRequest) throw new Error('Expected Usage report request');

  port.onmessage?.({
    data: {
      type: 'pico:plugin-ui:response',
      id: reportRequest.id,
      ok: true,
      value: {
        rows: [],
        totals: {},
        counts: {},
        groups: { thread: [], project: [], provider: [], model: [], purpose: [], day: [] },
        rates: [],
        limitations: [],
      },
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(rendered).toBe(true);
  expect(fields).toMatchObject({
    threadId: { value: 'thread-1' },
    projectId: { value: 'project-1' },
  });

  fields.provider.value = 'anthropic';
  fields.from.value = '2026-10-01';
  submitFilters?.({ preventDefault() {}, currentTarget: {} });
  const filteredRequest = requests.at(-1);
  if (!filteredRequest) throw new Error('Expected filtered Usage report request');
  expect(filteredRequest.path).toBe(
    '/api/plugins/pico.usage/report?threadId=thread-1&projectId=project-1&provider=anthropic&from=2026-10-01',
  );
  expect(fields.provider.value).toBe('anthropic');
  expect(fields.from.value).toBe('2026-10-01');
});
