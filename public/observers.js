/* === MeshCore Analyzer — observers.js === */
'use strict';

(function () {
  let observers = [];
  let wsHandler = null;
  let refreshTimer = null;
  let regionChangeHandler = null;
  let sortCol = 'last_seen';
  let sortDir = -1; // -1 = desc, 1 = asc

  function toggleSort(col) {
    if (sortCol === col) { sortDir *= -1; } else { sortCol = col; sortDir = -1; }
    render();
  }

  function sortArrow(col) {
    if (sortCol !== col) return '';
    return `<span class="sort-arrow">${sortDir === 1 ? '▲' : '▼'}</span>`;
  }

  function sortedObservers(list) {
    return [...list].sort((a, b) => {
      let va, vb;
      switch (sortCol) {
        case 'status':
          va = healthStatus(a.last_seen).cls; vb = healthStatus(b.last_seen).cls; break;
        case 'name':
          va = (a.name || a.id || '').toLowerCase(); vb = (b.name || b.id || '').toLowerCase(); break;
        case 'region':
          va = a.iata || ''; vb = b.iata || ''; break;
        case 'last_seen':
          va = a.last_seen ? new Date(a.last_seen).getTime() : 0;
          vb = b.last_seen ? new Date(b.last_seen).getTime() : 0; break;
        case 'packet_count':
          va = a.packet_count || 0; vb = b.packet_count || 0; break;
        case 'packets_hr':
          va = a.packetsLastHour || 0; vb = b.packetsLastHour || 0; break;
        case 'uptime':
          va = a.first_seen ? new Date(a.first_seen).getTime() : 0;
          vb = b.first_seen ? new Date(b.first_seen).getTime() : 0; break;
        default: return 0;
      }
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
  }

  function init(app) {
    app.innerHTML = `
      <div class="observers-page">
        <div class="obs-topbar">
          <h2 class="obs-title">Observer Status</h2>
          <div id="obsRegionFilter" class="region-filter-container obs-region-filter"></div>
          <button class="btn-icon obs-refresh-btn" data-action="obs-refresh" title="Refresh" aria-label="Refresh observers">🔄</button>
        </div>
        <div id="obsContent"><div class="text-center text-muted" style="padding:40px">Loading…</div></div>
      </div>`;
    RegionFilter.init(document.getElementById('obsRegionFilter'), { compact: true });
    regionChangeHandler = RegionFilter.onChange(function () { render(); });
    loadObservers();
    // Event delegation for data-action buttons
    app.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (btn && btn.dataset.action === 'obs-refresh') loadObservers();
    });
    // Auto-refresh every 30s
    refreshTimer = setInterval(loadObservers, 30000);
    wsHandler = debouncedOnWS(function (msgs) {
      if (msgs.some(function (m) { return m.type === 'packet'; })) loadObservers();
    });
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

    const sorted = sortedObservers(filtered);

    el.innerHTML = `
      <div class="obs-summary">
        <span class="obs-stat"><span class="health-dot health-green">●</span> ${online} Online</span>
        <span class="obs-stat"><span class="health-dot health-yellow">▲</span> ${stale} Stale</span>
        <span class="obs-stat"><span class="health-dot health-red">✕</span> ${offline} Offline</span>
        <span class="obs-stat">📡 ${filtered.length} Total</span>
      </div>
      <div class="obs-table-wrap"><table class="data-table obs-table" id="obsTable">
        <caption class="sr-only">Observer status and statistics</caption>
        <thead><tr>
          <th class="sortable${sortCol==='status'?' sort-active':''}" data-sort="status">Status${sortArrow('status')}</th>
          <th class="sortable${sortCol==='name'?' sort-active':''}" data-sort="name">Name${sortArrow('name')}</th>
          <th class="sortable${sortCol==='region'?' sort-active':''}" data-sort="region">Region${sortArrow('region')}</th>
          <th class="sortable${sortCol==='last_seen'?' sort-active':''}" data-sort="last_seen">Last Seen${sortArrow('last_seen')}</th>
          <th class="sortable${sortCol==='packet_count'?' sort-active':''}" data-sort="packet_count">Packets${sortArrow('packet_count')}</th>
          <th class="sortable${sortCol==='packets_hr'?' sort-active':''}" data-sort="packets_hr">Packets/Hour${sortArrow('packets_hr')}</th>
          <th class="sortable${sortCol==='uptime'?' sort-active':''}" data-sort="uptime">Uptime${sortArrow('uptime')}</th>
        </tr></thead>
        <tbody>${sorted.map(o => {
          const h = healthStatus(o.last_seen);
          const shape = h.cls === 'health-green' ? '●' : h.cls === 'health-yellow' ? '▲' : '✕';
          const statusRowCls = h.cls === 'health-green' ? 'obs-row-online' : h.cls === 'health-yellow' ? 'obs-row-stale' : 'obs-row-offline';
          return `<tr class="${statusRowCls}" style="cursor:pointer" onclick="goto('/observers/${encodeURIComponent(o.id)}')">
            <td><span class="health-dot ${h.cls}" title="${h.label}">${shape}</span> ${h.label}</td>
            <td class="mono">${o.name || o.id}</td>
            <td>${o.iata ? `<span class="badge-region">${o.iata}</span>` : '—'}</td>
            <td>${timeAgo(o.last_seen)}</td>
            <td>${(o.packet_count || 0).toLocaleString()}</td>
            <td>${sparkBar(o.packetsLastHour || 0, maxPktsHr)}</td>
            <td>${uptimeStr(o.first_seen)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;
    makeColumnsResizable('#obsTable', 'meshcore-obs-col-widths');
    el.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => toggleSort(th.dataset.sort));
    });
  }


  registerPage('observers', { init, destroy });
})();
