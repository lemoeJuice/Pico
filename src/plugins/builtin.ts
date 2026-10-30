import type { PicoPlugin } from './host.js';

export const workspacePlugin: PicoPlugin = {
  id: 'pico.workspace',
  name: 'Workspace companion',
  version: '0.1.0',
  defaultToolsEnabled: true,
  activate({ tools, pipelines, commands, state, canonical }) {
    tools.register(
      {
        name: 'workspace_info',
        description: 'Get the current thread workspace path and its project name.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      async (_args, context) => {
        if (!context.thread) throw new Error('Thread context is not available');
        const count = state.get('toolCalls', 0) + 1;
        state.set('toolCalls', count);
        return {
          project: context.thread.title,
          workspace: context.thread.workspacePath,
          executor: context.thread.executorKind,
          callsFromThisPlugin: count,
        };
      },
    );

    pipelines.use('projection', async (input, next) =>
      next({
        ...input,
        systemPrompt:
          input.thread.executorKind === 'runtime'
            ? input.systemPrompt
            : input.thread.workspacePath
              ? `${input.systemPrompt}\nThe Project workspace is ${input.thread.workspacePath}. The executor type is ${input.thread.executorKind}.`
              : `${input.systemPrompt}\nThis Thread has no Project workspace. The executor type is ${input.thread.executorKind}.`,
      }),
    );

    commands.register({
      name: 'workspace',
      description: 'Show the selected workspace and executor.',
      execute(_args, context) {
        if (!context.thread) return { text: 'Choose a thread first.' };
        if (context.thread.executorKind === 'runtime') return { text: 'This Chat Thread has no attached workspace.' };
        canonical.append(context.thread.id, { action: 'workspace-inspected', executor: context.thread.executorKind });
        return { text: `Workspace: ${context.thread.workspacePath || 'Not set'}\nExecutor: ${context.thread.executorLabel}` };
      },
    });
  },
};

export const helpPlugin: PicoPlugin = {
  id: 'pico.commands',
  name: 'Built-in commands',
  version: '0.1.0',
  activate({ commands }) {
    commands.register({
      name: 'help',
      description: 'List available slash commands.',
      execute() {
        return { text: 'Open the command menu with “/” or type a command name.' };
      },
    });
  },
};

export const builtinPlugins: PicoPlugin[] = [
  workspacePlugin,
  helpPlugin,
];
