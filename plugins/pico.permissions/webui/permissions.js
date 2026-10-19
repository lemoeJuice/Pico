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
  let data = { tools: [], approvals: [], autoReview: false, autoReviewDenials: false };
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
    const id = context.toolResult?.executionId ?? context.execution?.id;
    return id ? data.approvals.find((approval) => approval.executionId === id) : undefined;
  }

  async function refresh() {
    const threadId = context.threadId ?? context.thread?.id;
    if (!threadId) {
      data = { tools: [], approvals: [], autoReview: false, autoReviewDenials: false };
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
        autoReviewDenials: next.autoReviewDenials === true,
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
      return '<section class="panel pico-ui-panel toolbar-panel"><div class="permission-menu"><div class="permission-popover"><div class="popover-heading pico-ui-heading"><strong>Tool permissions</strong><span>Saved for this Thread</span></div><div class="pico-ui-empty empty">Choose a Thread to review its tools.</div></div></div></section>';
    const rows = data.tools
      .map(
        (tool) => {
          const defaultAllow = tool.policy === 'allow';
          const hidden = tool.policy === 'deny';
          return `
        <div class="permission-row pico-ui-list-item">
          <span class="permission-tool-copy"><strong>${escape(tool.name)}</strong><small>${escape(tool.description)}</small></span>
          <span class="permission-tool-setting">
            <small class="permission-policy-state">${hidden ? 'Hidden' : defaultAllow ? 'Default allow' : 'Ask'}</small>
            <button type="button" class="permission-switch" role="switch" aria-checked="${defaultAllow}" aria-label="Allow ${escape(tool.name)} by default" data-tool="${escape(tool.name)}" ${busy ? 'disabled' : ''}><span></span></button>
          </span>
        </div>`;
        },
      )
      .join('');
    return `<section class="panel pico-ui-panel toolbar-panel">
      <div class="permission-menu">
        <div class="permission-popover" role="dialog" aria-label="Tool permissions">
          <div class="popover-heading pico-ui-heading"><strong>Tool permissions</strong><span>Saved for this Thread</span></div>
          <section class="permission-auto-section" aria-label="Automatic review">
            <div class="permission-auto-primary">
              <div class="permission-auto-copy"><strong>Auto-review</strong><small>Use an independent reviewer for tools set to Ask</small></div>
              <button type="button" class="permission-switch permission-switch--auto" role="switch" aria-checked="${data.autoReview}" aria-label="Auto-review" data-reviewer ${busy ? 'disabled' : ''}><span></span></button>
            </div>
            <div class="permission-auto-separator"></div>
            <div class="permission-auto-denials">
              <div class="permission-auto-copy"><strong>Apply reviewer denials directly</strong><small>Skip manual review for denials. A timeout fails temporarily without a decision; other reviewer errors still need human review.</small></div>
              <button type="button" class="permission-switch" role="switch" aria-checked="${data.autoReviewDenials}" aria-label="Apply reviewer denials directly" data-reviewer-denials ${busy || !data.autoReview ? 'disabled' : ''}><span></span></button>
            </div>
          </section>
          ${error ? `<div class="pico-ui-error">${escape(error)}</div>` : ''}
          <section class="permission-tool-section" aria-label="Per-tool defaults">
            <div class="permission-section-heading"><strong>Per-tool defaults</strong><small>On allows by default; off routes through Ask.</small></div>
            <div class="tools pico-ui-section">${rows || '<div class="pico-ui-empty empty">Tool definitions will appear after the next Model projection.</div>'}</div>
          </section>
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

  function permissionResultActions() {
    const execution = context.toolResult ?? context.execution;
    const approval = currentApproval();
    if (approval?.status === 'failed') {
      return `<section class="permission-result-actions pico-ui-section" aria-label="Permission review failed">
        <div class="permission-review-failure"><strong>Approval temporarily failed</strong><span>Reviewer timed out. No decision was made; this is not a denial.</span></div>
      </section>`;
    }
    const awaiting = execution?.status === 'pending' && approval?.status === 'pending';
    if (!awaiting) return '';
    const review = approval?.reviewer;
    return `<section class="permission-result-actions pico-ui-section" aria-label="Permission decision">
      ${review || error ? `<div class="permission-messages">
        ${review ? `<div class="review-result"><strong>${escape(review.outcome === 'allow' ? 'Auto-review allowed' : review.outcome === 'deny' ? 'Auto-review denied' : 'Auto-review unavailable')}</strong><span class="review-reason" title="${escape(review.reason)}">${escape(review.reason)}</span>${review.model ? `<small title="${escape(review.model)}">Reviewer model: ${escape(review.model)}</small>` : ''}</div>` : ''}
        ${error ? `<div class="pico-ui-error" title="${escape(error)}">${escape(error)}</div>` : ''}
      </div>` : ''}
      <div class="pico-ui-actions permission-decisions">
        <button type="button" class="pico-ui-button pico-ui-button--danger" data-decision="deny" ${busy ? 'disabled' : ''}>Deny</button>
        <button type="button" class="pico-ui-button pico-ui-button--primary" data-decision="allow" ${busy ? 'disabled' : ''}>Allow once</button>
        ${review ? '' : `<button type="button" class="pico-ui-button" data-decision="allow" data-remember-for-thread="true" aria-label="Allow this tool in this Thread" title="Allow this tool in this Thread" ${busy ? 'disabled' : ''}>Allow in Thread</button>`}
      </div>
    </section>`;
  }

  function draw() {
    root.innerHTML = init?.viewId === 'ToolPermissions' ? toolbar() : permissionResultActions();
    if (init?.viewId === 'ToolPermissions') {
      root.querySelectorAll('button[data-tool]').forEach((button) => {
        button.addEventListener('click', async () => {
          const target = button;
          const toolName = target.getAttribute('data-tool');
          if (!toolName || !context.thread) return;
          const policy = target.getAttribute('aria-checked') === 'true' ? 'ask' : 'allow';
          try {
            busy = true;
            draw();
            await api('/rules', 'PUT', { threadId: context.thread.id, toolName, policy });
            await refresh();
          } catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason);
            draw();
          } finally {
            busy = false;
            draw();
          }
        });
      });
      root.querySelector('[data-reviewer]')?.addEventListener('click', async (event) => {
        if (!context.thread) return;
        const enabled = event.currentTarget.getAttribute('aria-checked') !== 'true';
        try {
          busy = true;
          draw();
          await api('/reviewer', 'PUT', { threadId: context.thread.id, enabled });
          await refresh();
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
          draw();
        } finally {
          busy = false;
          draw();
        }
      });
      root.querySelector('[data-reviewer-denials]')?.addEventListener('click', async (event) => {
        if (!context.thread || !data.autoReview) return;
        const enabled = event.currentTarget.getAttribute('aria-checked') !== 'true';
        try {
          busy = true;
          draw();
          await api('/reviewer-denials', 'PUT', { threadId: context.thread.id, enabled });
          await refresh();
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
          draw();
        } finally {
          busy = false;
          draw();
        }
      });
      if (toolsExpanded) {
        setPopover(true, popoverMaxHeight);
      }
    }
    root.querySelectorAll('button[data-decision]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!approvalId()) return;
        const rememberForThread = button.getAttribute('data-remember-for-thread') === 'true';
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
    return context.toolResult?.executionId ?? context.execution?.id ?? '';
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
      const nextThreadId = message.context?.threadId ?? message.context?.thread?.id ?? null;
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
    if (typeof init.attemptId === 'string')
      port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId });
    void refresh();
  });
})();
