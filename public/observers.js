/* === CoreScope — observers.js === */
'use strict';

(function () {
  let observers = [];
  let wsHandler = null;
  let refreshTimer = null;
  let regionChangeHandler = null;
  let sortCol = 'status';
  let sortDir = 1; // 1 = asc, -1 = desc

  const SORT_KEYS = {
    status:  o => { const c = healthStatus(o.last_seen).cls; return c === 'health-green' ? 0 : c === 'health-yellow' ? 1 : 2; },
    name:    o => (o.name || o.id || '').toLowerCase(),
    region:  o => (o.iata || '').toLowerCase(),
    packets: o => o.packet_count || 0,
    rate:    o => o.packetsLastHour || 0,
    uptime:  o => o.first_seen ? new Date(o.first_seen).getTime() : Infinity,
  };

  function init(app) {
    const isMobile = window.matchMedia('(max-width: 1023px)').matches;
    app.innerHTML = `
      <div class="observers-page">
        <div class="page-header">
          <h2>Observer Status</h2>
        </div>
        <div class="obs-toolbar">
          <div id="obsRegionFilter" class="region-filter-container"></div>
          ${isMobile ? `<button class="obs-refresh-btn" data-action="obs-refresh" title="Refresh observer data" aria-label="Refresh">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>` : ''}
        </div>
        <div id="obsContent"><div class="text-center text-muted" style="padding:40px">Loading…</div></div>
      </div>`;
    RegionFilter.init(document.getElementById('obsRegionFilter'));
    regionChangeHandler = RegionFilter.onChange(function () { render(); });
    loadObservers();
    // Event delegation for data-action buttons
    app.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (btn && btn.dataset.action === 'obs-refresh') loadObservers();
      var row = e.target.closest('tr[data-action="navigate"]');
      if (row) location.hash = row.dataset.value;
    });
    // #209 — Keyboard accessibility for observer rows
    app.addEventListener('keydown', function (e) {
      var row = e.target.closest('tr[data-action="navigate"]');
      if (!row) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      location.hash = row.dataset.value;
    });
    // On mobile/tablet: snapshot only — no auto-refresh or WS-driven reloads
    if (!isMobile) {
      refreshTimer = setInterval(loadObservers, 30000);
      wsHandler = debouncedOnWS(function (msgs) {
        if (msgs.some(function (m) { return m.type === 'packet'; })) loadObservers();
      });
    }
  }

  function destroy() {
    if (wsHandler) offWS(wsHandler);
    wsHandler = null;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    if (regionChangeHandler) RegionFilter.offChange(regionChangeHandler);
    regionChangeHandler = null;
    observers = [];
  }

  async function loadObservers() {
    try {
      const data = await api('/observers', { ttl: CLIENT_TTL.observers });
      observers = data.observers || [];
      render();
    } catch (e) {
      document.getElementById('obsContent').innerHTML =
        `<div class="text-muted" role="alert" aria-live="polite" style="padding:40px">Error loading observers: ${e.message}</div>`;
    }
  }

  // NOTE: Comparing server timestamps to Date.now() can skew if client/server
  // clocks differ. We add ±30s tolerance to thresholds to reduce false positives.
  function healthStatus(lastSeen) {
    if (!lastSeen) return { cls: 'health-red', label: 'Unknown' };
    const ago = Date.now() - new Date(lastSeen).getTime();
    const tolerance = 30000; // 30s tolerance for clock skew
    if (ago < 600000 + tolerance) return { cls: 'health-green', label: 'Online' };    // < 10 min + tolerance
    if (ago < 3600000 + tolerance) return { cls: 'health-yellow', label: 'Stale' };   // < 1 hour + tolerance
    return { cls: 'health-red', label: 'Offline' };
  }

  function uptimeStr(firstSeen) {
    if (!firstSeen) return '—';
    const ms = Date.now() - new Date(firstSeen).getTime();
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    if (d > 0) return `${d}d ${h}h`;
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function sparkBar(count, max) {
    if (max === 0) return `<span class="text-muted">0/hr</span>`;
    const pct = Math.min(100, Math.round((count / max) * 100));
    return `<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap"><span style="display:inline-block;width:60px;height:12px;background:var(--border);border-radius:3px;overflow:hidden;vertical-align:middle"><span style="display:block;height:100%;width:${pct}%;background:linear-gradient(90deg,#3b82f6,#60a5fa);border-radius:3px"></span></span><span style="font-size:11px">${count}/hr</span></span>`;
  }

  function render() {
    const el = document.getElementById('obsContent');
    if (!el) return;

    // Apply region filter
    const selectedRegions = RegionFilter.getSelected();
    const filtered = selectedRegions
      ? observers.filter(o => o.iata && selectedRegions.includes(o.iata))
      : observers;

    if (filtered.length === 0) {
      el.innerHTML = '<div class="text-center text-muted" style="padding:40px">No observers found.</div>';
      return;
    }

    const maxPktsHr = Math.max(1, ...filtered.map(o => o.packetsLastHour || 0));

    // Summary counts
    const online = filtered.filter(o => healthStatus(o.last_seen).cls === 'health-green').length;
    const stale = filtered.filter(o => healthStatus(o.last_seen).cls === 'health-yellow').length;
    const offline = filtered.filter(o => healthStatus(o.last_seen).cls === 'health-red').length;

    function sortedRows() {
      const fn = SORT_KEYS[sortCol];
      return [...filtered].sort((a, b) => {
        const av = fn(a), bv = fn(b);
        return av < bv ? -sortDir : av > bv ? sortDir : 0;
      });
    }

    function thHtml(label, key) {
      const active = sortCol === key;
      const arrow = active ? (sortDir === 1 ? ' ↑' : ' ↓') : '';
      return `<th scope="col" class="obs-sortable${active ? ' obs-sort-active' : ''}" data-sort="${key}" style="cursor:pointer" title="Sort by ${label}">${label}${arrow}</th>`;
    }

    function renderRows() {
      const rows = sortedRows();
      const maxPkts = Math.max(1, ...rows.map(o => o.packetsLastHour || 0));
      return rows.map(o => {
        const h = healthStatus(o.last_seen);
        return `<tr style="cursor:pointer" tabindex="0" role="row" data-action="navigate" data-value="#/observers/${encodeURIComponent(o.id)}" onclick="location.hash='#/observers/${encodeURIComponent(o.id)}'">
          <td><span class="health-dot ${h.cls}" title="${h.label}"></span> ${h.label}</td>
          <td class="mono">${o.name || o.id}</td>
          <td>${o.iata || '—'}</td>
          <td>${timeAgo(o.last_seen)}</td>
          <td>${(o.packet_count || 0).toLocaleString()}</td>
          <td>${sparkBar(o.packetsLastHour || 0, maxPkts)}</td>
          <td>${uptimeStr(o.first_seen)}</td>
        </tr>`;
      }).join('');
    }

    el.innerHTML = `
      <div class="obs-summary">
        <span class="obs-stat"><span class="health-dot health-green"></span> ${online} Online</span>
        <span class="obs-stat"><span class="health-dot health-yellow"></span> ${stale} Stale</span>
        <span class="obs-stat"><span class="health-dot health-red"></span> ${offline} Offline</span>
        <span class="obs-stat">📡 ${filtered.length} Total</span>
      </div>
      <div class="obs-table-scroll"><table class="data-table obs-table" id="obsTable">
        <caption class="sr-only">Observer status and statistics</caption>
        <thead><tr>
          ${thHtml('Status','status')}${thHtml('Name','name')}${thHtml('Region','region')}
          <th scope="col">Last Seen</th>
          ${thHtml('Packets','packets')}${thHtml('Packets/Hour','rate')}${thHtml('Uptime','uptime')}
        </tr></thead>
        <tbody>${renderRows()}</tbody>
      </table></div>`;

    // Sort header click handlers
    el.querySelectorAll('.obs-sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (sortCol === key) sortDir *= -1;
        else { sortCol = key; sortDir = 1; }
        // Re-render just the thead and tbody in place
        const table = el.querySelector('#obsTable');
        table.querySelector('thead tr').innerHTML = `
          ${thHtml('Status','status')}${thHtml('Name','name')}${thHtml('Region','region')}
          <th scope="col">Last Seen</th>
          ${thHtml('Packets','packets')}${thHtml('Packets/Hour','rate')}${thHtml('Uptime','uptime')}`;
        table.querySelector('tbody').innerHTML = renderRows();
      });
    });

    makeColumnsResizable('#obsTable', 'meshcore-obs-col-widths');
  }


  registerPage('observers', { init, destroy });
})();
