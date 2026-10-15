import { describe, expect, it } from 'vitest';
import { ExecutionPipelines } from '../src/core/pipeline.js';

describe('execution pipeline priorities', () => {
  it('uses stable explicit priority order and reports the effective order', async () => {
    const pipelines = new ExecutionPipelines();
    const calls: string[] = [];
    pipelines.use(
      'projection',
      'later',
      async (input, next) => {
        calls.push('later:before');
        const result = await next(input);
        calls.push('later:after');
        return result;
      },
      20,
    );
    pipelines.use(
      'projection',
      'first',
      async (input, next) => {
        calls.push('first:before');
        const result = await next(input);
        calls.push('first:after');
        return result;
      },
      10,
    );

    await pipelines.run('projection', {}, async () => {
      calls.push('terminal');
      return undefined;
    });

    expect(calls).toEqual(['first:before', 'later:before', 'terminal', 'later:after', 'first:after']);
    expect(pipelines.registrations()).toEqual([
      { stage: 'projection', pluginId: 'first', order: 0 },
      { stage: 'projection', pluginId: 'later', order: 1 },
    ]);
  });
});
