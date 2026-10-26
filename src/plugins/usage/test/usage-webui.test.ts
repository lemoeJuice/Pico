import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { validatePluginUiTree } from '../../../plugins/ui-protocol.js';

function createHarness(viewType: 'page' | 'component' = 'component') {
  const summarySource = readFileSync(
    new URL('../../../../plugins/pico.usage/webui/usage-summary.js', import.meta.url),
    'utf8',
  );
  const source = readFileSync(new URL('../../../../plugins/pico.usage/webui/usage.js', import.meta.url), 'utf8');
  let tree: any[] = [];
  let onWindowMessage: ((event: any) => void) | undefined;
  const parent = {};
  const requests: Array<Record<string, any>> = [];
  const port = {
    onmessage: undefined as ((event: { data: any }) => void) | undefined,
    postMessage(message: Record<string, any>) {
      if (message.type === 'pico:plugin-ui:render') tree = message.tree;
      if (message.type === 'pico:plugin-ui:request') requests.push(message);
    },
    start() {},
  };
  const globals = {
    document: {},
    window: {
      PicoUsageSummary: {
        formatUsageSummary: () => ({
          input: '0',
          output: '0',
          cached: '0',
          cacheRate: 'unknown',
          cacheCoverage: 'No data',
        }),
      },
      parent,
      addEventListener(_type: string, listener: (event: any) => void) {
        onWindowMessage = listener;
      },
    },
    location: { search: '' },
    URLSearchParams,
    Intl,
    Date,
    queueMicrotask,
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
      viewType,
      viewId: viewType === 'component' ? 'ComposerUsage' : 'Usage',
      context: { thread: { id: 'thread-a' } },
    },
    ports: [port],
  });
  const sendContext = (threadId?: string) =>
    port.onmessage?.({
      data: { type: 'pico:plugin-ui:context', context: threadId ? { thread: { id: threadId } } : { thread: null } },
    });
  const respond = (request: Record<string, any>, value: unknown) =>
    port.onmessage?.({ data: { type: 'pico:plugin-ui:response', id: request.id, ok: true, value } });
  const reject = (request: Record<string, any>) =>
    port.onmessage?.({ data: { type: 'pico:plugin-ui:response', id: request.id, ok: false, error: 'stale failure' } });
  const action = (actionId: string, value?: string) =>
    port.onmessage?.({ data: { type: 'pico:plugin-ui:action', actionId, ...(value === undefined ? {} : { value }) } });
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  return {
    get tree() {
      return tree;
    },
    requests,
    sendContext,
    respond,
    reject,
    action,
    flush,
  };
}

const treeText = (tree: unknown) => JSON.stringify(tree);

it('keeps Composer Usage on the current Thread when reports finish out of order', async () => {
  const h = createHarness();
  const firstA = h.requests[0];
  if (!firstA) throw new Error('Expected initial Thread A report');
  h.sendContext('thread-b');
  const reportB = h.requests[1];
  if (!reportB) throw new Error('Expected Thread B report');
  h.respond(reportB, { totals: { inputTokens: 222, outputTokens: 1, cachedInputTokens: 0 }, coverage: {}, rows: [] });
  await h.flush();
  expect(treeText(h.tree)).toContain('In 222');
  h.respond(firstA, { totals: { inputTokens: 111, outputTokens: 1, cachedInputTokens: 0 }, coverage: {}, rows: [] });
  await h.flush();
  expect(treeText(h.tree)).toContain('In 222');
  expect(treeText(h.tree)).not.toContain('In 111');
});

it('ignores stale failures and same-Thread refreshes, and clears the host tree when Thread context disappears', async () => {
  const h = createHarness();
  const firstA = h.requests[0]!;
  h.sendContext('thread-b');
  const reportB = h.requests[1]!;
  h.respond(reportB, { totals: { inputTokens: 222, outputTokens: 1, cachedInputTokens: 0 }, coverage: {}, rows: [] });
  await h.flush();
  h.reject(firstA);
  await h.flush();
  expect(treeText(h.tree)).toContain('In 222');

  h.sendContext('thread-b');
  const older = h.requests[2]!;
  h.sendContext('thread-b');
  const newer = h.requests[3]!;
  h.respond(newer, { totals: { inputTokens: 333, outputTokens: 1, cachedInputTokens: 0 }, coverage: {}, rows: [] });
  await h.flush();
  h.respond(older, { totals: { inputTokens: 444, outputTokens: 1, cachedInputTokens: 0 }, coverage: {}, rows: [] });
  await h.flush();
  expect(treeText(h.tree)).toContain('In 333');
  expect(treeText(h.tree)).not.toContain('In 444');
  h.sendContext('thread-b');
  const beforeClear = h.requests[4]!;
  h.sendContext();
  expect(h.tree).toEqual([]);
  h.respond(beforeClear, {
    totals: { inputTokens: 555, outputTokens: 1, cachedInputTokens: 0 },
    coverage: {},
    rows: [],
  });
  await h.flush();
  expect(h.tree).toEqual([]);
});

it('renders Usage filters as plain tree data and refreshes reports through host actions', async () => {
  const h = createHarness('page');
  const catalog = h.requests.find((request) => request.path.endsWith('/catalog'))!;
  const options = h.requests.find((request) => request.path.endsWith('/options'))!;
  const report = h.requests.find((request) => request.path.endsWith('/report'))!;
  h.respond(catalog, {
    projects: [{ id: 'project-1', name: 'Garden project' }],
    threads: [{ id: 'thread-1', projectId: 'project-1', title: 'Planning session' }],
  });
  h.respond(options, { providerModels: [], purposes: [] });
  h.respond(report, {
    totals: { inputTokens: 10, outputTokens: 2 },
    rows: [],
    coverage: {},
    groups: { thread: [], project: [], provider: [], model: [], purpose: [], day: [] },
    rates: [],
    limitations: [],
  });
  await h.flush();
  const serialized = treeText(h.tree);
  expect(serialized).toContain('Garden project');
  expect(serialized).toContain('Planning session');
  expect(serialized).toContain('Apply filters');
  expect(serialized).not.toContain('<select');

  h.action('filter.projectId', 'project-1');
  await h.flush();
  h.action('apply-filters');
  await h.flush();
  expect(h.requests.at(-1)?.path).toBe('/api/plugins/pico.usage/report?projectId=project-1');
  expect(h.requests.at(-1)?.action).toBe('api');
});

it('restores the Usage overview layout and keeps 300-call pages within host tree limits', async () => {
  const h = createHarness('page');
  const reportRequest = h.requests.find((request) => request.path.endsWith('/report'));
  if (!reportRequest) throw new Error('Expected the initial Usage report request');
  const rows = Array.from({ length: 317 }, (_, index) => ({
    createdAt: new Date(Date.UTC(2026, 9, 22, 0, index)).toISOString(),
    kind: 'main',
    purpose: 'chat',
    provider: 'chatgpt-plan',
    model: 'gpt-6-luna',
    threadId: 'thread-a',
    status: 'completed',
    usage: { inputTokens: 200, outputTokens: 40, cachedInputTokens: 120 },
    estimatedCost: 0.0004,
    currency: 'USD',
    attempts: [{ outcome: 'completed', model: 'gpt-6-luna' }],
  }));
  h.respond(reportRequest, {
    rows,
    totals: { inputTokens: 63_400, outputTokens: 12_680, cachedInputTokens: 38_040 },
    coverage: {},
    counts: { completedMainCalls: rows.length, auxiliaryCalls: 0 },
    groups: {
      thread: [
        {
          key: 'thread-a',
          count: rows.length,
          totals: { inputTokens: 63_400, outputTokens: 12_680 },
          coverage: {
            inputTokens: { reported: rows.length, total: rows.length },
            outputTokens: { reported: rows.length, total: rows.length },
          },
        },
      ],
      project: [],
      provider: [],
      model: [],
      purpose: [],
      day: [],
    },
    rates: [],
    limitations: [],
  });
  await h.flush();

  const table = () => h.tree.find((node) => node.type === 'table');
  const groups = h.tree.filter((node) => node.type === 'group');
  expect(validatePluginUiTree(h.tree, 'settings.page')).toBe(true);
  expect(groups.some((node) => node.layout === 'grid-2')).toBe(true);
  expect(groups.some((node) => node.layout === 'grid-standard')).toBe(true);
  expect(groups.some((node) => node.layout === 'masonry')).toBe(true);
  expect(treeText(h.tree)).toContain('Input tokens');
  expect(treeText(h.tree)).toContain('By Thread');
  const breakdown = groups.find((node) => node.layout === 'grid-standard');
  expect(JSON.stringify(breakdown)).toContain('"type":"card"');
  expect(JSON.stringify(breakdown)).toContain('63,400 in / 12,680 out');
  expect(JSON.stringify(breakdown)).toContain('Known · 317/317 calls');
  expect(table()?.rows).toHaveLength(300);
  expect(treeText(h.tree)).toContain('Showing 1–300 of 317 calls.');

  h.action('model-calls.next');
  expect(table()?.rows).toHaveLength(17);
  expect(treeText(h.tree)).toContain('Showing 301–317 of 317 calls.');
  h.action('model-calls.previous');
  expect(table()?.rows).toHaveLength(300);
  expect(treeText(h.tree)).toContain('Showing 1–300 of 317 calls.');
});
