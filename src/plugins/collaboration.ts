import type { PicoPlugin, PluginContext } from './host.js';
import type { ProjectionInput } from '../runtime/stages.js';

type CollaborationServices = Pick<PluginContext, 'threads'>;

export const collaborationPlugin: PicoPlugin = {
  id: 'pico.collaboration',
  name: 'Thread collaboration',
  version: '0.1.0',
  activate({ tools, pipelines, ...context }) {
    const { threads } = context as typeof context & CollaborationServices;
    pipelines.use<ProjectionInput, ProjectionInput>('projection', async (input, next) =>
      next({
        ...input,
        systemPrompt: `${input.systemPrompt}\n\nTo work in parallel, spawn a child Thread; spawning returns immediately. Child Threads and their parent communicate with ordinary messages. A child can send a message to its parent Thread ID shown below. Do not wait for a child unless you have other useful work to do.`,
      }),
    );

    tools.register(
      {
        name: 'spawn_thread',
        description:
          'Create a child Thread in this Project, send it an initial message, and return immediately without waiting for it.',
        parameters: {
          type: 'object',
          properties: { prompt: { type: 'string' }, title: { type: 'string' } },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
      async (args, toolContext) => {
        const parent = toolContext.thread;
        if (!parent) throw new Error('Thread context is missing');
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) throw new Error('Child Thread prompt is required');
        const requestedTitle = typeof args.title === 'string' ? args.title.trim() : '';
        const title = requestedTitle || prompt.replace(/\s+/g, ' ').slice(0, 60) || 'Child Thread';
        return threads.createChild(parent.id, prompt, title, `${toolContext.executionId}:child-message`);
      },
    );
    tools.register(
      {
        name: 'send_thread_message',
        description:
          'Send a normal message to another Thread in this Project. This does not wait for that Thread to finish.',
        parameters: {
          type: 'object',
          properties: { thread_id: { type: 'string' }, message: { type: 'string' } },
          required: ['thread_id', 'message'],
          additionalProperties: false,
        },
      },
      async (args, toolContext) => {
        const sender = toolContext.thread;
        if (!sender) throw new Error('Thread context is missing');
        const targetId = typeof args.thread_id === 'string' ? args.thread_id : '';
        const content = typeof args.message === 'string' ? args.message.trim() : '';
        if (!targetId || !content) throw new Error('thread_id and message are required');
        return threads.send(sender.id, targetId, content, `${toolContext.executionId}:message`);
      },
    );
  },
};
