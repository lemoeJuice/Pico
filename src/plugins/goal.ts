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
      const turns = [...input.turns];
      const turnIndex = turns.length;
      turns.push({
        kind: 'message',
        role: 'user',
        content: [
          '<active_goal>',
          `Status: ${goal.status}`,
          `Goal: ${goal.text}`,
          ...(goal.constraints ? [`Constraints: ${goal.constraints}`] : []),
          ...(goal.completionCriteria ? [`Completion criteria: ${goal.completionCriteria}`] : []),
          ...(goal.recentProgress ? [`Recent progress: ${goal.recentProgress}`] : []),
          ...(goal.blocker ? [`Current blocker: ${goal.blocker}`] : []),
          'Continue with the next useful action while this Goal is active. Do not claim completion without calling goal_checkpoint with verifiable evidence from this Thread.',
          '</active_goal>',
        ].join('\n'),
      });
      const extended = input as GoalProjectionInput;
      return next({
        ...input,
        turns,
        provenance: [
          ...(extended.provenance ?? []),
          {
            id: goal.id,
            sourcePluginId: 'pico.goal',
            label: 'Active Goal',
            kind: 'plugin',
            disposition: 'raw',
            turnIndex,
          },
        ],
      });
    });

    tools.register(
      {
        name: 'goal_checkpoint',
        description:
          'Record meaningful progress or report a blocker for the current user-defined Goal. This cannot edit or clear the Goal.',
        parameters: {
          type: 'object',
          properties: {
            progress: { type: 'string', description: 'Concise, concrete progress made since the previous checkpoint.' },
            status: { type: 'string', enum: ['active', 'needs_input', 'paused', 'completed'] },
            blocker: { type: 'string', description: 'What is blocking progress or what input is needed.' },
            verificationExecutionId: {
              type: 'string',
              description: 'Completed same-Thread execution that verifies the completion criteria.',
            },
            verificationRecordId: {
              type: 'string',
              description: 'Same-Thread canonical record that contains verification evidence.',
            },
            verificationSummary: {
              type: 'string',
              description: 'What the referenced verification evidence establishes.',
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
        if (requestedStatus === 'completed') {
          const summary = requiredString(args.verificationSummary, 'verificationSummary');
          if (typeof args.verificationExecutionId === 'string' && args.verificationExecutionId.trim()) {
            const execution: Execution | null = executions.get(args.verificationExecutionId.trim());
            if (!execution || execution.threadId !== thread.id || execution.status !== 'completed') {
              throw new Error('Completion evidence must reference a completed execution in this Thread');
            }
            evidence = { kind: 'execution', id: execution.id, summary };
          } else if (typeof args.verificationRecordId === 'string' && args.verificationRecordId.trim()) {
            const recordId = args.verificationRecordId.trim();
            const record = canonical.list(thread.id).find((item) => item.id === recordId);
            if (!record || record.kind === 'plugin' || record.seq >= maxSeq(thread.id)) {
              throw new Error('Completion evidence must reference a prior canonical record in this Thread');
            }
            evidence = { kind: 'canonical', id: record.id, summary };
          } else {
            throw new Error('completed requires a same-Thread verificationExecutionId or verificationRecordId');
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
          audit(thread.id, 'checkpoint', { status, progress, blocker: goal!.blocker, evidence });
          if (status === 'paused' || status === 'needs_input')
            threads.pause(thread.id, goal!.blocker || `Goal ${status}`);
        });
        return { status, progress, blocker: goal.blocker, evidence };
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
