import type { Execution, Thread, UiContribution } from '../core/types.js';
import type { ProjectionInput } from '../runtime/stages.js';
import type { PicoPlugin, PluginContext } from './host.js';

type GoalStatus = 'active' | 'paused' | 'needs_input' | 'completed' | 'cleared';
interface GoalEvidence {
  kind: 'execution' | 'canonical';
  id: string;
  summary: string;
}
interface ThreadGoal {
  id: string;
  threadId: string;
  text: string;
  constraints: string;
  completionCriteria: string;
  status: GoalStatus;
  recentProgress: string;
  blocker: string;
  evidence: GoalEvidence | null;
  // Legacy persisted fields from the removed automatic step limits.
  lastObservedSeq?: number;
  stepsInSession?: number;
  stepsWithoutProgress?: number;
  createdAt: string;
  updatedAt: string;
}
type GoalMap = Record<string, ThreadGoal>;

const EMPTY_MAP: GoalMap = {};

type GoalServices = Pick<PluginContext, 'threads' | 'executions' | 'continuations'>;
interface GoalProjectionInput extends ProjectionInput {
  provenance?: Array<{
    id: string;
    sourcePluginId: string;
    label: string;
    kind: 'canonical' | 'plugin' | 'rolling_segment';
    disposition: 'raw' | 'summary' | 'omitted';
    canonicalStartSeq?: number;
    canonicalEndSeq?: number;
    summaryVersion?: string;
    turnIndex?: number;
    reason?: string;
  }>;
}

function bodyObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function goalView(
  goal: ThreadGoal | undefined,
): Omit<ThreadGoal, 'lastObservedSeq' | 'stepsInSession' | 'stepsWithoutProgress'> | null {
  if (!goal) return null;
  const {
    lastObservedSeq: _lastObservedSeq,
    stepsInSession: _stepsInSession,
    stepsWithoutProgress: _stepsWithoutProgress,
    ...view
  } = goal;
  return view;
}

function defaultGoal(
  threadId: string,
  value: { text: string; constraints: string; completionCriteria: string },
): ThreadGoal {
  const now = new Date().toISOString();
  return {
    id: `goal:${threadId}:${Date.now()}`,
    threadId,
    text: value.text,
    constraints: value.constraints,
    completionCriteria: value.completionCriteria,
    status: 'active',
    recentProgress: '',
    blocker: '',
    evidence: null,
    createdAt: now,
    updatedAt: now,
  };
}

export const goalPlugin: PicoPlugin = {
  id: 'pico.goal',
  name: 'Goal',
  version: '0.1.0',
  defaultToolsEnabled: true,
  pipelinePriority: { projection: 20 },
  activate(pluginContext) {
    const context = pluginContext as PluginContext & GoalServices;
    const { state, canonical, pipelines, tools, continuations, threads, executions, ui, http } = context;
    const readGoals = (): GoalMap => {
      const value = state.get<unknown>('goals', EMPTY_MAP);
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as GoalMap) : EMPTY_MAP;
    };
    const getGoal = (threadId: string): ThreadGoal | undefined => readGoals()[threadId];
    const save = (goal: ThreadGoal): void => state.set('goals', { ...readGoals(), [goal.threadId]: goal });
    const maxSeq = (threadId: string): number =>
      canonical.list(threadId).reduce((max, record) => Math.max(max, record.seq), 0);
    const audit = (threadId: string, action: string, details: Record<string, unknown> = {}): void => {
      canonical.append(threadId, { plugin: 'pico.goal', action, ...details });
    };
    const validateThread = (threadId: string): Thread => {
      const thread = threads.get(threadId);
      if (!thread) throw new Error('Thread not found');
      return thread;
    };

    const withStatus = (goal: ThreadGoal, status: GoalStatus, patch: Partial<ThreadGoal> = {}): ThreadGoal => ({
      ...goal,
      ...patch,
      status,
      blocker: status === 'active' ? '' : (patch.blocker ?? goal.blocker),
      updatedAt: new Date().toISOString(),
    });

    continuations.register((threadId) => {
      const goal = getGoal(threadId);
      const thread = threads.get(threadId);
      // This is a read-only scheduling predicate. The durable Goal status owns
      // continuation; model-step counts do not pause an active Goal.
      return Boolean(goal?.status === 'active' && thread && thread.state !== 'paused' && thread.state !== 'pausing');
    });

    pipelines.use<ProjectionInput, ProjectionInput>('projection', async (input, next) => {
      const goal = getGoal(input.thread.id);
      if (!goal || goal.status === 'cleared') return next(input);
      const goalInstructions = [
        '<thread_goal>',
        `Goal: ${goal.text}`,
        ...(goal.constraints ? [`Constraints: ${goal.constraints}`] : []),
        ...(goal.completionCriteria ? [`Completion criteria: ${goal.completionCriteria}`] : []),
        ...(goal.status === 'active'
          ? [
              'Work toward this Goal continuously. An active goal_checkpoint records progress; it does not finish the work. After recording an active checkpoint, continue with the next concrete action in this Thread until the completion criteria are met or an external blocker requires user input or a pause.',
              'Use needs_input or paused only when work is genuinely blocked or should wait for the user. When the completion criteria are met, call goal_checkpoint once with status=completed and put a concise completion report in progress; evidence citations are optional. If you want to attach a Canonical record, call read_thread_history without thread_id to read this Thread. In its returned records, find the original message or tool result containing the verification and copy that record’s seq into verificationRecordSeq; do not use the seq of the read_thread_history call itself or invent a reference. Do not read history just to complete the Goal. After a successful completed checkpoint, stop this Goal and give the user a concise result. If a checkpoint call fails, correct the call or continue useful work; do not repeat the same completion message while this Goal remains active.',
            ]
          : [
              `Status: ${goal.status}`,
              ...(goal.blocker ? [`Current blocker: ${goal.blocker}`] : []),
              ...(goal.status === 'needs_input'
                ? ['Pause work that depends on missing input and clearly ask the user for it.']
                : goal.status === 'paused'
                  ? ['Do not continue this Goal until the user resumes it.']
                  : ['This Goal is completed. Do not restart it unless the user asks.']),
            ]),
        '</thread_goal>',
      ].join('\n');
      const extended = input as GoalProjectionInput;
      return next({
        ...input,
        systemPrompt: `${input.systemPrompt}${input.systemPrompt ? '\n\n' : ''}${goalInstructions}`,
        provenance: [
          ...(extended.provenance ?? []),
          {
            id: goal.id,
            sourcePluginId: 'pico.goal',
            label: 'Thread Goal instructions',
            kind: 'plugin',
            disposition: 'raw',
          },
        ],
      });
    });

    tools.register(
      {
        name: 'goal_checkpoint',
        description:
          'Record meaningful progress or report a blocker for the current user-defined Goal. For completion, put a concise completion report in progress; evidence references are optional. To attach a Canonical record, call read_thread_history without thread_id and use the seq beside the original verification record in its returned records (not the seq of the history-read call) as verificationRecordSeq. An active checkpoint is non-terminal: continue the Goal with the next concrete action after recording it. Use needs_input or paused only when work must wait. This cannot edit or clear the Goal.',
        parameters: {
          type: 'object',
          properties: {
            progress: { type: 'string', description: 'Concise, concrete progress made since the previous checkpoint.' },
            status: {
              type: 'string',
              enum: ['active', 'needs_input', 'paused', 'completed'],
              description:
                'Use active to record progress and keep working; use needs_input or paused only when work must wait; use completed when the Goal criteria are met. Put the completion report in progress; evidence references are optional.',
            },
            blocker: { type: 'string', description: 'What is blocking progress or what input is needed.' },
            verificationRecordSeq: {
              type: 'integer',
              minimum: 1,
              description:
                'Optional Canonical History reference. Call read_thread_history with thread_id omitted (the current Thread); in its returned records, use the seq beside the original message or tool result containing the verification, not the seq of the history-read call. Omit this field when you do not need a citation; never guess a seq.',
            },
            verificationExecutionId: {
              type: 'string',
              description:
                'Legacy optional exact execution ID. Prefer verificationRecordSeq from read_thread_history; omit this field if the exact ID is not already available.',
            },
            verificationRecordId: {
              type: 'string',
              description:
                'Legacy optional opaque Canonical record ID. Prefer verificationRecordSeq from read_thread_history; do not pass a seq in this field.',
            },
            verificationSummary: {
              type: 'string',
              description: 'Optional note about what an attached evidence reference establishes; defaults to progress.',
            },
          },
          required: ['progress'],
          additionalProperties: false,
        },
      },
      async (args, toolContext) => {
        const thread = toolContext.thread;
        if (!thread) throw new Error('Goal checkpoint requires a Thread context');
        let goal = getGoal(thread.id);
        if (!goal || goal.status === 'cleared') throw new Error('There is no active Goal in this Thread');
        if (goal.status === 'completed')
          throw new Error('The Goal is already completed; only the user can reopen or edit it');
        const progress = requiredString(args.progress, 'progress');
        const requestedStatus = args.status === undefined ? goal.status : args.status;
        if (!['active', 'needs_input', 'paused', 'completed'].includes(String(requestedStatus))) {
          throw new Error('Invalid Goal checkpoint status');
        }
        if (requestedStatus === 'active' && goal.status !== 'active') {
          throw new Error('Only the user can resume a paused Goal');
        }
        let evidence: GoalEvidence | null = goal.evidence;
        let evidenceWarning: string | undefined;
        if (requestedStatus === 'completed') {
          const summary =
            typeof args.verificationSummary === 'string' && args.verificationSummary.trim()
              ? args.verificationSummary.trim()
              : progress;
          evidence = null;
          if (args.verificationRecordSeq !== undefined) {
            const seq = args.verificationRecordSeq;
            const record =
              typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 1
                ? canonical.list(thread.id).find((item) => item.seq === seq)
                : undefined;
            if (!record || record.kind === 'plugin' || record.seq >= maxSeq(thread.id)) {
              evidenceWarning =
                'Optional evidence was not attached: the supplied seq is not a prior non-plugin Canonical record in this Thread. Completion was recorded without a citation.';
            } else {
              evidence = { kind: 'canonical', id: record.id, summary };
            }
          } else if (typeof args.verificationExecutionId === 'string' && args.verificationExecutionId.trim()) {
            const execution: Execution | null = executions.get(args.verificationExecutionId.trim());
            if (!execution || execution.threadId !== thread.id || execution.status !== 'completed') {
              evidenceWarning =
                'Optional evidence was not attached: the supplied execution ID is not a completed execution in this Thread. Completion was recorded without a citation.';
            } else {
              evidence = { kind: 'execution', id: execution.id, summary };
            }
          } else if (typeof args.verificationRecordId === 'string' && args.verificationRecordId.trim()) {
            const recordId = args.verificationRecordId.trim();
            const record = canonical.list(thread.id).find((item) => item.id === recordId);
            if (!record || record.kind === 'plugin' || record.seq >= maxSeq(thread.id)) {
              evidenceWarning =
                'Optional evidence was not attached: the supplied record ID is not a prior non-plugin Canonical record in this Thread. Completion was recorded without a citation.';
            } else {
              evidence = { kind: 'canonical', id: record.id, summary };
            }
          }
        }
        const status = requestedStatus as GoalStatus;
        goal = {
          ...goal,
          status,
          recentProgress: progress,
          blocker: status === 'needs_input' || status === 'paused' ? String(args.blocker ?? '').trim() : '',
          evidence,
          updatedAt: new Date().toISOString(),
        };
        state.transaction(() => {
          save(goal!);
          audit(thread.id, 'checkpoint', {
            status,
            progress,
            blocker: goal!.blocker,
            evidence,
            ...(evidenceWarning ? { evidenceWarning } : {}),
          });
          if (status === 'paused' || status === 'needs_input')
            threads.pause(thread.id, goal!.blocker || `Goal ${status}`);
        });
        return { status, progress, blocker: goal.blocker, evidence, ...(evidenceWarning ? { evidenceWarning } : {}) };
      },
    );

    ui.contribute({
      slot: 'thread.toolbar',
      id: 'goal-panel',
      label: 'Goal',
      description: 'View and manage the current Thread Goal.',
      entry: 'webui',
      component: 'GoalPanel',
      supportsPopover: true,
    } satisfies UiContribution);
    http.register('GET', '/goal', ({ query }) => {
      const threadId = requiredString(query.get('threadId'), 'threadId');
      validateThread(threadId);
      return { threadId, goal: goalView(getGoal(threadId)) };
    });
    http.register('PUT', '/goal', ({ body }) => {
      const value = bodyObject(body);
      const threadId = requiredString(value.threadId, 'threadId');
      validateThread(threadId);
      const text = requiredString(value.text, 'text');
      const constraints = typeof value.constraints === 'string' ? value.constraints.trim() : '';
      const completionCriteria = requiredString(value.completionCriteria, 'completionCriteria');
      const previous = getGoal(threadId);
      if (previous && previous.status !== 'cleared') {
        const updated: ThreadGoal = {
          ...previous,
          text,
          constraints,
          completionCriteria,
          status: 'active',
          recentProgress: previous.text === text ? previous.recentProgress : '',
          blocker: '',
          evidence: null,
          updatedAt: new Date().toISOString(),
        };
        state.transaction(() => {
          save(updated);
          audit(threadId, 'edited', { text, constraints, completionCriteria });
        });
        return { threadId, goal: goalView(updated) };
      }
      const goal = defaultGoal(threadId, { text, constraints, completionCriteria });
      state.transaction(() => {
        save(goal);
        audit(threadId, 'created', { text, constraints, completionCriteria });
      });
      return { threadId, goal: goalView(goal) };
    });
    http.register('POST', '/goal/action', ({ body }) => {
      const value = bodyObject(body);
      const threadId = requiredString(value.threadId, 'threadId');
      validateThread(threadId);
      const goal = getGoal(threadId);
      if (!goal || goal.status === 'cleared') throw new Error('There is no Goal to update');
      if (value.action === 'clear') {
        const cleared = withStatus(goal, 'cleared', { blocker: '', evidence: null });
        state.transaction(() => {
          save(cleared);
          audit(threadId, 'cleared', { previousGoalId: goal.id });
        });
        return { threadId, goal: goalView(cleared) };
      }
      if (value.action === 'pause') {
        const paused = withStatus(goal, 'paused', {
          blocker:
            typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : 'Paused by the user.',
        });
        state.transaction(() => {
          save(paused);
          audit(threadId, 'paused', { source: 'user', reason: paused.blocker });
          threads.pause(threadId, paused.blocker);
        });
        return { threadId, goal: goalView(paused) };
      }
      if (value.action === 'resume') {
        const active = withStatus(goal, 'active');
        state.transaction(() => {
          save(active);
          audit(threadId, 'resumed', { source: 'user' });
          threads.resume(threadId);
        });
        return { threadId, goal: goalView(active) };
      }
      throw new Error('action must be pause, resume, or clear');
    });
  },
};
