(() => {
  'use strict';
  const pluginId = 'pico.permissions';
  let port = null, init = null, context = { thread: null }, sequence = 0, requestId = 0;
  let data = { tools: [], approvals: [], autoReview: false, autoReviewDenials: false }, busy = false, error = '', toolsExpanded = false, renderedThreadId = null;
  const pending = new Map();
  const text = (text) => ({ type: 'text', text: String(text ?? '') });
  const para = (text) => ({ type: 'paragraph', text: String(text ?? '') });
  const button = (label, actionId, disabled = busy, tone) => ({ type: 'button', label, actionId, disabled, ...(tone ? { tone } : {}) });
  function send(action, payload = {}) { const id = `${pluginId}-${++sequence}`; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); port.postMessage({ type: 'pico:plugin-ui:request', id, action, ...payload }); }); }
  const api = (path, method = 'GET', body) => send('api', { path: `/api/plugins/${pluginId}${path}`, ...(method === 'GET' ? {} : { init: { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) } }) });
  function currentApproval() { const id = context.toolResult?.executionId ?? context.execution?.id; return id ? data.approvals.find((a) => a.executionId === id) : undefined; }
  async function refresh() {
    const threadId = context.threadId ?? context.thread?.id;
    if (!threadId) { data = { tools: [], approvals: [], autoReview: false, autoReviewDenials: false }; draw(); return; }
    const sequenceId = ++requestId;
    try { const next = await api(`/threads?threadId=${encodeURIComponent(threadId)}`); if (sequenceId !== requestId) return; data = { tools: Array.isArray(next.tools) ? next.tools : [], approvals: Array.isArray(next.approvals) ? next.approvals : [], autoReview: next.autoReview === true, autoReviewDenials: next.autoReviewDenials === true }; error = ''; }
    catch (reason) { if (sequenceId !== requestId) return; error = reason instanceof Error ? reason.message : String(reason); }
    draw();
  }
  function toolbar() {
    port?.postMessage({ type: 'pico:plugin-ui:toolbar-state', badgeCount: Math.min(999, data.tools.length) });
    if (!context.thread) return [{ type: 'card', children: [
      { type: 'group', layout: 'stack-compact', children: [
        { type: 'heading', text: 'Tool permissions' },
        para('Choose a Thread to review its tools.'),
      ] },
    ] }];
    const content = [
      { type: 'group', layout: 'stack-compact', children: [
        { type: 'heading', text: 'Tool permissions' },
        para('Saved for this Thread'),
      ] },
      { type: 'group', layout: 'stack-compact', children: [
        { type: 'heading', text: 'Automatic review' },
        { type: 'group', layout: 'spread', children: [
          { type: 'group', layout: 'stack-compact', children: [
            { type: 'heading', level: 4, text: 'Auto-review' },
            para('Use an independent reviewer for tools set to Ask.'),
          ] },
          { type: 'group', layout: 'row', children: [
            { type: 'status', text: data.autoReview ? 'Enabled' : 'Disabled', tone: data.autoReview ? 'success' : 'neutral' },
            { type: 'switch', label: 'Auto-review', checked: data.autoReview, actionId: 'reviewer', disabled: busy, visuallyHidden: true },
          ] },
        ] },
        { type: 'group', layout: 'spread', children: [
          { type: 'group', layout: 'stack-compact', children: [
            { type: 'heading', level: 4, text: 'Apply reviewer denials directly' },
            para('Skip manual review for denials. A timeout fails temporarily without a decision; other reviewer errors still need human review.'),
          ] },
          { type: 'group', layout: 'row', children: [
            { type: 'status', text: data.autoReviewDenials ? 'Enabled' : 'Disabled', tone: data.autoReviewDenials ? 'success' : 'neutral' },
            { type: 'switch', label: 'Apply reviewer denials directly', checked: data.autoReviewDenials, actionId: 'reviewer-denials', disabled: busy || !data.autoReview, visuallyHidden: true },
          ] },
        ] },
      ] },
    ];
    if (error) content.push({ type: 'status', text: error, tone: 'danger' });
    const toolRows = data.tools.map((tool) => {
      const hidden = tool.policy === 'deny';
      const allowed = tool.policy === 'allow';
      return { type: 'group', layout: 'spread', children: [
        { type: 'group', layout: 'stack-compact', children: [
          { type: 'heading', level: 4, text: tool.name },
          para(tool.description),
        ] },
        { type: 'group', layout: 'row', children: [
          { type: 'status', text: hidden ? 'Hidden' : allowed ? 'Default allow' : 'Ask', tone: hidden ? 'danger' : allowed ? 'success' : 'neutral' },
          { type: 'switch', label: `Allow ${tool.name} by default`, checked: allowed, actionId: `tool:${tool.name}`, disabled: busy || hidden, visuallyHidden: true },
        ] },
      ] };
    });
    content.push({ type: 'group', layout: 'stack-compact', children: [
      { type: 'heading', text: 'Per-tool defaults' },
      para('On allows by default; off routes through Ask.'),
      { type: 'group', layout: 'stack-compact', children: toolRows.length ? toolRows : [para('Tool definitions will appear after the next Model projection.')] },
    ] });
    return [{ type: 'card', children: [{ type: 'group', layout: 'stack-compact', children: content }] }];
  }
  function resultActions() {
    const execution = context.toolResult ?? context.execution, approval = currentApproval();
    if (approval?.status === 'failed') return [{ type: 'group', layout: 'spread', children: [
      { type: 'group', layout: 'stack-compact', children: [
        para('Approval temporarily failed'),
        para(approval.reviewer?.reason || 'No approval decision was made. This is not a denial.'),
      ] },
    ] }];
    if (!(execution?.status === 'pending' && approval?.status === 'pending')) return [];
    const review = approval?.reviewer, nodes = [];
    const messages = [];
    if (review) {
      messages.push(para(review.outcome === 'allow' ? 'Auto-review allowed' : review.outcome === 'deny' ? 'Auto-review denied' : 'Auto-review unavailable'));
      messages.push(para(review.reason));
      if (review.model) messages.push(para(`Reviewer model: ${review.model}`));
    }
    if (error) messages.push(para(error));
    return [{ type: 'group', layout: 'spread', children: [
      ...(messages.length ? [{ type: 'group', layout: 'stack-compact', children: messages }] : []),
      { type: 'actions', children: [button('Deny', 'decision:deny', busy, 'danger'), button('Allow once', 'decision:allow', busy, 'primary'), ...(!review ? [button('Allow in Thread', 'decision:allow-thread', busy)] : [])] },
    ] }];
  }
  function draw() { const nodes = init?.viewId === 'ToolPermissions' ? toolbar() : resultActions(); port?.postMessage({ type: 'pico:plugin-ui:render', tree: nodes }); }
  async function update(action, body) { busy = true; error = ''; draw(); try { await api(action.path, action.method || 'PUT', body); await refresh(); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); } finally { busy = false; draw(); } }
  async function act(action) {
    const id = action.actionId;
    if (id.startsWith('tool:')) { const toolName = id.slice(5), tool = data.tools.find((x) => x.name === toolName); if (!tool || !context.thread) return; await update({ path: '/rules' }, { threadId: context.thread.id, toolName, policy: action.value === 'true' ? 'allow' : 'ask' }); return; }
    if (id === 'reviewer' || id === 'reviewer-denials') { if (!context.thread) return; await update({ path: id === 'reviewer' ? '/reviewer' : '/reviewer-denials' }, { threadId: context.thread.id, enabled: action.value === 'true' }); return; }
    if (id.startsWith('decision:')) { const approval = currentApproval(); if (!approval?.executionId) return; const allow = id !== 'decision:deny'; await update({ path: '/approvals', method: 'POST' }, { executionId: approval.executionId, allow, rememberForThread: allow && id === 'decision:allow-thread' }); return; }
  }
  function accept(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pico:plugin-ui:response') { const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); message.ok ? handler.resolve(message.value) : handler.reject(new Error(message.error)); }
    else if (message.type === 'pico:plugin-ui:action') void act(message);
    else if (message.type === 'pico:plugin-ui:context') { const nextThreadId = message.context?.threadId ?? message.context?.thread?.id ?? null; if (nextThreadId !== renderedThreadId) toolsExpanded = false; renderedThreadId = nextThreadId; context = message.context ?? { thread: null }; void refresh(); }
    else if (message.type === 'pico:plugin-ui:popover-dismiss') { toolsExpanded = false; }
    else if (message.type === 'pico:plugin-ui:toolbar-toggle') { toolsExpanded = message.open === true; }
    else if (message.type === 'pico:plugin-ui:event' && message.event?.type === 'plugin.updated' && message.event.pluginId === pluginId) void refresh();
  }
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== window.parent || message?.type !== 'pico:plugin-ui:init' || message.protocolVersion !== 1 || message.pluginId !== pluginId || message.entry !== 'webui' || event.ports.length !== 1) return;
    init = message; context = init.context ?? { thread: null }; port = event.ports[0]; port.onmessage = ({ data }) => accept(data); port.start(); draw();
    if (typeof init.attemptId === 'string') port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId }); void refresh();
  });
})();
