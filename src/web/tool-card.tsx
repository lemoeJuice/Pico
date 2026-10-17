import type { Execution, ToolCall, ToolResultPayload } from '../core/types.js';
import type { ReactNode } from 'react';

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCard({
  call,
  execution,
  result,
  preview,
  resultActions,
}: {
  call: ToolCall;
  execution: Execution | undefined;
  result: ToolResultPayload | undefined;
  preview?: { argumentsText: string };
  resultActions?: ReactNode;
}) {
  const status = execution?.status ?? result?.status ?? 'pending';
  const hasError = Boolean(execution?.error || result?.status === 'failed' || result?.status === 'interrupted');
  const outcomeUnconfirmed = execution?.error?.includes('The Executor did not confirm an outcome.') ?? false;
  const structuredResult =
    result?.result && typeof result.result === 'object' && !Array.isArray(result.result)
      ? (result.result as Record<string, unknown>)
      : undefined;
  const modelGuidance = typeof structuredResult?.modelGuidance === 'string' ? structuredResult.modelGuidance : null;
  const resultText = preview
    ? 'Waiting for the model to finish this call…'
    : result?.status === 'interrupted'
      ? `The tool was interrupted. Its side effects may be partial or unknown. Inspect the workspace before retrying.${result.error ? `\n\n${result.error}` : ''}`
      : result?.status === 'failed'
        ? (result.error ?? 'Tool failed.')
        : result
          ? toJson(result.result)
          : execution?.error
            ? `${execution.error}${execution.status === 'pending' && !outcomeUnconfirmed ? '\n\nContinue this Thread to retry the same Execution.' : ''}`
            : execution?.status === 'running'
              ? 'Running in the selected Executor…'
              : 'Waiting for the Executor…';
  return (
    <article
      className={`conversation-detail-card pico-ui-card tool-card tool-${status}${hasError ? ' tool-has-error' : ''}`}
      data-phase={preview ? 'generating' : status}
    >
      <div className="tool-card-heading pico-ui-heading">
        <span className="tool-name">{call.name}</span>
        <span className={`tool-status pico-ui-status status-${status}`} data-status={status}>
          {preview ? 'Generating' : status}
        </span>
      </div>
      <div className="tool-card-body">
        <section className="conversation-detail-row tool-detail">
          <div className="tool-detail-heading">Arguments</div>
          <pre className="pico-ui-preview">
            {preview ? preview.argumentsText || 'Waiting for arguments…' : toJson(call.arguments)}
          </pre>
        </section>
        <section className="conversation-detail-row tool-detail">
          <div className="tool-detail-heading">
            Result{' '}
            {execution?.updatedAt ? (
              <span className="subtle-inline">· {new Date(execution.updatedAt).toLocaleTimeString()}</span>
            ) : null}
          </div>
          <pre className={`pico-ui-preview tool-output${hasError ? ' tool-output-error' : ''}`}>{resultText}</pre>
          {modelGuidance ? (
            <>
              <div className="tool-detail-heading tool-model-guidance-heading">Model guidance</div>
              <pre className="pico-ui-preview tool-model-guidance">{modelGuidance}</pre>
            </>
          ) : null}
          {resultActions}
        </section>
      </div>
    </article>
  );
}
