/* global document, window, requestAnimationFrame */
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
  let data = { tools: [], approvals: [] };
  let busy = false;
  let error = '';
  let toolsExpanded = false;
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
      data = { tools: [], approvals: [] };
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
      };
      error = '';
    } catch (reason) {
      if (currentRequest !== requestId) return;
      error = reason instanceof Error ? reason.message : String(reason);
    }
    draw();
  }

  function toolbar() {
    if (!context.thread)
      return '<section class="panel"><strong>Tool permissions</strong><div class="empty">Choose a Thread to review its tools.</div></section>';
    const pendingCount = data.approvals.filter((approval) => approval.status === 'pending').length;
    const rows = data.tools
      .map(
        (tool) => `
      <div class="tool">
        <div><div class="tool-name">${escape(tool.name)}</div><div class="tool-description">${escape(tool.description)}</div></div>
        <select data-tool="${escape(tool.name)}" aria-label="${escape(tool.name)} permission">
          ${['allow', 'ask', 'deny'].map((policy) => `<option value="${policy}" ${tool.policy === policy ? 'selected' : ''}>${policy}</option>`).join('')}
        </select>
      </div>`,
      )
      .join('');
    return `<section class="panel">
      <div class="heading"><strong>Tool permissions · ${escape(context.thread.title)}</strong><span class="muted">${pendingCount} pending</span></div>
      ${error ? `<div class="error">${escape(error)}</div>` : ''}
      <details class="tool-list-disclosure" ${toolsExpanded ? 'open' : ''}>
        <summary>Tools ${data.tools.length}</summary>
        <div class="tools-scroll"><div class="tools">${rows || '<div class="empty">No tools are available for this Thread.</div>'}</div></div>
      </details>
    </section>`;
  }

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
    return `<section class="panel"><article class="card">
      <div class="card-header"><strong>${escape(name)}</strong><span class="status ${awaiting ? 'pending' : ''}">${escape(awaiting ? 'awaiting approval' : status)}</span></div>
      ${args === undefined ? '' : `<details ${awaiting ? 'open' : ''}><summary>Arguments</summary><pre>${escape(JSON.stringify(args, null, 2))}</pre></details>`}
      ${failure ? `<div class="error">${escape(failure)}</div>` : ''}
      ${status === 'interrupted' ? '<div class="muted">Execution was interrupted. Side effects may be partial or unknown.</div>' : ''}
      ${result === undefined ? '' : `<details><summary>Result</summary><pre>${escape(typeof result === 'string' ? result : JSON.stringify(result, null, 2))}</pre></details>`}
      ${awaiting ? `<div class="actions"><label class="remember"><input id="remember" type="checkbox" /> Allow this tool in this Thread</label><button class="deny" data-decision="deny" ${busy ? 'disabled' : ''}>Deny</button><button class="allow" data-decision="allow" ${busy ? 'disabled' : ''}>Allow once</button></div>` : ''}
      ${error ? `<div class="error">${escape(error)}</div>` : ''}
    </article></section>`;
  }

  function draw() {
    root.innerHTML = init?.viewId === 'ToolPermissions' ? toolbar() : renderer();
    if (init?.viewId === 'ToolPermissions') {
      const disclosure = root.querySelector('.tool-list-disclosure');
      disclosure?.addEventListener('toggle', () => {
        toolsExpanded = disclosure.open;
        resizeToContent();
      });
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
      if (nextThreadId !== renderedThreadId) toolsExpanded = false;
      renderedThreadId = nextThreadId;
      context = message.context ?? { thread: null };
      void refresh();
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
