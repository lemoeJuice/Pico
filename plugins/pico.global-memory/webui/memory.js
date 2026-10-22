(() => {
  'use strict';
  const pluginId = 'pico.global-memory';
  let port = null, context = { thread: null }, items = [], visibleCount = 60, autoEnabled = true, search = '', busy = false, error = '', sequence = 0, timer = 0;
  let addFields = { text: '', category: 'preference' }, editId = null, editFields = { text: '', applicability: '' }, deleteId = null;
  const requests = new Map();
  const para = (text) => ({ type: 'paragraph', text: String(text ?? '') });
  const button = (label, actionId, options = {}) => ({ type: 'button', label, actionId, ...options });
  function api(path, method = 'GET', body) {
    const id = `${pluginId}-${++sequence}`, init = method === 'GET' ? undefined : { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); port.postMessage({ type: 'pico:plugin-ui:request', id, action: 'api', path: `/api/plugins/${pluginId}${path}`, ...(init ? { init } : {}) }); });
  }
  async function refresh() {
    try { const result = await api(`/items${search ? `?query=${encodeURIComponent(search)}` : ''}`); items = Array.isArray(result.items) ? result.items : []; autoEnabled = result.autoEnabled !== false; error = ''; }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    draw();
  }
  function draw() {
    const nodes = [{ type: 'heading', text: 'Memory' }, para('Global memories apply across Projects. Project Context remains scoped to its Project.'),
      { type: 'switch', label: 'Auto memory', checked: autoEnabled, actionId: 'auto', disabled: busy },
      { type: 'textArea', label: 'Memory text', value: addFields.text, placeholder: 'Add a durable preference or general fact…', actionId: 'add.text', rows: 'standard', maxLength: 1200, disabled: busy },
      { type: 'select', label: 'Category', value: addFields.category, actionId: 'add.category', disabled: busy, options: ['preference','fact','collaboration','other'].map((x) => ({ label: x[0].toUpperCase()+x.slice(1), value: x })) },
      button('Add', 'add', { tone: 'primary', disabled: busy || !addFields.text.trim() }),
      { type: 'textInput', label: 'Search memories', value: search, placeholder: 'Search memories…', actionId: 'search' }];
    if (error) nodes.push(para(error));
    if (!items.length) nodes.push(para('No matching Global Memory entries.'));
    for (const item of items.slice(0, visibleCount)) {
      const content = [{ type: 'heading', text: `${item.category} · ${Math.round(item.confidence * 100)}%` }];
      if (editId === item.id) {
        content.push({ type: 'textArea', label: 'Memory text', value: editFields.text, actionId: `edit.text:${item.id}`, rows: 'standard', maxLength: 1200, disabled: busy });
        content.push({ type: 'textInput', label: 'Applicability (optional)', value: editFields.applicability, actionId: `edit.applicability:${item.id}`, disabled: busy });
        content.push({ type: 'actions', children: [button('Save', `save:${item.id}`, { tone: 'primary', disabled: busy || !editFields.text.trim() }), button('Cancel', 'cancel-edit', { disabled: busy })] });
      } else {
        content.push(para(item.text));
        if (item.applicability) content.push(para(`Applies: ${item.applicability}`));
        content.push(para(item.sources?.length ? `Sources: ${item.sources.map((source) => `${source.threadId} #${source.seq}`).join(' · ')}` : 'Manual entry'));
        content.push({ type: 'checkbox', label: 'Pin', checked: item.pinned, actionId: `pin:${item.id}` });
        content.push({ type: 'actions', children: [button('Edit', `edit:${item.id}`, { disabled: busy }), button(deleteId === item.id ? 'Confirm delete' : 'Delete', deleteId === item.id ? `confirm-delete:${item.id}` : `delete:${item.id}`, { tone: 'danger', disabled: busy }), ...(deleteId === item.id ? [button('Cancel', 'cancel-delete')] : [])] });
      }
      nodes.push({ type: 'card', children: content });
    }
    if (items.length > visibleCount) nodes.push(button('Load more memories', 'load-more'));
    port?.postMessage({ type: 'pico:plugin-ui:render', tree: nodes });
  }
  async function mutate(patch) {
    busy = true; error = ''; draw();
    try { await api('/items', 'PATCH', { threadId: context.thread?.id, ...patch }); await refresh(); }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { busy = false; draw(); }
  }
  async function act(a) {
    const id = a.actionId;
    if (id === 'search' && typeof a.value === 'string') { search = a.value; draw(); clearTimeout(timer); timer = setTimeout(() => void refresh(), 250); return; }
    if (id === 'add.text') addFields.text = a.value;
    else if (id === 'add.category') addFields.category = a.value;
    else if (id === 'auto') { busy = true; draw(); try { const result = await api('/settings', 'PUT', { autoEnabled: a.value === 'true' }); autoEnabled = result.autoEnabled; error = ''; } catch (reason) { error = reason.message || String(reason); } finally { busy = false; draw(); } return; }
    else if (id.startsWith('edit.text:')) editFields.text = a.value;
    else if (id.startsWith('edit.applicability:')) editFields.applicability = a.value;
    else if (id.startsWith('pin:')) { const item = items.find((x) => x.id === id.slice(4)); if (item) await mutate({ id: item.id, pinned: a.value === 'true' }); return; }
    else if (id === 'add') { busy = true; draw(); try { await api('/items', 'POST', { threadId: context.thread?.id, text: addFields.text, category: addFields.category, confidence: 1 }); addFields = { text: '', category: 'preference' }; await refresh(); } catch (reason) { error = reason.message || String(reason); } finally { busy = false; draw(); } return; }
    else if (id === 'cancel-edit') { editId = null; draw(); return; }
    else if (id === 'cancel-delete') { deleteId = null; draw(); return; }
    else if (id === 'load-more') { visibleCount += 60; draw(); return; }
    else if (id.startsWith('edit:')) { const item = items.find((x) => x.id === id.slice(5)); if (item) { editId = item.id; editFields = { text: item.text, applicability: item.applicability || '' }; } draw(); return; }
    else if (id.startsWith('delete:')) { deleteId = id.slice(7); draw(); return; }
    else if (id.startsWith('confirm-delete:')) { const itemId = id.slice(15); busy = true; draw(); try { await api('/items', 'DELETE', { threadId: context.thread?.id, id: itemId }); deleteId = null; await refresh(); } catch (reason) { error = reason.message || String(reason); } finally { busy = false; draw(); } return; }
    else if (id.startsWith('save:')) { const itemId = id.slice(5); await mutate({ id: itemId, text: editFields.text, applicability: editFields.applicability }); editId = null; return; }
    draw();
  }
  window.addEventListener('message', (event) => {
    const init = event.data;
    if (event.source !== window.parent || init?.type !== 'pico:plugin-ui:init' || init.protocolVersion !== 1 || init.pluginId !== pluginId || init.entry !== 'webui' || init.viewType !== 'page' || event.ports.length !== 1) return;
    context = init.context || context; port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === 'pico:plugin-ui:response' && requests.has(data.id)) { const request = requests.get(data.id); requests.delete(data.id); data.ok ? request.resolve(data.value) : request.reject(new Error(data.error)); }
      else if (data?.type === 'pico:plugin-ui:action') void act(data);
      else if (data?.type === 'pico:plugin-ui:context') { context = data.context || context; void refresh(); }
      else if (data?.type === 'pico:plugin-ui:event' && data.event?.type === 'plugin.updated' && data.event.pluginId === pluginId) void refresh();
    };
    port.start(); draw(); if (typeof init.attemptId === 'string') port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId }); void refresh();
  });
})();
