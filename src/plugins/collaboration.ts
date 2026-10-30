import type { PicoPlugin, PluginContext } from './host.js';
import type { Thread, ThreadModelSelection } from '../core/types.js';
import type { CatalogSelection, CatalogModel, AdapterContribution } from '../contracts/model-catalog.js';
import { projectThreadHistoryIo } from '../contracts/canonical-projection.js';

const THREAD_HISTORY_MAX_RESULT_CHARS = 16_000;
const THREAD_HISTORY_MAX_CHUNK_CHARS = 8_000;

function jsonChars(value: unknown): number {
  return JSON.stringify(value).length;
}

function historyRecordChunk(text: string, offset: number, requestedChars: number) {
  const points = Array.from(text);
  if (offset > points.length) throw new Error(`offset must be between 0 and ${points.length}.`);
  const chunkChars = Math.min(requestedChars, THREAD_HISTORY_MAX_CHUNK_CHARS);
  const chunk = points.slice(offset, offset + chunkChars).join('');
  const nextOffset = offset + Array.from(chunk).length;
  return {
    chunk: { offset, total_chars: points.length, text: chunk },
    next_offset: nextOffset < points.length ? nextOffset : null,
    complete: nextOffset >= points.length,
  };
}

type CollaborationServices = Pick<PluginContext, 'threads'>;
type SpawnIndex = Record<
  string,
  {
    threadId: string;
    prompt: string;
    createdAt: string;
    executorKind?: Thread['executorKind'];
    executorIdentity?: string;
    modelSelection?: CatalogSelection;
    requestedModel?: CatalogSelection | null;
    toolOverrides?: Record<string, boolean>;
  }
>;

function readSpawnIndex(get: PluginContext['state']['get']): SpawnIndex {
  const value = get<unknown>('spawn-index', {});
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as SpawnIndex) : {};
}

function childThreads(threads: CollaborationServices['threads'], parent: Thread): Thread[] {
  return threads
    .list(parent.projectId)
    .filter((thread) => thread.parentThreadId === parent.id && thread.archivedAt == null && thread.deletedAt == null)
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
  defaultToolsEnabled: true,
  pipelinePriority: { projection: 60 },
  activate({ tools, pipelines, commands, http, state, ...context }) {
    const { threads } = context as typeof context & CollaborationServices;
    const models = context.models as typeof context.models & {
      catalog(): CatalogModel[];
      matchingAdapters(modelId: string): AdapterContribution[];
      validateSelection(selection: CatalogSelection): CatalogSelection;
    };
    const stable = (value: unknown): string =>
      JSON.stringify(value, (_key, entry: unknown) =>
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
          : entry,
      );
    pipelines.use('projection', async (input, next) =>
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
          'Create a child Thread in the current Project, send it a bounded task, and return immediately without waiting for it. ' +
          'Choose a model and supported parameters appropriate to the task, following any user preferences: consider a lighter model and lower reasoning effort for straightforward work, and stronger capabilities or higher reasoning effort for complex or high-risk work. ' +
          'Use list_models to discover available models, matching adapters, and supported controls before selecting; do not guess model IDs or parameter values. ' +
          'If model is omitted, the child inherits the parent Thread’s current model selection.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', minLength: 1 },
            title: { type: 'string' },
            executor: {
              type: 'string',
              enum: ['inherit', 'runtime', 'container', 'host'],
              description:
                'Executor for the child Thread. Defaults to inherit; this preserves a parent Remote Host binding when present. Explicit host selects the local Host executor.',
            },
            model: {
              type: 'object',
              description:
                'Optional child model selection from list_models. Set parameters.options using the selected adapter’s supported controls, including reasoning effort when available; use an empty options object when no options are needed.',
              properties: {
                modelId: { type: 'string', minLength: 1 },
                adapterId: { type: 'string', minLength: 1 },
                parameters: {
                  type: 'object',
                  properties: { temperature: { type: ['number', 'null'] }, options: { type: 'object' } },
                  additionalProperties: false,
                },
              },
              required: ['modelId', 'adapterId', 'parameters'],
              additionalProperties: false,
            },
            tool_settings: {
              type: 'array',
              description:
                'Optional per-tool visibility overrides for the child Thread. Unlisted tools inherit the parent Thread settings.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 1 },
                  enabled: { type: 'boolean' },
                },
                required: ['name', 'enabled'],
                additionalProperties: false,
              },
            },
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
        const requestedExecutor = args.executor ?? 'inherit';
        if (!['inherit', 'runtime', 'container', 'host'].includes(String(requestedExecutor))) {
          throw new Error('executor must be inherit, runtime, container, or host');
        }
        const executorKind = (
          requestedExecutor === 'inherit' ? parent.executorKind : requestedExecutor
        ) as Thread['executorKind'];
        const preserveRemoteBinding = requestedExecutor === 'inherit' && parent.executorRemote;
        const sameExecutorTemplate =
          executorKind === parent.executorKind && preserveRemoteBinding === parent.executorRemote;
        const parentBinding = threads.binding(parent.id);
        const executorIdentity = stable({
          executorKind,
          remote: preserveRemoteBinding,
          remoteConnectionId: preserveRemoteBinding ? parentBinding?.remoteConnectionId ?? null : null,
        });

        const requestedToolOverrides: Record<string, boolean> = {};
        if (args.tool_settings !== undefined) {
          if (!Array.isArray(args.tool_settings) || args.tool_settings.length > 100) {
            throw new Error('tool_settings must be an array with at most 100 entries');
          }
          for (const entry of args.tool_settings) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
              throw new Error('Each tool_settings entry must contain a tool name and enabled state');
            }
            const setting = entry as Record<string, unknown>;
            const name = typeof setting.name === 'string' ? setting.name.trim() : '';
            if (!name || name.length > 200 || typeof setting.enabled !== 'boolean') {
              throw new Error('Each tool_settings entry needs a valid name and boolean enabled value');
            }
            if (Object.prototype.hasOwnProperty.call(requestedToolOverrides, name)) {
              throw new Error(`tool_settings contains duplicate entries for ${name}`);
            }
            requestedToolOverrides[name] = setting.enabled;
          }
        }
        const normalizedToolOverrides = Object.keys(requestedToolOverrides).length
          ? Object.fromEntries(
              Object.entries(requestedToolOverrides).sort(([left], [right]) => left.localeCompare(right)),
            )
          : undefined;
        if (normalizedToolOverrides) {
          const availableToolNames = new Set(
            sameExecutorTemplate
              ? (await threads.tools(parent.id)).map((tool) => tool.name)
              : await threads.toolNamesForExecutor(parent.projectId, executorKind),
          );
          const unknownTool = Object.keys(normalizedToolOverrides).find((name) => !availableToolNames.has(name));
          if (unknownTool) {
            throw new Error(
              `Tool is not available in the ${sameExecutorTemplate ? 'parent Thread' : 'target Executor'}: ${unknownTool}`,
            );
          }
        }

        let requestedModel: CatalogSelection | null = null;
        if (args.model !== undefined) {
          if (!args.model || typeof args.model !== 'object' || Array.isArray(args.model))
            throw new Error('Invalid child model selection');
          const requested = args.model as Record<string, unknown>;
          if (
            typeof requested.modelId !== 'string' ||
            !requested.modelId ||
            typeof requested.adapterId !== 'string' ||
            !requested.adapterId ||
            !requested.parameters ||
            typeof requested.parameters !== 'object' ||
            Array.isArray(requested.parameters)
          )
            throw new Error('Invalid child model selection');
          requestedModel = {
            modelId: requested.modelId,
            adapterId: requested.adapterId,
            parameters: requested.parameters as CatalogSelection['parameters'],
          };
        }
        const stableKey = toolContext.executionId;
        const index = readSpawnIndex(state.get);
        const previous = index[stableKey];
        let child = previous ? threads.get(previous.threadId) : null;
        if (previous && previous.prompt !== prompt) {
          throw new Error('This tool execution ID was already used to spawn a different task');
        }
        if (
          previous &&
          JSON.stringify(previous.toolOverrides ?? {}) !== JSON.stringify(normalizedToolOverrides ?? {})
        ) {
          throw new Error('This tool execution ID was already used with different Child Thread tool settings');
        }
        if (previous && stable(previous.requestedModel ?? null) !== stable(requestedModel))
          throw new Error('This tool execution ID was already used with a different model selection');
        const legacyExecutorIdentity = stable({
          executorKind: parent.executorKind,
          remote: parent.executorRemote,
          remoteConnectionId: parentBinding?.remoteConnectionId ?? null,
        });
        if (
          previous &&
          (previous.executorIdentity ?? legacyExecutorIdentity) !== executorIdentity
        )
          throw new Error('This tool execution ID was already used with a different executor');
        if (!child) {
          let modelSelection = previous?.modelSelection;
          if (!modelSelection) {
            modelSelection = requestedModel
              ? models.validateSelection(requestedModel)
              : structuredClone(threads.modelSelection(parent.id) as unknown as CatalogSelection);
          }
          const taskKey = `spawn:${parent.id}:${stableKey}`;
          state.transaction(() => {
            child = threads.create(parent.projectId, executorKind, title, {
              parentThreadId: parent.id,
              createdByAgent: true,
              idempotencyKey: taskKey,
              ...(preserveRemoteBinding && parentBinding?.remoteConnectionId
                ? { remoteConnectionId: parentBinding.remoteConnectionId }
                : {}),
              ...(preserveRemoteBinding ? { workspacePath: parent.workspacePath } : {}),
              modelSelection: modelSelection as unknown as ThreadModelSelection,
              inheritToolSettings: sameExecutorTemplate,
              ...(normalizedToolOverrides ? { toolOverrides: normalizedToolOverrides } : {}),
            });
            const current = readSpawnIndex(state.get);
            state.set('spawn-index', {
              ...current,
              [stableKey]: {
                threadId: child!.id,
                prompt,
                createdAt: new Date().toISOString(),
                modelSelection,
                requestedModel,
                executorKind,
                executorIdentity,
                ...(normalizedToolOverrides ? { toolOverrides: normalizedToolOverrides } : {}),
              },
            });
          });
        }
        if (!child) throw new Error('Child Thread creation failed.');

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
        name: 'list_models',
        description: 'List available models, matching adapters and their controls for choosing a child Thread model.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      () =>
        models
          .catalog()
          .filter((model) => model.availability !== 'unavailable')
          .map((model) => ({
            ...model,
            adapters: models
              .matchingAdapters(model.modelId)
              .map(({ id, label, description, controls, temperature }) => ({
                id,
                label,
                ...(description ? { description } : {}),
                controls,
                temperature,
              })),
          })),
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
        name: 'list_project_threads',
        description:
          'List visible, non-archived Threads in the current Project, newest first. Use this to discover a Thread before reading its history with read_thread_history. Results are paginated; pass offset=next_offset to continue.',
        parameters: {
          type: 'object',
          properties: {
            offset: { type: 'integer', minimum: 0, description: 'Number of Threads to skip; defaults to 0.' },
            limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum results; defaults to 50.' },
          },
          additionalProperties: false,
        },
      },
      (args, toolContext) => {
        const current = toolContext.thread;
        if (!current) throw new Error('Thread context is missing');
        const offset = args.offset === undefined ? 0 : args.offset;
        const limit = args.limit === undefined ? 50 : args.limit;
        if (!Number.isInteger(offset) || (offset as number) < 0)
          throw new Error('offset must be a non-negative integer');
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
          throw new Error('limit must be an integer between 1 and 100');
        }
        const visible = threads
          .list(current.projectId)
          .filter((thread) => thread.archivedAt == null && thread.deletedAt == null)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        const page = visible.slice(offset as number, (offset as number) + (limit as number));
        const nextOffset = (offset as number) + page.length;
        return {
          threads: page.map((thread) => ({
            threadId: thread.id,
            title: thread.title,
            state: thread.state,
            executor: thread.executorLabel,
            parentThreadId: thread.parentThreadId,
            createdAt: thread.createdAt,
          })),
          offset,
          next_offset: nextOffset < visible.length ? nextOffset : null,
          has_more: nextOffset < visible.length,
        };
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
          'Read input/output records from a Thread in this Project, indexed by Canonical seq. Omit thread_id to read the current Thread. ' +
          'Choose exactly one mode; omit unused fields entirely rather than filling defaults or null. ' +
          'PAGE mode: use after_seq and limit, for example {"after_seq":0,"limit":10}; never include record_seq, offset, or chunk_chars. ' +
          'Each page is limited to 16,000 JSON characters. Continue with next_after_seq; if a page is too large, reduce limit with the same after_seq. ' +
          'CHUNK mode: read one oversized record with record_seq, offset, and chunk_chars, for example {"record_seq":123,"offset":0,"chunk_chars":8000}; never include after_seq or limit. ' +
          'Continue that record with next_offset until it is null, then resume pages with after_seq set to that record_seq and all chunk fields omitted. ' +
          'Nested read_thread_history outputs, plugin records, and diagnostic metadata are omitted. A successful result is shown to the Model once; later requests receive a placeholder, so preserve useful findings and seq references or call again. Use the returned seq when attaching a same-Thread history reference. This does not wait for or change another Thread.',
        parameters: {
          type: 'object',
          properties: {
            thread_id: { type: 'string', minLength: 1, description: 'Omit to read the current Thread.' },
            after_seq: {
              type: 'integer',
              minimum: 0,
              description: 'PAGE mode only. Exclusive starting seq; defaults to 0. Omit in CHUNK mode.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description: 'PAGE mode only. Maximum records to scan; defaults to 50. Omit in CHUNK mode.',
            },
            record_seq: {
              type: 'integer',
              minimum: 1,
              description: 'CHUNK mode only. Exact seq of one record. Omit in PAGE mode.',
            },
            offset: {
              type: 'integer',
              minimum: 0,
              description: 'CHUNK mode only; requires record_seq. Start at 0, then use next_offset. Omit in PAGE mode.',
            },
            chunk_chars: {
              type: 'integer',
              minimum: 1,
              maximum: THREAD_HISTORY_MAX_CHUNK_CHARS,
              description: 'CHUNK mode only; requires record_seq. Defaults to 8,000 characters. Omit in PAGE mode.',
            },
          },
          additionalProperties: false,
        },
      },
      (args, toolContext) => {
        const sender = toolContext.thread;
        if (!sender) throw new Error('Thread context is missing');
        const targetId = typeof args.thread_id === 'string' ? args.thread_id.trim() : sender.id;
        const target = threads.get(targetId);
        if (!target || target.projectId !== sender.projectId)
          throw new Error('Target Thread must belong to the same Project');
        const hasAfterSeq = Object.prototype.hasOwnProperty.call(args, 'after_seq');
        if (
          hasAfterSeq &&
          (typeof args.after_seq !== 'number' || !Number.isSafeInteger(args.after_seq) || args.after_seq < 0)
        ) {
          throw new Error('after_seq must be a non-negative integer.');
        }
        const afterSeq = hasAfterSeq ? (args.after_seq as number) : undefined;
        if (
          Object.prototype.hasOwnProperty.call(args, 'limit') &&
          (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100)
        ) {
          throw new Error('limit must be between 1 and 100.');
        }
        const requestedLimit = typeof args.limit === 'number' && Number.isSafeInteger(args.limit) ? args.limit : 50;
        if (requestedLimit < 1 || requestedLimit > 100) throw new Error('limit must be between 1 and 100');
        const hasRecordSeq = Object.prototype.hasOwnProperty.call(args, 'record_seq');
        if (
          hasRecordSeq &&
          (typeof args.record_seq !== 'number' || !Number.isSafeInteger(args.record_seq) || args.record_seq < 1)
        ) {
          throw new Error('record_seq must be a positive integer.');
        }
        const recordSeq = hasRecordSeq ? (args.record_seq as number) : undefined;
        if (recordSeq !== undefined) {
          if (afterSeq !== undefined || Object.prototype.hasOwnProperty.call(args, 'limit')) {
            throw new Error(
              'Use record_seq chunk arguments separately from after_seq and limit. ' +
                'For a history page, omit record_seq, offset, and chunk_chars. For one record, omit after_seq and limit. ' +
                'Omit unused fields entirely; changing limit does not resolve this conflict.',
            );
          }
          const offset = typeof args.offset === 'number' ? args.offset : 0;
          const chunkChars = typeof args.chunk_chars === 'number' ? args.chunk_chars : THREAD_HISTORY_MAX_CHUNK_CHARS;
          if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer.');
          if (!Number.isSafeInteger(chunkChars) || chunkChars < 1 || chunkChars > THREAD_HISTORY_MAX_CHUNK_CHARS) {
            throw new Error(`chunk_chars must be between 1 and ${THREAD_HISTORY_MAX_CHUNK_CHARS}.`);
          }
          const records = context.canonical.read(target.id, { afterSeq: recordSeq - 1, limit: 2 });
          const record = records.find((candidate) => candidate.seq === recordSeq);
          if (!record) throw new Error(`Canonical record ${recordSeq} was not found.`);
          const projected = projectThreadHistoryIo([record]).records[0];
          if (!projected) throw new Error(`Canonical record ${recordSeq} has no readable input/output.`);
          const chunk = historyRecordChunk(JSON.stringify(projected), offset, chunkChars);
          return { records: [{ seq: recordSeq, ...chunk }], has_more: chunk.next_offset !== null };
        }
        if (
          Object.prototype.hasOwnProperty.call(args, 'offset') ||
          Object.prototype.hasOwnProperty.call(args, 'chunk_chars')
        ) {
          throw new Error('offset and chunk_chars require record_seq.');
        }

        const scanRecords = context.canonical.read(target.id, {
          ...(afterSeq === undefined ? {} : { afterSeq }),
          limit: requestedLimit + 1,
        });
        const pageRecords = scanRecords.slice(0, requestedLimit);
        const result = {
          records: projectThreadHistoryIo(pageRecords).records,
          next_after_seq: pageRecords.at(-1)?.seq ?? afterSeq ?? 0,
          has_more: scanRecords.length > requestedLimit,
        };
        const resultChars = jsonChars(result);
        if (resultChars > THREAD_HISTORY_MAX_RESULT_CHARS) {
          const oversized = result.records.find(
            (record) => jsonChars({ records: [record] }) > THREAD_HISTORY_MAX_RESULT_CHARS,
          );
          if (oversized) {
            throw new Error(
              `History record at seq ${oversized.seq} exceeds the ${THREAD_HISTORY_MAX_RESULT_CHARS}-character result limit by itself. Read it in chunks with record_seq=${oversized.seq}, offset=0, and chunk_chars=${THREAD_HISTORY_MAX_CHUNK_CHARS}; omit after_seq and limit. Do not retry the same page unchanged.`,
            );
          }
          throw new Error(
            `History page exceeds the ${THREAD_HISTORY_MAX_RESULT_CHARS}-character result limit. No records were returned. Retry with a smaller limit and the same starting cursor after_seq=${afterSeq ?? 0}; do not retry the same request unchanged.`,
          );
        }
        return result;
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
  },
};
