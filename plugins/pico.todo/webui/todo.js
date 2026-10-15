(() => {
  const pluginId = 'pico.todo';
  const root = document.getElementById('root');
  let port = null;
  let seq = 0;
  let context = { thread: null };
  let items = [];
  let pending = false;
  const requests = new Map();
  const api = (path, init) =>
    new Promise((resolve, reject) => {
      const id = `todo-ui-${++seq}`;
      requests.set(id, { resolve, reject });
      port.postMessage({ type: 'pico:plugin-ui:request', id, action: 'api', path, ...(init ? { init } : {}) });
    });
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
  function render(error = '') {
    if (!root) return;
    const threadId = context.thread?.id;
    if (!threadId) {
      root.innerHTML =
        '<section class="panel"><strong>Todo</strong><p class="empty">Select a Thread to manage its checklist.</p></section>';
      return;
    }
    const open = items.filter((item) => item.status === 'open');
    const ordered = [...items].sort(
      (a, b) =>
        Number(a.status === 'done') - Number(b.status === 'done') ||
        b.priority - a.priority ||
        a.createdAt.localeCompare(b.createdAt),
    );
    root.innerHTML = `<section class="panel">
      <div class="heading"><strong>TODO</strong><span class="count">${open.length} open</span></div>
      <form class="form"><input name="title" maxlength="240" placeholder="Add a short-term action…" aria-label="New Todo" required><button ${pending ? 'disabled' : ''}>Add</button></form>
      ${error ? `<div class="error" role="alert">${escape(error)}</div>` : ''}
      <div class="items">${
        ordered
          .map(
            (item) => `<div class="item ${item.status === 'done' ? 'done' : ''}">
        <input type="checkbox" data-id="${escape(item.id)}" ${item.status === 'done' ? 'checked' : ''} ${pending ? 'disabled' : ''} aria-label="Mark ${escape(item.title)} ${item.status === 'done' ? 'open' : 'done'}">
        <span class="title">${escape(item.title)}${item.nextAction ? `<small class="muted"><br>Next: ${escape(item.nextAction)}</small>` : ''}${item.sourceMessageSeq ? `<small class="muted"><br>Source message #${item.sourceMessageSeq}</small>` : ''}</span>
        <span class="item-actions"><span class="priority">${item.priority}/5</span><button type="button" data-edit="${escape(item.id)}" aria-label="Edit ${escape(item.title)}" ${pending ? 'disabled' : ''}>Edit</button></span></div>`,
          )
          .join('') || '<p class="empty">No Todo items yet.</p>'
      }</div>
      <span class="muted">Agent updates are saved automatically. Completed items stay in the list.</span>
    </section>`;
    root.querySelector('form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const title = new FormData(form).get('title')?.toString().trim();
      if (!title) return;
      pending = true;
      render();
      try {
        await api(`/api/plugins/${pluginId}/items`, {
          method: 'POST',
          body: JSON.stringify({ threadId, title, operationId: crypto.randomUUID() }),
        });
        await refresh();
      } catch (failure) {
        render(failure.message);
      } finally {
        pending = false;
        render();
      }
    });
    root.querySelectorAll('input[type=checkbox]').forEach((checkbox) =>
      checkbox.addEventListener('change', async (event) => {
        const target = event.currentTarget;
        pending = true;
        render();
        try {
          await api(`/api/plugins/${pluginId}/items`, {
            method: 'PATCH',
            body: JSON.stringify({
              threadId,
              id: target.dataset.id,
              status: target.checked ? 'done' : 'open',
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
    root.querySelectorAll('button[data-edit]').forEach((button) =>
      button.addEventListener('click', async (event) => {
        const id = event.currentTarget.dataset.edit;
        const item = items.find((candidate) => candidate.id === id);
        if (!item) return;
        const title = window.prompt('Todo title', item.title);
        if (title === null) return;
        const nextAction = window.prompt('Next action (leave blank to clear)', item.nextAction || '');
        if (nextAction === null) return;
        pending = true;
        render();
        try {
          await api(`/api/plugins/${pluginId}/items`, {
            method: 'PATCH',
            body: JSON.stringify({ threadId, id, title, nextAction, operationId: crypto.randomUUID() }),
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
  }
  async function refresh() {
    if (!context.thread?.id) {
      items = [];
      render();
      return;
    }
    const result = await api(`/api/plugins/${pluginId}/threads?threadId=${encodeURIComponent(context.thread.id)}`);
    items = Array.isArray(result.items) ? result.items : [];
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
      init.viewType !== 'component' ||
      init.viewId !== 'TodoPanel' ||
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
