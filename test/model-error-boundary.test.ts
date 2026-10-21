import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { Thread } from '../src/core/types.js';
import type { PluginContext } from '../src/plugins/host.js';
import { summarizeAndEvaluate, type RollingSegment } from '../src/plugins/rolling-context.js';
import { sanitizeModelCallError } from '../src/contracts/model-error.js';
import { OpenAiCompatibleAdapter } from '../src/runtime/model.js';
import { setupRuntime } from './helpers.js';

const canary = 'synthetic-api-key-never-use-outside-this-test';

describe('shared Runtime model error boundary', () => {
  it('redacts a real OpenAI-compatible HTTP error from main and auxiliary model paths', async () => {
    const server = createServer((request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `Rejected ${request.headers.authorization ?? ''}` }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback test server did not bind a TCP port.');

    let completeAuxiliary:
      | ((request: {
          threadId: string;
          purpose: string;
          idempotencyKey: string;
          prompt: { system: string; turns: []; tools: []; model: string; temperature: number };
        }) => Promise<unknown>)
      | undefined;
    let setPluginState: ((key: string, value: unknown) => void) | undefined;
    const recorder = {
      id: 'test.model-error-recorder',
      name: 'Model error recorder',
      version: '1',
      activate(context: PluginContext) {
        completeAuxiliary = context.models.complete;
        setPluginState = context.state.set;
      },
    };
    const env = await setupRuntime(new OpenAiCompatibleAdapter(), { plugins: [recorder] });
    try {
      env.runtime.updateModelSettings({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: canary,
        model: 'boundary-test-model',
      });
      const thread = env.createThread('host');
      const runtimeErrors: unknown[] = [];
      env.runtime.subscribe((event) => {
        if (event.type === 'runtime.error') runtimeErrors.push(event);
      });
      await env.runtime.submit(thread.id, 'main-error-boundary', 'Trigger the local provider failure.');
      await env.runtime.drain();

      const execution = env.store.listExecutions(thread.id).find((item) => item.kind === 'model');
      expect(execution).toMatchObject({ status: 'failed', error: 'Model provider returned HTTP 401.' });
      expect(runtimeErrors).toContainEqual(
        expect.objectContaining({ type: 'runtime.error', message: 'Model provider returned HTTP 401.' }),
      );
      const mainDiagnostic = execution && env.runtime.getModelInputAttempts(thread.id, execution.id);
      expect(mainDiagnostic?.some((attempt) => attempt.error === 'Model request failed (http_401).')).toBe(true);

      const auxiliaryError = await completeAuxiliary!({
        threadId: thread.id,
        purpose: 'rolling-summary',
        idempotencyKey: 'redaction-check',
        prompt: { system: 'Summarize.', turns: [], tools: [], model: 'boundary-test-model', temperature: 0 },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(auxiliaryError).toBeInstanceOf(Error);
      const auxiliaryMessage = auxiliaryError instanceof Error ? auxiliaryError.message : String(auxiliaryError);
      expect(auxiliaryMessage).toBe('Model provider returned HTTP 401.');

      // Exercise Rolling Context's failure-to-reason path with the actual Runtime model service.
      const segment: RollingSegment = {
        id: 'redaction-segment',
        threadId: thread.id,
        startSeq: 1,
        endSeq: 1,
        sourceRecordIds: [],
        sourceHash: '0'.repeat(64),
        tier: 'hot',
        summary: null,
        summaryVersion: null,
        summaryStatus: 'pending',
        summaryCallId: null,
        evaluator: {
          status: 'pending',
          recommendation: null,
          reason: null,
          confidence: null,
          expectedSavings: null,
          cacheCostDataKnown: false,
          callId: null,
        },
        transitions: [],
        updatedAt: new Date().toISOString(),
      };
      const rollingContext = {
        models: { complete: completeAuxiliary },
      } as unknown as PluginContext;
      const rolled = await summarizeAndEvaluate(
        rollingContext,
        env.runtime.getThread(thread.id) as Thread,
        segment,
        'Only a local synthetic source record.',
      );
      expect(rolled.summaryStatus).toBe('failed');
      expect(rolled.evaluator.reason).toBe('Model provider returned HTTP 401.');

      // Simulate the plugin's state and Canonical recording of error.message/reason.
      setPluginState!('last-model-error', auxiliaryMessage);
      env.store.appendPluginRecord(thread.id, 'test.model-error-recorder', {
        action: 'rolling-summary-failed',
        reason: rolled.evaluator.reason,
      });

      const snapshot = env.runtime.getSnapshot(thread.id);
      const exposed = JSON.stringify({
        canonical: env.store.listRecords(thread.id),
        snapshot,
        executions: env.store.listExecutions(thread.id),
        diagnostics: mainDiagnostic,
        runtimeErrors,
        auxiliaryError: auxiliaryMessage,
        pluginState: env.store.getPluginState('test.model-error-recorder', 'last-model-error', ''),
        rollingState: rolled,
      });
      expect(exposed.includes(canary)).toBe(false);
      expect(exposed.includes('Bearer ')).toBe(false);
    } finally {
      await env.cleanup();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

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
    const provider = {
      id: 'test.trace-error-provider',
      name: 'Trace error provider',
      version: '1',
      activate(context: PluginContext) {
        context.models.registerProvider(
          { id: 'trace-error-provider', label: 'Trace error provider' },
          async (input) => {
            const attemptId = input.requestTrace!.started({
              provider: 'trace-error-provider',
              protocol: 'test',
              endpoint: 'https://models.example.test/v1',
              attempt: 1,
            });
            input.requestTrace!.settled(attemptId, {
              outcome: 'failed',
              durationMs: 1,
              errorCategory: 'http',
              errorCode: canary,
            });
            throw new Error(canary);
          },
        );
      },
    };
    const env = await setupRuntime(
      {
        async complete() {
          throw new Error('The default adapter must not run.');
        },
      },
      { plugins: [provider] },
    );
    try {
      const thread = env.createThread('host', 'Provider trace boundary');
      const selection = env.runtime.threadModelSelection(thread.id);
      env.runtime.updateThreadModelSelection(thread.id, {
        ...selection,
        provider: 'trace-error-provider',
        model: 'trace-test-model',
        parameters: { options: {} },
      });
      await env.runtime.submit(thread.id, 'trace-error-boundary', 'Run once.');
      await env.runtime.drain();

      const execution = env.store.listExecutions(thread.id).find((item) => item.kind === 'model');
      expect(execution).toMatchObject({ status: 'failed', error: 'Model request failed (provider_error).' });
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
