(() => {
  'use strict';
  const pluginId = 'pico.usage';
  const root = document.getElementById('root');
  let port;
  let requestId = 0;
  let pending = new Map();
  let context = { thread: null };
  let report = null;
  let error = '';
  let busy = false;
  const query = new URLSearchParams(location.search);
  let catalog = { projects: [], threads: [] };
  let filters = {
    threadId: query.get('threadId') || '',
    projectId: query.get('projectId') || '',
    provider: query.get('provider') || '',
    model: query.get('model') || '',
    purpose: query.get('purpose') || '',
    from: query.get('from') || '',
    to: query.get('to') || '',
  };
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const api = (path, method = 'GET', body) =>
    new Promise((resolve, reject) => {
      const id = `${pluginId}-${++requestId}`;
      pending.set(id, { resolve, reject });
      port.postMessage({
        type: 'pico:plugin-ui:request',
        id,
        action: 'api',
        path: `/api/plugins/${pluginId}${path}`,
        ...(method === 'GET'
          ? {}
          : { init: { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) } }),
      });
    });
  const fmt = (value) => (value == null ? 'unknown' : new Intl.NumberFormat().format(value));
  const money = (value, currency) => (value == null ? 'unknown' : `${currency || ''} ${value.toFixed(6)}`.trim());
  function filterQuery() {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    return params.size ? `?${params}` : '';
  }
  function readFilters(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    return Object.fromEntries(
      ['threadId', 'projectId', 'provider', 'model', 'purpose', 'from', 'to'].map((key) => [key, values[key] || '']),
    );
  }
  function projectOptions() {
    return catalog.projects
      .map(
        (project) =>
          `<option value="${escape(project.id)}" ${filters.projectId === project.id ? 'selected' : ''}>${escape(project.name)}</option>`,
      )
      .join('');
  }
  function threadOptions() {
    return catalog.threads
      .filter((thread) => !filters.projectId || thread.projectId === filters.projectId)
      .map(
        (thread) =>
          `<option value="${escape(thread.id)}" ${filters.threadId === thread.id ? 'selected' : ''}>${escape(thread.title || 'Untitled thread')}</option>`,
      )
      .join('');
  }
  function projectLabel(id) {
    return catalog.projects.find((project) => project.id === id)?.name || 'Unknown project';
  }
  function threadLabel(id) {
    return catalog.threads.find((thread) => thread.id === id)?.title || 'Unknown thread';
  }
  function coverageText(coverage) {
    if (!coverage) return 'No data';
    const state = coverage.reported === 0 ? 'No data' : coverage.reported < coverage.total ? 'Partial' : 'Known';
    return `${state} · ${coverage.reported}/${coverage.total} calls`;
  }
  function metricCoverage(key) {
    return `<span class="coverage">${escape(coverageText(report?.coverage?.[key]))}</span>`;
  }
  async function loadCatalog() {
    try {
      const value = await api('/catalog');
      catalog = {
        projects: Array.isArray(value.projects) ? value.projects : [],
        threads: Array.isArray(value.threads) ? value.threads : [],
      };
      render();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      render();
    }
  }
  async function refresh() {
    if (!port) return;
    busy = true;
    render();
    try {
      report = await api(`/report${filterQuery()}`);
      error = '';
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      busy = false;
      render();
    }
  }
  function group(title, rows, label = (key) => key) {
    return `<div><strong>${escape(title)}</strong><div class="group-list">${
      (rows || [])
        .slice(0, 12)
        .map(
          (row) =>
            `<div class="group-row pico-ui-list-item"><span>${escape(label(row.key))}</span><span>${fmt(row.totals.inputTokens)} in / ${fmt(row.totals.outputTokens)} out</span></div><small class="coverage">In ${escape(coverageText(row.coverage?.inputTokens))} · Out ${escape(coverageText(row.coverage?.outputTokens))}</small>`,
        )
        .join('') || '<span class="muted pico-ui-empty">No calls</span>'
    }</div></div>`;
  }
  function render() {
    if (!root) return;
    const totals = report?.totals || {};
    const rows = report?.rows || [];
    root.innerHTML = `<div class="panel pico-ui-panel">
      <div class="heading pico-ui-heading"><div><h1>Usage</h1><div class="subtle">Committed main calls and Runtime-tracked auxiliary model calls</div></div><button id="refresh" class="pico-ui-button" ${busy ? 'disabled' : ''}>Refresh</button></div>
      <form id="filters" class="filters pico-ui-panel"><label>Project<select class="pico-ui-control" name="projectId"><option value="" ${filters.projectId ? '' : 'selected'}>All projects</option>${projectOptions()}</select></label><label>Thread<select class="pico-ui-control" name="threadId"><option value="" ${filters.threadId ? '' : 'selected'}>All threads</option>${threadOptions()}</select></label><label>Provider<input class="pico-ui-control" name="provider" placeholder="Any provider" value="${escape(filters.provider)}"></label><label>Model<input class="pico-ui-control" name="model" placeholder="Any model" value="${escape(filters.model)}"></label><label>Purpose<input class="pico-ui-control" name="purpose" placeholder="Any purpose" value="${escape(filters.purpose)}"></label><label>From<input class="pico-ui-control" name="from" type="date" aria-label="From" value="${escape(filters.from)}"></label><label>To<input class="pico-ui-control" name="to" type="date" aria-label="To" value="${escape(filters.to)}"></label><button class="pico-ui-button pico-ui-button--primary" ${busy ? 'disabled' : ''}>Apply filters</button></form>
      ${error ? `<div class="error pico-ui-error" role="alert">${escape(error)}</div>` : ''}
      <div class="coverage-note">Token totals include reported values only; missing values are excluded, never estimated.</div>
      <div class="cards"><div class="card metric-card pico-ui-metric-card">Input tokens<strong>${fmt(totals.inputTokens)}</strong>${metricCoverage('inputTokens')}</div><div class="card metric-card pico-ui-metric-card">Output tokens<strong>${fmt(totals.outputTokens)}</strong>${metricCoverage('outputTokens')}</div><div class="card metric-card pico-ui-metric-card">Cache read<strong>${fmt(totals.cachedInputTokens)}</strong>${metricCoverage('cachedInputTokens')}</div><div class="card metric-card pico-ui-metric-card">Cache write<strong>${fmt(totals.cacheWriteTokens)}</strong>${metricCoverage('cacheWriteTokens')}</div><div class="card metric-card pico-ui-metric-card">Reasoning<strong>${fmt(totals.reasoningTokens)}</strong>${metricCoverage('reasoningTokens')}</div><div class="card metric-card pico-ui-metric-card">Estimated cost<strong>${money(totals.estimatedCost, rows.find((r) => r.currency)?.currency)}</strong><span class="coverage">Unknown if any call or required price is unknown</span></div><div class="card metric-card pico-ui-metric-card">Main calls<strong>${fmt(report?.counts.completedMainCalls)}</strong></div><div class="card metric-card pico-ui-metric-card">Auxiliary calls<strong>${fmt(report?.counts.auxiliaryCalls)}</strong></div><div class="card metric-card pico-ui-metric-card">Provider attempts<strong>${fmt(report?.counts.providerAttempts)}</strong></div></div>
      <section class="section pico-ui-section"><h2>Breakdown</h2><div class="groups">${group('By Thread', report?.groups.thread, threadLabel)}${group('By Project', report?.groups.project, projectLabel)}${group('By Provider', report?.groups.provider)}${group('By Model', report?.groups.model)}${group('By Purpose', report?.groups.purpose)}${group('By day', report?.groups.day)}</div></section>
      <section class="section pico-ui-section"><h2>Model calls</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>Kind / purpose</th><th>Provider / model</th><th>Thread</th><th>Status / tokens</th><th>Cost</th><th>Attempts</th></tr></thead><tbody>${
        rows
          .slice()
          .reverse()
          .slice(0, 300)
          .map(
            (row) =>
              `<tr><td>${escape(new Date(row.createdAt).toLocaleString())}</td><td>${escape(row.kind)}<br>${escape(row.purpose)}</td><td>${escape(row.provider)}<br>${escape(row.model)}</td><td>${escape(row.threadId ? threadLabel(row.threadId) : '—')}</td><td><span class="pico-ui-status" data-status="${escape(row.status)}">${escape(row.status)}</span><br>${fmt(row.usage?.inputTokens)} in / ${fmt(row.usage?.outputTokens)} out</td><td>${escape(money(row.estimatedCost, row.currency))}</td><td class="attempt">${row.attempts?.map((a) => `${escape(a.outcome || 'attempt')} · ${escape(a.model || '')}`).join('<br>') || '—'}</td></tr>`,
          )
          .join('') || '<tr><td colspan="7" class="muted pico-ui-empty">No calls match the selected filters.</td></tr>'
      }</tbody></table></div><div class="muted">Showing up to 300 calls. Main-call provider and retry telemetry are unavailable in the current Runtime service.</div></section>
      <section class="section pico-ui-section"><h2>Rates</h2><div class="notice pico-ui-panel">Rate inputs use currency units per million tokens. Costs remain unknown unless a matching provider/model rate effective at call time can price every reported dimension.</div><form id="rate-form" class="rate-form pico-ui-panel"><input class="pico-ui-control" name="provider" placeholder="Provider" required><input class="pico-ui-control" name="model" placeholder="Model" required><input class="pico-ui-control" name="currency" placeholder="Currency (e.g. USD)" required maxlength="8"><input class="pico-ui-control" name="effectiveAt" type="date" required><input class="pico-ui-control" name="inputPerMillion" type="number" min="0" step="any" placeholder="Input / 1M" required><input class="pico-ui-control" name="outputPerMillion" type="number" min="0" step="any" placeholder="Output / 1M" required><input class="pico-ui-control" name="cachedInputPerMillion" type="number" min="0" step="any" placeholder="Cache read / 1M"><input class="pico-ui-control" name="cacheWritePerMillion" type="number" min="0" step="any" placeholder="Cache write / 1M"><button class="pico-ui-button pico-ui-button--primary" ${busy ? 'disabled' : ''}>Save rate</button></form><div class="rate-list">${(report?.rates || []).map((rate) => `<div class="rate-row pico-ui-list-item"><span>${escape(rate.provider)} / ${escape(rate.model)} · ${escape(rate.effectiveAt)} · ${escape(rate.currency)} ${rate.inputPerMillion}/${rate.outputPerMillion} per 1M</span><button class="pico-ui-button" type="button" data-delete-rate="${escape(rate.id)}">Remove</button></div>`).join('') || '<span class="muted pico-ui-empty">No rates configured.</span>'}</div></section>
      ${report?.limitations?.map((item) => `<div class="notice">${escape(item)}</div>`).join('') || ''}
    </div>`;
    root.querySelector('#refresh')?.addEventListener('click', () => void refresh());
    root.querySelector('#filters')?.addEventListener('submit', (event) => {
      event.preventDefault();
      filters = readFilters(event.currentTarget);
      void refresh();
    });
    root.querySelector('[name="projectId"]')?.addEventListener('change', (event) => {
      filters = readFilters(root.querySelector('#filters'));
      filters.projectId = event.currentTarget.value;
      filters.threadId = '';
      render();
      void refresh();
    });
    root.querySelector('[name="threadId"]')?.addEventListener('change', (event) => {
      filters = readFilters(root.querySelector('#filters'));
      filters.threadId = event.currentTarget.value;
      render();
      void refresh();
    });
    root.querySelector('#rate-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget).entries());
      const rate = {
        id: crypto.randomUUID(),
        ...values,
        inputPerMillion: Number(values.inputPerMillion),
        outputPerMillion: Number(values.outputPerMillion),
        ...(values.cachedInputPerMillion ? { cachedInputPerMillion: Number(values.cachedInputPerMillion) } : {}),
        ...(values.cacheWritePerMillion ? { cacheWritePerMillion: Number(values.cacheWritePerMillion) } : {}),
        effectiveAt: new Date(`${values.effectiveAt}T00:00:00.000Z`).toISOString(),
      };
      try {
        await api('/rates', 'PUT', { rate });
        await refresh();
      } catch (reason) {
        error = reason.message || String(reason);
        render();
      }
    });
    root.querySelectorAll('[data-delete-rate]').forEach((button) =>
      button.addEventListener('click', async (event) => {
        try {
          await api('/rates', 'DELETE', { id: event.currentTarget.dataset.deleteRate });
          await refresh();
        } catch (reason) {
          error = reason.message || String(reason);
          render();
        }
      }),
    );
  }
  window.addEventListener('message', (event) => {
    const init = event.data;
    if (
      event.source !== window.parent ||
      init?.type !== 'pico:plugin-ui:init' ||
      init.protocolVersion !== 1 ||
      init.pluginId !== pluginId ||
      init.entry !== 'webui' ||
      init.viewType !== 'page' ||
      event.ports.length !== 1
    )
      return;
    context = init.context || context;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === 'pico:plugin-ui:response' && pending.has(data.id)) {
        const request = pending.get(data.id);
        pending.delete(data.id);
        data.ok ? request.resolve(data.value) : request.reject(new Error(data.error));
      }
      if (data?.type === 'pico:plugin-ui:context') {
        context = data.context || context;
        void refresh();
      }
    };
    port.start();
    render();
    void loadCatalog();
    void refresh();
  });
})();
