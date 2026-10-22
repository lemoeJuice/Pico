(() => {
  const pluginId = 'pico.rolling-context';
  let port = null, seq = 0, context = { thread: null }, segments = [], inputs = [], visibleSegments = 30, visibleInputs = 20, pending = false, error = '';
  const requests = new Map(), sourceById = new Map(), openDisclosures = new Set(['inputs']);
  const text = (text) => ({ type: 'text', text: String(text ?? '') });
  const para = (text) => ({ type: 'paragraph', text: String(text ?? '') });
  const button = (label, actionId, disabled = pending) => ({ type: 'button', label, actionId, disabled });
  const api = (path, init) => request('api', { path, ...(init ? { init } : {}) });
  function request(action, payload = {}) { const id = `rolling-ui-${++seq}`; return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); port.postMessage({ type: 'pico:plugin-ui:request', id, action, ...payload }); }); }
  async function act(action, segmentId) {
    if (!context.thread?.id || pending) return;
    pending = true; error = ''; draw();
    try { const result = await api(`/api/plugins/${pluginId}/action`, { method: 'POST', body: JSON.stringify({ threadId: context.thread.id, action, ...(segmentId ? { segmentId } : {}) }) }); if (result?.segments) segments = result.segments; else await refresh(); }
    catch (failure) { error = failure.message || String(failure); }
    finally { pending = false; draw(); }
  }
  function draw() {
    if (!context.thread?.id) { port?.postMessage({ type: 'pico:plugin-ui:render', tree: [{ type: 'heading', text: 'Rolling Context' }, para('Select a Thread to inspect its context.')] }); return; }
    const nodes = [{ type: 'heading', text: `Rolling Context · ${segments.length} segment(s)` }, para('Canonical History stays intact. Tier review is skipped when Runtime cannot estimate complete net savings; Usage rates alone are insufficient. Segments stay hot; use manual compact to change tier.'),
      { type: 'actions', children: [button('Refresh / summarize sealed turns', 'global:refresh'), button('Manual compact summaries', 'global:compact-all')] }];
    if (error) nodes.push(para(error));
    if (!segments.length) nodes.push(para('No sealed complete turn blocks yet. A turn becomes eligible after a later user turn closes it.'));
    for (const segment of [...segments].sort((a,b) => b.startSeq-a.startSeq).slice(0, visibleSegments)) {
      const actions = [];
      if (segment.tier !== 'hot') actions.push(button('Pin hot', `action:pin:${segment.id}`));
      if (segment.tier !== 'warm' && segment.summary) actions.push(button('Manual warm', `action:warm:${segment.id}`));
      if (segment.tier === 'warm') actions.push(button('Move cold', `action:cold:${segment.id}`));
      if (segment.summaryStatus !== 'completed') actions.push(button('Retry summary', `action:retry-summary:${segment.id}`));
      actions.push(button('Jump to source', `open:${segment.startSeq}`, false));
      const children = [
        { type: 'heading', text: `Canonical #${segment.startSeq}–#${segment.endSeq} · ${segment.tier}` },
        para(`${segment.id} · SHA-256 ${segment.sourceHash} · summary ${segment.summaryStatus} · ${segment.sourceRecordIds?.length || 0} records`),
      ];
      if (segment.summary) children.push({ type: 'disclosure', label: `Direct summary · ${segment.summaryVersion}`, open: openDisclosures.has(`summary:${segment.id}`), actionId: `disclosure:summary:${segment.id}`, children: [para(segment.summary)] });
      children.push({ type: 'disclosure', label: sourceById.has(segment.id) ? 'Canonical source' : 'Load exact Canonical source', open: openDisclosures.has(`source:${segment.id}`), actionId: `disclosure:source:${segment.id}`, children: [sourceById.has(segment.id) ? para(sourceById.get(segment.id)) : para('Use the disclosure to load source.')] });
      const evaluator = segment.evaluator || {};
      children.push(para(`Evaluator: ${evaluator.status} · ${evaluator.recommendation || 'no recommendation'} · ${evaluator.reason || 'not evaluated'} · expected savings ${evaluator.expectedSavings ?? 'unknown'} · cache data ${evaluator.cacheCostDataKnown ? 'known' : 'unknown'}`));
      const transitions = (segment.transitions || []).map((item) => para(`${item.from} → ${item.to} · ${item.reason}`));
      children.push({ type: 'disclosure', label: `Tier transition history (${transitions.length})`, open: openDisclosures.has(`transitions:${segment.id}`), actionId: `disclosure:transitions:${segment.id}`, children: transitions.length ? transitions : [para('No changes yet.')] });
      children.push({ type: 'actions', children: actions }); nodes.push({ type: 'card', children });
    }
    const inputRows = [...inputs].reverse().slice(0, visibleInputs).map(({ executionId, attempt }) => ({ type: 'card', children: [
      { type: 'heading', text: `Model Execution ${executionId} · ${attempt.status}` },
      para(`Request ${attempt.id} · ${attempt.prompt?.model || 'model unknown'} · ${attempt.createdAt}`),
      { type: 'disclosure', label: 'Exact prompt sent to Model Adapter', open: openDisclosures.has(`prompt:${executionId}`), actionId: `disclosure:prompt:${executionId}`, children: [para(JSON.stringify(attempt.prompt, null, 2))] },
      ...(attempt.error ? [para(attempt.error)] : []),
    ] }));
    nodes.push({ type: 'disclosure', label: `Actual Model Inputs (${inputs.length})`, open: openDisclosures.has('inputs'), actionId: 'disclosure:inputs', children: inputRows.length ? inputRows : [para('No recorded Model Inputs for this Thread yet.')] });
    if (segments.length > visibleSegments || inputs.length > visibleInputs) nodes.push(button('Load more history', 'load-more', false));
    port?.postMessage({ type: 'pico:plugin-ui:render', tree: nodes });
  }
  async function refresh() {
    if (!context.thread?.id) { segments = []; inputs = []; draw(); return; }
    const threadId = encodeURIComponent(context.thread.id);
    const [result, inputResult] = await Promise.all([api(`/api/plugins/${pluginId}/segments?threadId=${threadId}`), api(`/api/plugins/${pluginId}/inputs?threadId=${threadId}`)]);
    segments = Array.isArray(result.segments) ? result.segments : []; inputs = Array.isArray(inputResult.inputs) ? inputResult.inputs : []; draw();
  }
  async function handle(a) {
    const id = a.actionId;
    if (id === 'load-more') { visibleSegments += 30; visibleInputs += 20; draw(); return; }
    if (id.startsWith('disclosure:')) {
      const key = id.slice('disclosure:'.length);
      if (a.value === 'true') openDisclosures.add(key); else openDisclosures.delete(key);
      if (key.startsWith('source:') && a.value === 'true') {
        const segmentId = key.slice('source:'.length);
        if (!sourceById.has(segmentId)) try {
          const result = await api(`/api/plugins/${pluginId}/source?threadId=${encodeURIComponent(context.thread.id)}&segmentId=${encodeURIComponent(segmentId)}`);
          sourceById.set(segmentId, result.source);
        } catch (failure) { error = failure.message || String(failure); }
      }
      draw(); return;
    }
    if (id.startsWith('global:')) { await act(id.slice(7)); return; }
    if (id.startsWith('action:')) { const [, action, ...parts] = id.split(':'); await act(action, parts.join(':')); return; }
    if (id.startsWith('open:')) { try { await request('open-message', { seq: Number(id.slice(5)) }); } catch (failure) { error = failure.message || String(failure); draw(); } return; }
  }
  window.addEventListener('message', (event) => {
    const init = event.data;
    if (event.source !== window.parent || init?.type !== 'pico:plugin-ui:init' || init.protocolVersion !== 1 || init.pluginId !== pluginId || init.entry !== 'webui' || init.viewType !== 'component' || init.viewId !== 'RollingContextPanel' || event.ports.length !== 1) return;
    context = init.context || context; port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === 'pico:plugin-ui:response' && requests.has(data.id)) { const request = requests.get(data.id); requests.delete(data.id); data.ok ? request.resolve(data.value) : request.reject(new Error(data.error)); }
      else if (data?.type === 'pico:plugin-ui:action') void handle(data);
      else if (data?.type === 'pico:plugin-ui:context') { context = data.context || context; void refresh().catch((failure) => { error = failure.message; draw(); }); }
    };
    port.start(); draw(); if (typeof init.attemptId === 'string') port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId }); void refresh().catch((failure) => { error = failure.message; draw(); });
  });
})();
