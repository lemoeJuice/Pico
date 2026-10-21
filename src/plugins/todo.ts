import { randomUUID } from 'node:crypto';
import type { Thread } from '../core/types.js';
import type { PicoPlugin, PluginContext, PluginHttpRequest } from './host.js';
import type { ProjectionInput } from '../runtime/stages.js';

export type TodoStatus = 'open' | 'done';
export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  createdAt: string;
  completedAt: string | null;
  createdBy: 'agent' | 'user';
  sourceMessageSeq: number | null;
  nextAction?: string;
  priority: number;
  goalId?: string;
  updatedAt: string;
}
interface TodoOperation {
  operationId: string;
  result: unknown;
}
interface ThreadTodos {
  items: TodoItem[];
  operations: TodoOperation[];
}
type TodoState = Record<string, ThreadTodos>;
type TodoToolContext = Parameters<Parameters<PluginContext['tools']['register']>[1]>[1];

const MAX_OPEN_TODOS = 20;
const MAX_TITLE = 240;
const MAX_NEXT_ACTION = 500;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function readThreadTodos(state: PluginContext['state'], threadId: string): ThreadTodos {
  const all = object(state.get<unknown>('byThread', {})) as TodoState;
  const value = object(all[threadId]);
  return {
    items: Array.isArray(value.items) ? value.items.filter(isTodoItem) : [],
    operations: Array.isArray(value.operations) ? value.operations.filter(isOperation) : [],
  };
}
function isTodoItem(value: unknown): value is TodoItem {
  const item = object(value);
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    (item.status === 'open' || item.status === 'done') &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string' &&
    (item.completedAt === null || typeof item.completedAt === 'string') &&
    (item.createdBy === 'agent' || item.createdBy === 'user') &&
    (item.sourceMessageSeq === null || Number.isSafeInteger(item.sourceMessageSeq)) &&
    Number.isFinite(item.priority)
  );
}
function isOperation(value: unknown): value is TodoOperation {
  const item = object(value);
  return typeof item.operationId === 'string';
}
function latestUserMessageSeq(canonical: PluginContext['canonical'], threadId: string): number | null {
  const record = canonical
    .list(threadId)
    .findLast((item) => item.kind === 'message' && object(item.payload).role === 'user');
  return record?.seq ?? null;
}
function persist(
  state: PluginContext['state'],
  canonical: PluginContext['canonical'],
  threadId: string,
  next: ThreadTodos,
  audit: Record<string, unknown>,
): void {
  state.transaction(() => {
    const all = object(state.get<unknown>('byThread', {})) as TodoState;
    state.transaction(() => {
      state.set('byThread', { ...all, [threadId]: next });
      canonical.append(threadId, { action: 'todo.updated', ...audit });
    });
  });
}
function titleArg(args: Record<string, unknown>): string {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) throw new Error('Todo title is required.');
  if (title.length > MAX_TITLE) throw new Error(`Todo title must be ${MAX_TITLE} characters or fewer.`);
  return title;
}
function operationId(args: Record<string, unknown>, context: TodoToolContext): string {
  const supplied = typeof args.operation_id === 'string' ? args.operation_id.trim() : '';
  return supplied || context.executionId;
}
function priorOperation(items: ThreadTodos, id: string): unknown | undefined {
  return items.operations.find((item) => item.operationId === id)?.result;
}
function recordOperation(items: ThreadTodos, id: string, result: unknown): TodoOperation[] {
  return [...items.operations.filter((item) => item.operationId !== id), { operationId: id, result }].slice(-500);
}
function contextThread(context: TodoToolContext): Thread {
  if (!context.thread) throw new Error('Thread context is not available.');
  return context.thread;
}

function addTodo(
  state: PluginContext['state'],
  canonical: PluginContext['canonical'],
  thread: Thread,
  args: Record<string, unknown>,
  createdBy: TodoItem['createdBy'],
  fallbackOperationId: string,
): unknown {
  const todos = readThreadTodos(state, thread.id);
  const opId = (typeof args.operation_id === 'string' && args.operation_id.trim()) || fallbackOperationId;
  const previous = priorOperation(todos, opId);
  if (previous !== undefined) return previous;
  const openCount = todos.items.filter((item) => item.status === 'open').length;
  if (openCount >= MAX_OPEN_TODOS) throw new Error(`A Thread may have at most ${MAX_OPEN_TODOS} open Todos.`);
  const now = new Date().toISOString();
  const priority =
    typeof args.priority === 'number' && Number.isFinite(args.priority)
      ? Math.max(0, Math.min(5, Math.round(args.priority)))
      : 3;
  const nextAction = typeof args.next_action === 'string' ? args.next_action.trim().slice(0, MAX_NEXT_ACTION) : '';
  const goalId = typeof args.goal_id === 'string' && args.goal_id.trim() ? args.goal_id.trim() : undefined;
  const item: TodoItem = {
    id: randomUUID(),
    title: titleArg(args),
    status: 'open',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    createdBy,
    sourceMessageSeq: latestUserMessageSeq(canonical, thread.id),
    priority,
    ...(nextAction ? { nextAction } : {}),
    ...(goalId ? { goalId } : {}),
  };
  const result = { item, created: true };
  const next = { items: [...todos.items, item], operations: recordOperation(todos, opId, result) };
  persist(state, canonical, thread.id, next, {
    threadId: thread.id,
    operation: 'add',
    todoId: item.id,
    title: item.title,
    sourceMessageSeq: item.sourceMessageSeq,
  });
  return result;
}
function updateTodo(
  state: PluginContext['state'],
  canonical: PluginContext['canonical'],
  thread: Thread,
  args: Record<string, unknown>,
  fallbackOperationId: string,
  statusChange?: TodoStatus,
): unknown {
  const todos = readThreadTodos(state, thread.id);
  const opId = (typeof args.operation_id === 'string' && args.operation_id.trim()) || fallbackOperationId;
  const previous = priorOperation(todos, opId);
  if (previous !== undefined) return previous;
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const index = todos.items.findIndex((item) => item.id === id);
  if (!id || index < 0) throw new Error('Todo item was not found in this Thread.');
  const item = todos.items[index]!;
  const now = new Date().toISOString();
  let updated: TodoItem;
  if (statusChange) {
    updated =
      item.status === statusChange
        ? item
        : { ...item, status: statusChange, completedAt: statusChange === 'done' ? now : null, updatedAt: now };
  } else {
    const title = args.title === undefined ? item.title : titleArg(args);
    const nextAction =
      args.next_action === undefined
        ? item.nextAction
        : typeof args.next_action === 'string'
          ? args.next_action.trim().slice(0, MAX_NEXT_ACTION)
          : '';
    const priority =
      args.priority === undefined
        ? item.priority
        : typeof args.priority === 'number' && Number.isFinite(args.priority)
          ? Math.max(0, Math.min(5, Math.round(args.priority)))
          : item.priority;
    const { nextAction: _previousNextAction, ...withoutNextAction } = item;
    updated = { ...withoutNextAction, title, updatedAt: now, priority, ...(nextAction ? { nextAction } : {}) };
  }
  const nextItems = [...todos.items];
  nextItems[index] = updated;
  const result = { item: updated, updated: true };
  persist(
    state,
    canonical,
    thread.id,
    { items: nextItems, operations: recordOperation(todos, opId, result) },
    {
      threadId: thread.id,
      operation: statusChange === 'done' ? 'complete' : statusChange === 'open' ? 'reopen' : 'update',
      todoId: id,
      status: updated.status,
      title: updated.title,
    },
  );
  return result;
}

export function formatOpenTodos(items: readonly TodoItem[]): string {
  const open = items
    .filter((item) => item.status === 'open')
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  if (!open.length) return '';
  const selected = open.slice(0, MAX_OPEN_TODOS);
  return [
    'Active short-term checklist for this Thread (plugin-injected context; source IDs are stable Todo IDs):',
    ...selected.map(
      (item) =>
        `- [${item.id}] ${item.title}${item.nextAction ? ` — Next: ${item.nextAction}` : ''} (priority ${item.priority}/5)`,
    ),
    open.length > selected.length ? `- ${open.length - selected.length} lower-priority open items omitted.` : '',
    'Update items as work changes and mark each completed item done. This checklist is separate from the durable Goal.',
  ]
    .filter(Boolean)
    .join('\n');
}

export const todoPlugin: PicoPlugin = {
  id: 'pico.todo',
  name: 'Todo',
  version: '0.1.0',
  pipelinePriority: { projection: 30 },
  activate(context) {
    const { tools, pipelines, commands, http, state, canonical } = context;
    const list = (threadId: string) => {
      const todos = readThreadTodos(state, threadId);
      return { items: todos.items, openCount: todos.items.filter((item) => item.status === 'open').length };
    };
    tools.register(
      {
        name: 'todo_list',
        description: 'List the current Thread’s open and completed Todo items.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      (_args, toolContext) => list(contextThread(toolContext).id),
    );
    tools.register(
      {
        name: 'todo_add',
        description: 'Add a short-term action to this Thread’s Todo list when useful. Retry-safe with operation_id.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: MAX_TITLE },
            next_action: { type: 'string', maxLength: MAX_NEXT_ACTION },
            priority: { type: 'integer', minimum: 0, maximum: 5 },
            goal_id: { type: 'string' },
            operation_id: { type: 'string' },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
      (args, toolContext) =>
        addTodo(state, canonical, contextThread(toolContext), args, 'agent', operationId(args, toolContext)),
    );
    tools.register(
      {
        name: 'todo_update',
        description: 'Update a Todo title, next action, or priority without deleting its history.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string', maxLength: MAX_TITLE },
            next_action: { type: 'string', maxLength: MAX_NEXT_ACTION },
            priority: { type: 'integer', minimum: 0, maximum: 5 },
            operation_id: { type: 'string' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      (args, toolContext) =>
        updateTodo(state, canonical, contextThread(toolContext), args, operationId(args, toolContext)),
    );
    tools.register(
      {
        name: 'todo_complete',
        description: 'Mark a completed Todo item done; completed items remain available in history.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' }, operation_id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      (args, toolContext) =>
        updateTodo(state, canonical, contextThread(toolContext), args, operationId(args, toolContext), 'done'),
    );

    pipelines.use<ProjectionInput, ProjectionInput>('projection', async (input, next) => {
      const items = readThreadTodos(state, input.thread.id).items;
      const text = formatOpenTodos(items);
      if (!text) return next(input);
      const turnIndex = input.turns.length;
      const provenance = (input.provenance ?? []).concat(
        items
          .filter((item) => item.status === 'open')
          .map((item) => ({
            id: `pico.todo:${item.id}`,
            sourcePluginId: 'pico.todo',
            label: `Open Todo: ${item.title}`,
            kind: 'plugin' as const,
            disposition: 'raw' as const,
            turnIndex,
            ...(item.sourceMessageSeq === null
              ? {}
              : { canonicalStartSeq: item.sourceMessageSeq, canonicalEndSeq: item.sourceMessageSeq }),
            reason: 'The active Thread checklist guides this Model Input.',
          })),
      );
      return next({ ...input, turns: [...input.turns, { kind: 'message', role: 'user', content: text }], provenance });
    });

    http.register('GET', '/threads', ({ query }) => {
      const threadId = query.get('threadId')?.trim();
      if (!threadId) throw new Error('threadId is required.');
      return list(threadId);
    });
    http.register('POST', '/items', ({ body }: PluginHttpRequest) => {
      const input = object(body);
      const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : '';
      if (!threadId) throw new Error('threadId is required.');
      const thread = { id: threadId } as Thread;
      return addTodo(
        state,
        canonical,
        thread,
        input,
        'user',
        typeof input.operationId === 'string' ? input.operationId : randomUUID(),
      );
    });
    http.register('PATCH', '/items', ({ body }: PluginHttpRequest) => {
      const input = object(body);
      const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : '';
      if (!threadId) throw new Error('threadId is required.');
      return updateTodo(
        state,
        canonical,
        { id: threadId } as Thread,
        {
          id: input.id,
          title: input.title,
          next_action: input.nextAction,
          priority: input.priority,
          operation_id: input.operationId,
        },
        typeof input.operationId === 'string' ? input.operationId : randomUUID(),
        input.status === 'done' || input.status === 'open' ? input.status : undefined,
      );
    });
    commands.register({
      name: 'todo',
      description: 'Open the Todo panel for this Thread.',
      execute(_args, commandContext) {
        if (!commandContext.thread) return { text: 'Choose a Thread first.' };
        const todos = list(commandContext.thread.id);
        return {
          text: todos.items.length
            ? todos.items.map((item) => `${item.status === 'done' ? '[x]' : '[ ]'} ${item.title}`).join('\n')
            : 'No Todo items yet.',
        };
      },
    });
  },
};
