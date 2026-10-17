(() => {
  const pluginId = 'pico.rolling-context';
  const root = document.getElementById('root');
  let port = null;
  let seq = 0;
  let context = { thread: null };
  let segments = [];
  let inputs = [];
  let pending = false;
  let error = '';
  const sourceById = new Map();
  const requests = new Map();
  let resizeFrame = 0;
  const resizeObserver = new ResizeObserver(() => {
    if (!root || !port || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      port?.postMessage({ type: 'pico:plugin-ui:resize', height: root.getBoundingClientRect().height });
    });
  });
  if (root) resizeObserver.observe(root);
  const request = (action, value = {}) =>
    new Promise((resolve, reject) => {
      const id = `rolling-ui-${++seq}`;
      requests.set(id, { resolve, reject });
      port.postMessage({ type: 'pico:plugin-ui:request', id, action, ...value });
    });
  const api = (path, init) => request('api', { path, ...(init ? { init } : {}) });
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
  async function act(action, segmentId) {
    if (!context.thread?.id || pending) return;
    pending = true;
    error = '';
    render();
    try {
      const result = await api(`/api/plugins/${pluginId}/action`, {
        method: 'POST',
        body: JSON.stringify({ threadId: context.thread.id, action, ...(segmentId ? { segmentId } : {}) }),
      });
      if (result?.segments) segments = result.segments;
      else await refresh();
    } catch (failure) {
      error = failure.message || String(failure);
    } finally {
      pending = false;
      render();
    }
  }
  function render() {
    if (!root) return;
    if (!context.thread?.id) {
      root.innerHTML =
        '<section class="pico-ui-panel panel"><strong>Rolling Context</strong><p class="pico-ui-empty empty">Select a Thread to inspect its context.</p></section>';
      return;
    }
    const cards = [...segments]
      .sort((a, b) => b.startSeq - a.startSeq)
      .map((segment) => {
        const evaluator = segment.evaluator || {};
        const transitions = (segment.transitions || [])
          .map((item) => `<li>${escape(item.from)} → ${escape(item.to)} · ${escape(item.reason)}</li>`)
          .join('');
        const actions = [
          segment.tier !== 'hot'
            ? `<button class="pico-ui-button" data-action="pin" data-id="${escape(segment.id)}">Pin hot</button>`
            : '',
          segment.tier !== 'warm' && segment.summary
            ? `<button class="pico-ui-button" data-action="warm" data-id="${escape(segment.id)}">Manual warm</button>`
            : '',
          segment.tier === 'warm'
            ? `<button class="pico-ui-button" data-action="cold" data-id="${escape(segment.id)}">Move cold</button>`
            : '',
          segment.summaryStatus !== 'completed'
            ? `<button class="pico-ui-button" data-action="retry-summary" data-id="${escape(segment.id)}">Retry summary</button>`
            : '',
          `<button class="pico-ui-button" data-open="${segment.startSeq}">Jump to source</button>`,
        ]
          .filter(Boolean)
          .join('');
        return `<article class="pico-ui-card segment">
        <div class="segment-head"><strong>Canonical #${segment.startSeq}–#${segment.endSeq}</strong><span class="pico-ui-tag tier ${escape(segment.tier)}">${escape(segment.tier)}</span></div>
        <span class="muted">${escape(segment.id)} · SHA-256 ${escape(segment.sourceHash)} · summary ${escape(segment.summaryStatus)} · ${segment.sourceRecordIds?.length || 0} records</span>
        ${segment.summary ? `<details class="pico-ui-disclosure"><summary>Direct summary · ${escape(segment.summaryVersion)}</summary><div class="pico-ui-preview summary">${escape(segment.summary)}</div></details>` : ''}
        <details class="pico-ui-disclosure" data-source-details="${escape(segment.id)}"><summary data-source="${escape(segment.id)}">${sourceById.has(segment.id) ? 'Canonical source' : 'Load exact Canonical source'}</summary>${sourceById.has(segment.id) ? `<div class="pico-ui-preview source">${escape(sourceById.get(segment.id))}</div>` : ''}</details>
        <div class="muted">Evaluator: ${escape(evaluator.status)} · ${escape(evaluator.recommendation || 'no recommendation')} · ${escape(evaluator.reason || 'not evaluated')} · expected savings ${evaluator.expectedSavings ?? 'unknown'} · cache data ${evaluator.cacheCostDataKnown ? 'known' : 'unknown'}</div>
        <details class="pico-ui-disclosure"><summary>Tier transition history (${segment.transitions?.length || 0})</summary><ul>${transitions || '<li>No changes yet.</li>'}</ul></details>
        <div class="pico-ui-actions actions">${actions}</div>
      </article>`;
      })
      .join('');
    const inputCards = [...inputs]
      .reverse()
      .map(({ executionId, attempt }) => {
        const providerRequests = attempt.providerRequests || [];
        return `<article class="pico-ui-card segment">
        <div class="segment-head"><strong>Model Execution ${escape(executionId)}</strong><span class="pico-ui-tag tier">${escape(attempt.status)}</span></div>
        <span class="muted">Request ${escape(attempt.id)} · ${escape(attempt.prompt?.model || 'model unknown')} · ${escape(attempt.createdAt)}</span>
        <details class="pico-ui-disclosure"><summary>Exact prompt sent to Model Adapter</summary><pre class="pico-ui-preview source">${escape(JSON.stringify(attempt.prompt, null, 2))}</pre></details>
        <details class="pico-ui-disclosure"><summary>Provider attempts (${providerRequests.length})</summary><pre class="pico-ui-preview source">${escape(JSON.stringify(providerRequests, null, 2))}</pre></details>
        ${attempt.error ? `<div class="pico-ui-error error">${escape(attempt.error)}</div>` : ''}
      </article>`;
      })
      .join('');
    root.innerHTML = `<section class="pico-ui-panel panel">
      <div class="pico-ui-heading heading"><strong>ROLLING CONTEXT</strong><span class="muted">${segments.length} segment(s)</span></div>
      <div class="muted">Canonical History stays intact. Automatic warm is disabled when provider cache cost data is unknown.</div>
      <div class="toolbar"><button class="pico-ui-button" data-global="refresh" ${pending ? 'disabled' : ''}>Refresh / summarize sealed turns</button><button class="pico-ui-button" data-global="compact-all" ${pending ? 'disabled' : ''}>Manual compact summaries</button></div>
      ${error ? `<div class="pico-ui-error error" role="alert">${escape(error)}</div>` : ''}
      <div>${cards || '<p class="pico-ui-empty empty">No sealed complete turn blocks yet. A turn becomes eligible after a later user turn closes it.</p>'}</div>
      <details class="pico-ui-disclosure"><summary>Actual Model Inputs (${inputs.length})</summary><div class="input-list">${inputCards || '<p class="pico-ui-empty empty">No recorded Model Inputs for this Thread yet.</p>'}</div></details>
    </section>`;
    if (root && port && !resizeFrame) {
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        port?.postMessage({ type: 'pico:plugin-ui:resize', height: root.getBoundingClientRect().height });
      });
    }
    root
      .querySelectorAll('[data-global]')
      .forEach((button) => button.addEventListener('click', () => void act(button.dataset.global)));
    root
      .querySelectorAll('[data-action]')
      .forEach((button) => button.addEventListener('click', () => void act(button.dataset.action, button.dataset.id)));
    root.querySelectorAll('[data-open]').forEach((button) =>
      button.addEventListener('click', () => {
        const id = `rolling-ui-${++seq}`;
        requests.set(id, {
          resolve: () => {},
          reject: (failure) => {
            error = failure.message;
            render();
          },
        });
        port.postMessage({
          type: 'pico:plugin-ui:request',
          id,
          action: 'open-message',
          seq: Number(button.dataset.open),
        });
      }),
    );
    root.querySelectorAll('[data-source]').forEach((summary) =>
      summary.addEventListener('click', async (event) => {
        event.preventDefault();
        const segmentId = summary.dataset.source;
        if (sourceById.has(segmentId)) {
          summary.closest('details').open = !summary.closest('details').open;
          return;
        }
        try {
          const result = await api(
            `/api/plugins/${pluginId}/source?threadId=${encodeURIComponent(context.thread.id)}&segmentId=${encodeURIComponent(segmentId)}`,
          );
          sourceById.set(segmentId, result.source);
          render();
          root.querySelector(`[data-source-details="${CSS.escape(segmentId)}"]`).open = true;
        } catch (failure) {
          error = failure.message || String(failure);
          render();
        }
      }),
    );
  }
  async function refresh() {
    if (!context.thread?.id) {
      segments = [];
      inputs = [];
      render();
      return;
    }
    const threadId = encodeURIComponent(context.thread.id);
    const [result, inputResult] = await Promise.all([
      api(`/api/plugins/${pluginId}/segments?threadId=${threadId}`),
      api(`/api/plugins/${pluginId}/inputs?threadId=${threadId}`),
    ]);
    segments = Array.isArray(result.segments) ? result.segments : [];
    inputs = Array.isArray(inputResult.inputs) ? inputResult.inputs : [];
    render();
  }
  window.addEventListener('message', (event) => {
    const init = event.data;
    if (
      event.source !== window.parent ||
      !init ||
      init.type !== 'pico:plugin-ui:init' ||
      init.protocolVersion !== 1 ||
      init.pluginId !== pluginId ||
      init.entry !== 'webui' ||
      init.viewType !== 'component' ||
      init.viewId !== 'RollingContextPanel' ||
      event.ports.length !== 1
    )
      return;
    context = init.context || context;
    port = event.ports[0];
    port.onmessage = (messageEvent) => {
      const message = messageEvent.data;
      if (message?.type === 'pico:plugin-ui:response' && requests.has(message.id)) {
        const pendingRequest = requests.get(message.id);
        requests.delete(message.id);
        message.ok ? pendingRequest.resolve(message.value) : pendingRequest.reject(new Error(message.error));
      }
      if (message?.type === 'pico:plugin-ui:context') {
        context = message.context || context;
        void refresh().catch((failure) => {
          error = failure.message;
          render();
        });
      }
    };
    port.start();
    void refresh().catch((failure) => {
      error = failure.message;
      render();
    });
  });
})();
