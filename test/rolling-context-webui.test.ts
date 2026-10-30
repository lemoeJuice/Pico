import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('edits the selected thread cost assumptions without exposing legacy cold actions', async () => {
  let onWindowMessage: ((event: any) => void) | undefined;
  let tree: unknown[] = [];
  const parent = {};
  const requests: Array<Record<string, any>> = [];
  const port = {
    onmessage: undefined as ((event: { data: any }) => void) | undefined,
    postMessage(message: Record<string, any>) {
      if (message.type === 'pico:plugin-ui:render') tree = message.tree;
      if (message.type !== 'pico:plugin-ui:request') return;
      requests.push(message);
      const value = message.path.includes('/economics')
        ? { economics: message.init?.method === 'PUT' ? JSON.parse(message.init.body) : null }
        : message.path.includes('/segments?')
          ? { segments: [] }
          : { inputs: [] };
      queueMicrotask(() =>
        port.onmessage?.({ data: { type: 'pico:plugin-ui:response', id: message.id, ok: true, value } }),
      );
    },
    start() {},
  };
  runInNewContext(
    readFileSync(new URL('../plugins/pico.rolling-context/webui/rolling-context.js', import.meta.url), 'utf8'),
    {
      window: {
        parent,
        addEventListener(_type: string, callback: typeof onWindowMessage) {
          onWindowMessage = callback;
        },
      },
      queueMicrotask,
    },
  );
  onWindowMessage?.({
    source: parent,
    data: {
      type: 'pico:plugin-ui:init',
      protocolVersion: 1,
      pluginId: 'pico.rolling-context',
      entry: 'webui',
      viewType: 'component',
      viewId: 'RollingContextPanel',
      context: { thread: { id: 'thread-a' } },
    },
    ports: [port],
  });
  const flush = async () => {
    for (let n = 0; n < 12; n += 1) await Promise.resolve();
  };
  await flush();
  const action = (actionId: string, value?: string) =>
    port.onmessage?.({ data: { type: 'pico:plugin-ui:action', actionId, value } });
  for (const [key, value] of Object.entries({
    provider: 'test',
    model: 'model',
    inputPerMillion: '2',
    cachedInputPerMillion: '0.1',
    cacheWritePerMillion: '2.5',
    expectedFutureCalls: '10',
  }))
    action(`economics:${key}`, value);
  action('economics:save');
  await flush();
  const update = requests.find((request) => request.path.endsWith('/economics') && request.init?.method === 'PUT');
  expect(JSON.parse(update?.init.body)).toEqual({
    threadId: 'thread-a',
    provider: 'test',
    model: 'model',
    inputPerMillion: 2,
    cachedInputPerMillion: 0.1,
    cacheWritePerMillion: 2.5,
    expectedFutureCalls: 10,
  });
  expect(JSON.stringify(tree)).not.toContain('Move cold');
  expect(JSON.stringify(tree)).not.toContain('Estimated characters per token');
  port.onmessage?.({ data: { type: 'pico:plugin-ui:context', context: { thread: { id: 'thread-b' } } } });
  await flush();
  expect(requests.some((request) => request.path.endsWith('/economics?threadId=thread-b'))).toBe(true);
});

it('keeps long history and repeated execution inputs within the host UI protocol while preserving full details', async () => {
  const { validatePluginUiTree } = await import('../src/plugins/ui-protocol.js');
  let onWindowMessage: ((event: any) => void) | undefined;
  let tree: any[] = [];
  const trees: unknown[] = [];
  const parent = {};
  const summary = 's'.repeat(25001);
  const prompt = { text: 'p'.repeat(25001) };
  const source = 'c'.repeat(25001);
  const segments = Array.from({ length: 40 }, (_, i) => ({
    id: `rc-${i}`,
    startSeq: i + 1,
    endSeq: i + 1,
    tier: 'hot',
    sourceHash: 'hash',
    summaryStatus: 'completed',
    summaryVersion: 1,
    summary,
    transitions: [],
  }));
  const inputs = Array.from({ length: 30 }, (_, i) => ({
    executionId: 'same-execution',
    attempt: { id: `request-${i}`, status: 'completed', createdAt: 'now', prompt },
  }));
  const port = {
    onmessage: undefined as ((event: { data: any }) => void) | undefined,
    postMessage(message: Record<string, any>) {
      if (message.type === 'pico:plugin-ui:render') {
        tree = message.tree;
        trees.push(tree);
      }
      if (message.type !== 'pico:plugin-ui:request') return;
      const value = message.path.includes('/segments?')
        ? { segments }
        : message.path.includes('/inputs?')
          ? { inputs }
          : message.path.includes('/source?')
            ? { source }
            : { economics: null };
      queueMicrotask(() =>
        port.onmessage?.({ data: { type: 'pico:plugin-ui:response', id: message.id, ok: true, value } }),
      );
    },
    start() {},
  };
  runInNewContext(
    readFileSync(new URL('../plugins/pico.rolling-context/webui/rolling-context.js', import.meta.url), 'utf8'),
    {
      window: {
        parent,
        addEventListener(_type: string, callback: typeof onWindowMessage) {
          onWindowMessage = callback;
        },
      },
      queueMicrotask,
    },
  );
  onWindowMessage?.({
    source: parent,
    data: {
      type: 'pico:plugin-ui:init',
      protocolVersion: 1,
      pluginId: 'pico.rolling-context',
      entry: 'webui',
      viewType: 'component',
      viewId: 'RollingContextPanel',
      context: { thread: { id: 'thread-a' } },
    },
    ports: [port],
  });
  const flush = async () => {
    for (let n = 0; n < 12; n += 1) await Promise.resolve();
  };
  const action = async (actionId: string, value?: string) => {
    port.onmessage?.({ data: { type: 'pico:plugin-ui:action', actionId, value } });
    await flush();
  };
  const find = (nodes: any[], predicate: (node: any) => boolean): any => {
    for (const node of nodes) {
      if (predicate(node)) return node;
      const found = find(node.children ?? [], predicate);
      if (found) return found;
    }
    return undefined;
  };
  await flush();
  expect(find(tree, (node) => node.actionId === 'detail:open:prompt:1')).toBeDefined();
  const readDetail = async (key: string, expected: string) => {
    await action(`detail:open:${key}`, 'true');
    let reconstructed = '';
    for (let page = 0; page < Math.ceil(expected.length / 8000); page += 1) {
      const node = find(tree, (item) => item.actionId === `detail:open:${key}`);
      reconstructed += node.children[0].text;
      if (page + 1 < Math.ceil(expected.length / 8000)) await action('detail:next');
    }
    expect(reconstructed).toBe(expected);
  };
  await readDetail('summary:0', summary);
  await readDetail('source:0', source);
  await readDetail('prompt:0', JSON.stringify(prompt, null, 2));
  await action('page:segments:next');
  await action('page:inputs:next');
  expect(trees.every((value) => validatePluginUiTree(value, 'thread.toolbar'))).toBe(true);
});
