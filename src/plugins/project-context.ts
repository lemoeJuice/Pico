import { randomUUID } from 'node:crypto';
import type { CanonicalRecord, Thread } from '../core/types.js';
import type { ProjectionInput, ProjectionProvenance } from '../contracts/plugin-pipeline.js';
import type { PicoPlugin, PluginContext, PluginHttpRequest } from './host.js';

export type ProjectMemoryCategory = 'fact' | 'decision' | 'activity' | 'open-issue';
export type ProjectMemoryStatus = 'active' | 'conflicted' | 'expired';
export interface ProjectMemoryEntry {
  id: string;
  projectId: string;
  category: ProjectMemoryCategory;
  text: string;
  source: 'agent' | 'manual' | 'legacy';
  sourceThreadId: string | null;
  sourceSeq: number | null;
  confidence: 'high' | 'medium' | 'low';
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  supersedes: string[];
  status: ProjectMemoryStatus;
  pinned: boolean;
  operationId?: string;
}
interface ProjectMemoryState {
  entries: ProjectMemoryEntry[];
}
const MAX_ENTRIES = 1000;
const MAX_ENTRY_TEXT = 4000;
const MAX_PROJECTION_CHARS = 4800;
const PROJECT_KEYWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'when',
  'where',
  'which',
  'while',
  'have',
  'will',
  'would',
  'should',
  'could',
  'about',
  'your',
  'their',
  'then',
  'than',
  'there',
  'here',
  'using',
  'use',
  'need',
  'want',
  'please',
  'current',
  'thread',
  'project',
  '任务',
  '这个',
  '我们',
  '请你',
  '可以',
  '进行',
  '已经',
  '需要',
  '一下',
]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function validCategory(value: unknown): value is ProjectMemoryCategory {
  return value === 'fact' || value === 'decision' || value === 'activity' || value === 'open-issue';
}
function validEntry(value: unknown): value is ProjectMemoryEntry {
  const entry = object(value);
  return (
    typeof entry.id === 'string' &&
    typeof entry.projectId === 'string' &&
    validCategory(entry.category) &&
    typeof entry.text === 'string' &&
    ['agent', 'manual', 'legacy'].includes(String(entry.source)) &&
    (entry.sourceThreadId === null || typeof entry.sourceThreadId === 'string') &&
    (entry.sourceSeq === null || Number.isSafeInteger(entry.sourceSeq)) &&
    ['high', 'medium', 'low'].includes(String(entry.confidence)) &&
    typeof entry.createdAt === 'string' &&
    typeof entry.updatedAt === 'string' &&
    (entry.expiresAt === null || typeof entry.expiresAt === 'string') &&
    Array.isArray(entry.supersedes) &&
    ['active', 'conflicted', 'expired'].includes(String(entry.status)) &&
    typeof entry.pinned === 'boolean'
  );
}
function readState(context: PluginContext): ProjectMemoryState {
  const value = object(context.state.get<unknown>('memory', { entries: [] }));
  return { entries: Array.isArray(value.entries) ? value.entries.filter(validEntry) : [] };
}
function save(context: PluginContext, state: ProjectMemoryState): void {
  context.state.set('memory', { entries: state.entries.slice(-MAX_ENTRIES) });
}
function audit(
  context: PluginContext,
  threadId: string,
  action: string,
  details: Record<string, unknown>,
): CanonicalRecord {
  return context.canonical.append(threadId, { plugin: 'pico.project-context', action, ...details });
}
function latestUserSource(context: PluginContext, threadId: string): number | null {
  const record = context.canonical.list(threadId).findLast((item) => {
    const payload = object(item.payload);
    return item.kind === 'message' && payload.role === 'user';
  });
  return record?.seq ?? null;
}
function migrateLegacy(context: PluginContext, projectId: string): ProjectMemoryEntry[] {
  const legacy = object(context.state.get<unknown>('byProject', {}))[projectId];
  const value = object(legacy);
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (!text) return [];
  const revision = Number.isSafeInteger(value.revision) ? Number(value.revision) : 0;
  const existing = readState(context).entries.find((entry) => entry.id === `legacy:${projectId}:${revision}`);
  if (existing) return [];
  const source = context.threads
    .list(projectId)
    .flatMap((thread) =>
      context.canonical
        .list(thread.id)
        .filter(
          (record) =>
            record.kind === 'plugin' &&
            object(record.payload).action === 'project-context.updated' &&
            object(record.payload).projectId === projectId,
        ),
    )
    .sort((a, b) => b.seq - a.seq)[0];
  const entry: ProjectMemoryEntry = {
    id: `legacy:${projectId}:${revision}`,
    projectId,
    category: 'fact',
    text,
    source: 'legacy',
    sourceThreadId: source?.threadId ?? null,
    sourceSeq: source?.seq ?? null,
    confidence: 'medium',
    createdAt: source?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: null,
    supersedes: [],
    status: 'active',
    pinned: false,
  };
  const memory = readState(context);
  save(context, { entries: [...memory.entries, entry] });
  return [entry];
}
function entriesForProject(context: PluginContext, projectId: string): ProjectMemoryEntry[] {
  migrateLegacy(context, projectId);
  return readState(context).entries.filter((entry) => entry.projectId === projectId);
}
function normalizeText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Memory text is required.');
  const text = value.trim();
  if (text.length > MAX_ENTRY_TEXT) throw new Error(`Memory text must be ${MAX_ENTRY_TEXT} characters or fewer.`);
  return text;
}
function sourceSeq(context: PluginContext, threadId: string, args: Record<string, unknown>): number | null {
  if (Number.isSafeInteger(args.source_seq) && Number(args.source_seq) >= 0) {
    const seq = Number(args.source_seq);
    if (!context.canonical.list(threadId).some((record) => record.seq === seq))
      throw new Error('source_seq must refer to a Canonical record in this Thread.');
    return seq;
  }
  return latestUserSource(context, threadId);
}
function wordSet(text: string): Set<string> {
  return new Set(
    (text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((word) => !PROJECT_KEYWORDS.has(word)),
  );
}
function relevance(text: string, query: string): number {
  const terms = wordSet(query);
  if (!terms.size) return 0;
  const words = wordSet(text);
  let hits = 0;
  for (const word of terms) if (words.has(word)) hits++;
  return hits / Math.sqrt(terms.size);
}
function currentQuery(input: ProjectionInput): string {
  const latest = [...input.records]
    .reverse()
    .find((record) => record.kind === 'message' && object(record.payload).role === 'user');
  const payload = object(latest?.payload);
  const body = typeof payload.content === 'string' ? payload.content : '';
  return `${input.thread.title}\n${body}`.slice(0, 5000);
}
export function selectProjectMemories(
  entries: readonly ProjectMemoryEntry[],
  query: string,
  now = Date.now(),
): ProjectMemoryEntry[] {
  const active = entries.filter(
    (entry) => entry.status !== 'expired' && (!entry.expiresAt || Date.parse(entry.expiresAt) > now),
  );
  const scored = active.map((entry) => ({ entry, score: relevance(`${entry.text} ${entry.category}`, query) }));
  const eligible = scored.filter(({ entry, score }) => entry.pinned || score > 0);
  return eligible
    .sort(
      (a, b) =>
        Number(b.entry.pinned) - Number(a.entry.pinned) ||
        b.score - a.score ||
        b.entry.updatedAt.localeCompare(a.entry.updatedAt),
    )
    .slice(0, 12)
    .map(({ entry }) => entry);
}
export function formatProjectMemory(
  entries: readonly ProjectMemoryEntry[],
  budget = MAX_PROJECTION_CHARS,
): { text: string; entries: ProjectMemoryEntry[] } {
  const intro =
    '## Relevant Project Memory\nOnly use these sourced notes when relevant; newer or conflicting evidence should take precedence.\n\n';
  const groups: Array<[ProjectMemoryCategory, string]> = [
    ['fact', 'Stable facts'],
    ['decision', 'Decisions'],
    ['activity', 'Recent project activity'],
    ['open-issue', 'Open issues'],
  ];
  const selected: ProjectMemoryEntry[] = [];
  const sections: string[] = [];
  let remaining = Math.max(0, budget - intro.length);
  for (const [category, heading] of groups) {
    const items = entries.filter((entry) => entry.category === category);
    if (!items.length || remaining <= 0) continue;
    const lines: string[] = [];
    const headingCost = heading.length + 1 + (sections.length ? 2 : 0);
    for (const entry of items) {
      const source = entry.sourceThreadId
        ? `source ${entry.sourceThreadId}${entry.sourceSeq === null ? '' : `#${entry.sourceSeq}`}`
        : 'manual/legacy source';
      const line = `- [${entry.id}] ${entry.text} (${source}; ${entry.confidence} confidence${entry.expiresAt ? `; expires ${entry.expiresAt}` : ''}${entry.status === 'conflicted' ? '; conflict needs review' : ''})`;
      const cost = line.length + 1 + (lines.length === 0 ? headingCost : 0);
      if (cost > remaining) continue;
      lines.push(line);
      remaining -= cost;
      selected.push(entry);
    }
    if (lines.length) sections.push(`${heading}:\n${lines.join('\n')}`);
  }
  return { text: sections.length ? `${intro}${sections.join('\n\n')}` : '', entries: selected };
}

export const projectContextPlugin: PicoPlugin = {
  id: 'pico.project-context',
  name: 'Project Context',
  version: '0.2.0',
  defaultToolsEnabled: true,
  pipelinePriority: { projection: 40 },
  activate(context) {
    const { tools, pipelines, commands, ui, http, threads } = context;
    const projectOfThread = (threadId: string): Thread => {
      const thread = threads.get(threadId);
      if (!thread) throw new Error('Thread not found.');
      if (!thread.projectId) throw new Error('This Thread is not attached to a Project.');
      return thread;
    };
    const list = (projectId: string, query = '') => {
      const items = entriesForProject(context, projectId).filter(
        (entry) => !query.trim() || relevance(entry.text, query) > 0 || entry.id.includes(query),
      );
      return items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    };
    const add = (thread: Thread, args: Record<string, unknown>, source: ProjectMemoryEntry['source'] = 'agent') => {
      const text = normalizeText(args.text);
      const category = validCategory(args.category) ? args.category : null;
      if (!category) throw new Error('category must be fact, decision, activity, or open-issue.');
      const memory = readState(context);
      const operationId = typeof args.operation_id === 'string' ? args.operation_id.trim() : '';
      if (operationId) {
        const duplicate = memory.entries.find(
          (entry) => entry.projectId === thread.projectId && entry.operationId === operationId,
        );
        if (duplicate) return duplicate;
      }
      const supersedes = Array.isArray(args.supersedes)
        ? args.supersedes.filter((item): item is string => typeof item === 'string')
        : [];
      const now = new Date().toISOString();
      const entry: ProjectMemoryEntry = {
        id: randomUUID(),
        projectId: thread.projectId,
        category,
        text,
        source,
        sourceThreadId: thread.id,
        sourceSeq: sourceSeq(context, thread.id, args),
        confidence: args.confidence === 'low' || args.confidence === 'medium' ? args.confidence : 'high',
        createdAt: now,
        updatedAt: now,
        expiresAt:
          typeof args.expires_at === 'string' && Number.isFinite(Date.parse(args.expires_at))
            ? new Date(args.expires_at).toISOString()
            : null,
        supersedes: [...new Set(supersedes)].slice(0, 20),
        status: 'active',
        pinned: false,
        ...(operationId ? { operationId } : {}),
      };
      const updatedEntries = memory.entries.map((existing) =>
        entry.supersedes.includes(existing.id) && existing.projectId === entry.projectId
          ? { ...existing, status: 'conflicted' as const, updatedAt: now }
          : existing,
      );
      context.state.transaction(() => {
        save(context, { entries: [...updatedEntries, entry] });
        audit(context, thread.id, 'memory.recorded', {
          projectId: thread.projectId,
          entryId: entry.id,
          category,
          sourceSeq: entry.sourceSeq,
          supersedes: entry.supersedes,
        });
      });
      return entry;
    };
    tools.register(
      {
        name: 'project_memory_record',
        description:
          'Record a durable Project fact, decision, activity, or open issue after an important milestone. Keep it concise, source-grounded, and scoped to this Project. Use operation_id for retry safety; use supersedes when correcting older notes.',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: ['fact', 'decision', 'activity', 'open-issue'] },
            text: { type: 'string', maxLength: MAX_ENTRY_TEXT },
            source_seq: { type: 'integer', minimum: 1 },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            expires_at: { type: 'string' },
            supersedes: { type: 'array', items: { type: 'string' }, maxItems: 20 },
            operation_id: { type: 'string' },
          },
          required: ['category', 'text'],
          additionalProperties: false,
        },
      },
      (args, toolContext) => {
        if (!toolContext.thread) throw new Error('Thread context is not available.');
        const thread = projectOfThread(toolContext.thread.id);
        return add(thread, { ...args, operation_id: args.operation_id ?? toolContext.executionId });
      },
    );
    tools.register(
      {
        name: 'project_memory_search',
        description: 'Search active Project Memory entries relevant to the current Project.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
      (args, toolContext) => {
        if (!toolContext.thread) throw new Error('Thread context is not available.');
        const thread = projectOfThread(toolContext.thread.id);
        const query = typeof args.query === 'string' ? args.query : '';
        return list(thread.projectId, query)
          .filter((entry) => entry.status !== 'expired')
          .slice(0, 30);
      },
    );

    pipelines.use('projection', async (input, next) => {
      if (!input.thread.projectId) return next(input);
      const query = currentQuery(input);
      const selected = selectProjectMemories(entriesForProject(context, input.thread.projectId), query);
      const formatted = formatProjectMemory(selected);
      if (!formatted.text) return next(input);
      const turnIndex = input.turns.length;
      const provenance: ProjectionProvenance[] = [
        ...(input.provenance ?? []),
        ...formatted.entries.map((entry): ProjectionProvenance => ({
          id: `pico.project-context:${entry.id}`,
          sourcePluginId: 'pico.project-context',
          label: `Project ${entry.category}: ${entry.text.slice(0, 100)}`,
          kind: 'plugin',
          disposition: 'raw',
          turnIndex,
          ...(entry.sourceSeq === null ? {} : { canonicalStartSeq: entry.sourceSeq, canonicalEndSeq: entry.sourceSeq }),
          reason: entry.pinned
            ? 'Pinned Project Memory.'
            : 'Lexically relevant to this Thread and current user request.',
        })),
      ];
      return next({
        ...input,
        turns: [...input.turns, { kind: 'message', role: 'user', content: formatted.text }],
        provenance,
      });
    });

    const patchEntry = (projectId: string, entryId: string, patch: Record<string, unknown>): ProjectMemoryEntry => {
      const memory = readState(context);
      const index = memory.entries.findIndex((entry) => entry.projectId === projectId && entry.id === entryId);
      if (index < 0) throw new Error('Project Memory entry not found.');
      const previous = memory.entries[index]!;
      const next: ProjectMemoryEntry = {
        ...previous,
        ...(typeof patch.text === 'string' ? { text: normalizeText(patch.text) } : {}),
        ...(validCategory(patch.category) ? { category: patch.category } : {}),
        ...(typeof patch.pinned === 'boolean' ? { pinned: patch.pinned } : {}),
        ...(patch.status === 'active' || patch.status === 'conflicted' || patch.status === 'expired'
          ? { status: patch.status }
          : {}),
        ...(patch.expiresAt === null || typeof patch.expiresAt === 'string' ? { expiresAt: patch.expiresAt } : {}),
        updatedAt: new Date().toISOString(),
      };
      const entries = [...memory.entries];
      entries[index] = next;
      context.state.transaction(() => {
        save(context, { entries });
        if (previous.sourceThreadId)
          audit(context, previous.sourceThreadId, 'memory.updated', { projectId, entryId, fields: Object.keys(patch) });
      });
      return next;
    };
    http.register('GET', '/memory', ({ query }) => {
      const projectId = query.get('projectId')?.trim();
      if (!projectId) throw new Error('projectId is required.');
      return { entries: list(projectId, query.get('q') ?? '') };
    });
    http.register('POST', '/memory', ({ body }: PluginHttpRequest) => {
      const input = object(body);
      const threadId = typeof input.threadId === 'string' ? input.threadId : '';
      const thread = projectOfThread(threadId);
      return add(thread, { ...input, operation_id: input.operationId ?? randomUUID() }, 'manual');
    });
    http.register('PATCH', '/memory', ({ body }: PluginHttpRequest) => {
      const input = object(body);
      const projectId = typeof input.projectId === 'string' ? input.projectId : '';
      const entryId = typeof input.id === 'string' ? input.id : '';
      if (!projectId || !entryId) throw new Error('projectId and id are required.');
      return patchEntry(projectId, entryId, input);
    });
    http.register('DELETE', '/memory', ({ body }: PluginHttpRequest) => {
      const input = object(body);
      const projectId = typeof input.projectId === 'string' ? input.projectId : '';
      const entryId = typeof input.id === 'string' ? input.id : '';
      const memory = readState(context);
      const entry = memory.entries.find((candidate) => candidate.projectId === projectId && candidate.id === entryId);
      if (!entry) throw new Error('Project Memory entry not found.');
      context.state.transaction(() => {
        save(context, {
          entries: memory.entries.filter((candidate) => candidate.id !== entryId || candidate.projectId !== projectId),
        });
        if (entry.sourceThreadId) audit(context, entry.sourceThreadId, 'memory.deleted', { projectId, entryId });
      });
      return { deleted: true, id: entryId };
    });

    commands.register({
      name: 'project-context',
      description: 'View or update shared memory for this Project.',
      execute(_args, commandContext) {
        if (!commandContext.thread || !commandContext.projectId) return { text: 'Choose a Project Thread first.' };
        const currentThread = commandContext.thread;
        const currentProjectId = commandContext.projectId;
        const raw = commandContext.rawArgs.trim();
        if (!raw)
          return {
            text:
              list(commandContext.projectId)
                .map((entry) => `[${entry.category}] ${entry.text}`)
                .join('\n') ||
              'No Project Memory entries are relevant yet. Use the Project Context panel or project_memory_record.',
          };
        if (raw.toLowerCase() === 'clear') {
          const memory = readState(context);
          const removed = memory.entries.filter(
            (entry) => entry.projectId === currentProjectId && entry.source !== 'agent',
          );
          context.state.transaction(() => {
            save(context, {
              entries: memory.entries.filter(
                (entry) => entry.projectId !== currentProjectId || entry.source === 'agent',
              ),
            });
            const legacyContexts = object(context.state.get<unknown>('byProject', {}));
            const legacyValue = object(legacyContexts[currentProjectId]);
            context.state.set('byProject', {
              ...legacyContexts,
              [currentProjectId]: {
                text: '',
                revision: (Number.isSafeInteger(legacyValue.revision) ? Number(legacyValue.revision) : 0) + 1,
              },
            });
            audit(context, currentThread.id, 'legacy-context.cleared', {
              projectId: currentProjectId,
              removed: removed.length,
            });
          });
          return {
            text: `Manual Project Context cleared (${removed.length} entries). Agent-maintained Project Memory remains.`,
          };
        }
        const match = /^set(?:[ \t]+|\r?\n+)([\s\S]*)$/i.exec(raw);
        if (!match?.[1]?.trim())
          return {
            text: 'Use /project-context to view, /project-context set followed by text, or /project-context clear.',
          };
        const item = add(
          commandContext.thread,
          { category: 'fact', text: match[1], operation_id: randomUUID() },
          'manual',
        );
        return { text: `Project context saved as manual memory (${item.id}).` };
      },
    });
    ui.contribute({
      slot: 'thread.toolbar',
      id: 'project-context',
      label: 'Project Memory',
      description: 'Browse and manage shared Project Memory.',
      entry: 'webui',
      component: 'ProjectContextPanel',
      supportsPopover: true,
    });
  },
};
