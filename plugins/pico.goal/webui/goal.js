(() => {
  'use strict';
  const pluginId = 'pico.goal';
  const root = document.getElementById('root');
  if (!root) return;
  let port = null;
  let init = null;
  let context = { thread: null };
  let goal = null;
  let busy = false;
  let error = '';
  let editing = false;
  let sequence = 0;
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
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }
  async function refresh() {
    const threadId = context.thread?.id;
    if (!threadId) {
      goal = null;
      draw();
      return;
    }
    try {
      const result = await api(`/goal?threadId=${encodeURIComponent(threadId)}`);
      goal = result.goal;
      error = '';
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    draw();
  }
  function form() {
    const current = goal ?? {};
    return `<form class="form" id="goal-form">
      <label>Goal<textarea name="text" required maxlength="8000" placeholder="Describe the result you want">${escape(current.text)}</textarea></label>
      <label>Constraints<textarea name="constraints" maxlength="4000" placeholder="Optional constraints, boundaries, or preferences">${escape(current.constraints)}</textarea></label>
      <label>Completion criteria<textarea name="completionCriteria" required maxlength="4000" placeholder="What evidence will show this is complete?">${escape(current.completionCriteria)}</textarea></label>
      <div class="actions"><button class="primary" type="submit" ${busy ? 'disabled' : ''}>${goal ? 'Save Goal' : 'Start Goal'}</button><button type="button" data-action="cancel">Cancel</button></div>
    </form>`;
  }
  function panel() {
    port?.postMessage({ type: 'pico:plugin-ui:toolbar-state', badgeCount: goal?.status === 'active' ? 1 : 0 });
    if (!context.thread)
      return '<section class="goal-panel"><div class="empty">Select a Thread to manage its Goal.</div></section>';
    if (editing || !goal || goal.status === 'cleared')
      return `<section class="goal-panel"><div class="heading"><strong>${goal ? 'Edit Goal' : 'Set a Goal'}</strong></div>${form()}</section>`;
    const canResume = ['paused', 'needs_input'].includes(goal.status);
    return `<section class="goal-panel">
      <div class="heading"><strong>Goal</strong><span class="status ${escape(goal.status)}">${escape(goal.status)}</span></div>
      <article class="card">
        <div class="goal-text">${escape(goal.text)}</div>
        ${goal.constraints ? `<div class="detail"><small>Constraints</small><p>${escape(goal.constraints)}</p></div>` : ''}
        <div class="detail"><small>Completion criteria</small><p>${escape(goal.completionCriteria)}</p></div>
        ${goal.recentProgress ? `<div class="detail"><small>Recent progress</small><p>${escape(goal.recentProgress)}</p></div>` : ''}
        ${goal.blocker ? `<div class="detail"><small>${goal.status === 'needs_input' ? 'Needs input' : 'Pause reason'}</small><p>${escape(goal.blocker)}</p></div>` : ''}
        ${goal.evidence ? `<div class="detail evidence"><small>Completion evidence · ${escape(goal.evidence.kind)} ${escape(goal.evidence.id)}</small><p>${escape(goal.evidence.summary)}</p></div>` : ''}
      </article>
      <div class="actions">
        ${goal.status !== 'completed' ? `<button data-action="edit">Edit</button>${goal.status === 'active' ? '<button data-action="pause">Pause</button>' : ''}${canResume ? '<button class="primary" data-action="resume">Resume</button>' : ''}` : ''}
        <button class="danger" data-action="clear">Clear</button>
      </div>
      ${error ? `<div class="error">${escape(error)}</div>` : ''}
    </section>`;
  }
  function draw() {
    root.innerHTML = panel();
    root.querySelector('#goal-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const data = new FormData(formElement);
      try {
        busy = true;
        draw();
        const result = await api('/goal', 'PUT', {
          threadId: context.thread.id,
          text: data.get('text'),
          constraints: data.get('constraints'),
          completionCriteria: data.get('completionCriteria'),
        });
        goal = result.goal;
        editing = false;
        error = '';
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
      } finally {
        busy = false;
        draw();
      }
    });
    root.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
      editing = false;
      draw();
    });
    root.querySelectorAll('button[data-action]:not([data-action="cancel"])').forEach((button) => {
      button.addEventListener('click', async () => {
        const action = button.getAttribute('data-action');
        if (action === 'edit') {
          editing = true;
          draw();
          return;
        }
        try {
          busy = true;
          draw();
          const result = await api('/goal/action', 'POST', { threadId: context.thread.id, action });
          goal = result.goal;
          error = '';
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
        } finally {
          busy = false;
          draw();
        }
      });
    });
    requestAnimationFrame(() =>
      port?.postMessage({ type: 'pico:plugin-ui:resize', height: root.getBoundingClientRect().height }),
    );
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
      context = message.context ?? { thread: null };
      editing = false;
      void refresh();
    } else if (
      message.type === 'pico:plugin-ui:event' &&
      message.event?.type === 'plugin.updated' &&
      message.event.pluginId === pluginId
    ) {
      void refresh();
    }
  }
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      event.data?.type !== 'pico:plugin-ui:init' ||
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
