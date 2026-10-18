(() => {
  const pluginId = 'pico.collaboration';
  const root = document.getElementById('root');
  let port = null;
  let sequence = 0;
  let context = { thread: null };
  let children = [];
  let pending = false;
  let requests = new Map();
  let resizeFrame = 0;
  const resizeObserver = new ResizeObserver(() => {
    if (!root || !port || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      port?.postMessage({ type: 'pico:plugin-ui:resize', height: root.getBoundingClientRect().height });
    });
  });
  if (root) resizeObserver.observe(root);
  const api = (path, init) =>
    new Promise((resolve, reject) => {
      const id = `collaboration-${++sequence}`;
      requests.set(id, { resolve, reject });
      port.postMessage({ type: 'pico:plugin-ui:request', id, action: 'api', path, ...(init ? { init } : {}) });
    });
  const openThread = (threadId) =>
    new Promise((resolve, reject) => {
      const id = `collaboration-${++sequence}`;
      requests.set(id, { resolve, reject });
      port.postMessage({ type: 'pico:plugin-ui:request', id, action: 'open-thread', threadId });
    });
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
  const apiRoot = `/api/plugins/${pluginId}`;
  function render(error = '') {
    if (!root) return;
    const thread = context.thread;
    if (!thread) {
      root.innerHTML =
        '<section class="pico-ui-panel panel"><strong>Child Threads</strong><p class="pico-ui-empty empty">Select a Thread to inspect its child Threads.</p></section>';
      return;
    }
    root.innerHTML = `<section class="pico-ui-panel panel">
      <div class="pico-ui-heading heading"><span>CHILD THREADS</span><span class="count">${children.length}</span></div>
      ${error ? `<div class="pico-ui-error error" role="alert">${escape(error)}</div>` : ''}
      <div class="children">${
        children
          .map(
            (child) => `<article class="pico-ui-card pico-ui-list-item child">
        <div class="child-main"><div class="title">${escape(child.title)}</div><div class="meta">${escape(child.executorLabel)} · ${escape(child.id)}</div>
          <span class="pico-ui-status state" data-status="${escape(child.state)}">${escape(child.state)}</span>${child.pauseReason ? `<div class="meta">${escape(child.pauseReason)}</div>` : ''}
          <div class="pico-ui-actions actions"><button class="pico-ui-button" type="button" data-open="${escape(child.id)}" ${pending ? 'disabled' : ''}>Open</button><button class="pico-ui-button" type="button" data-action="${child.state === 'paused' ? 'resume' : 'pause'}" data-id="${escape(child.id)}" ${pending ? 'disabled' : ''}>${child.state === 'paused' ? 'Continue' : 'Pause'}</button></div>
          <form class="form" data-child="${escape(child.id)}"><textarea class="pico-ui-control" name="message" maxlength="20000" placeholder="Send a follow-up message…" aria-label="Message ${escape(child.title)}" required ${pending ? 'disabled' : ''}></textarea><button class="pico-ui-button" ${pending ? 'disabled' : ''}>Send</button></form>
        </div></article>`,
          )
          .join('') ||
        '<p class="pico-ui-empty empty">No child Threads yet. Ask the agent to delegate a bounded task with spawn_thread.</p>'
      }</div>
      <p class="muted">Messages use normal Thread history. Sending a message does not resume a paused child.</p>
    </section>`;
    root.querySelectorAll('form[data-child]').forEach((form) =>
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const childThreadId = form.dataset.child;
        const message = new FormData(form).get('message')?.toString().trim();
        if (!childThreadId || !message) return;
        pending = true;
        render();
        try {
          await api(`${apiRoot}/threads/message`, {
            method: 'POST',
            body: JSON.stringify({
              parentThreadId: thread.id,
              childThreadId,
              message,
              operationId: crypto.randomUUID(),
            }),
          });
          await refresh();
        } catch (failure) {
          render(failure.message);
        } finally {
          pending = false;
          render();
        }
      }),
    );
    root.querySelectorAll('button[data-action]').forEach((button) =>
      button.addEventListener('click', async (event) => {
        const target = event.currentTarget;
        pending = true;
        render();
        try {
          await api(`${apiRoot}/threads/state`, {
            method: 'POST',
            body: JSON.stringify({
              parentThreadId: thread.id,
              childThreadId: target.dataset.id,
              action: target.dataset.action,
            }),
          });
          await refresh();
        } catch (failure) {
          render(failure.message);
        } finally {
          pending = false;
          render();
        }
      }),
    );
    root.querySelectorAll('button[data-open]').forEach((button) =>
      button.addEventListener('click', async (event) => {
        pending = true;
        render();
        try {
          await openThread(event.currentTarget.dataset.open);
        } catch (failure) {
          render(failure.message);
        } finally {
          pending = false;
          render();
        }
      }),
    );
  }
  async function refresh() {
    if (!context.thread?.id) {
      children = [];
      render();
      return;
    }
    const result = await api(`${apiRoot}/threads?threadId=${encodeURIComponent(context.thread.id)}`);
    children = Array.isArray(result.children) ? result.children : [];
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
      !['page', 'component'].includes(init.viewType) ||
      !['CollaborationPanel', 'collaboration'].includes(init.viewId) ||
      event.ports.length !== 1
    )
      return;
    context = init.context || context;
    port = event.ports[0];
    port.onmessage = (messageEvent) => {
      const message = messageEvent.data;
      if (message?.type === 'pico:plugin-ui:response' && requests.has(message.id)) {
        const request = requests.get(message.id);
        requests.delete(message.id);
        message.ok ? request.resolve(message.value) : request.reject(new Error(message.error));
      }
      if (message?.type === 'pico:plugin-ui:context') {
        context = message.context || context;
        void refresh().catch((failure) => render(failure.message));
      }
    };
    port.start();
    void refresh().catch((failure) => render(failure.message));
  });
})();
