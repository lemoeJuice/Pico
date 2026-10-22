(() => {
  'use strict';
  const pluginId = 'pico.goal';
  let port = null;
  let context = { thread: null };
  let goal = null;
  let busy = false;
  let error = '';
  let editing = false;
  let fields = { text: '', constraints: '', completionCriteria: '' };
  let sequence = 0;
  const pending = new Map();
  const text = (value) => ({ type: 'text', text: String(value ?? '') });
  const paragraph = (value) => ({ type: 'paragraph', text: String(value ?? '') });
  const group = (...children) => {
    const layouts = ['row', 'spread', 'grid-2', 'grid-compact', 'grid-standard', 'stack-compact'];
    const layout = layouts.includes(children.at(-1)) ? children.pop() : undefined;
    return { type: 'group', children, ...(layout ? { layout } : {}) };
  };
  const card = (...children) => ({ type: 'card', children: [group(...children, 'stack-compact')] });
  const button = (label, actionId, options = {}) => ({ type: 'button', label, actionId, ...options });
  const statusTone = (status) => ['completed', 'active'].includes(status) ? 'success' : status === 'failed' ? 'danger' : 'neutral';
  function send(action, payload = {}) {
    if (!port) return Promise.reject(new Error('Pico plugin UI is not connected.'));
    const id = `${pluginId}-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ type: 'pico:plugin-ui:request', id, action, ...payload });
    });
  }
  function api(path, method = 'GET', body) {
    return send('api', {
      path: `/api/plugins/${pluginId}${path}`,
      ...(method === 'GET' ? {} : { init: { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) } }),
    });
  }
  function draw() {
    if (!context.thread) {
      port?.postMessage({ type: 'pico:plugin-ui:render', tree: [card(paragraph('Select a Thread to manage its Goal.'))] });
      return;
    }
    const nodes = [];
    if (editing || !goal || goal.status === 'cleared') {
      nodes.push(card(
        { type: 'heading', text: goal ? 'Edit Goal' : 'Set a Goal' },
        group(
          { type: 'textArea', label: 'Goal', value: fields.text, placeholder: 'Describe the result you want', actionId: 'field.goal', rows: 'large', maxLength: 8000, disabled: busy },
          { type: 'textArea', label: 'Constraints', value: fields.constraints, placeholder: 'Optional constraints, boundaries, or preferences', actionId: 'field.constraints', rows: 'standard', maxLength: 4000, disabled: busy },
          { type: 'textArea', label: 'Completion criteria', value: fields.completionCriteria, placeholder: 'What evidence will show this is complete?', actionId: 'field.completion', rows: 'large', maxLength: 4000, disabled: busy },
        ),
        { type: 'actions', children: [
          button(goal ? 'Save Goal' : 'Start Goal', 'save', { tone: 'primary', disabled: busy || !fields.text.trim() || !fields.completionCriteria.trim() }),
          button('Cancel', 'cancel', { disabled: busy }),
        ] },
      ));
    } else {
      const details = [paragraph(goal.text)];
      if (goal.constraints) details.push(group(text('Constraints'), paragraph(goal.constraints), 'stack-compact'));
      if (goal.completionCriteria) details.push(group(text('Completion criteria'), paragraph(goal.completionCriteria), 'stack-compact'));
      if (goal.recentProgress) details.push(group(text('Recent progress'), paragraph(goal.recentProgress), 'stack-compact'));
      if (goal.blocker) details.push(group(text(goal.status === 'needs_input' ? 'Needs input' : 'Pause reason'), paragraph(goal.blocker), 'stack-compact'));
      if (goal.evidence) details.push(group(
        text(`Completion evidence · ${goal.evidence.kind} ${goal.evidence.id}`),
        paragraph(goal.evidence.summary),
        'stack-compact',
      ));
      const actions = [];
      if (goal.status !== 'completed') {
        actions.push(button('Edit', 'edit', { disabled: busy }));
        if (goal.status === 'active') actions.push(button('Pause', 'pause', { disabled: busy }));
        if (['paused', 'needs_input'].includes(goal.status)) actions.push(button('Resume', 'resume', { tone: 'primary', disabled: busy }));
      }
      actions.push(button('Clear', 'clear', { tone: 'danger', disabled: busy }));
      nodes.push(card(
        group(
          { type: 'heading', text: 'Goal' },
          { type: 'status', text: goal.status, tone: statusTone(goal.status) },
          'spread',
        ),
        group(...details, 'stack-compact'),
        { type: 'actions', children: actions },
        ...(error ? [{ type: 'status', text: error, tone: 'danger' }] : []),
      ));
    }
    if (error && (editing || !goal || goal.status === 'cleared')) nodes.push({ type: 'status', text: error, tone: 'danger' });
    port?.postMessage({ type: 'pico:plugin-ui:render', tree: nodes });
  }
  async function refresh() {
    const threadId = context.thread?.id;
    if (!threadId) { goal = null; draw(); return; }
    try {
      const result = await api(`/goal?threadId=${encodeURIComponent(threadId)}`);
      goal = result.goal;
      if (!editing) fields = { text: goal?.text ?? '', constraints: goal?.constraints ?? '', completionCriteria: goal?.completionCriteria ?? '' };
      error = '';
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    draw();
  }
  async function act(action) {
    if (action.actionId.startsWith('field.') && typeof action.value === 'string') {
      const key = action.actionId.slice(6);
      fields = { ...fields, [key === 'goal' ? 'text' : key === 'constraints' ? 'constraints' : 'completionCriteria']: action.value };
      draw();
      return;
    }
    if (action.actionId === 'cancel') { editing = false; error = ''; draw(); return; }
    if (action.actionId === 'edit') { fields = { text: goal?.text ?? '', constraints: goal?.constraints ?? '', completionCriteria: goal?.completionCriteria ?? '' }; editing = true; draw(); return; }
    if (action.actionId !== 'save' && !['pause', 'resume', 'clear'].includes(action.actionId)) return;
    busy = true; error = ''; draw();
    try {
      if (action.actionId === 'save') {
        const result = await api('/goal', 'PUT', { threadId: context.thread.id, ...fields });
        goal = result.goal; editing = false;
      } else {
        const result = await api('/goal/action', 'POST', { threadId: context.thread.id, action: action.actionId });
        goal = result.goal;
      }
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { busy = false; draw(); }
  }
  function accept(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pico:plugin-ui:response') {
      const handler = pending.get(message.id); if (!handler) return;
      pending.delete(message.id); message.ok ? handler.resolve(message.value) : handler.reject(new Error(message.error));
    } else if (message.type === 'pico:plugin-ui:action') void act(message);
    else if (message.type === 'pico:plugin-ui:context') { context = message.context ?? { thread: null }; editing = false; void refresh(); }
    else if (message.type === 'pico:plugin-ui:event' && message.event?.type === 'plugin.updated' && message.event.pluginId === pluginId) void refresh();
  }
  window.addEventListener('message', (event) => {
    const init = event.data;
    if (event.source !== window.parent || init?.type !== 'pico:plugin-ui:init' || init.protocolVersion !== 1 || init.pluginId !== pluginId || init.entry !== 'webui' || event.ports.length !== 1) return;
    context = init.context ?? { thread: null }; port = event.ports[0]; port.onmessage = (portEvent) => accept(portEvent.data); port.start();
    draw(); if (typeof init.attemptId === 'string') port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId }); void refresh();
  });
})();
