import { createHash } from 'node:crypto';
import type { PicoPlugin } from './host.js';
import { collaborationPlugin } from './collaboration.js';
import { permissionPlugin } from './permissions.js';
import type { ProjectionInput } from '../runtime/stages.js';

export const workspacePlugin: PicoPlugin = {
  id: 'pico.workspace',
  name: 'Workspace companion',
  version: '0.1.0',
  activate({ tools, pipelines, commands, ui, state, canonical }) {
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

    pipelines.use<
      { systemPrompt: string; thread: { workspacePath: string; executorKind: string }; [key: string]: unknown },
      { systemPrompt: string; [key: string]: unknown }
    >('projection', async (input, next) =>
      next({
        ...input,
        systemPrompt:
          input.thread.executorKind === 'runtime'
            ? input.systemPrompt
            : `${input.systemPrompt}\nThe selected workspace is ${input.thread.workspacePath}. The executor type is ${input.thread.executorKind}.`,
      }),
    );

    commands.register({
      name: 'workspace',
      description: 'Show the selected workspace and executor.',
      execute(_args, context) {
        if (!context.thread) return { text: 'Choose a thread first.' };
        if (context.thread.executorKind === 'runtime') return { text: 'This Chat Thread has no attached workspace.' };
        canonical.append(context.thread.id, { action: 'workspace-inspected', executor: context.thread.executorKind });
        return { text: `Workspace: ${context.thread.workspacePath}\nExecutor: ${context.thread.executorLabel}` };
      },
    });

    ui.contribute({
      slot: 'thread.toolbar',
      id: 'workspace',
      label: 'Workspace',
      description: 'Inspect the thread workspace and bound executor.',
      command: '/workspace',
    });
  },
};

interface ProjectContextEntry {
  text: string;
  revision: number;
}

type ProjectContexts = Record<string, ProjectContextEntry>;

function readProjectContexts(get: <T>(key: string, fallback: T) => T): ProjectContexts {
  const value = get<unknown>('byProject', {});
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ProjectContexts) : {};
}

function projectContextFor(contexts: ProjectContexts, projectId: string): ProjectContextEntry {
  const value: unknown = contexts[projectId];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { text: '', revision: 0 };
  const entry = value as Record<string, unknown>;
  return {
    text: typeof entry.text === 'string' ? entry.text : '',
    revision:
      typeof entry.revision === 'number' && Number.isSafeInteger(entry.revision) && entry.revision >= 0
        ? entry.revision
        : 0,
  };
}

export const projectContextPlugin: PicoPlugin = {
  id: 'pico.project-context',
  name: 'Project context',
  version: '0.1.0',
  activate({ pipelines, commands, ui, state, canonical }) {
    pipelines.use<ProjectionInput, ProjectionInput>('projection', async (input, next) => {
      const context = projectContextFor(readProjectContexts(state.get), input.thread.projectId);
      if (!context.text.trim()) return next(input);
      return next({
        ...input,
        systemPrompt: `${input.systemPrompt}\n\n## User-maintained Project Context\nThis context is shared across Threads in the selected Project. It was explicitly maintained by the user; treat it as project guidance, not as a complete record of current Thread state.\n\n${context.text}`,
      });
    });

    commands.register({
      name: 'project-context',
      description: 'View or set context shared by Threads in this Project.',
      execute(_args, context) {
        if (!context.thread || !context.projectId) return { text: 'Choose a Project Thread first.' };
        const contexts = readProjectContexts(state.get);
        const previous = projectContextFor(contexts, context.projectId);
        const raw = context.rawArgs;

        if (!raw.trim()) {
          return {
            text: previous.text
              ? `Project context (revision ${previous.revision}):\n\n${previous.text}\n\nSet it with /project-context set followed by the context text on the next line. Clear it with /project-context clear.`
              : 'No Project context is set. Use /project-context set followed by context text on the next line.',
          };
        }

        if (raw.trim().toLowerCase() === 'clear') {
          const revision = previous.revision + 1;
          state.set('byProject', { ...contexts, [context.projectId]: { text: '', revision } });
          canonical.append(context.thread.id, {
            action: 'project-context.updated',
            projectId: context.projectId,
            revision,
            operation: 'clear',
            sha256: createHash('sha256').update('').digest('hex'),
            characters: 0,
          });
          return { text: `Project context cleared (revision ${revision}).` };
        }

        const match = /^set(?:[ \t]+|\r?\n+)([\s\S]*)$/i.exec(raw);
        if (!match) {
          return {
            text: 'Use /project-context to view, /project-context set followed by text, or /project-context clear.',
          };
        }
        const text = match[1]?.trim();
        if (!text) {
          return {
            text: 'Add context after /project-context set, or use /project-context clear.',
          };
        }
        const revision = previous.revision + 1;
        state.set('byProject', { ...contexts, [context.projectId]: { text, revision } });
        canonical.append(context.thread.id, {
          action: 'project-context.updated',
          projectId: context.projectId,
          revision,
          operation: 'set',
          sha256: createHash('sha256').update(text).digest('hex'),
          characters: text.length,
        });
        return {
          text: `Project context saved (revision ${revision}, ${text.length} characters). It will be included in future Model Input projections for Threads in this Project.`,
        };
      },
    });

    ui.contribute({
      slot: 'thread.toolbar',
      id: 'project-context',
      label: 'Project context',
      description: 'View or update context shared by Threads in this Project.',
      command: '/project-context',
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
  projectContextPlugin,
  helpPlugin,
  collaborationPlugin,
  permissionPlugin,
];
