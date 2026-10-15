import type { PicoPlugin, PluginContext } from './host.js';
import type { Thread } from '../core/types.js';
import type { ProjectionInput } from '../runtime/stages.js';

type CollaborationServices = Pick<PluginContext, 'threads'>;
type SpawnIndex = Record<string, { threadId: string; prompt: string; createdAt: string }>;

function readSpawnIndex(get: PluginContext['state']['get']): SpawnIndex {
  const value = get<unknown>('spawn-index', {});
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as SpawnIndex) : {};
}

function childThreads(threads: CollaborationServices['threads'], parent: Thread): Thread[] {
  return threads
    .list(parent.projectId)
    .filter((thread) => thread.parentThreadId === parent.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function displayChildren(children: Thread[]): string {
  if (children.length === 0) return 'No child Threads have been created.';
  return children
    .map((thread) => `- ${thread.title} (${thread.id}) — ${thread.state}, ${thread.executorLabel}`)
    .join('\n');
}

export const collaborationPlugin: PicoPlugin = {
  id: 'pico.collaboration',
  name: 'Thread collaboration',
  version: '0.2.0',
  pipelinePriority: { projection: 60 },
  activate({ tools, pipelines, commands, ui, http, state, ...context }) {
    const { threads } = context as typeof context & CollaborationServices;
    pipelines.use<ProjectionInput, ProjectionInput>('projection', async (input, next) =>
      next({
        ...input,
        systemPrompt:
          `${input.systemPrompt}\n\n## Child Thread collaboration\nUse child Threads for bounded work that can proceed independently. ` +
          'Spawning returns immediately; continue useful work in this Thread instead of waiting. Children are ordinary Threads that send and receive regular messages. ' +
          'Read their state and canonical messages with the normal Thread tools, then ask follow-up questions with send_thread_message. A message to a paused Thread is queued, but it will not resume until a user continues it. Do not assume files or uncommitted changes are shared between Executors.',
      }),
    );

    tools.register(
      {
        name: 'spawn_thread',
        description:
          'Create a child Thread in the current Project, send it a bounded task, and return immediately without waiting for it.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', minLength: 1 },
            title: { type: 'string' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
      async (args, toolContext) => {
        const parent = toolContext.thread;
        if (!parent) throw new Error('Thread context is missing');
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) throw new Error('Child Thread prompt is required');
        if (prompt.length > 20_000) throw new Error('Child Thread prompt must be at most 20,000 characters');
        const title =
          (typeof args.title === 'string' ? args.title.trim() : '') ||
          prompt.replace(/\s+/g, ' ').slice(0, 60) ||
          'Child Thread';
        if (title.length > 120) throw new Error('Child Thread title must be at most 120 characters');

        const stableKey = toolContext.executionId;
        const index = readSpawnIndex(state.get);
        const previous = index[stableKey];
        let child = previous ? threads.get(previous.threadId) : null;
        if (!child) {
          const binding = threads.binding(parent.id);
          const taskKey = `spawn:${parent.id}:${stableKey}`;
          child = threads.create(parent.projectId, parent.executorKind, title, {
            parentThreadId: parent.id,
            createdByAgent: true,
            idempotencyKey: taskKey,
            ...(binding?.remoteConnectionId ? { remoteConnectionId: binding.remoteConnectionId } : {}),
            ...(parent.executorRemote ? { workspacePath: parent.workspacePath } : {}),
          });
          state.transaction(() => {
            const current = readSpawnIndex(state.get);
            state.set('spawn-index', {
              ...current,
              [stableKey]: { threadId: child!.id, prompt, createdAt: new Date().toISOString() },
            });
          });
        } else if (previous?.prompt !== prompt) {
          throw new Error('This tool execution ID was already used to spawn a different task');
        }

        // Re-delivery with this stable message ID is safe if the process stops after
        // creating the child but before Runtime accepts the initial message.
        const delivery = threads.send(parent.id, child.id, prompt, `${stableKey}:child-message`);
        return {
          threadId: child.id,
          title: child.title,
          state: child.state,
          executor: child.executorLabel,
          initialMessageDelivered: delivery.delivered,
        };
      },
    );

    tools.register(
      {
        name: 'send_thread_message',
        description:
          'Send a normal message to another Thread in this Project, including a parent or child. Delivery does not wait for a reply or resume paused Threads.',
        parameters: {
          type: 'object',
          properties: {
            thread_id: { type: 'string', minLength: 1 },
            message: { type: 'string', minLength: 1 },
          },
          required: ['thread_id', 'message'],
          additionalProperties: false,
        },
      },
      async (args, toolContext) => {
        const sender = toolContext.thread;
        if (!sender) throw new Error('Thread context is missing');
        const targetId = typeof args.thread_id === 'string' ? args.thread_id.trim() : '';
        const content = typeof args.message === 'string' ? args.message.trim() : '';
        if (!targetId || !content) throw new Error('thread_id and message are required');
        if (content.length > 20_000) throw new Error('Message must be at most 20,000 characters');
        const target = threads.get(targetId);
        if (!target || target.projectId !== sender.projectId) {
          throw new Error('Target Thread must belong to the same Project');
        }
        if (target.id === sender.id) throw new Error('Cannot send a message to the current Thread');
        return threads.send(sender.id, target.id, content, `${toolContext.executionId}:message`);
      },
    );

    tools.register(
      {
        name: 'list_child_threads',
        description: 'List the current Thread’s child Threads and their current state.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      async (_args, toolContext) => {
        const parent = toolContext.thread;
        if (!parent) throw new Error('Thread context is missing');
        return childThreads(threads, parent).map((thread) => ({
          threadId: thread.id,
          title: thread.title,
          state: thread.state,
          pauseReason: thread.pauseReason,
          executor: thread.executorLabel,
          createdAt: thread.createdAt,
        }));
      },
    );

    tools.register(
      {
        name: 'read_thread_history',
        description:
          'Read recent ordinary Canonical History records from another Thread in this Project. Use it to inspect a child Thread result; this does not wait for or change that Thread.',
        parameters: {
          type: 'object',
          properties: {
            thread_id: { type: 'string', minLength: 1 },
            after_seq: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: ['thread_id'],
          additionalProperties: false,
        },
      },
      (args, toolContext) => {
        const sender = toolContext.thread;
        if (!sender) throw new Error('Thread context is missing');
        const targetId = typeof args.thread_id === 'string' ? args.thread_id.trim() : '';
        const target = threads.get(targetId);
        if (!target || target.projectId !== sender.projectId)
          throw new Error('Target Thread must belong to the same Project');
        const afterSeq =
          typeof args.after_seq === 'number' && Number.isSafeInteger(args.after_seq) && args.after_seq >= 0
            ? args.after_seq
            : undefined;
        const requestedLimit = typeof args.limit === 'number' && Number.isSafeInteger(args.limit) ? args.limit : 50;
        if (requestedLimit < 1 || requestedLimit > 100) throw new Error('limit must be between 1 and 100');
        const records = context.canonical.read(target.id, {
          ...(afterSeq === undefined ? {} : { afterSeq }),
          limit: requestedLimit,
        });
        return {
          threadId: target.id,
          title: target.title,
          state: target.state,
          records: records.map((record) => ({
            seq: record.seq,
            kind: record.kind,
            createdAt: record.createdAt,
            payload: record.payload,
          })),
        };
      },
    );

    commands.register({
      name: 'children',
      description: 'List child Threads for the current Thread.',
      execute(_args, commandContext) {
        if (!commandContext.thread) return { text: 'Choose a Thread first.' };
        return { text: displayChildren(childThreads(threads, commandContext.thread)) };
      },
    });

    http.register('GET', '/threads', ({ query }) => {
      const threadId = query.get('threadId') ?? '';
      const parent = threads.get(threadId);
      if (!parent) throw new Error('Thread not found');
      return { parentThreadId: parent.id, children: childThreads(threads, parent) };
    });
    http.register('POST', '/threads/message', ({ body }) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid message request');
      const request = body as Record<string, unknown>;
      const parent = threads.get(typeof request.parentThreadId === 'string' ? request.parentThreadId : '');
      const child = threads.get(typeof request.childThreadId === 'string' ? request.childThreadId : '');
      const content = typeof request.message === 'string' ? request.message.trim() : '';
      const operationId = typeof request.operationId === 'string' ? request.operationId.trim() : '';
      if (!parent || !child || child.parentThreadId !== parent.id || child.projectId !== parent.projectId)
        throw new Error('Child Thread does not belong to this parent');
      if (!content || content.length > 20_000) throw new Error('Message must contain 1 to 20,000 characters');
      if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(operationId)) throw new Error('A valid operationId is required');
      return threads.send(parent.id, child.id, content, `collaboration-ui:${operationId}`);
    });
    http.register('POST', '/threads/state', ({ body }) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid Thread state request');
      const request = body as Record<string, unknown>;
      const parent = threads.get(typeof request.parentThreadId === 'string' ? request.parentThreadId : '');
      const child = threads.get(typeof request.childThreadId === 'string' ? request.childThreadId : '');
      if (!parent || !child || child.parentThreadId !== parent.id || child.projectId !== parent.projectId)
        throw new Error('Child Thread does not belong to this parent');
      if (request.action === 'pause') return threads.pause(child.id, 'Paused from parent collaboration panel');
      if (request.action === 'resume') return threads.resume(child.id);
      throw new Error('Action must be pause or resume');
    });

    ui.contribute({
      slot: 'thread.toolbar',
      id: 'collaboration',
      label: 'Child Threads',
      description: 'Inspect and open collaborating child Threads.',
      entry: 'webui',
      component: 'CollaborationPanel',
      supportsPopover: true,
    });
  },
};
