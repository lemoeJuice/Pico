import type { Execution, ToolCall, ToolResultPayload } from '../core/types.js';

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
}: {
  call: ToolCall;
  execution: Execution | undefined;
  result: ToolResultPayload | undefined;
}) {
  const status = execution?.status ?? result?.status ?? 'pending';
  const hasError = Boolean(execution?.error || result?.status === 'failed' || result?.status === 'interrupted');
  const outcomeUnconfirmed = execution?.error?.includes('The Executor did not confirm an outcome.') ?? false;
  const resultText =
    result?.status === 'interrupted'
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
    <article className={`conversation-detail-card tool-card tool-${status}${hasError ? ' tool-has-error' : ''}`}>
      <div className="tool-card-heading">
        <span className="tool-name">{call.name}</span>
        <span className={`tool-status status-${status}`}>{status}</span>
      </div>
      <div className="tool-card-body">
        <section className="conversation-detail-row tool-detail">
          <div className="tool-detail-heading">Arguments</div>
          <pre>{toJson(call.arguments)}</pre>
        </section>
        <section className="conversation-detail-row tool-detail">
          <div className="tool-detail-heading">
            Result{' '}
            {execution?.updatedAt ? (
              <span className="subtle-inline">· {new Date(execution.updatedAt).toLocaleTimeString()}</span>
            ) : null}
          </div>
          <pre className={`tool-output${hasError ? ' tool-output-error' : ''}`}>{resultText}</pre>
        </section>
      </div>
    </article>
  );
}
