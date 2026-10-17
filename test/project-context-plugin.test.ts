import { describe, expect, it } from 'vitest';
import type { CanonicalRecord, Thread, UiContribution } from '../src/core/types.js';
import type { PluginContext } from '../src/plugins/host.js';
import { formatProjectMemory, projectContextPlugin, selectProjectMemories } from '../src/plugins/project-context.js';
import type { ProjectionInput } from '../src/runtime/stages.js';

function harness() {
  const values = new Map<string, unknown>();
  const records = new Map<string, CanonicalRecord[]>();
  const tools = new Map<
    string,
    (args: Record<string, unknown>, context: { executionId: string; thread?: Thread }) => unknown
  >();
  const contributions: UiContribution[] = [];
  const routes = new Map<string, (request: { body: unknown; query: URLSearchParams }) => unknown>();
  const commands = new Map<
    string,
    {
      execute: (
        args: string[],
        context: { thread: Thread | null; projectId: string | null; rawArgs: string },
      ) => unknown;
    }
  >();
  let project:
    | ((input: ProjectionInput, next: (input: ProjectionInput) => Promise<ProjectionInput>) => Promise<ProjectionInput>)
    | null = null;
  const threads = [
    { id: 'thread-a', projectId: 'project-a', title: 'Pico runtime', state: 'idle' },
    { id: 'thread-b', projectId: 'project-b', title: 'Other project', state: 'idle' },
  ] as Thread[];
  const context = {
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
    commands: {
      register(command: {
        name: string;
        execute: (
          args: string[],
          context: { thread: Thread | null; projectId: string | null; rawArgs: string },
        ) => unknown;
      }) {
        commands.set(command.name, command);
      },
    },
    ui: {
      contribute(contribution: UiContribution) {
        contributions.push(contribution);
      },
    },
    http: {
      register(method: string, path: string, handler: (request: { body: unknown; query: URLSearchParams }) => unknown) {
        routes.set(`${method} ${path}`, handler);
      },
    },
    threads: {
      get(id: string) {
        return threads.find((thread) => thread.id === id) ?? null;
      },
      list(projectId?: string) {
        return projectId ? threads.filter((thread) => thread.projectId === projectId) : threads;
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
        return run();
      },
    },
    canonical: {
      append(threadId: string, payload: Record<string, unknown>) {
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
      read(threadId: string) {
        return records.get(threadId) ?? [];
      },
      subscribe() {
        return () => undefined;
      },
    },
  } as unknown as PluginContext;
  projectContextPlugin.activate?.(context);
  const runTool = (
    name: string,
    args: Record<string, unknown>,
    thread = threads[0]!,
    executionId = `exec-${Math.random()}`,
  ) => {
    const implementation = tools.get(name);
    if (!implementation) throw new Error(`Tool not found: ${name}`);
    return implementation(args, { executionId, thread });
  };
  return {
    context,
    threads,
    records,
    tools,
    routes,
    commands,
    contributions,
    values,
    getProjection: () => project,
    runTool,
  };
}

describe('Project Context plugin', () => {
  it('labels its Thread toolbar contribution Project Memory', () => {
    const env = harness();
    expect(env.contributions).toEqual([
      expect.objectContaining({ slot: 'thread.toolbar', id: 'project-context', label: 'Project Memory' }),
    ]);
  });

  it('stores sourced, project-scoped notes and is idempotent on tool retries', () => {
    const env = harness();
    env.records.set('thread-a', [
      {
        id: 'user-1',
        threadId: 'thread-a',
        seq: 1,
        kind: 'message',
        payload: { role: 'user', content: 'We chose SQLite for persistence.' },
        createdAt: new Date().toISOString(),
      } as CanonicalRecord,
    ]);
    const first = env.runTool('project_memory_record', {
      category: 'decision',
      text: 'Use SQLite for durable plugin state.',
      operation_id: 'decision-1',
    }) as { id: string; sourceSeq: number };
    const retry = env.runTool('project_memory_record', {
      category: 'decision',
      text: 'Use SQLite for durable plugin state.',
      operation_id: 'decision-1',
    }) as { id: string };
    expect(retry.id).toBe(first.id);
    expect(first.sourceSeq).toBe(1);
    expect(env.runTool('project_memory_search', { query: 'SQLite' })).toMatchObject([
      { projectId: 'project-a', category: 'decision' },
    ]);
    expect(env.runTool('project_memory_search', { query: 'SQLite' }, env.threads[1])).toEqual([]);
    expect(env.records.get('thread-a')?.at(-1)?.payload).toMatchObject({
      action: 'memory.recorded',
      entryId: first.id,
    });
  });

  it('injects only relevant entries with source provenance and category sections', async () => {
    const env = harness();
    const sqlite = env.runTool('project_memory_record', {
      category: 'decision',
      text: 'Use SQLite for durable plugin state.',
    }) as { id: string };
    env.runTool('project_memory_record', { category: 'fact', text: 'The main UI uses React and Vite.' });
    const base: ProjectionInput = {
      thread: env.threads[0]!,
      records: [
        {
          id: 'user-1',
          threadId: 'thread-a',
          seq: 8,
          kind: 'message',
          payload: { role: 'user', content: 'How should SQLite store plugin records?' },
          createdAt: new Date().toISOString(),
        } as CanonicalRecord,
      ],
      through: 8,
      systemPrompt: 'base',
      turns: [],
      tools: [],
    };
    const projected = await env.getProjection()!(base, async (input) => input);
    const appended = projected.turns.at(-1);
    expect(appended?.kind === 'message' && appended.content).toContain('Use SQLite for durable plugin state.');
    expect(appended?.kind === 'message' && appended.content).not.toContain('main UI uses React');
    expect(projected.provenance).toMatchObject([
      {
        id: `pico.project-context:${sqlite.id}`,
        sourcePluginId: 'pico.project-context',
        disposition: 'raw',
        turnIndex: 0,
      },
    ]);
    expect(appended?.kind === 'message' && appended.content).toContain('Decisions:');
  });

  it('migrates legacy manual text without injecting it wholesale, and keeps clear scoped to manual entries', () => {
    const env = harness();
    env.context.state.set('byProject', {
      'project-a': { text: 'Legacy retry behavior for SQLite storage.', revision: 3 },
    });
    const migrated = env.routes.get('GET /memory')!({
      body: null,
      query: new URLSearchParams({ projectId: 'project-a' }),
    }) as { entries: Array<{ id: string; source: string }> };
    expect(migrated.entries).toMatchObject([{ id: 'legacy:project-a:3', source: 'legacy' }]);
    const legacy = migrated.entries[0]!;
    const projected = selectProjectMemories(migrated.entries as never, 'weather report');
    expect(projected).toEqual([]);
    const toolEntry = env.runTool('project_memory_record', {
      category: 'fact',
      text: 'SQLite is the project store.',
    }) as { source: string };
    expect(toolEntry.source).toBe('agent');
    const result = env.routes.get('PATCH /memory')!({
      body: { projectId: 'project-a', id: legacy.id, pinned: true },
      query: new URLSearchParams(),
    }) as { pinned: boolean };
    expect(result.pinned).toBe(true);
    env.commands
      .get('project-context')!
      .execute([], { thread: env.threads[0]!, projectId: 'project-a', rawArgs: 'clear' });
    const afterClear = env.routes.get('GET /memory')!({
      body: null,
      query: new URLSearchParams({ projectId: 'project-a' }),
    }) as { entries: Array<{ source: string }> };
    expect(afterClear.entries).toHaveLength(1);
    expect(afterClear.entries[0]?.source).toBe('agent');
  });

  it('supersedes prior entries and bounds projection text', () => {
    const env = harness();
    const first = env.runTool('project_memory_record', {
      category: 'fact',
      text: 'Runtime stores state in JSON.',
      operation_id: 'fact-1',
    }) as { id: string };
    env.runTool('project_memory_record', {
      category: 'fact',
      text: 'Runtime now stores state in SQLite.',
      supersedes: [first.id],
      operation_id: 'fact-2',
    });
    const listed = (
      env.routes.get('GET /memory')!({ body: null, query: new URLSearchParams({ projectId: 'project-a' }) }) as {
        entries: Array<{ id: string; status: string }>;
      }
    ).entries;
    expect(listed.find((entry) => entry.id === first.id)?.status).toBe('conflicted');
    const formatted = formatProjectMemory(listed as never, 120);
    expect(formatted.text.length).toBeLessThanOrEqual(120);
  });
});
