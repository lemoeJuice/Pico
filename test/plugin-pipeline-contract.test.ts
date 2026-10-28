import { describe, expect, it } from 'vitest';
import type { PluginContext } from '../src/plugins/host.js';
import type { Interceptor } from '../src/core/pipeline.js';
import type { StepInput } from '../src/contracts/plugin-pipeline.js';

function registerStepInterceptorOnProjection(pipelines: PluginContext['pipelines']): void {
  const stepInterceptor: Interceptor<StepInput, void> = async (input, next) => next(input);
  // @ts-expect-error Projection interceptors require ProjectionInput -> ProjectionInput.
  pipelines.use('projection', stepInterceptor);
}

describe('plugin pipeline type contract', () => {
  it('rejects registering a Step interceptor on Projection', () => {
    expect(registerStepInterceptorOnProjection).toBeTypeOf('function');
  });
});
