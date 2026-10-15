(() => {
  'use strict';

  const pluginId = 'pico.permissions';
  const root = document.getElementById('root');
  if (!root) return;

  let port = null;
  let init = null;
  let context = { thread: null };
  let sequence = 0;
  let requestId = 0;
  let data = { tools: [], approvals: [], autoReview: false };
  let busy = false;
  let error = '';
  let toolsExpanded = false;
  let popoverMaxHeight = 480;
  let renderedThreadId = null;
  const pending = new Map();

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

  function escape(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character],
    );
  }

  function currentApproval() {
    const id = context.execution?.id;
    return id ? data.approvals.find((approval) => approval.executionId === id) : undefined;
  }

  async function refresh() {
    const threadId = context.thread?.id;
    if (!threadId) {
      data = { tools: [], approvals: [], autoReview: false };
      draw();
      return;
    }
    const currentRequest = ++requestId;
    try {
      const next = await api(`/threads?threadId=${encodeURIComponent(threadId)}`);
      if (currentRequest !== requestId) return;
      data = {
        tools: Array.isArray(next.tools) ? next.tools : [],
        approvals: Array.isArray(next.approvals) ? next.approvals : [],
        autoReview: next.autoReview === true,
      };
      error = '';
    } catch (reason) {
      if (currentRequest !== requestId) return;
      error = reason instanceof Error ? reason.message : String(reason);
    }
    draw();
  }

  function toolbar() {
    port?.postMessage({ type: 'pico:plugin-ui:toolbar-state', badgeCount: Math.min(999, data.tools.length) });
    if (!context.thread)
      return '<section class="panel toolbar-panel"><div class="permission-menu"><div class="permission-popover"><div class="popover-heading"><strong>Tool permissions</strong><span>Saved for this Thread</span></div><div class="empty">Choose a Thread to review its tools.</div></div></div></section>';
    const rows = data.tools
      .map(
        (tool) => `
      <label class="permission-row">
        <span><strong>${escape(tool.name)}</strong><small>${escape(tool.description)}</small></span>
        <select data-tool="${escape(tool.name)}" aria-label="${escape(tool.name)} permission">
          ${['allow', 'ask', 'deny'].map((policy) => `<option value="${policy}" ${tool.policy === policy ? 'selected' : ''}>${policy[0].toUpperCase()}${policy.slice(1)}</option>`).join('')}
        </select>
      </label>`,
      )
      .join('');
    return `<section class="panel toolbar-panel">
      <div class="permission-menu">
        <div class="permission-popover" role="dialog" aria-label="Tool permissions">
          <div class="popover-heading"><strong>Tool permissions</strong><span>Saved for this Thread</span></div>
          <label class="reviewer-toggle"><span><strong>Auto-review</strong><small>Use an independent reviewer for tools set to Ask</small></span><input type="checkbox" data-reviewer ${data.autoReview ? 'checked' : ''} /></label>
          ${error ? `<div class="error">${escape(error)}</div>` : ''}
          <div class="tools">${rows || '<div class="empty">Tool definitions will appear after the next Model projection.</div>'}</div>
        </div>
      </div>
    </section>`;
  }

  function setPopover(open, maxHeight) {
    toolsExpanded = open;
    if (typeof maxHeight === 'number' && Number.isFinite(maxHeight)) {
      popoverMaxHeight = Math.max(80, Math.min(480, maxHeight));
    }
    const panel = root.querySelector('.permission-popover');
    if (panel) panel.style.maxHeight = `${popoverMaxHeight}px`;
    if (!open) {
      port?.postMessage({ type: 'pico:plugin-ui:popover', open: false, width: 390, height: 0 });
      return;
    }
    requestAnimationFrame(() => {
      const height = panel?.getBoundingClientRect().height ?? 160;
      port?.postMessage({ type: 'pico:plugin-ui:popover', open: true, width: 390, height });
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !toolsExpanded) return;
    setPopover(false);
  });

  function renderer() {
    const execution = context.execution;
    const call = context.toolCall;
    if (!execution && !call)
      return '<section class="panel"><div class="empty">Tool execution details are not available.</div></section>';
    const name = execution?.toolName ?? call?.name ?? 'Tool';
    const status = execution?.status ?? context.result?.status ?? 'pending';
    const args = execution?.arguments ?? call?.arguments;
    const result = execution?.result ?? context.result?.result;
    const failure = execution?.error ?? context.result?.error;
    const approval = currentApproval();
    const awaiting = status === 'pending' && approval?.status === 'pending';
    const review = approval?.reviewer;
    const reviewerBoundary = Boolean(review);
    return `<section class="panel"><article class="card">
      <div class="card-header"><strong>${escape(name)}</strong><span class="status ${awaiting ? 'pending' : ''}">${escape(awaiting ? 'awaiting approval' : status)}</span></div>
      ${args === undefined ? '' : `<details ${awaiting ? 'open' : ''}><summary>Arguments</summary><pre>${escape(JSON.stringify(args, null, 2))}</pre></details>`}
      ${failure ? `<div class="error">${escape(failure)}</div>` : ''}
      ${review ? `<div class="review-result"><strong>${escape(review.outcome === 'allow' ? 'Auto-review allowed' : review.outcome === 'deny' ? 'Auto-review denied' : 'Auto-review unavailable')}</strong><span>${escape(review.reason)}</span>${review.model ? `<small>Reviewer model: ${escape(review.model)}</small>` : ''}</div>` : ''}
      ${status === 'interrupted' ? '<div class="muted">Execution was interrupted. Side effects may be partial or unknown.</div>' : ''}
      ${result === undefined ? '' : `<details><summary>Result</summary><pre>${escape(typeof result === 'string' ? result : JSON.stringify(result, null, 2))}</pre></details>`}
      ${awaiting ? `<div class="actions">${reviewerBoundary ? '' : '<label class="remember"><input id="remember" type="checkbox" /> Allow this tool in this Thread</label>'}<button class="deny" data-decision="deny" ${busy ? 'disabled' : ''}>Deny</button><button class="allow" data-decision="allow" ${busy ? 'disabled' : ''}>Allow once</button></div>` : ''}
      ${error ? `<div class="error">${escape(error)}</div>` : ''}
    </article></section>`;
  }

  function draw() {
    root.innerHTML = init?.viewId === 'ToolPermissions' ? toolbar() : renderer();
    if (init?.viewId === 'ToolPermissions') {
      root.querySelectorAll('select[data-tool]').forEach((select) => {
        select.addEventListener('change', async () => {
          const target = select;
          const toolName = target.getAttribute('data-tool');
          if (!toolName || !context.thread) return;
          try {
            busy = true;
            await api('/rules', 'PUT', { threadId: context.thread.id, toolName, policy: target.value });
            await refresh();
          } catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason);
            draw();
          } finally {
            busy = false;
          }
        });
      });
      root.querySelector('[data-reviewer]')?.addEventListener('change', async (event) => {
        if (!context.thread) return;
        const enabled = event.currentTarget.checked;
        try {
          busy = true;
          await api('/reviewer', 'PUT', { threadId: context.thread.id, enabled });
          await refresh();
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
          draw();
        } finally {
          busy = false;
        }
      });
      if (toolsExpanded) {
        setPopover(true, popoverMaxHeight);
      }
    }
    root.querySelectorAll('button[data-decision]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!approvalId()) return;
        const rememberForThread = Boolean(root.querySelector('#remember')?.checked);
        try {
          busy = true;
          draw();
          const allow = button.getAttribute('data-decision') === 'allow';
          await api('/approvals', 'POST', {
            executionId: approvalId(),
            allow,
            rememberForThread: allow && rememberForThread,
          });
          await refresh();
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
        } finally {
          busy = false;
          draw();
        }
      });
    });
    resizeToContent();
  }

  function resizeToContent() {
    requestAnimationFrame(() =>
      port?.postMessage({ type: 'pico:plugin-ui:resize', height: root.getBoundingClientRect().height }),
    );
  }

  function approvalId() {
    return context.execution?.id ?? '';
  }

  function accept(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pico:plugin-ui:response') {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.ok) handler.resolve(message.value);
      else handler.reject(new Error(message.error));
    } else if (message.type === 'pico:plugin-ui:context') {
      const nextThreadId = message.context?.thread?.id ?? null;
      if (nextThreadId !== renderedThreadId) {
        toolsExpanded = false;
        setPopover(false);
      }
      renderedThreadId = nextThreadId;
      context = message.context ?? { thread: null };
      void refresh();
    } else if (message.type === 'pico:plugin-ui:popover-dismiss') {
      setPopover(false);
    } else if (message.type === 'pico:plugin-ui:toolbar-toggle') {
      setPopover(message.open === true, message.maxHeight);
    } else if (message.type === 'pico:plugin-ui:popover-viewport') {
      if (toolsExpanded) setPopover(true, message.maxHeight);
    } else if (message.type === 'pico:plugin-ui:event') {
      if (message.event?.type === 'plugin.updated' && message.event.pluginId === pluginId) void refresh();
    }
  }

  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      !event.data ||
      event.data.type !== 'pico:plugin-ui:init' ||
      event.data.protocolVersion !== 1 ||
      event.data.pluginId !== pluginId ||
      event.data.entry !== 'webui' ||
      event.ports.length !== 1
    )
      return;
    init = event.data;
    context = init.context ?? { thread: null };
    port = event.ports[0];
    port.onmessage = (portEvent) => accept(portEvent.data);
    port.start();
    draw();
    void refresh();
  });
})();
