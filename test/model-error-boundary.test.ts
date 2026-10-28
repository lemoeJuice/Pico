import { describe, expect, it } from 'vitest';
import { sanitizeModelCallError } from '../src/contracts/model-error.js';
import { OpenAiCompatibleAdapter } from '../src/runtime/model.js';
import { setupRuntime } from './helpers.js';

const canary = 'synthetic-api-key-never-use-outside-this-test';

describe('shared Runtime model error boundary', () => {
  it('preserves AbortError and sanitizes non-Error adapter failures', async () => {
    const controller = new AbortController();
    const unrequestedAbortError = sanitizeModelCallError(new DOMException(canary, 'AbortError'), controller.signal);
    expect(unrequestedAbortError).toMatchObject({
      name: 'ModelCallError',
      message: 'Model request failed (provider_error).',
    });
    controller.abort();
    const abortError = sanitizeModelCallError(new DOMException(canary, 'AbortError'), controller.signal);
    expect(abortError).toMatchObject({ name: 'AbortError', message: 'The model request was aborted.' });
    expect((abortError as Error).message.includes(canary)).toBe(false);

    let calls = 0;
    const model = {
      async complete() {
        calls += 1;
        throw calls === 1 ? new DOMException(canary, 'AbortError') : canary;
      },
    } as unknown as OpenAiCompatibleAdapter;
    const env = await setupRuntime(model);
    try {
      const abortThread = env.createThread('host', 'Unrequested AbortError');
      await env.runtime.submit(abortThread.id, 'unrequested-abort-error', 'Run once.');
      await env.runtime.drain();
      const abortExecution = env.store.listExecutions(abortThread.id).find((item) => item.kind === 'model');
      expect(abortExecution).toMatchObject({ status: 'failed', error: 'Model request failed (provider_error).' });
      expect(env.runtime.getThread(abortThread.id)?.pauseRequested).toBe(true);
      expect(calls).toBe(1);

      const nonErrorThread = env.createThread('host', 'Non-Error boundary');
      await env.runtime.submit(nonErrorThread.id, 'non-error-boundary', 'Run once.');
      await env.runtime.drain();
      const nonErrorExecution = env.store.listExecutions(nonErrorThread.id).find((item) => item.kind === 'model');
      expect(nonErrorExecution).toMatchObject({
        status: 'failed',
        error: 'Model request failed (provider_error).',
      });
      expect(env.runtime.getThread(nonErrorThread.id)?.pauseRequested).toBe(true);
      expect(calls).toBe(2);
      expect(JSON.stringify(env.runtime.getSnapshot(abortThread.id)).includes(canary)).toBe(false);
      expect(JSON.stringify(env.runtime.getSnapshot(nonErrorThread.id)).includes(canary)).toBe(false);
    } finally {
      await env.cleanup();
    }
  }, 20_000);

  it('filters an untrusted provider error code passed through trace callbacks', async () => {
    let attempts = 0;
    const env = await setupRuntime({
      async complete(_prompt, _settings, _signal, _onText, trace) {
        attempts += 1;
        if (!trace) throw new Error('Trace is required for this test');
        const attemptId = trace.started({
          provider: 'pico.test-provider',
          protocol: 'openai-chat-completions',
          endpoint: 'https://test.invalid/v1',
          attempt: 1,
        });
        trace.settled(attemptId, { outcome: 'failed', durationMs: 1, errorCategory: 'http', errorCode: canary });
        throw new Error(canary);
      },
    });
    try {
      const thread = env.createThread('host', 'Provider trace boundary');
      await env.runtime.submit(thread.id, 'trace-error-boundary', 'Run once.');
      await env.runtime.drain();

      const execution = env.store.listExecutions(thread.id).find((item) => item.kind === 'model');
      expect(execution).toMatchObject({ status: 'failed', error: 'Model request failed (provider_error).' });
      expect(attempts).toBe(1);
      expect(execution && env.store.listExecutionLog(execution.id, 'provider-request-settled')).toEqual([
        expect.objectContaining({ detail: expect.objectContaining({ outcome: 'failed', errorCategory: 'http' }) }),
      ]);
      const diagnostics = execution && [
        ...env.store.listExecutionLog(execution.id, 'provider-request-settled'),
        ...env.store.listExecutionLog(execution.id, 'model-input-settled'),
      ];
      expect(JSON.stringify(diagnostics).includes(canary)).toBe(false);
      const publicAttempts = execution && env.runtime.getModelInputAttempts(thread.id, execution.id);
      expect(JSON.stringify(publicAttempts).includes(canary)).toBe(false);
      expect(JSON.stringify(env.runtime.getSnapshot(thread.id)).includes(canary)).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  it('keeps a missing model base URL actionable at the adapter boundary', async () => {
    const adapter = new OpenAiCompatibleAdapter();
    await expect(
      adapter.complete(
        { system: '', turns: [], tools: [], model: 'test-model', temperature: 0 },
        { baseUrl: '', apiKey: '', model: 'test-model', provider: 'openai-compatible', temperature: 0 },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ name: 'ModelCallError', message: 'Model API base URL is required.' });
  });
});
