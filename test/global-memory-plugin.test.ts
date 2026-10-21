import { describe, expect, it } from 'vitest';
import type { CanonicalRecord, Thread } from '../src/core/types.js';
import type { PluginContext } from '../src/plugins/host.js';
import {
  globalMemoryPlugin,
  selectRelevantGlobalMemories,
  type GlobalMemoryItem,
} from '../src/plugins/global-memory.js';
import type { ProjectionInput } from '../src/runtime/stages.js';
import { setupRuntime, response } from './helpers.js';

function harness() {
  const values = new Map<string, unknown>();
  const records = new Map<string, CanonicalRecord[]>();
  const tools = new Map<
    string,
    (args: Record<string, unknown>, context: { executionId: string; thread?: Thread }) => unknown
  >();
  const routes = new Map<string, (request: { body: unknown; query: URLSearchParams }) => unknown>();
  let failCanonicalAppend = false;
  let project:
    | ((input: ProjectionInput, next: (input: ProjectionInput) => Promise<ProjectionInput>) => Promise<ProjectionInput>)
    | null = null;
  const thread = { id: 'thread-1' } as Thread;
  const otherThread = { id: 'thread-2' } as Thread;
  const context = {
    threads: {
      get(id: string) {
        return id === thread.id ? thread : id === otherThread.id ? otherThread : null;
      },
    },
    tools: {
      register(
        definition: { name: string },
        execute: (args: Record<string, unknown>, toolContext: { executionId: string; thread?: Thread }) => unknown,
      ) {
        tools.set(definition.name, execute);
      },
    },
    pipelines: {
      use(_stage: string, interceptor: typeof project) {
        project = interceptor;
      },
    },
    ui: { registerPage() {} },
    http: {
      register(method: string, path: string, handler: (request: { body: unknown; query: URLSearchParams }) => unknown) {
        routes.set(`${method} ${path}`, handler);
      },
    },
    state: {
      get<T>(key: string, fallback: T): T {
        return (values.has(key) ? values.get(key) : fallback) as T;
      },
      set<T>(key: string, value: T) {
        values.set(key, structuredClone(value));
      },
      transaction<T>(run: () => T): T {
        const previous = new Map(values);
        const previousRecords = new Map([...records].map(([key, list]) => [key, [...list]]));
        try {
          return run();
        } catch (error) {
          values.clear();
          for (const [key, value] of previous) values.set(key, value);
          records.clear();
          for (const [key, list] of previousRecords) records.set(key, list);
          throw error;
        }
      },
    },
    canonical: {
      append(threadId: string, payload: Record<string, unknown>) {
        if (failCanonicalAppend) throw new Error('simulated audit failure');
        const list = records.get(threadId) ?? [];
        const record = {
          id: `record-${list.length + 1}`,
          threadId,
          seq: list.length + 1,
          kind: 'plugin',
          payload,
          createdAt: new Date().toISOString(),
        } as CanonicalRecord;
        records.set(threadId, [...list, record]);
        return record;
      },
      list(threadId: string) {
        return records.get(threadId) ?? [];
      },
    },
  } as unknown as PluginContext;
  const userMessage = (content: string, seq = 1) =>
    records.set(thread.id, [
      {
        id: 'user-1',
        threadId: thread.id,
        seq,
        kind: 'message',
        payload: { role: 'user', content, source: 'user' },
        createdAt: new Date().toISOString(),
      } as CanonicalRecord,
    ]);
  globalMemoryPlugin.activate?.(context);
  const runTool = (name: string, args: Record<string, unknown>, toolThread: Thread = thread) => {
    const implementation = tools.get(name);
    if (!implementation) throw new Error(`Tool not found: ${name}`);
    return implementation(args, { executionId: `exec-${name}`, thread: toolThread });
  };
  return {
    context,
    thread,
    records,
    tools,
    routes,
    runTool,
    userMessage,
    setFailCanonicalAppend(value: boolean) {
      failCanonicalAppend = value;
    },
    getProjection: () => project,
  };
}

describe('Global Memory plugin', () => {
  it('stores no-Thread Settings edits as replayable Global Canonical state', async () => {
    const env = await setupRuntime(
      {
        async complete() {
          return response();
        },
      },
      { plugins: [globalMemoryPlugin] },
    );
    try {
      const route = env.runtime.pluginHttpRoute('pico.global-memory', 'POST', '/items');
      expect(route).toBeDefined();
      const saved = (await route!.handler({
        body: { text: 'Prefers concise written responses.', category: 'preference' },
        query: new URLSearchParams(),
        origin: null,
      })) as { item: GlobalMemoryItem };
      const globalFacts = env.store.listScopedCanonical('workflow:global');
      expect(JSON.stringify(globalFacts)).toContain(saved.item.text);
      expect(
        globalFacts.every((record) => record.threadId === null && Number.isSafeInteger(record.seq) && record.seq > 0),
      ).toBe(true);
      env.store.db.exec("DELETE FROM plugin_state WHERE plugin_id = 'pico.global-memory';");
      env.store.rebuildWorkflowViews();
      const restored = (await env.runtime.pluginHttpRoute('pico.global-memory', 'GET', '/items')!.handler({
        body: null,
        query: new URLSearchParams(),
        origin: null,
      })) as { items: GlobalMemoryItem[] };
      expect(restored.items).toMatchObject([{ id: saved.item.id, text: saved.item.text }]);
    } finally {
      await env.cleanup();
    }
  });

  it('rolls back Global Memory state when its Thread audit append fails', () => {
    const env = harness();
    env.userMessage('Please remember I prefer concise replies.');
    env.setFailCanonicalAppend(true);
    expect(() => env.runTool('memory_save', { text: 'Prefers concise replies.', category: 'preference' })).toThrow(
      'simulated audit failure',
    );
    expect(env.context.state.get('memory', {})).toEqual({});
    expect(env.records.get(env.thread.id)).toHaveLength(1);
  });

  it('lets the agent search, save, and replace cross-project memories with verifiable sources', () => {
    const env = harness();
    env.userMessage('Please remember that I prefer concise Chinese replies.');
    const saved = env.runTool('memory_save', {
      text: 'Prefers concise Chinese replies.',
      category: 'preference',
      applicability: 'All conversations',
    }) as { item: GlobalMemoryItem };
    expect(saved.item.scope).toBe('global');
    expect(saved.item.sources).toMatchObject([{ threadId: env.thread.id, seq: 1 }]);
    expect(env.runTool('memory_search', { query: 'Chinese replies' })).toMatchObject({
      items: [{ id: saved.item.id }],
    });
    const replacement = env.runTool('memory_replace', {
      id: saved.item.id,
      text: 'Prefers concise Chinese unless a detailed explanation is requested.',
      category: 'preference',
    }) as { item: GlobalMemoryItem };
    expect(replacement.item.supersedes).toEqual([saved.item.id]);
    expect(env.runTool('memory_search', { query: 'concise Chinese' })).toMatchObject({
      items: [{ id: replacement.item.id }],
    });
    expect(
      env.records
        .get(env.thread.id)
        ?.filter((record) => record.kind === 'plugin')
        .map((record) => (record.payload as { action: string }).action),
    ).toEqual(['memory.added', 'memory.replaced']);
  });

  it('projects only relevant and pinned memories and respects the automatic-memory switch', async () => {
    const env = harness();
    env.userMessage('Help me write a TypeScript test.');
    const first = env.runTool('memory_save', { text: 'Uses TypeScript for tests.', category: 'fact' }) as {
      item: GlobalMemoryItem;
    };
    env.runTool('memory_save', { text: 'Prefers dark blue dashboards.', category: 'preference', pinned: true });
    env.runTool('memory_save', { text: 'Keeps sourdough starter in the kitchen.', category: 'fact' });
    const base: ProjectionInput = {
      thread: env.thread,
      records: [],
      through: 0,
      systemPrompt: 'base',
      turns: [{ kind: 'message', role: 'user', content: 'Help me write a TypeScript test.' }],
      tools: [],
    };
    const invoke = async () => env.getProjection()!(base, async (input) => input);
    const projected = await invoke();
    expect(projected.turns.at(-1)?.kind === 'message' && projected.turns.at(-1)?.content).toContain(first.item.id);
    expect(projected.turns.at(-1)?.kind === 'message' && projected.turns.at(-1)?.content).toContain(
      'dark blue dashboards',
    );
    expect(projected.turns.at(-1)?.kind === 'message' && projected.turns.at(-1)?.content).not.toContain('sourdough');
    expect(projected.provenance).toMatchObject([{ sourcePluginId: 'pico.global-memory', disposition: 'raw' }]);
    env.routes.get('PUT /settings')!({ body: { autoEnabled: false }, query: new URLSearchParams() });
    expect((await invoke()).turns).toHaveLength(1);
  });

  it('provides manual CRUD, pinning, source checks, and rejects unsupported or forbidden writes', () => {
    const env = harness();
    const created = env.routes.get('POST /items')!({
      body: { text: 'Uses a local-first workflow.', category: 'collaboration', confidence: 1 },
      query: new URLSearchParams(),
    }) as { item: GlobalMemoryItem };
    env.routes.get('PATCH /items')!({ body: { id: created.item.id, pinned: true }, query: new URLSearchParams() });
    expect(env.routes.get('GET /items')!({ body: null, query: new URLSearchParams() })).toMatchObject({
      items: [{ id: created.item.id, pinned: true }],
    });
    expect(() => env.runTool('memory_save', { text: 'api_key: hidden value' })).toThrow(/Credentials and secrets/);
    env.userMessage('Please do not remember this private preference.');
    expect(() => env.runTool('memory_save', { text: 'A private preference' })).toThrow(/asked not to save/);
    env.userMessage('Please save a general fact.');
    expect(() => env.runTool('memory_save', { text: 'Good fact', sources: [{ threadId: 'missing', seq: 1 }] })).toThrow(
      /Thread was not found/,
    );
    env.routes.get('DELETE /items')!({ body: { id: created.item.id }, query: new URLSearchParams() });
    expect(env.routes.get('GET /items')!({ body: null, query: new URLSearchParams() })).toMatchObject({ items: [] });
  });

  it('keeps projection selection bounded and excludes superseded items', () => {
    const now = new Date().toISOString();
    const items = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index}`,
      scope: 'global' as const,
      text: `TypeScript preference ${index}`,
      category: 'preference' as const,
      applicability: '',
      confidence: 1,
      pinned: index === 11,
      sources: [],
      supersedes: [],
      supersededBy: index === 10 ? 'new' : null,
      createdAt: now,
      updatedAt: now,
    }));
    expect(selectRelevantGlobalMemories(items, 'TypeScript', 100)).toHaveLength(8);
    expect(selectRelevantGlobalMemories(items, 'TypeScript').some((item) => item.id === 'm10')).toBe(false);
    expect(selectRelevantGlobalMemories(items, 'unrelated')).toMatchObject([{ id: 'm11', pinned: true }]);
  });
});
