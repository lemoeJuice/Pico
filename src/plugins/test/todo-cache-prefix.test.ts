import { describe, expect, it } from 'vitest';
import { FakeModel, response, setupRuntime } from '../../../test/helpers.js';
import type { PicoPlugin } from '../host.js';
import { todoPlugin } from '../todo.js';

describe('Todo model context', () => {
  it('keeps Todo state out of projected turns and reads current state through todo_list', async () => {
    const model = new FakeModel((_prompt, call) => {
      if (call === 1) {
        return response('', [
          { id: 'update', name: 'todo_update', arguments: { id: 'item', title: 'Updated outcome' } },
        ]);
      }
      if (call === 2) return response('', [{ id: 'complete', name: 'todo_complete', arguments: { id: 'item' } }]);
      if (call === 3) return response('', [{ id: 'list', name: 'todo_list', arguments: {} }]);
      return response('The Todo is complete.');
    });
    const env = await setupRuntime(model, { plugins: [todoPlugin] });
    const thread = env.createThread('runtime');
    try {
      env.store.setPluginState('pico.todo', 'byThread', {
        [thread.id]: [{ id: 'item', title: 'Original outcome', status: 'open' }],
      });
      await env.runtime.submit(thread.id, 'todo-context-test', 'Update and finish the outcome');
      await env.runtime.drain();

      expect(model.prompts).toHaveLength(4);
      const systems = model.prompts.map((prompt) => prompt.system);
      expect(new Set(systems).size).toBe(1);
      expect(systems[0]).toMatch(/Todo/i);
      expect(systems[0]).toMatch(/todo_list/);
      expect(systems[0]).not.toContain('Original outcome');
      expect(systems[0]).not.toContain('Updated outcome');

      for (const prompt of model.prompts) {
        const messages = prompt.turns.filter((turn) => turn.kind === 'message');
        expect(JSON.stringify(messages)).not.toContain('Original outcome');
        expect(JSON.stringify(messages)).not.toContain('Updated outcome');
      }
      const listResult = model.prompts[3]!.turns.find((turn) => turn.kind === 'tool_result' && turn.callId === 'list');
      expect(listResult?.kind).toBe('tool_result');
      const currentState = JSON.parse(listResult!.content) as { items: Array<{ status: string }>; openCount: number };
      expect(currentState.items).toEqual([{ id: 'item', title: 'Updated outcome', status: 'done' }]);
      expect(currentState.openCount).toBe(0);
      expect(model.prompts[0]!.tools.map((tool) => tool.name)).toContain('todo_list');
      expect(model.prompts[2]!.tools.map((tool) => tool.name)).toContain('todo_list');
    } finally {
      await env.cleanup();
    }
  });

  it('describes only Todo tools available to this Thread, including when none are enabled', async () => {
    const model = new FakeModel(() => response('Ready.'));
    const env = await setupRuntime(model, { plugins: [todoPlugin] });
    const thread = env.createThread('runtime');
    try {
      await env.runtime.setThreadToolEnabled(thread.id, 'todo_list', false);
      await env.runtime.submit(thread.id, 'todo-no-list-test', 'Continue');
      await env.runtime.drain();
      const withoutList = model.prompts[0]!;
      expect(withoutList.tools.map((tool) => tool.name)).not.toContain('todo_list');
      expect(withoutList.system).not.toMatch(/call\s+todo_list|use\s+todo_list/i);

      for (const name of ['todo_add', 'todo_update', 'todo_complete', 'todo_reopen', 'todo_delete']) {
        await env.runtime.setThreadToolEnabled(thread.id, name, false);
      }
      await env.runtime.submit(thread.id, 'todo-no-tools-test', 'Continue again');
      await env.runtime.drain();
      const withoutTodoTools = model.prompts[1]!;
      expect(withoutTodoTools.tools.map((tool) => tool.name).filter((name) => name.startsWith('todo_'))).toEqual([]);
      expect(withoutTodoTools.system).not.toMatch(
        /todo_list|todo_add|todo_update|todo_complete|todo_reopen|todo_delete/i,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('builds the capability hint from the final tool table after a later projection filter', async () => {
    const filterTodoList: PicoPlugin = {
      id: 'pico.test-filter-todo-list',
      name: 'Test Todo list filter',
      version: '1.0.0',
      pipelinePriority: { projection: 35 },
      activate({ pipelines }) {
        pipelines.use('projection', async (input, next) =>
          next({ ...input, tools: input.tools.filter((tool) => tool.name !== 'todo_list') }),
        );
      },
    };
    const model = new FakeModel(() => response('Ready.'));
    const env = await setupRuntime(model, { plugins: [todoPlugin, filterTodoList] });
    const thread = env.createThread('runtime');
    try {
      await env.runtime.submit(thread.id, 'todo-filtered-tool-test', 'Continue');
      await env.runtime.drain();
      const prompt = model.prompts[0]!;
      expect(prompt.tools.map((tool) => tool.name)).not.toContain('todo_list');
      expect(prompt.system).not.toMatch(/call\s+todo_list|use\s+todo_list/i);
    } finally {
      await env.cleanup();
    }
  });
});
