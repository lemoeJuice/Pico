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
    charactersPerToken: '3',
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
    charactersPerToken: 3,
  });
  expect(JSON.stringify(tree)).not.toContain('Move cold');
  port.onmessage?.({ data: { type: 'pico:plugin-ui:context', context: { thread: { id: 'thread-b' } } } });
  await flush();
  expect(requests.some((request) => request.path.endsWith('/economics?threadId=thread-b'))).toBe(true);
});
