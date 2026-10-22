(() => {
  const pluginId = 'pico.project-context';
  const PAGE_SIZE = 40;
  let port = null, context = { thread: null }, entries = [], pageStart = 0, query = '', busy = false, error = '', editing = null, pendingSource = null, sequence = 0, timer = 0;
  let fields = { category: 'fact', text: '' };
  const requests = new Map();
  const para = (text) => ({ type: 'paragraph', text: String(text ?? '') });
  const button = (label, actionId, options = {}) => ({ type: 'button', label, actionId, ...options });
  const apiRoot = `/api/plugins/${pluginId}`;
  const group = (...children) => {
    const layouts = ['row', 'spread', 'grid-2', 'grid-compact', 'grid-standard', 'stack-compact'];
    const layout = layouts.includes(children.at(-1)) ? children.pop() : undefined;
    return { type: 'group', children, ...(layout ? { layout } : {}) };
  };
  const card = (...children) => ({ type: 'card', children: [group(...children, 'stack-compact')] });
  function send(action, payload = {}) {
    const id = `${pluginId}-${++sequence}`;
    return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); port.postMessage({ type: 'pico:plugin-ui:request', id, action, ...payload }); });
  }
  const api = (path, method = 'GET', body) => send('api', { path: `${apiRoot}${path}`, ...(method === 'GET' ? {} : { init: { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) } }) });
  async function refresh() {
    if (!context.thread?.projectId) { entries = []; draw(); return; }
    try { const result = await api(`/memory?projectId=${encodeURIComponent(context.thread.projectId)}&q=${encodeURIComponent(query)}`); entries = result.entries ?? []; if (pageStart >= entries.length) pageStart = Math.max(0, Math.floor((entries.length - 1) / PAGE_SIZE) * PAGE_SIZE); error = ''; }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    draw();
  }
  function draw() {
    if (!context.thread?.projectId) {
      port?.postMessage({ type: 'pico:plugin-ui:render', tree: [para('Select a Thread attached to a Project to manage shared memory.')] });
      return;
    }
    const nodes = [
      group(
        { type: 'heading', text: 'Project Context' },
        button('Add memory', 'add', { tone: 'primary', disabled: busy }),
        'spread',
      ),
      para(`Shared notes for ${context.thread.title ?? 'this Project'}`),
      { type: 'textInput', label: 'Search project memory', value: query, placeholder: 'Search project memory', actionId: 'search' },
    ];
    const pageEnd = Math.min(entries.length, pageStart + PAGE_SIZE);
    if (editing === 'new') nodes.push(card(
      { type: 'heading', text: 'Add memory' },
      { type: 'select', label: 'Category', value: fields.category, actionId: 'new.category', disabled: busy, options: ['fact', 'decision', 'activity', 'open-issue'].map((x) => ({ label: x === 'open-issue' ? 'Open issue' : x, value: x })) },
      { type: 'textArea', label: 'Memory text', value: fields.text, placeholder: 'Add a sourced project note', actionId: 'new.text', rows: 'standard', maxLength: 4000, disabled: busy },
      { type: 'actions', children: [button('Save memory', 'save-new', { tone: 'primary', disabled: busy || !fields.text.trim() }), button('Cancel', 'cancel', { disabled: busy })] },
    ));
    const categories = [['activity', 'Recent project activity'], ['fact', 'Stable facts'], ['decision', 'Decisions'], ['open-issue', 'Open issues']];
    for (const [category, label] of categories) {
      const groupEntries = entries.filter((entry) => entry.category === category);
      if (!groupEntries.length) continue;
      const items = groupEntries.filter((entry) => { const index = entries.indexOf(entry); return index >= pageStart && index < pageEnd; }).map((entry) => {
        const source = entry.sourceThreadId ? `Source: ${entry.sourceThreadId}${entry.sourceSeq === null ? '' : ` · #${entry.sourceSeq}`}` : `${entry.source} entry`;
        const state = entry.status === 'conflicted' ? { type: 'status', text: 'Conflict', tone: 'danger' }
          : entry.status === 'expired' ? { type: 'status', text: 'Expired', tone: 'neutral' } : null;
        const content = [group(
          group({ type: 'status', text: entry.category, tone: 'neutral' }, ...(state ? [state] : []), 'row'),
          button(entry.pinned ? '★ Unpin' : '☆ Pin', `pin:${entry.id}`, { tone: entry.pinned ? 'soft' : 'quiet', disabled: busy }),
          'spread',
        )];
        if (editing === entry.id) {
          content.push({ type: 'select', label: 'Category', value: fields.category, actionId: `edit:${entry.id}:category`, disabled: busy, options: ['fact', 'decision', 'activity', 'open-issue'].map((x) => ({ label: x === 'open-issue' ? 'Open issue' : x, value: x })) });
          content.push({ type: 'textArea', label: 'Memory text', value: fields.text, actionId: `edit:${entry.id}:text`, rows: 'standard', maxLength: 4000, disabled: busy });
          content.push({ type: 'actions', children: [button('Save', `save-edit:${entry.id}`, { tone: 'primary', disabled: busy || !fields.text.trim() }), button('Cancel', 'cancel', { disabled: busy })] });
        } else {
          content.push(para(entry.text));
          content.push(para(`${source} · ${entry.confidence} confidence · ${entry.source}`));
          const actions = [button('Edit', `edit:${entry.id}`, { disabled: busy }), button('Mark conflict', `conflict:${entry.id}`, { disabled: busy }), button('Expire', `expire:${entry.id}`, { disabled: busy }), button('Delete', `delete:${entry.id}`, { tone: 'danger', disabled: busy })];
          if (entry.sourceThreadId && entry.sourceSeq !== null) actions.unshift(button('Open source', `source:${entry.id}`, { tone: 'quiet' }));
          content.push({ type: 'actions', children: actions });
        }
        return card(...content);
      });
      nodes.push(group({ type: 'heading', text: label }, ...items, 'stack-compact'));
    }
    if (entries.length > PAGE_SIZE) nodes.push({ type: 'actions', children: [
      ...(pageStart > 0 ? [button('Previous entries', 'page.previous', { tone: 'soft' })] : []),
      ...(pageEnd < entries.length ? [button('Next entries', 'page.next', { tone: 'soft' })] : []),
    ] });
    if (!entries.length) nodes.push(para('No matching Project Memory entries.'));
    if (error) nodes.push({ type: 'status', text: error, tone: 'danger' });
    port?.postMessage({ type: 'pico:plugin-ui:render', tree: nodes });
  }
  async function act(a) {
    const id = a.actionId;
    if (id === 'search' && typeof a.value === 'string') { query = a.value; pageStart = 0; draw(); clearTimeout(timer); timer = setTimeout(() => void refresh(), 250); return; }
    if (id === 'new.category') fields.category = a.value;
    else if (id === 'new.text') fields.text = a.value;
    else if (id.startsWith('edit:') && (id.endsWith(':category') || id.endsWith(':text'))) { const key = id.endsWith(':category') ? 'category' : 'text'; const entryId = id.slice(5, -(key.length + 1)); if (editing !== entryId) { const entry = entries.find((item) => item.id === entryId); if (entry) { editing = entryId; fields = { category: entry.category, text: entry.text }; } } if (key === 'category') fields.category = a.value; if (key === 'text') fields.text = a.value; }
    else if (id === 'add') { editing = 'new'; fields = { category: 'fact', text: '' }; draw(); return; }
    else if (id === 'cancel') { editing = null; error = ''; draw(); return; }
    else if (id.startsWith('edit:')) { const entry = entries.find((item) => item.id === id.slice(5)); if (entry) { editing = entry.id; fields = { category: entry.category, text: entry.text }; } draw(); return; }
    else if (id.startsWith('source:')) { const entry = entries.find((item) => item.id === id.slice(7)); if (!entry) return; try { if (context.thread.id === entry.sourceThreadId) await send('open-message', { seq: entry.sourceSeq }); else { pendingSource = { threadId: entry.sourceThreadId, seq: entry.sourceSeq }; await send('open-thread', { threadId: entry.sourceThreadId }); } } catch (reason) { error = reason.message || String(reason); draw(); } return; }
    else if (id === 'save-new' || id.startsWith('save-edit:')) {
      const newEntry = id === 'save-new'; const entryId = newEntry ? null : id.slice(10); busy = true; error = ''; draw();
      try { await api('/memory', newEntry ? 'POST' : 'PATCH', newEntry ? { threadId: context.thread.id, category: fields.category, text: fields.text } : { projectId: context.thread.projectId, id: entryId, category: fields.category, text: fields.text }); editing = null; await refresh(); }
      catch (reason) { error = reason.message || String(reason); }
      finally { busy = false; draw(); } return;
    } else if (/^(pin|conflict|expire|delete):/.test(id)) {
      const separator = id.indexOf(':'); const action = id.slice(0, separator); const entryId = id.slice(separator + 1); const entry = entries.find((item) => item.id === entryId); if (!entry) return;
      busy = true; error = ''; draw();
      try { if (action === 'delete') await api('/memory', 'DELETE', { projectId: context.thread.projectId, id: entryId }); else await api('/memory', 'PATCH', { projectId: context.thread.projectId, id: entryId, ...(action === 'pin' ? { pinned: !entry.pinned } : { status: action === 'conflict' ? 'conflicted' : 'expired' }) }); await refresh(); }
      catch (reason) { error = reason.message || String(reason); }
      finally { busy = false; draw(); } return;
    }
    if (id === 'page.next') { pageStart = Math.min(Math.floor((entries.length - 1) / PAGE_SIZE) * PAGE_SIZE, pageStart + PAGE_SIZE); draw(); return; }
    if (id === 'page.previous') { pageStart = Math.max(0, pageStart - PAGE_SIZE); draw(); return; }
    if (id.startsWith('category:')) return;
    draw();
  }
  window.addEventListener('message', (event) => {
    const init = event.data;
    if (event.source !== window.parent || init?.type !== 'pico:plugin-ui:init' || init.protocolVersion !== 1 || init.pluginId !== pluginId || init.entry !== 'webui' || event.ports.length !== 1) return;
    context = init.context ?? { thread: null }; port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === 'pico:plugin-ui:response' && requests.has(data.id)) { const r = requests.get(data.id); requests.delete(data.id); data.ok ? r.resolve(data.value) : r.reject(new Error(data.error)); }
      else if (data?.type === 'pico:plugin-ui:action') void act(data);
      else if (data?.type === 'pico:plugin-ui:context') { context = data.context ?? { thread: null }; editing = null; query = ''; pageStart = 0; if (pendingSource && context.thread?.id === pendingSource.threadId) { const seq = pendingSource.seq; pendingSource = null; void send('open-message', { seq }).catch((reason) => { error = reason instanceof Error ? reason.message : String(reason); draw(); }); } void refresh(); }
      else if (data?.type === 'pico:plugin-ui:event' && data.event?.type === 'plugin.updated' && data.event.pluginId === pluginId) void refresh();
    };
    port.start(); draw(); if (typeof init.attemptId === 'string') port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId }); void refresh();
  });
})();
