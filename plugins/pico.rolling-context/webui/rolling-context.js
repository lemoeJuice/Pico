(() => {
  const pluginId = 'pico.rolling-context';
  let port = null, seq = 0, context = { thread: null }, segments = [], inputs = [], segmentPage = 0, inputPage = 0, pending = false, error = '';
  let openDetail = '', detailPage = 0;
  const pageSize = 10, detailSize = 8000;
  let economics = null, economicsThreadId = null;
  const emptyEconomics = () => ({ provider: '', model: '', inputPerMillion: '', cachedInputPerMillion: '', cacheWritePerMillion: '', expectedFutureCalls: '', charactersPerToken: '' });
  let economicsDraft = emptyEconomics();
  const requests = new Map(), sourceById = new Map(), openDisclosures = new Set(['inputs']);
  const text = (text) => ({ type: 'text', text: String(text ?? '') });
  const para = (text) => { const value = String(text ?? ''); return { type: 'paragraph', text: value.length > 2000 ? `${value.slice(0, 1999)}…` : value }; };
  const detail = (key, label, value) => {
    const open = openDetail === key;
    const content = String(value ?? '');
    const pages = Math.max(1, Math.ceil(content.length / detailSize));
    const page = Math.min(detailPage, pages - 1);
    const children = open ? [{ type: 'paragraph', text: content.slice(page * detailSize, (page + 1) * detailSize) }] : [];
    if (open && pages > 1) children.push(para(`Part ${page + 1} of ${pages}`), { type: 'actions', children: [button('Previous part', 'detail:previous', page === 0), button('Next part', 'detail:next', page + 1 >= pages)] });
    return { type: 'disclosure', label, open, actionId: `detail:open:${key}`, children };
  };
  const pagination = (kind, page, total) => {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    return pages > 1 ? [para(`Page ${page + 1} of ${pages}`), { type: 'actions', children: [button('Previous page', `page:${kind}:previous`, page === 0), button('Next page', `page:${kind}:next`, page + 1 >= pages)] }] : [];
  };
  const button = (label, actionId, disabled = pending) => ({ type: 'button', label, actionId, disabled });
  const input = (label, value, actionId, inputType = 'text') => ({ type: 'textInput', label, value: String(value ?? ''), actionId, inputType, ...(inputType === 'number' ? { min: 0, step: 'any' } : {}) });
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
    const nodes = [{ type: 'heading', text: `Rolling Context · ${segments.length} model round(s)` }, para('User messages stay verbatim. Completed model rounds may be summarized when the next model step begins; the Agent can compact older rounds when the estimated cost permits. Canonical History stays intact.'),
      { type: 'actions', children: [button('Refresh', 'global:refresh')] }];
    nodes.push({ type: 'disclosure', label: 'Cost estimate settings', open: openDisclosures.has('economics'), actionId: 'disclosure:economics', children: [
      para('Configure the current provider and model rates, expected future calls, and an estimated characters-per-token ratio. Estimates assume the old suffix is cached and the new suffix is written once, then read from cache; actual token counts and cache hits may differ.'),
      input('Provider', economicsDraft.provider, 'economics:provider'),
      input('Model', economicsDraft.model, 'economics:model'),
      input('Input price / 1M tokens', economicsDraft.inputPerMillion, 'economics:inputPerMillion', 'number'),
      input('Cache read price / 1M tokens', economicsDraft.cachedInputPerMillion, 'economics:cachedInputPerMillion', 'number'),
      input('Cache write price / 1M tokens', economicsDraft.cacheWritePerMillion, 'economics:cacheWritePerMillion', 'number'),
      input('Expected future model calls', economicsDraft.expectedFutureCalls, 'economics:expectedFutureCalls', 'number'),
      input('Estimated characters per token', economicsDraft.charactersPerToken, 'economics:charactersPerToken', 'number'),
      para(economics ? `Active estimate: ${economics.provider} / ${economics.model}.` : 'No estimate configured; Agent compaction cannot be evaluated.'),
      { type: 'actions', children: [button('Save cost estimate', 'economics:save')] },
    ] });
    if (error) nodes.push(para(error));
    if (!segments.length) nodes.push(para('No summarized model rounds yet. A completed round becomes eligible when the next model step starts.'));
    segmentPage = Math.min(segmentPage, Math.max(0, Math.ceil(segments.length / pageSize) - 1));
    inputPage = Math.min(inputPage, Math.max(0, Math.ceil(inputs.length / pageSize) - 1));
    const segmentRows = [...segments].sort((a,b) => b.startSeq-a.startSeq).slice(segmentPage * pageSize, (segmentPage + 1) * pageSize);
    for (const [index, segment] of segmentRows.entries()) {
      const actions = [];
      if (segment.summaryStatus !== 'completed') actions.push(button('Retry summary', `action:retry-summary:${segment.id}`));
      actions.push(button('Jump to source', `open:${segment.startSeq}`, false));
      const children = [
        { type: 'heading', text: `Canonical #${segment.startSeq}–#${segment.endSeq} · ${segment.tier}` },
        para(`${segment.id} · SHA-256 ${segment.sourceHash} · summary ${segment.summaryStatus} · ${segment.sourceRecordIds?.length || 0} records`),
      ];
      if (segment.summary) children.push(detail(`summary:${index}`, `Direct summary · ${segment.summaryVersion}`, segment.summary));
      children.push(detail(`source:${index}`, sourceById.has(segment.id) ? 'Canonical source' : 'Load exact Canonical source', sourceById.get(segment.id) ?? 'Loading source…'));
      const evaluator = segment.evaluator || {};
      children.push(para(`Evaluator: ${evaluator.status} · ${evaluator.recommendation || 'no recommendation'} · ${evaluator.reason || 'not evaluated'} · expected savings ${evaluator.expectedSavings ?? 'unknown'} · cache data ${evaluator.cacheCostDataKnown ? 'known' : 'unknown'}`));
      const transitions = segment.transitions || [];
      children.push(detail(`transitions:${index}`, `Tier transition history (${transitions.length})`, transitions.length ? transitions.map((item) => `${item.from} → ${item.to} · ${item.reason}`).join('\n') : 'No changes yet.'));
      children.push({ type: 'actions', children: actions }); nodes.push({ type: 'card', children });
    }
    nodes.push(...pagination('segments', segmentPage, segments.length));
    const inputRows = [...inputs].reverse().slice(inputPage * pageSize, (inputPage + 1) * pageSize).map(({ executionId, attempt }, index) => ({ type: 'card', children: [
      { type: 'heading', text: `Model Execution ${executionId} · ${attempt.status}` },
      para(`Request ${attempt.id} · ${attempt.prompt?.model || 'model unknown'} · ${attempt.createdAt}`),
      detail(`prompt:${index}`, 'Exact prompt sent to Model Adapter', openDetail === `prompt:${index}` ? JSON.stringify(attempt.prompt, null, 2) : ''),
      ...(attempt.error ? [para(attempt.error)] : []),
    ] }));
    nodes.push({ type: 'disclosure', label: `Actual Model Inputs (${inputs.length})`, open: openDisclosures.has('inputs'), actionId: 'disclosure:inputs', children: inputRows.length ? [...inputRows, ...pagination('inputs', inputPage, inputs.length)] : [para('No recorded Model Inputs for this Thread yet.')] });
    port?.postMessage({ type: 'pico:plugin-ui:render', tree: nodes });
  }
  async function refresh() {
    if (!context.thread?.id) { segments = []; inputs = []; draw(); return; }
    const threadId = encodeURIComponent(context.thread.id);
    const [result, inputResult] = await Promise.all([api(`/api/plugins/${pluginId}/segments?threadId=${threadId}`), api(`/api/plugins/${pluginId}/inputs?threadId=${threadId}`)]);
    segments = Array.isArray(result.segments) ? result.segments : []; inputs = Array.isArray(inputResult.inputs) ? inputResult.inputs : []; draw();
  }
  async function loadEconomics() {
    const threadId = context.thread?.id;
    if (!threadId || economicsThreadId === threadId) return;
    economics = null; economicsDraft = emptyEconomics(); economicsThreadId = null;
    const result = await api(`/api/plugins/${pluginId}/economics?threadId=${encodeURIComponent(threadId)}`);
    if (context.thread?.id !== threadId) return;
    economics = result?.economics ?? null;
    if (economics) economicsDraft = Object.fromEntries(Object.keys(economicsDraft).map((key) => [key, String(economics[key] ?? '')]));
    economicsThreadId = threadId; draw();
  }
  async function handle(a) {
    const id = a.actionId;
    if (id === 'economics:save') {
      if (pending) return;
      pending = true; error = ''; draw();
      try {
        const body = { ...economicsDraft, threadId: context.thread?.id };
        for (const key of ['inputPerMillion', 'cachedInputPerMillion', 'cacheWritePerMillion', 'expectedFutureCalls', 'charactersPerToken']) {
          if (!body[key].trim()) throw new Error(`Enter ${key}.`);
          body[key] = Number(body[key]);
        }
        const result = await api(`/api/plugins/${pluginId}/economics`, { method: 'PUT', body: JSON.stringify(body) });
        economics = result?.economics ?? null;
      } catch (failure) { error = failure.message || String(failure); }
      finally { pending = false; draw(); }
      return;
    }
    if (id.startsWith('economics:')) { const key = id.slice('economics:'.length); if (Object.hasOwn(economicsDraft, key)) economicsDraft[key] = a.value ?? ''; return; }
    if (id === 'detail:previous' || id === 'detail:next') { detailPage = Math.max(0, detailPage + (id.endsWith('next') ? 1 : -1)); draw(); return; }
    if (id.startsWith('page:')) {
      const [, kind, direction] = id.split(':');
      const delta = direction === 'next' ? 1 : -1;
      if (kind === 'segments') segmentPage = Math.max(0, segmentPage + delta);
      else if (kind === 'inputs') inputPage = Math.max(0, inputPage + delta);
      openDetail = ''; detailPage = 0; draw(); return;
    }
    if (id.startsWith('detail:open:')) {
      const key = id.slice('detail:open:'.length);
      openDetail = a.value === 'true' ? key : ''; detailPage = 0;
      if (openDetail.startsWith('source:')) {
        const index = Number(openDetail.slice('source:'.length));
        const segment = [...segments].sort((a,b) => b.startSeq-a.startSeq)[segmentPage * pageSize + index];
        if (segment && !sourceById.has(segment.id)) try {
          draw();
          const result = await api(`/api/plugins/${pluginId}/source?threadId=${encodeURIComponent(context.thread.id)}&segmentId=${encodeURIComponent(segment.id)}`);
          sourceById.set(segment.id, result.source);
        } catch (failure) { error = failure.message || String(failure); }
      }
      draw(); return;
    }
    if (id.startsWith('disclosure:')) {
      const key = id.slice('disclosure:'.length);
      if (a.value === 'true') openDisclosures.add(key); else openDisclosures.delete(key);
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
      else if (data?.type === 'pico:plugin-ui:context') { if (data.context?.thread?.id !== context.thread?.id) { segmentPage = 0; inputPage = 0; openDetail = ''; detailPage = 0; sourceById.clear(); } context = data.context || context; void Promise.all([refresh(), loadEconomics()]).catch((failure) => { error = failure.message; draw(); }); }
    };
    port.start(); draw(); if (typeof init.attemptId === 'string') port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId }); void Promise.all([refresh(), loadEconomics()]).catch((failure) => { error = failure.message; draw(); });
  });
})();
