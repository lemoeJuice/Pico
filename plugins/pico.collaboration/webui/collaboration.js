(() => {
  const pluginId = 'pico.collaboration';
  let port = null, sequence = 0, context = { thread: null }, children = [], pending = false, error = '';
  const messages = new Map(), requests = new Map();
  const para = (text) => ({ type: 'paragraph', text: String(text ?? '') });
  const group = (...children) => ({ type: 'group', children });
  const card = (...children) => ({ type: 'card', children: [{ type: 'group', layout: 'stack-compact', children }] });
  const button = (label, actionId, disabled = false) => ({ type: 'button', label, actionId, disabled });
  const statusTone = (state) => ['completed', 'running', 'active'].includes(state) ? 'success' : ['failed', 'interrupted'].includes(state) ? 'danger' : 'neutral';
  const apiRoot = `/api/plugins/${pluginId}`;
  const updateToolbarCount = () => port?.postMessage({
    type: 'pico:plugin-ui:toolbar-state',
    badgeCount: Math.min(999, children.length),
  });
  const request = (action, payload) => new Promise((resolve, reject) => {
    const id = `collaboration-${++sequence}`; requests.set(id, { resolve, reject });
    port.postMessage({ type: 'pico:plugin-ui:request', id, action, ...payload });
  });
  const api = (path, init) => request('api', { path, ...(init ? { init } : {}) });
  const openThread = (threadId) => request('open-thread', { threadId });
  function render() {
    updateToolbarCount();
    if (!context.thread) {
      port?.postMessage({
        type: 'pico:plugin-ui:render',
        tree: [card({ type: 'heading', text: 'Child Threads' }, para('Select a Thread to inspect its child Threads.'))],
      });
      return;
    }
    const nodes = [group(
      { type: 'group', layout: 'spread', children: [
        { type: 'heading', text: 'Child Threads' },
        { type: 'status', text: String(children.length) },
      ] },
    )];
    if (error) nodes.push({ type: 'status', text: error, tone: 'danger' });
    for (const child of children) {
      const content = [group(
        { type: 'heading', text: child.title },
        { type: 'status', text: child.state, tone: statusTone(child.state) },
      ), para(`${child.executorLabel} · ${child.id}`)];
      if (child.pauseReason) content.push(para(child.pauseReason));
      content.push({ type: 'actions', children: [
        button('Open', `open:${child.id}`, pending),
        button(child.state === 'paused' ? 'Continue' : 'Pause', `state:${child.id}:${child.state === 'paused' ? 'resume' : 'pause'}`, pending),
      ] });
      content.push({ type: 'textArea', label: `Message ${child.title}`, value: messages.get(child.id) ?? '', placeholder: 'Send a follow-up message…', actionId: `message:${child.id}`, rows: 'compact', maxLength: 20000, disabled: pending });
      content.push({ type: 'actions', children: [button('Send', `send:${child.id}`, pending || !(messages.get(child.id) ?? '').trim(),)] });
      nodes.push(card(...content));
    }
    if (!children.length) nodes.push(card(para('No child Threads yet. Ask the agent to delegate a bounded task with spawn_thread.')));
    nodes.push(para('Messages use normal Thread history. Sending a message does not resume a paused child.'));
    port?.postMessage({ type: 'pico:plugin-ui:render', tree: nodes });
  }
  async function refresh() {
    if (!context.thread?.id) { children = []; render(); return; }
    const result = await api(`${apiRoot}/threads?threadId=${encodeURIComponent(context.thread.id)}`);
    children = Array.isArray(result.children) ? result.children : []; render();
  }
  async function act(action) {
    const id = action.actionId;
    if (id.startsWith('message:')) { if (typeof action.value === 'string') messages.set(id.slice(8), action.value); render(); return; }
    if (id.startsWith('open:')) {
      pending = true; error = ''; render();
      try { await openThread(id.slice(5)); } catch (failure) { error = failure.message || String(failure); }
      finally { pending = false; render(); }
      return;
    }
    const [verb, childId, stateAction] = id.split(':');
    if (verb !== 'state' && verb !== 'send') return;
    pending = true; error = ''; render();
    try {
      if (verb === 'state') await api(`${apiRoot}/threads/state`, { method: 'POST', body: JSON.stringify({ parentThreadId: context.thread.id, childThreadId: childId, action: stateAction }) });
      else {
        const message = (messages.get(childId) ?? '').trim(); if (!message) return;
        await api(`${apiRoot}/threads/message`, { method: 'POST', body: JSON.stringify({ parentThreadId: context.thread.id, childThreadId: childId, message, operationId: crypto.randomUUID() }) });
        messages.set(childId, '');
      }
      await refresh();
    } catch (failure) { error = failure.message || String(failure); }
    finally { pending = false; render(); }
  }
  window.addEventListener('message', (event) => {
    const init = event.data;
    if (event.source !== window.parent || init?.type !== 'pico:plugin-ui:init' || init.protocolVersion !== 1 || init.pluginId !== pluginId || init.entry !== 'webui' || !['page', 'component'].includes(init.viewType) || !['CollaborationPanel', 'collaboration'].includes(init.viewId) || event.ports.length !== 1) return;
    context = init.context || context; port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === 'pico:plugin-ui:response' && requests.has(data.id)) { const request = requests.get(data.id); requests.delete(data.id); data.ok ? request.resolve(data.value) : request.reject(new Error(data.error)); }
      else if (data?.type === 'pico:plugin-ui:action') void act(data);
      else if (data?.type === 'pico:plugin-ui:context') { context = data.context || context; void refresh().catch((failure) => { error = failure.message || String(failure); render(); }); }
    };
    port.start(); render(); if (typeof init.attemptId === 'string') port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId });
    void refresh().catch((failure) => { error = failure.message || String(failure); render(); });
  });
})();
