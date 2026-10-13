import type { PicoPlugin, PluginContext } from './host.js';
import type { Execution, Thread, ToolDefinition, UiContribution } from '../core/types.js';
import type { ProjectionInput, ToolInvocationInput } from '../runtime/stages.js';

type PermissionPolicy = 'allow' | 'deny' | 'ask';
type ApprovalStatus = PermissionApproval['status'];
interface PermissionApproval {
  executionId: string;
  threadId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'allowed' | 'denied' | 'cancelled';
  createdAt: string;
}
type PermissionRules = Record<string, Record<string, PermissionPolicy>>;
type PermissionApprovals = Record<string, PermissionApproval>;
type PermissionTools = Record<
  string,
  Array<Pick<ToolDefinition, 'name' | 'description'> & { policy: PermissionPolicy }>
>;

interface PermissionContext extends PluginContext {
  executions: {
    get(executionId: string): Execution | null;
    fail(executionId: string, reason: string, result?: unknown): Execution;
    subscribe(listener: (execution: Execution) => void): () => void;
  };
  state: PluginContext['state'] & {
    transaction<T>(operation: () => T): T;
    subscribe(listener: () => void): () => void;
  };
}

function objectValue<T extends object>(value: unknown): T {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : ({} as T);
}

function requestBody(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function permissionPath(value: string | null, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value;
}

function isPolicy(value: unknown): value is PermissionPolicy {
  return value === 'allow' || value === 'deny' || value === 'ask';
}

const permissionsUi = (slot: 'thread.toolbar' | 'tool.renderer', id: string, component: string) =>
  ({
    slot,
    id,
    label: slot === 'thread.toolbar' ? 'Tools' : 'Tool execution',
    description:
      slot === 'thread.toolbar'
        ? 'Review and change this Thread’s tool permission rules.'
        : 'Inspect a Tool execution and resolve a pending permission request.',
    entry: 'webui',
    component,
    ...(slot === 'thread.toolbar' ? { supportsPopover: true } : {}),
    ...(slot === 'tool.renderer' ? {} : { command: '/permissions' }),
  }) as unknown as UiContribution;

export const permissionPlugin: PicoPlugin = {
  id: 'pico.permissions',
  name: 'Invocation permissions',
  version: '0.1.0',
  activate(pluginContext) {
    const context = pluginContext as PermissionContext;
    const { pipelines, state, canonical, commands, ui, http, executions, threads } = context;
    const decisionWaiters = new Map<string, Set<(allow: boolean) => void>>();

    const readRules = (): PermissionRules => objectValue<PermissionRules>(state.get('rules', {}));
    const readApprovals = (): PermissionApprovals => objectValue<PermissionApprovals>(state.get('approvals', {}));
    const writeDecision = (
      approval: PermissionApproval,
      status: Exclude<ApprovalStatus, 'pending'>,
      options: { rememberForThread?: boolean; source: 'user' | 'interrupt' | 'policy'; reason?: string },
    ): PermissionApproval => {
      let updated = approval;
      state.transaction(() => {
        const approvals = readApprovals();
        const current = approvals[approval.executionId] ?? approval;
        if (current.status !== 'pending') {
          updated = current;
          return;
        }
        if (options.rememberForThread) {
          const rules = readRules();
          state.set('rules', {
            ...rules,
            [current.threadId]: { ...(rules[current.threadId] ?? {}), [current.toolName]: 'allow' },
          });
        }
        updated = { ...current, status };
        state.set('approvals', { ...approvals, [approval.executionId]: updated });
        canonical.append(current.threadId, {
          action: status === 'cancelled' ? 'cancel' : 'decision',
          executionId: current.executionId,
          toolName: current.toolName,
          ...(status !== 'cancelled' ? { decision: status === 'allowed' ? 'allow' : 'deny' } : {}),
          ...(options.rememberForThread ? { scope: 'thread' } : { scope: 'once' }),
          ...(options.reason ? { reason: options.reason } : {}),
          source: options.source,
        });
      });
      const waiters = decisionWaiters.get(approval.executionId);
      if (waiters && updated.status !== 'pending' && updated.status !== 'cancelled') {
        decisionWaiters.delete(approval.executionId);
        for (const resolve of waiters) resolve(updated.status === 'allowed');
      }
      return updated;
    };

    const setPolicy = (threadId: string, toolName: string, policy: PermissionPolicy): void => {
      const rules = readRules();
      state.transaction(() => {
        state.set('rules', { ...rules, [threadId]: { ...(rules[threadId] ?? {}), [toolName]: policy } });
        canonical.append(threadId, { action: 'rule.updated', toolName, policy });
      });
    };

    const getPolicy = (
      threadId: string,
      toolName: string,
      source: ToolInvocationInput['toolSource'],
      thread: Thread,
    ): PermissionPolicy => {
      const configured = readRules()[threadId]?.[toolName];
      if (configured) return configured;
      if (source === 'runtime') return 'allow';
      return thread.executorKind === 'host' ? 'ask' : 'allow';
    };

    const createApproval = (input: ToolInvocationInput): PermissionApproval => {
      const previous = readApprovals()[input.executionId];
      if (previous) return previous;
      const approval: PermissionApproval = {
        executionId: input.executionId,
        threadId: input.thread.id,
        toolName: input.call.name,
        arguments: input.call.arguments,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      state.transaction(() => {
        state.set('approvals', { ...readApprovals(), [input.executionId]: approval });
        canonical.append(input.thread.id, {
          action: 'request',
          executionId: input.executionId,
          toolName: input.call.name,
          arguments: input.call.arguments,
        });
      });
      return approval;
    };

    const awaitDecision = (approval: PermissionApproval, signal: AbortSignal): Promise<boolean> => {
      if (approval.status !== 'pending') return Promise.resolve(approval.status === 'allowed');
      return new Promise<boolean>((resolve, reject) => {
        let onAbort = (): void => undefined;
        const finish = (allow: boolean): void => {
          signal.removeEventListener('abort', onAbort);
          const currentWaiters = decisionWaiters.get(approval.executionId);
          currentWaiters?.delete(finish);
          if (currentWaiters?.size === 0) decisionWaiters.delete(approval.executionId);
          resolve(allow);
        };
        const waiters = decisionWaiters.get(approval.executionId) ?? new Set<(allow: boolean) => void>();
        waiters.add(finish);
        decisionWaiters.set(approval.executionId, waiters);
        onAbort = (): void => {
          const cleanup = (): void => {
            signal.removeEventListener('abort', onAbort);
            const currentWaiters = decisionWaiters.get(approval.executionId);
            currentWaiters?.delete(finish);
            if (currentWaiters?.size === 0) decisionWaiters.delete(approval.executionId);
          };
          const current = readApprovals()[approval.executionId] ?? approval;
          try {
            if (current.status === 'pending') {
              writeDecision(current, 'cancelled', { source: 'interrupt', reason: 'user_interrupt' });
            }
          } catch (error) {
            cleanup();
            reject(error);
            return;
          }
          cleanup();
          reject(new DOMException('Tool invocation interrupted while waiting for permission.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    };

    executions.subscribe((execution) => {
      if (execution.status !== 'interrupted') return;
      const approval = readApprovals()[execution.id];
      if (!approval || approval.status !== 'pending') return;
      try {
        writeDecision(approval, 'cancelled', {
          source: 'interrupt',
          reason: 'execution_interrupted',
        });
      } catch {
        // Keep the pending decision recoverable if its audit record cannot be committed.
      }
    });

    const toolList = async (
      threadId: string,
    ): Promise<Array<{ name: string; description: string; policy: PermissionPolicy }>> => {
      const thread = threads.get(threadId);
      if (!thread) throw new Error('Thread not found');
      const known = objectValue<PermissionTools>(state.get('availableTools', {}))[threadId];
      const binding = threads.binding(threadId);
      const available =
        known ??
        (thread.executorKind === 'container' || binding?.remoteConnectionId
          ? []
          : (await threads.tools(threadId)).map((tool) => ({
              name: tool.name,
              description: tool.description,
              policy: tool.source === 'runtime' ? 'allow' : thread.executorKind === 'host' ? 'ask' : 'allow',
            })));
      const rules = readRules()[threadId] ?? {};
      return available.map((tool) => ({ ...tool, policy: rules[tool.name] ?? tool.policy }));
    };

    pipelines.use<ProjectionInput, ProjectionInput>('projection', async (input, next) => {
      const rules = readRules()[input.thread.id] ?? {};
      const available = input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        policy:
          rules[tool.name] ??
          ((input.toolSources?.[tool.name] ?? (input.thread.executorKind === 'runtime' ? 'runtime' : 'executor')) ===
          'runtime'
            ? 'allow'
            : input.thread.executorKind === 'host'
              ? 'ask'
              : 'allow'),
      }));
      const nextAvailable = {
        ...objectValue<PermissionTools>(state.get('availableTools', {})),
        [input.thread.id]: available,
      };
      if (
        JSON.stringify(nextAvailable) !== JSON.stringify(objectValue<PermissionTools>(state.get('availableTools', {})))
      ) {
        state.set('availableTools', nextAvailable);
      }
      return next({ ...input, tools: input.tools.filter((tool) => rules[tool.name] !== 'deny') });
    });

    pipelines.use<ToolInvocationInput, Execution>('toolInvocation', async (input, next) => {
      const policy = getPolicy(input.thread.id, input.call.name, input.toolSource, input.thread);
      if (policy === 'deny') {
        canonical.append(input.thread.id, {
          action: 'decision',
          executionId: input.executionId,
          toolName: input.call.name,
          decision: 'deny',
          reason: 'Denied by the current permission policy.',
          source: 'policy',
        });
        return input.fail('Denied by the current permission policy.', { denied: true });
      }
      if (policy === 'ask') {
        const approval = createApproval(input);
        const approved = await awaitDecision(approval, input.signal);
        if (!approved) return input.fail('Denied by the user.', { denied: true });
      }
      return next(input);
    });

    commands.register({
      name: 'permissions',
      description: 'Open the tool permission controls for this Thread.',
      execute(_args, commandContext) {
        return commandContext.thread
          ? { text: 'Open the Tool permissions control in the Thread toolbar.' }
          : { text: 'Choose a Thread to review its tool permission rules.' };
      },
    });
    ui.contribute(permissionsUi('thread.toolbar', 'permissions', 'ToolPermissions'));
    ui.contribute(permissionsUi('tool.renderer', 'permission-tool', 'PermissionTool'));

    http.register('GET', '/threads', async ({ query }) => {
      const threadId = permissionPath(query.get('threadId'), 'threadId');
      if (!threads.get(threadId)) throw new Error('Thread not found');
      const approvals = Object.values(readApprovals()).filter((approval) => approval.threadId === threadId);
      return { threadId, tools: await toolList(threadId), approvals };
    });
    http.register('PUT', '/rules', async ({ body }) => {
      const value = requestBody(body);
      const threadId = typeof value.threadId === 'string' ? value.threadId : '';
      const toolName = typeof value.toolName === 'string' ? value.toolName : '';
      if (!threadId || !toolName || !isPolicy(value.policy))
        throw new Error('threadId, toolName, and valid policy are required');
      if (!threads.get(threadId)) throw new Error('Thread not found');
      setPolicy(threadId, toolName, value.policy);
      return { threadId, tools: await toolList(threadId) };
    });
    http.register('POST', '/approvals', ({ body }) => {
      const value = requestBody(body);
      const executionId = typeof value.executionId === 'string' ? value.executionId : '';
      if (!executionId || typeof value.allow !== 'boolean') throw new Error('executionId and allow are required');
      if (value.rememberForThread !== undefined && typeof value.rememberForThread !== 'boolean') {
        throw new Error('rememberForThread must be a boolean');
      }
      const approval = readApprovals()[executionId];
      if (!approval) throw new Error('Approval request not found');
      const execution = executions.get(executionId);
      if (!execution || execution.threadId !== approval.threadId) throw new Error('Tool Execution not found');
      if (approval.status === 'pending' && execution.status !== 'pending') {
        throw new Error('Tool Execution is no longer pending');
      }
      if (approval.status === 'cancelled') throw new Error('Approval was cancelled');
      if (approval.status === 'denied') throw new Error('Approval was already resolved');
      if (value.rememberForThread === true && !value.allow) {
        throw new Error('A denied approval cannot create an allow rule');
      }
      const updated = writeDecision(approval, value.allow ? 'allowed' : 'denied', {
        source: 'user',
        rememberForThread: value.rememberForThread === true,
      });
      return updated;
    });
  },
};
