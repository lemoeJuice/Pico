import { describe, expect, it } from 'vitest';
import type { ExecutorToolContext, RuntimeToolContext } from '../src/executor/tool-catalog.js';

function runtimeContextCanReadThread(context: RuntimeToolContext): string {
  return context.thread.id;
}

function executorContextCannotReadThread(context: ExecutorToolContext): void {
  // @ts-expect-error Executor plugin callbacks must not receive Thread state.
  void context.thread;
}

// @ts-expect-error Runtime plugin callbacks require the active Thread.
const incompleteRuntimeContext: RuntimeToolContext = {
  workspacePath: '/workspace',
  executionId: 'execution-1',
  signal: new AbortController().signal,
};

describe('Executor and Runtime tool context boundaries', () => {
  it('keeps Thread required only for Runtime tool callbacks', () => {
    const executorContext: ExecutorToolContext = {
      workspacePath: '/workspace',
      executionId: 'execution-1',
      signal: new AbortController().signal,
    };
    expect('thread' in executorContext).toBe(false);
    expect(runtimeContextCanReadThread).toBeTypeOf('function');
    expect(executorContextCannotReadThread).toBeTypeOf('function');
    expect(incompleteRuntimeContext).toBeDefined();
  });
});
