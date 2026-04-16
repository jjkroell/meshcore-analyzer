/* === CoreScope — packets.js === */
'use strict';

(function () {
  let packets = [];
  let hashIndex = new Map(); // hash → packet group for O(1) dedup

  // Resolve observer_id to friendly name from loaded observers list
  function obsName(id) {
    if (!id) return '—';
    const o = observerMap.get(id);
    if (!o) return id;
    return o.iata ? `${o.name} (${o.iata})` : o.name;
  }
  function obsNameOnly(id) {
    if (!id) return '—';
    const o = observerMap.get(id);
    if (!o) return id;
    return o.name || id;
  }
  let selectedId = null;
  let groupByHash = true;
  let filters = {};
  { const o = localStorage.getItem('meshcore-observer-filter'); if (o) filters.observer = o;
    const t = localStorage.getItem('meshcore-type-filter'); if (t) filters.type = t; }
  let wsHandler = null;
  let packetsPaused = false;
  let pauseBuffer = [];
  let observers = [];
  let observerMap = new Map(); // id → observer for O(1) lookups (#383)
  let regionMap = {};
  const TYPE_NAMES = { 0:'Request', 1:'Response', 2:'Direct Msg', 3:'ACK', 4:'Advert', 5:'Channel Msg', 7:'Anon Req', 8:'Path', 9:'Trace', 11:'Control' };
  function typeName(t) { return TYPE_NAMES[t] ?? `Type ${t}`; }
  const isMobile = window.innerWidth <= 1024;
  const PACKET_LIMIT = isMobile ? 1000 : 50000;
  let savedTimeWindowMin = Number(localStorage.getItem('meshcore-time-window'));
  if (!Number.isFinite(savedTimeWindowMin) || savedTimeWindowMin <= 0) savedTimeWindowMin = 15;
  if (isMobile && savedTimeWindowMin > 180) savedTimeWindowMin = 15;
  let totalCount = 0;
  let expandedHashes = new Set();
  let hopNameCache = {};
  let _tableSortInstance = null;
  let _packetSortColumn = null;
  let _packetSortDirection = 'desc';
  const showHexHashes = true;
  var _pendingUrlRegion = null;

  var DEFAULT_TIME_WINDOW = 15;

  function buildPacketsQuery(timeWindowMin, regionParam) {
    var parts = [];
    if (timeWindowMin && timeWindowMin !== DEFAULT_TIME_WINDOW) parts.push('timeWindow=' + timeWindowMin);
    if (regionParam) parts.push('region=' + encodeURIComponent(regionParam));
    return parts.length ? '?' + parts.join('&') : '';
  }
  window.buildPacketsQuery = buildPacketsQuery;

  function updatePacketsUrl() {
    history.replaceState(null, '', '#/packets' + buildPacketsQuery(savedTimeWindowMin, RegionFilter.getRegionParam()));
  }

  let filtersBuilt = false;
  let _renderTimer = null;
  function scheduleRender() {
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(() => renderTableRows(), 200);
  }

  // Coalesce WS-triggered renders into one per animation frame (#396).
  // Multiple WS batches arriving within the same frame only trigger a single
  // renderTableRows() call on the next rAF, preventing rapid full rebuilds.
  function scheduleWSRender() {
    _wsRenderDirty = true;
    if (_wsRafId) return;  // already scheduled
    _wsRafId = requestAnimationFrame(function () {
      _wsRafId = null;
      if (_wsRenderDirty) {
        _wsRenderDirty = false;
        renderTableRows();
      }
    });
  }
  const PANEL_WIDTH_KEY = 'meshcore-panel-width';
  const PANEL_CLOSE_HTML = '<button class="panel-close-btn" data-tooltip="Close detail pane (Esc)">✕</button>';

  // getParsedPath / getParsedDecoded are in shared packet-helpers.js (loaded before this file)
  const getParsedPath = window.getParsedPath;
  const getParsedDecoded = window.getParsedDecoded;

  // --- Virtual scroll state ---
  let VSCROLL_ROW_HEIGHT = 36;    // measured dynamically on first render; fallback 36px
  let _vscrollRowHeightMeasured = false;
  let _vscrollTheadHeight = 40;   // measured dynamically on first render; fallback 40px
  const VSCROLL_BUFFER = 30;      // extra rows above/below viewport
  let _displayPackets = [];       // filtered packets for current view
  let _displayGrouped = false;    // whether _displayPackets is in grouped mode
  let _rowCounts = [];            // per-entry DOM row counts (1 for flat, 1+children for expanded groups)
  let _rowCountsDirty = false;    // set when _rowCounts may be stale (e.g. WS added children) (#410)
  let _cumulativeOffsetsCache = null; // cached cumulative offsets, invalidated on _rowCounts change
  let _lastVisibleStart = -1;     // last rendered start index (for dirty checking)
  let _lastVisibleEnd = -1;       // last rendered end index (for dirty checking)
  let _vsScrollHandler = null;    // scroll listener reference
  let _wsRenderTimer = null;      // debounce timer for WS-triggered renders
  let _wsRafId = null;            // rAF id for coalescing WS-triggered renders (#396)
  let _wsRenderDirty = false;     // dirty flag for rAF render coalescing (#396)
  let _observerFilterSet = null;  // cached Set from filters.observer, hoisted above loops (#427)

  // Pure function: calculate visible entry range from scroll state.
  // Extracted for testability (#405, #409).
  function _calcVisibleRange(offsets, entryCount, scrollTop, viewportHeight, rowHeight, theadHeight, buffer) {
    const adjustedScrollTop = Math.max(0, scrollTop - theadHeight);
    const firstDomRow = Math.floor(adjustedScrollTop / rowHeight);
    const visibleDomCount = Math.ceil(viewportHeight / rowHeight);

    // Binary search for first entry whose cumulative offset covers firstDomRow
    let lo = 0, hi = entryCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid + 1] <= firstDomRow) lo = mid + 1;
      else hi = mid;
    }
    const firstEntry = lo;

    // Binary search for last visible entry
    const lastDomRow = firstDomRow + visibleDomCount;
    lo = firstEntry; hi = entryCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid + 1] <= lastDomRow) lo = mid + 1;
      else hi = mid;
    }
    const lastEntry = Math.min(lo + 1, entryCount);

    const startIdx = Math.max(0, firstEntry - buffer);
    const endIdx = Math.min(entryCount, lastEntry + buffer);
    return { startIdx, endIdx, firstEntry, lastEntry };
  }

  function closeDetailPanel() {
    const overlay = document.getElementById('pktDetailOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
    selectedId = null;
    location.hash = '/packets';
    _popPktMobileBack();
  }

  function initPanelResize() {
    const handle = document.getElementById('pktResizeHandle');
    const panel = document.getElementById('pktRight');
    if (!handle || !panel) return;
    // Restore saved width
    const saved = localStorage.getItem(PANEL_WIDTH_KEY);
    if (saved) panel.style.width = saved + 'px';

    let startX, startW;
    function startResize(clientX) {
      startX = clientX;
      startW = panel.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    function doResize(clientX) {
      const w = Math.max(280, Math.min(window.innerWidth * 0.7, startW - (clientX - startX)));
      panel.style.width = w + 'px';
      panel.style.minWidth = w + 'px';
      const left = document.getElementById('pktLeft');
      if (left) {
        const available = left.parentElement.clientWidth - w;
        left.style.width = available + 'px';
      }
    }
    function endResize() {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(PANEL_WIDTH_KEY, panel.offsetWidth);
      const left = document.getElementById('pktLeft');
      if (left) left.style.width = '';
    }

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startResize(e.clientX);

      function onMove(e2) { doResize(e2.clientX); }
      function onUp() {
        endResize();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      startResize(e.touches[0].clientX);

      function onTouchMove(e2) {
        if (e2.touches.length !== 1) return;
        e2.preventDefault();
        doResize(e2.touches[0].clientX);
      }
      function onTouchEnd() {
        endResize();
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
      }
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('touchend', onTouchEnd);
    }, { passive: false });
  }

  // Ensure HopResolver is initialized with the nodes list + observer IATA data
  async function ensureHopResolver() {
    if (!HopResolver.ready()) {
      try {
        const [nodeData, obsData, coordData] = await Promise.all([
          api('/nodes?limit=2000', { ttl: 60000 }),
          api('/observers', { ttl: 60000 }),
          api('/iata-coords', { ttl: 300000 }).catch(() => ({ coords: {} })),
        ]);
        HopResolver.init(nodeData.nodes || [], {
          observers: obsData.observers || obsData || [],
          iataCoords: coordData.coords || {},
        });
      } catch {}
    }
  }

  // Resolve hop hex prefixes to node names (cached, client-side)
  async function resolveHops(hops) {
    const unknown = hops.filter(h => !(h in hopNameCache));
    if (unknown.length) {
      await ensureHopResolver();
      const resolved = HopResolver.resolve(unknown);
      Object.assign(hopNameCache, resolved || {});
      // Cache misses as null so we don't re-query
      unknown.forEach(h => { if (!(h in hopNameCache)) hopNameCache[h] = null; });
    }
  }

  /**
   * Pre-populate hopNameCache from server-side resolved_path on packets.
   * Packets with resolved_path skip client-side HopResolver entirely.
   * Must call ensureHopResolver() first so nodesList is available for name lookup.
   */
  async function cacheResolvedPaths(packets) {
    if (!packets || !packets.length) return;
    let needsInit = false;
    for (const p of packets) {
      const rp = getResolvedPath(p);
      if (rp) { needsInit = true; break; }
    }
    if (!needsInit) return;
    await ensureHopResolver();
    for (const p of packets) {
      const rp = getResolvedPath(p);
      if (!rp) continue;
      const hops = getParsedPath(p);
      const resolved = HopResolver.resolveFromServer(hops, rp);
      Object.assign(hopNameCache, resolved);
    }
  }

  function renderHop(h, observerId) {
    // Use per-packet cache key if observer context available (ambiguous hops differ by region)
    const cacheKey = observerId ? h + ':' + observerId : h;
    const entry = hopNameCache[cacheKey] || hopNameCache[h];
    return HopDisplay.renderHop(h, entry, { hexMode: showHexHashes });
  }

  function renderPath(hops, observerId) {
    if (!hops || !hops.length) return '—';
    return hops.map(h => renderHop(h, observerId)).join('<span class="arrow">→</span>');
  }

  let directPacketId = null;
  let directPacketHash = null;
  let initGeneration = 0;
  let _docActionHandler = null;
  let _docMenuCloseHandler = null;
  let _docColMenuCloseHandler = null;

  let directObsId = null;

  // Mobile back-gesture state (history.pushState approach, same as channels.js)
  let _pktMobileNavPushed = false;
  let _pktSkipNextPopstate = false;
  let _pktPopstateHandler = null;

  function _pushPktMobileBack() {
    if (window.matchMedia('(max-width: 640px)').matches && !_pktMobileNavPushed) {
      _pktMobileNavPushed = true;
      history.pushState({ _pktMobileBack: true }, '', location.href);
    }
  }

  function _popPktMobileBack() {
    if (_pktMobileNavPushed) {
      _pktMobileNavPushed = false;
      _pktSkipNextPopstate = true;
      history.back();
    }
  }

  function removeAllByopOverlays() {
    document.querySelectorAll('.byop-overlay').forEach(function (el) { el.remove(); });
  }

  function bindDocumentHandler(kind, eventName, handler) {
    const prev = kind === 'action'
      ? _docActionHandler
      : kind === 'menu'
        ? _docMenuCloseHandler
        : _docColMenuCloseHandler;
    if (prev) document.removeEventListener(eventName, prev);
    document.addEventListener(eventName, handler);
    if (kind === 'action') _docActionHandler = handler;
    else if (kind === 'menu') _docMenuCloseHandler = handler;
    else _docColMenuCloseHandler = handler;
  }

  function renderTimestampCell(isoString) {
    if (typeof formatTimestampWithTooltip !== 'function' || typeof getTimestampMode !== 'function') {
      const full = typeof timeAgo === 'function' ? timeAgo(isoString) : '—';
      const short = full.replace(/ ago$/, '');
      return `<span class="ts-full">${escapeHtml(full)}</span><span class="ts-short">${escapeHtml(short)}</span>`;
    }
    const f = formatTimestampWithTooltip(isoString, getTimestampMode());
    const short = f.text.replace(/ ago$/, '');
    const warn = f.isFuture
      ? ' <span class="timestamp-future-icon" title="Timestamp is in the future — node clock may be skewed">⚠️</span>'
      : '';
    return `<span class="timestamp-text" title="${escapeHtml(f.tooltip)}"><span class="ts-full">${escapeHtml(f.text)}</span><span class="ts-short">${escapeHtml(short)}</span></span>${warn}`;
  }

  async function init(app, routeParam) {
    const gen = ++initGeneration;
    // Parse ?obs=OBSERVER_ID from routeParam
    if (routeParam && routeParam.includes('?')) {
      const qIdx = routeParam.indexOf('?');
      const qs = new URLSearchParams(routeParam.substring(qIdx));
      directObsId = qs.get('obs');
      routeParam = routeParam.substring(0, qIdx);
    }
    // Detect route param type: "id/123" for direct packet, short hex for hash, long hex for node
    if (routeParam) {
      if (routeParam.startsWith('id/')) {
        directPacketId = routeParam.slice(3);
      } else if (routeParam.length <= 16) {
        filters.hash = routeParam;
        directPacketHash = routeParam;
      } else {
        filters.node = routeParam;
      }
    }

    // Read URL params (router strips query from routeParam; read from location.hash)
    var _initUrlParams = getHashParams();
    var _urlTimeWindow = Number(_initUrlParams.get('timeWindow'));
    if (Number.isFinite(_urlTimeWindow) && _urlTimeWindow > 0) {
      savedTimeWindowMin = _urlTimeWindow;
      localStorage.setItem('meshcore-time-window', String(_urlTimeWindow));
    }
    var _urlRegion = _initUrlParams.get('region');
    if (_urlRegion) _pendingUrlRegion = _urlRegion;

    app.innerHTML = `<div class="pkt-full-layout">
      <div class="panel-left" id="pktLeft" aria-live="polite" aria-relevant="additions removals"></div>
    </div>
    <div class="modal-overlay pkt-detail-overlay" id="pktDetailOverlay" style="display:none">
      <div class="modal pkt-detail-modal" role="dialog" aria-label="Packet Detail" aria-modal="true">
        <div class="pkt-detail-modal-header">
          <span class="pkt-detail-modal-title" id="pktDetailTitle">Packet Detail</span>
          <button class="btn-icon pkt-detail-close" id="pktDetailClose" data-tooltip="Close">✕</button>
        </div>
        <div class="pkt-detail-modal-body" id="pktDetailBody"></div>
      </div>
    </div>`;
    // Detail modal open/close
    document.getElementById('pktDetailClose').addEventListener('click', closeDetailPanel);
    document.getElementById('pktDetailOverlay').addEventListener('click', function(e) {
      if (e.target === this) closeDetailPanel();
    });
    document.addEventListener('keydown', function _detailEsc(e) {
      if (e.key === 'Escape' && document.getElementById('pktDetailOverlay').style.display !== 'none') closeDetailPanel();
    });

    // Mobile: intercept browser back gesture to close open modals
    _pktPopstateHandler = function() {
      if (_pktSkipNextPopstate) { _pktSkipNextPopstate = false; return; }
      if (!_pktMobileNavPushed) return;
      _pktMobileNavPushed = false;
      const detailOverlay = document.getElementById('pktDetailOverlay');
      const filtersOverlay = document.getElementById('pktFiltersOverlay');
      const byopOverlay = document.querySelector('.byop-overlay');
      if (detailOverlay && detailOverlay.style.display !== 'none') {
        detailOverlay.style.display = 'none';
        selectedId = null;
        location.hash = '/packets';
      } else if (filtersOverlay && filtersOverlay.style.display !== 'none') {
        filtersOverlay.style.display = 'none';
        filtersOverlay.setAttribute('aria-hidden', 'true');
      } else if (byopOverlay) {
        removeAllByopOverlays();
      }
    };
    window.addEventListener('popstate', _pktPopstateHandler);

    await loadObservers();
    loadPackets();

    // Auto-select packet detail when arriving via hash URL
    if (directPacketHash) {
      const h = directPacketHash;
      const obsTarget = directObsId;
      directPacketHash = null;
      directObsId = null;
      try {
        const data = await api(`/packets/${h}`);
        if (gen === initGeneration && data?.packet) {
          if (obsTarget && data.observations) {
            // Find the matching observation by its unique id
            const obs = data.observations.find(o => String(o.id) === String(obsTarget));
            if (obs) {
              expandedHashes.add(h);
              const obsPacket = {...data.packet, observer_id: obs.observer_id, observer_name: obs.observer_name, snr: obs.snr, rssi: obs.rssi, path_json: obs.path_json, resolved_path: obs.resolved_path, timestamp: obs.timestamp, first_seen: obs.timestamp};
              clearParsedCache(obsPacket);
              selectPacket(obs.id, h, {packet: obsPacket, breakdown: data.breakdown, observations: data.observations}, obs.id);
            } else {
              selectPacket(data.packet.id, h, data);
            }
          } else {
            selectPacket(data.packet.id, h, data);
          }
        }
      } catch {}
    }

    // Event delegation for data-action buttons
    bindDocumentHandler('action', 'click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'pkt-refresh') loadPackets();
      else if (btn.dataset.action === 'pkt-byop') showBYOP();
      else if (btn.dataset.action === 'pkt-pause') {
        packetsPaused = !packetsPaused;
        const pauseBtn = document.getElementById('pktPauseBtn');
        if (pauseBtn) {
          pauseBtn.setAttribute('aria-pressed', packetsPaused);
          pauseBtn.title = packetsPaused ? 'Resume live updates' : 'Pause live updates';
          pauseBtn.classList.toggle('paused', packetsPaused);
          pauseBtn.innerHTML = packetsPaused
            ? `<span class="pkt-pause-play">▶</span><span class="pkt-pill-text"> Resume</span>`
            : `⏸<span class="pkt-pill-text"> Pause</span>`;
        }
        if (!packetsPaused && pauseBuffer.length) {
          const handler = wsHandler;
          pauseBuffer.forEach(msg => { if (handler) handler(msg); });
          pauseBuffer = [];
        }
      }
    });

    // If linked directly to a packet by ID, load its detail and filter list
    if (directPacketId) {
      const pktId = Number(directPacketId);
      directPacketId = null;
      try {
        const data = await api(`/packets/${pktId}`);
        if (gen !== initGeneration) return;
        if (data.packet?.hash) {
          filters.hash = data.packet.hash;
          const hashInput = document.getElementById('fHash');
          if (hashInput) hashInput.value = filters.hash;
          await loadPackets();
        }
        // Show detail in modal
        await selectPacket(pktId, data.packet?.hash, data);
      } catch {}
    }
    wsHandler = debouncedOnWS(function (msgs) {
      if (packetsPaused) {
        pauseBuffer.push(...msgs);
        if (pauseBuffer.length > 2000) pauseBuffer = pauseBuffer.slice(-2000);
        const btn = document.getElementById('pktPauseBtn');
        if (btn) btn.innerHTML = `<span class="pkt-pause-play">▶</span><span class="pkt-pill-text"> +${pauseBuffer.length}</span>`;
        return;
      }
      const newPkts = msgs
        .filter(m => m.type === 'packet' && m.data?.packet)
        .map(m => m.data.packet);
      if (!newPkts.length) return;

      // Check if new packets pass current filters
      const filtered = newPkts.filter(p => {
        // Respect time window filter — drop packets outside the selected window
        const windowMin = savedTimeWindowMin;
        if (windowMin > 0) {
          const cutoff = new Date(Date.now() - windowMin * 60000).toISOString();
          const pktTime = p.latest || p.timestamp || p.first_seen;
          if (pktTime && pktTime < cutoff) return false;
        }
        if (filters.type) { const types = filters.type.split(',').map(Number); if (!types.includes(p.payload_type)) return false; }
        if (filters.observer) { const obsSet = new Set(filters.observer.split(',')); if (!obsSet.has(p.observer_id) && !(p._children && p._children.some(c => obsSet.has(String(c.observer_id))))) return false; }
        if (filters.hash && p.hash !== filters.hash) return false;
        if (RegionFilter.getRegionParam()) {
          const selectedRegions = RegionFilter.getRegionParam().split(',');
          const obs = observerMap.get(p.observer_id);
          if (!obs || !selectedRegions.includes(obs.iata)) return false;
        }
        if (filters.node && !(p.decoded_json || '').includes(filters.node)) return false;
        return true;
      });
      if (!filtered.length) return;

      // Resolve any new hops, then update and re-render
      // Pre-populate from server-side resolved_path, then fall back for remaining
      const newHops = new Set();
      for (const p of filtered) {
        const rp = getResolvedPath(p);
        const hops = getParsedPath(p);
        if (rp && rp.length === hops.length && window.HopResolver && HopResolver.ready()) {
          const resolved = HopResolver.resolveFromServer(hops, rp);
          Object.assign(hopNameCache, resolved);
        }
        try { hops.forEach(h => { if (!(h in hopNameCache)) newHops.add(h); }); } catch {}
      }
      (newHops.size ? resolveHops([...newHops]) : Promise.resolve()).then(() => {
        if (groupByHash) {
          // Update existing groups or create new ones
          for (const p of filtered) {
            const h = p.hash;
            const existing = hashIndex.get(h);
            if (existing) {
              existing.count = (existing.count || 1) + 1;
              existing.observation_count = (existing.observation_count || 1) + 1;
              existing.latest = p.timestamp > existing.latest ? p.timestamp : existing.latest;
              // Track unique observers
              if (p.observer_id && p.observer_id !== existing.observer_id) {
                existing.observer_count = (existing.observer_count || 1) + 1;
              }
              // Don't update path — header always shows first observer's path
              // Update decoded_json to latest
              if (p.decoded_json) existing.decoded_json = p.decoded_json;
              // Update expanded children if this group is expanded
              if (expandedHashes.has(h) && existing._children) {
                existing._children.unshift(p);
                if (existing._children.length > 200) existing._children.length = 200;
                sortGroupChildren(existing);
                // Invalidate row counts — child count changed, so virtual scroll
                // heights are stale until next renderTableRows() (#410)
                _invalidateRowCounts();
              }
            } else {
              // New group
              const newGroup = {
                hash: h,
                count: 1,
                observer_count: 1,
                latest: p.timestamp,
                observer_id: p.observer_id,
                observer_name: p.observer_name,
                path_json: p.path_json,
                payload_type: p.payload_type,
                raw_hex: p.raw_hex,
                decoded_json: p.decoded_json,
              };
              packets.unshift(newGroup);
              if (h) hashIndex.set(h, newGroup);
            }
          }
          // Re-sort by active sort column (or latest DESC as default), then evict oldest beyond the limit
          if (_packetSortColumn) {
            sortPacketsArray();
          } else {
            packets.sort((a, b) => (b.latest || '').localeCompare(a.latest || ''));
          }
          if (packets.length > PACKET_LIMIT) {
            const evicted = packets.splice(PACKET_LIMIT);
            for (const p of evicted) { if (p.hash) hashIndex.delete(p.hash); }
          }
        } else {
          // Flat mode: prepend, then evict oldest beyond the limit
          packets = filtered.concat(packets);
          if (packets.length > PACKET_LIMIT) packets.length = PACKET_LIMIT;
        }
        totalCount += filtered.length;
        // Coalesce WS-triggered renders via rAF (#396)
        scheduleWSRender();
      });
    });
  }

  function destroy() {
    clearTimeout(_renderTimer);
    if (wsHandler) offWS(wsHandler);
    wsHandler = null;
    if (_tableSortInstance) { _tableSortInstance.destroy(); _tableSortInstance = null; }
    detachVScrollListener();
    clearTimeout(_wsRenderTimer);
    if (_wsRafId) { cancelAnimationFrame(_wsRafId); _wsRafId = null; }
    _wsRenderDirty = false;
    _displayPackets = [];
    _rowCounts = [];
    _rowCountsDirty = false;
    _cumulativeOffsetsCache = null;
    _observerFilterSet = null;
    _lastVisibleStart = -1;
    _lastVisibleEnd = -1;
    if (_docActionHandler) { document.removeEventListener('click', _docActionHandler); _docActionHandler = null; }
    if (_docMenuCloseHandler) { document.removeEventListener('click', _docMenuCloseHandler); _docMenuCloseHandler = null; }
    if (_docColMenuCloseHandler) { document.removeEventListener('click', _docColMenuCloseHandler); _docColMenuCloseHandler = null; }
    if (_pktPopstateHandler) { window.removeEventListener('popstate', _pktPopstateHandler); _pktPopstateHandler = null; }
    _pktMobileNavPushed = false;
    removeAllByopOverlays();
    packets = [];
    hashIndex = new Map();    selectedId = null;
    filtersBuilt = false;
    delete filters.node;
    expandedHashes = new Set();
    hopNameCache = {};
    totalCount = 0;
    observers = [];
    observerMap = new Map();
    directPacketId = null;
    directPacketHash = null;
    groupByHash = true;
    filters = {};
    regionMap = {};
  }

  async function loadObservers() {
    try {
      const data = await api('/observers', { ttl: CLIENT_TTL.observers });
      observers = data.observers || [];
      observerMap = new Map(observers.map(o => [o.id, o]));
    } catch {}
  }

  async function loadPackets() {
    try {
      const params = new URLSearchParams();
      const selectedWindow = Number(document.getElementById('fTimeWindow')?.value);
      const windowMin = Number.isFinite(selectedWindow) ? selectedWindow : savedTimeWindowMin;
      if (windowMin > 0 && !filters.hash) {
        const since = new Date(Date.now() - windowMin * 60000).toISOString();
        params.set('since', since);
      }
      params.set('limit', String(PACKET_LIMIT));
      const regionParam = RegionFilter.getRegionParam();
      if (regionParam) params.set('region', regionParam);
      if (filters.hash) params.set('hash', filters.hash);
      if (filters.node) params.set('node', filters.node);
      if (filters.observer) params.set('observer', filters.observer);
      if (groupByHash) {
        params.set('groupByHash', 'true');
      } else {
        params.set('expand', 'observations');
      }

      const data = await api('/packets?' + params.toString());
      packets = data.packets || [];
      hashIndex = new Map();
      for (const p of packets) { if (p.hash) hashIndex.set(p.hash, p); }
      totalCount = data.total || packets.length;

      // When ungrouped, flatten observations inline (single API call, no N+1)
      if (!groupByHash) {
        const flat = [];
        for (const p of packets) {
          if (p.observations && p.observations.length > 1) {
            for (const o of p.observations) {
              flat.push(clearParsedCache({...p, ...o, _isObservation: true, observations: undefined}));
            }
          } else {
            flat.push(p);
          }
        }
        packets = flat;
        totalCount = flat.length;
      }

      // Pre-resolve from server-side resolved_path (preferred, no client-side disambiguation needed)
      await cacheResolvedPaths(packets);

      // Pre-resolve all path hops to node names (fallback for packets without resolved_path)
      const allHops = new Set();
      for (const p of packets) {
        try { getParsedPath(p).forEach(h => allHops.add(h)); } catch {}
      }
      if (allHops.size) await resolveHops([...allHops]);

      // Per-observer batch resolve for ambiguous hops (context-aware disambiguation)
      const hopsByObserver = {};
      for (const p of packets) {
        if (!p.observer_id) continue;
        try {
          const path = getParsedPath(p);
          const ambiguous = path.filter(h => hopNameCache[h]?.ambiguous);
          if (ambiguous.length) {
            if (!hopsByObserver[p.observer_id]) hopsByObserver[p.observer_id] = new Set();
            ambiguous.forEach(h => hopsByObserver[p.observer_id].add(h));
          }
        } catch {}
      }
      // Ambiguous hops are already resolved by HopResolver client-side
      // No need for per-observer server API calls

      // Restore expanded group children (parallel fetch, Map lookup)
      if (groupByHash && expandedHashes.size > 0) {
        const expandedArr = [...expandedHashes];
        const results = await Promise.all(expandedArr.map(hash => {
          const group = hashIndex.get(hash);
          if (!group) return { hash, group: null, data: null };
          return api(`/packets?hash=${hash}&limit=20`)
            .then(data => ({ hash, group, data }))
            .catch(() => ({ hash, group, data: null }));
        }));
        for (const { hash, group, data } of results) {
          if (!group) {
            expandedHashes.delete(hash);
          } else if (data) {
            group._children = data.packets || [];
            sortGroupChildren(group);
          }
        }
      }

      sortPacketsArray();
      renderLeft();
    } catch (e) {
      console.error('Failed to load packets:', e);
      const tbody = document.getElementById('pktBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="' + _getColCount() + '" class="text-center" style="padding:24px;color:var(--error,#ef4444)"><div role="alert" aria-live="polite">Failed to load packets. Please try again.</div></td></tr>';
    }
  }

  function renderLeft() {
    const el = document.getElementById('pktLeft');
    if (!el) return;

    // Only build the filter bar + table skeleton once; subsequent calls just update rows
    if (filtersBuilt) {
      renderTableRows();
      return;
    }
    filtersBuilt = true;

    el.innerHTML = `
      <div class="pkt-sticky-top" id="pktStickyTop">
        <div class="page-header pkt-page-header">
          <h2>Latest Packets <span class="count">(${totalCount})</span></h2>
        </div>
        <div class="pkt-search-bar">
          <button class="pkt-search-trigger" id="pktSearchTrigger" aria-label="Search packets" aria-haspopup="dialog">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <span class="pkt-trigger-text">Search packets…</span>
            <kbd class="pkt-search-trigger-kbd">/</kbd>
          </button>
          <button class="pkt-byop-pill pkt-filters-btn" id="pktFiltersBtn" aria-haspopup="dialog" data-tooltip="Filters">
            ⚙<span class="pkt-pill-text"> Filters</span><span class="pkt-filter-badge" id="pktFilterBadge" style="display:none">0</span>
          </button>
          <button class="pkt-byop-pill pkt-decode-btn" data-action="pkt-byop" data-tooltip="Paste raw packet hex for analysis" aria-label="Bring Your Own Packet - paste raw packet hex for analysis" aria-haspopup="dialog">
            📦<span class="pkt-pill-text"> Decode Packet</span>
          </button>
          <button class="pkt-byop-pill pkt-pause-btn" id="pktPauseBtn" data-action="pkt-pause" data-tooltip="Pause live updates" aria-pressed="false">
            ⏸<span class="pkt-pill-text"> Pause</span>
          </button>
        </div>
      </div>
      <div class="modal-overlay pkt-filters-overlay" id="pktFiltersOverlay" style="display:none" aria-hidden="true">
        <div class="modal pkt-filters-modal" role="dialog" aria-label="Packet Filters" aria-modal="true">
          <div class="pkt-fm-header">
            <span class="pkt-fm-title">Filters</span>
            <button class="btn-icon pkt-fm-close" id="pktFMClose" data-tooltip="Close filters">✕</button>
          </div>
          <div class="pkt-fm-body">
            <div class="pkt-fm-row">
              <div class="pkt-fm-field">
                <label class="pkt-fm-label">Time Window</label>
                <select id="fTimeWindow" class="filter-select pkt-fm-select" aria-label="Time window filter">
                  <option value="15">Last 15 min</option>
                  <option value="30">Last 30 min</option>
                  <option value="60">Last 1 hour</option>
                  <option value="180">Last 3 hours</option>
                  <option value="360"${isMobile ? ' disabled title="Disabled on mobile to prevent browser crashes"' : ''}>Last 6 hours</option>
                  <option value="720"${isMobile ? ' disabled title="Disabled on mobile to prevent browser crashes"' : ''}>Last 12 hours</option>
                  <option value="1440"${isMobile ? ' disabled title="Disabled on mobile to prevent browser crashes"' : ''}>Last 24 hours</option>
                  ${isMobile ? '' : '<option value="0">All time</option>'}
                </select>
              </div>
              <div class="pkt-fm-field">
                <label class="pkt-fm-label" for="fHash">Packet Hash</label>
                <input type="text" placeholder="Hash prefix…" id="fHash" aria-label="Filter by packet hash">
              </div>
              <div class="pkt-fm-field">
                <label class="pkt-fm-label" for="fNode">Node Name</label>
                <div class="node-filter-wrap" style="position:relative">
                  <input type="text" placeholder="Node name…" id="fNode" autocomplete="off" role="combobox" aria-expanded="false" aria-owns="fNodeDropdown" aria-activedescendant="" aria-autocomplete="list">
                  <div class="node-filter-dropdown hidden" id="fNodeDropdown" role="listbox"></div>
                </div>
              </div>
            </div>
            <div class="pkt-fm-row">
              <div class="pkt-fm-field">
                <label class="pkt-fm-label">Observer</label>
                <div class="multi-select-wrap" id="observerFilterWrap">
                  <button class="multi-select-trigger" id="observerTrigger" title="Show only packets seen by selected observer stations">All Observers ▾</button>
                  <div class="multi-select-menu" id="observerMenu"></div>
                </div>
              </div>
              <div class="pkt-fm-field">
                <label class="pkt-fm-label">Type</label>
                <div class="multi-select-wrap" id="typeFilterWrap">
                  <button class="multi-select-trigger" id="typeTrigger" title="Filter by packet type">All Types ▾</button>
                  <div class="multi-select-menu" id="typeMenu"></div>
                </div>
              </div>
              <div class="pkt-fm-field">
                <label class="pkt-fm-label">Region</label>
                <div id="packetsRegionFilter" class="region-filter-container"></div>
              </div>
            </div>
            <div class="pkt-fm-row pkt-fm-toggles">
              <button class="btn ${groupByHash ? 'active' : ''}" id="fGroup" data-tooltip="Collapse duplicate observations into expandable groups">Group by Hash</button>
              <button class="btn" id="fMyNodes" data-tooltip="Show only packets from your favorited/claimed nodes">★ My Nodes</button>
            </div>
            <div class="pkt-fm-divider"></div>
            <div class="pkt-fm-row">
              <div class="pkt-fm-field" style="flex:2">
                <label class="pkt-fm-label" for="fObsSort">Observation Sort</label>
                <select id="fObsSort" class="pkt-fm-select" aria-label="Observation sort order">
                  <option value="observer">Observer — groups by station</option>
                  <option value="path-asc">Path ↑ — shortest hops first</option>
                  <option value="path-desc">Path ↓ — longest hops first</option>
                  <option value="chrono-asc">Time ↑ — earliest first</option>
                  <option value="chrono-desc">Time ↓ — latest first</option>
                </select>
              </div>
            </div>
            <div class="pkt-fm-divider"></div>
            <div class="pkt-fm-field">
              <label class="pkt-fm-label">Columns</label>
              <div class="col-toggle-menu pkt-fm-col-inline" id="colToggleMenu"></div>
            </div>
            <div class="pkt-fm-reset-row">
              <button class="pkt-fm-reset-btn" id="pktFMReset">Reset to defaults</button>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-overlay pkt-search-overlay" id="pktSearchOverlay" style="display:none" aria-hidden="true">
        <div class="pkt-search-modal" role="dialog" aria-label="Search Packets" aria-modal="true">
          <div class="pkt-search-input-row">
            <svg class="pkt-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="pktSearchInput" class="pkt-search-input" placeholder="Search by hash, type, node or observer…" autocomplete="off" spellcheck="false" aria-label="Search packets">
            <button class="pkt-search-clear" id="pktSearchClear" style="display:none" aria-label="Clear search">✕</button>
          </div>
          <div class="pkt-search-meta" id="pktSearchMeta"></div>
          <div class="pkt-search-results" id="pktSearchResults">
            <div class="pkt-sr-empty">Type to search across loaded packets</div>
          </div>
          <div class="pkt-search-footer">
            <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>Esc</kbd> close</span>
          </div>
        </div>
      </div>
      <table class="data-table" id="pktTable">
        <colgroup>
          <col style="width:24px">
          <col class="col-region" style="width:48px">
          <col class="col-time" style="width:52px">
          <col class="col-hash" style="width:102px">
          <col class="col-size" style="width:48px">
          <col class="col-type" style="width:108px">
          <col class="col-observer" style="width:190px">
          <col class="col-rpt" style="width:64px">
          <col class="col-path">
          <col class="col-details" style="width:260px">
        </colgroup>
        <thead><tr>
          <th scope="col"></th><th scope="col" class="col-region" data-sort-key="region" title="Region">Rgn</th><th scope="col" class="col-time" data-sort-key="time" data-type="date">Time</th><th scope="col" class="col-hash" data-sort-key="hash">Hash</th><th scope="col" class="col-size" data-sort-key="size" data-type="numeric">Size</th>
          <th scope="col" class="col-type" data-sort-key="type">Type</th><th scope="col" class="col-observer" data-sort-key="observer">First Observer</th><th scope="col" class="col-rpt" data-sort-key="rpt" data-type="numeric">Repeats</th><th scope="col" class="col-path" data-sort-key="path">Path</th><th scope="col" class="col-details">Details</th>
        </tr></thead>
        <tbody id="pktBody"></tbody>
      </table>
    `;

    // Set thead top offset to match sticky header height
    requestAnimationFrame(() => {
      const stickyTop = document.getElementById('pktStickyTop');
      if (stickyTop) {
        const h = stickyTop.offsetHeight;
        document.getElementById('pktLeft')?.style.setProperty('--pkt-sticky-h', h + 'px');
      }
    });

    // Init shared RegionFilter component
    RegionFilter.init(document.getElementById('packetsRegionFilter'), { dropdown: true });
    if (_pendingUrlRegion) {
      RegionFilter.setSelected(_pendingUrlRegion.split(',').filter(Boolean));
      _pendingUrlRegion = null;
    }
    RegionFilter.onChange(function() { updatePacketsUrl(); updateFilterBadge(); loadPackets(); });

    // --- Packet Search Modal ---
    (function() {
      var trigger = document.getElementById('pktSearchTrigger');
      var overlay = document.getElementById('pktSearchOverlay');
      var input = document.getElementById('pktSearchInput');
      var clearBtn = document.getElementById('pktSearchClear');
      var meta = document.getElementById('pktSearchMeta');
      var results = document.getElementById('pktSearchResults');
      if (!trigger || !overlay || !input) return;

      // Type-name → payload_type_number lookup
      var typeMap = {};
      Object.entries(PAYLOAD_TYPES).forEach(function([num, name]) {
        typeMap[name.toLowerCase()] = Number(num);
      });

      var activeIdx = -1;
      var currentMatches = [];

      function openSearch() {
        // Position modal just below the sticky header (accounts for nav + sticky bar at any screen size)
        var stickyTop = document.getElementById('pktStickyTop');
        if (stickyTop) {
          var bottom = stickyTop.getBoundingClientRect().bottom;
          overlay.style.paddingTop = Math.max(bottom + 8, 12) + 'px';
        }
        overlay.style.display = 'flex';
        overlay.removeAttribute('aria-hidden');
        input.value = '';
        clearBtn.style.display = 'none';
        meta.textContent = '';
        results.innerHTML = '<div class="pkt-sr-empty">Type to search across loaded packets</div>';
        currentMatches = [];
        activeIdx = -1;
        requestAnimationFrame(function() { input.focus(); });
      }

      function closeSearch() {
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');
        trigger.focus();
      }

      function matchPackets(raw) {
        if (!raw) return [];
        var q = raw.toLowerCase().replace(/\s/g, '');
        var lq = raw.toLowerCase();
        var src = packets; // in-memory packet array (all loaded)
        // 1. Hex prefix → hash match
        if (q.length >= 4 && /^[0-9a-f]+$/.test(q)) {
          return src.filter(function(p) { return p.hash && p.hash.toLowerCase().includes(q); });
        }
        // 2. Type keyword
        var matchedTypes = [];
        Object.entries(typeMap).forEach(function([name, num]) {
          if (name.includes(lq)) matchedTypes.push(num);
        });
        if (matchedTypes.length) {
          return src.filter(function(p) { return matchedTypes.includes(p.payload_type); });
        }
        // 3. Observer name or decoded payload (node name / message text)
        return src.filter(function(p) {
          if (obsNameOnly(p.observer_id).toLowerCase().includes(lq)) return true;
          if ((p.decoded_json || '').toLowerCase().includes(lq)) return true;
          return false;
        });
      }

      function renderResults(raw) {
        activeIdx = -1;
        if (!raw) {
          currentMatches = [];
          results.innerHTML = '<div class="pkt-sr-empty">Type to search across loaded packets</div>';
          meta.textContent = '';
          return;
        }
        currentMatches = matchPackets(raw);
        var shown = currentMatches.slice(0, 100);
        meta.textContent = currentMatches.length === 0
          ? 'No results'
          : currentMatches.length > 100
            ? 'Showing 100 of ' + currentMatches.length.toLocaleString() + ' matches'
            : currentMatches.length.toLocaleString() + ' match' + (currentMatches.length === 1 ? '' : 'es');
        if (!shown.length) {
          results.innerHTML = '<div class="pkt-sr-empty">No packets found</div>';
          return;
        }
        results.innerHTML = shown.map(function(p, i) {
          var typeName = payloadTypeName(p.payload_type);
          var typeClass = payloadTypeColor(p.payload_type);
          var hash = p.hash ? midTruncate(p.hash, 4) : '—';
          var obs = obsNameOnly(p.observer_id);
          var region = p.observer_id ? (observerMap.get(p.observer_id)?.iata || '') : '';
          var time = timeAgo(p.latest || p.timestamp || p.first_seen) || '';
          var decoded = getParsedDecoded(p) || {};
          var detail = getDetailPreviewPlain(decoded);
          return '<div class="pkt-sr-item" data-idx="' + i + '" tabindex="-1" role="option">' +
            '<div class="pkt-sr-top">' +
              '<span class="badge badge-' + typeClass + '">' + escapeHtml(typeName) + '</span>' +
              '<span class="pkt-sr-hash mono">' + escapeHtml(hash) + '</span>' +
              (region ? '<span class="pkt-sr-region">' + escapeHtml(region) + '</span>' : '') +
              '<span class="pkt-sr-time">' + escapeHtml(time) + '</span>' +
            '</div>' +
            (detail ? '<div class="pkt-sr-detail">' + escapeHtml(detail) + '</div>' : '') +
            '<div class="pkt-sr-obs">' + escapeHtml(obs) + '</div>' +
          '</div>';
        }).join('');
      }

      // Plain-text version of detail preview (no HTML tags) for result rows
      function getDetailPreviewPlain(decoded) {
        if (!decoded) return '';
        if (decoded.type === 'CHAN' && decoded.text) {
          return (decoded.channel ? decoded.channel + ' ' : '') + decoded.text.slice(0, 80);
        }
        if (decoded.type === 'ADVERT' && decoded.name) return decoded.name;
        if (decoded.type === 'GRP_TXT' && decoded.channelHash != null) {
          var h = decoded.channelHashHex || decoded.channelHash.toString(16).padStart(2, '0').toUpperCase();
          return 'Ch 0x' + h + ' (encrypted)';
        }
        if (decoded.type === 'TXT_MSG') return (decoded.srcHash || '?').slice(0, 8) + ' → ' + (decoded.destHash || '?').slice(0, 8);
        if (decoded.type === 'PATH') return (decoded.srcHash || '?').slice(0, 8) + ' → ' + (decoded.destHash || '?').slice(0, 8);
        if (decoded.type === 'REQ' || decoded.type === 'RESPONSE') return (decoded.srcHash || '?').slice(0, 8) + ' → ' + (decoded.destHash || '?').slice(0, 8);
        if (decoded.text) return decoded.text.slice(0, 80);
        return '';
      }

      function setActive(idx) {
        var items = results.querySelectorAll('.pkt-sr-item');
        items.forEach(function(el) { el.classList.remove('active'); });
        if (idx >= 0 && idx < items.length) {
          activeIdx = idx;
          items[idx].classList.add('active');
          items[idx].scrollIntoView({ block: 'nearest' });
        } else {
          activeIdx = -1;
        }
      }

      function openResult(idx) {
        var p = currentMatches[idx];
        if (!p) return;
        closeSearch();
        selectPacket(p.id, p.hash, null, null);
      }

      // Event: open via trigger button
      trigger.addEventListener('click', openSearch);

      // Event: close via overlay backdrop click
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeSearch();
      });

      // Event: keyboard on input
      input.addEventListener('keydown', function(e) {
        var items = results.querySelectorAll('.pkt-sr-item');
        if (e.key === 'Escape') { closeSearch(); return; }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive(Math.min(activeIdx + 1, items.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive(Math.max(activeIdx - 1, 0));
          return;
        }
        if (e.key === 'Enter') {
          if (activeIdx >= 0) openResult(activeIdx);
          else if (currentMatches.length === 1) openResult(0);
          return;
        }
      });

      var srTimer = null;
      input.addEventListener('input', function() {
        var raw = input.value.trim();
        clearBtn.style.display = raw ? 'flex' : 'none';
        clearTimeout(srTimer);
        srTimer = setTimeout(function() { renderResults(raw); }, 150);
      });

      clearBtn.addEventListener('click', function() {
        input.value = '';
        clearBtn.style.display = 'none';
        renderResults('');
        input.focus();
      });

      // Event: click on result item
      results.addEventListener('click', function(e) {
        var item = e.target.closest('.pkt-sr-item');
        if (!item) return;
        openResult(Number(item.dataset.idx));
      });

      // Event: hover activates item
      results.addEventListener('mousemove', function(e) {
        var item = e.target.closest('.pkt-sr-item');
        if (!item) return;
        setActive(Number(item.dataset.idx));
      });

      // Global keyboard shortcut: '/' opens search when not in an input
      document.addEventListener('keydown', function(e) {
        if (overlay.style.display !== 'none') return;
        if (e.key !== '/') return;
        var tag = (document.activeElement || {}).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        openSearch();
      });
    })();

    // --- Observer multi-select ---
    const obsMenu = document.getElementById('observerMenu');
    const obsTrigger = document.getElementById('observerTrigger');
    const selectedObservers = new Set(filters.observer ? filters.observer.split(',') : []);
    function buildObserverMenu() {
      const allChecked = selectedObservers.size === 0;
      let html = `<label class="multi-select-item"><input type="checkbox" data-obs-id="__all__" ${allChecked ? 'checked' : ''}> All Observers</label>`;
      for (const o of observers) {
        const checked = selectedObservers.has(String(o.id)) ? 'checked' : '';
        html += `<label class="multi-select-item"><input type="checkbox" data-obs-id="${o.id}" ${checked}> ${o.name || o.id}</label>`;
      }
      obsMenu.innerHTML = html;
    }
    function updateObsTrigger() {
      if (selectedObservers.size === 0 || selectedObservers.size === observers.length) {
        obsTrigger.textContent = 'All Observers ▾';
      } else if (selectedObservers.size === 1) {
        const id = [...selectedObservers][0];
        const o = observerMap.get(id) || observerMap.get(Number(id));
        obsTrigger.textContent = (o ? (o.name || o.id) : id) + ' ▾';
      } else {
        obsTrigger.textContent = selectedObservers.size + ' Observers ▾';
      }
    }
    buildObserverMenu();
    updateObsTrigger();
    obsTrigger.addEventListener('click', (e) => { e.stopPropagation(); obsMenu.classList.toggle('open'); typeMenu.classList.remove('open'); });
    obsMenu.addEventListener('change', (e) => {
      const id = e.target.dataset.obsId;
      if (id === '__all__') {
        selectedObservers.clear();
      } else {
        if (e.target.checked) selectedObservers.add(id); else selectedObservers.delete(id);
      }
      filters.observer = selectedObservers.size > 0 ? [...selectedObservers].join(',') : undefined;
      if (filters.observer) localStorage.setItem('meshcore-observer-filter', filters.observer); else localStorage.removeItem('meshcore-observer-filter');
      buildObserverMenu();
      updateObsTrigger();
      updateFilterBadge();
      renderTableRows();
    });

    // --- Type multi-select ---
    const typeMenu = document.getElementById('typeMenu');
    const typeTrigger = document.getElementById('typeTrigger');
    const typeMap = {0:'Request',1:'Response',2:'Direct Msg',3:'ACK',4:'Advert',5:'Channel Msg',7:'Anon Req',8:'Path',9:'Trace'};
    const selectedTypes = new Set(filters.type ? String(filters.type).split(',') : []);
    function buildTypeMenu() {
      const allChecked = selectedTypes.size === 0;
      let html = `<label class="multi-select-item"><input type="checkbox" data-type-id="__all__" ${allChecked ? 'checked' : ''}> All Types</label>`;
      for (const [k, v] of Object.entries(typeMap)) {
        const checked = selectedTypes.has(k) ? 'checked' : '';
        html += `<label class="multi-select-item"><input type="checkbox" data-type-id="${k}" ${checked}> ${v}</label>`;
      }
      typeMenu.innerHTML = html;
    }
    function updateTypeTrigger() {
      const total = Object.keys(typeMap).length;
      if (selectedTypes.size === 0 || selectedTypes.size === total) {
        typeTrigger.textContent = 'All Types ▾';
      } else if (selectedTypes.size === 1) {
        const k = [...selectedTypes][0];
        typeTrigger.textContent = (typeMap[k] || k) + ' ▾';
      } else {
        typeTrigger.textContent = selectedTypes.size + ' Types ▾';
      }
    }
    buildTypeMenu();
    updateTypeTrigger();
    typeTrigger.addEventListener('click', (e) => { e.stopPropagation(); typeMenu.classList.toggle('open'); obsMenu.classList.remove('open'); });
    typeMenu.addEventListener('change', (e) => {
      const id = e.target.dataset.typeId;
      if (id === '__all__') {
        selectedTypes.clear();
      } else {
        if (e.target.checked) selectedTypes.add(id); else selectedTypes.delete(id);
      }
      filters.type = selectedTypes.size > 0 ? [...selectedTypes].join(',') : undefined;
      if (filters.type) localStorage.setItem('meshcore-type-filter', filters.type); else localStorage.removeItem('meshcore-type-filter');
      buildTypeMenu();
      updateTypeTrigger();
      updateFilterBadge();
      renderTableRows();
    });

    // Close multi-select menus on outside click
    bindDocumentHandler('menu', 'click', (e) => {
      const obsWrap = document.getElementById('observerFilterWrap');
      const typeWrap = document.getElementById('typeFilterWrap');
      if (obsWrap && !obsWrap.contains(e.target)) { const m = obsWrap.querySelector('.multi-select-menu'); if (m) m.classList.remove('open'); }
      if (typeWrap && !typeWrap.contains(e.target)) { const m = typeWrap.querySelector('.multi-select-menu'); if (m) m.classList.remove('open'); }
    });

    // Filters modal open/close
    const _pktFiltersBtn = document.getElementById('pktFiltersBtn');
    const _pktFiltersOverlay = document.getElementById('pktFiltersOverlay');
    const _pktFMClose = document.getElementById('pktFMClose');
    function _openFiltersModal() {
      _pktFiltersOverlay.style.display = 'flex';
      _pktFiltersOverlay.removeAttribute('aria-hidden');
      _pktFMClose.focus();
      _pushPktMobileBack();
    }
    function _closeFiltersModal() {
      _pktFiltersOverlay.style.display = 'none';
      _pktFiltersOverlay.setAttribute('aria-hidden', 'true');
      _pktFiltersBtn.focus();
      _popPktMobileBack();
    }
    _pktFiltersBtn.addEventListener('click', _openFiltersModal);
    _pktFMClose.addEventListener('click', _closeFiltersModal);
    _pktFiltersOverlay.addEventListener('click', (e) => { if (e.target === _pktFiltersOverlay) _closeFiltersModal(); });
    document.addEventListener('keydown', function _fmEsc(e) { if (e.key === 'Escape' && _pktFiltersOverlay.style.display !== 'none') _closeFiltersModal(); });

    function updateFilterBadge() {
      let n = 0;
      if (filters.hash) n++;
      if (filters.node) n++;
      if (filters.observer) n++;
      if (filters.type) n++;
      if (RegionFilter.getRegionParam()) n++;
      if (filters.myNodes) n++;
      const badge = document.getElementById('pktFilterBadge');
      if (badge) { badge.textContent = n; badge.style.display = n > 0 ? 'inline-flex' : 'none'; }
    }
    updateFilterBadge();

    function resetFilters() {
      // Time window: 24h
      savedTimeWindowMin = 1440;
      localStorage.setItem('meshcore-time-window', '1440');
      const fTW = document.getElementById('fTimeWindow');
      if (fTW) fTW.value = '1440';
      // Hash
      filters.hash = undefined;
      const fH = document.getElementById('fHash');
      if (fH) fH.value = '';
      // Node
      filters.node = undefined; filters.nodeName = undefined;
      const fN = document.getElementById('fNode');
      if (fN) fN.value = '';
      const fNDrop = document.getElementById('fNodeDropdown');
      if (fNDrop) fNDrop.classList.add('hidden');
      // Observers: all
      selectedObservers.clear();
      filters.observer = undefined;
      localStorage.removeItem('meshcore-observer-filter');
      buildObserverMenu(); updateObsTrigger();
      // Types: all
      selectedTypes.clear();
      filters.type = undefined;
      localStorage.removeItem('meshcore-type-filter');
      buildTypeMenu(); updateTypeTrigger();
      // Region: all
      RegionFilter.setSelected([]);
      // Group by hash: on
      groupByHash = true;
      const fGroup = document.getElementById('fGroup');
      if (fGroup) fGroup.classList.add('active');
      // My nodes: off
      filters.myNodes = false;
      const fMyNodes = document.getElementById('fMyNodes');
      if (fMyNodes) fMyNodes.classList.remove('active');
      // Obs sort: observer
      obsSortMode = SORT_OBSERVER;
      localStorage.setItem('meshcore-obs-sort', SORT_OBSERVER);
      const fObsSort = document.getElementById('fObsSort');
      if (fObsSort) fObsSort.value = SORT_OBSERVER;
      // Reset columns to platform default
      visibleCols = COL_DEFS.map(c => c.key).filter(k => !defaultHidden.includes(k));
      applyColVisibility();
      colMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = visibleCols.includes(cb.dataset.col);
      });
      updateFilterBadge();
      updatePacketsUrl();
      loadPackets();
    }
    document.getElementById('pktFMReset').addEventListener('click', resetFilters);

    // Filter event listeners
    document.getElementById('fHash').value = filters.hash || '';
    document.getElementById('fHash').addEventListener('input', debounce((e) => { filters.hash = e.target.value || undefined; updateFilterBadge(); loadPackets(); }, 300));

    // Time window dropdown — restore from localStorage and bind change
    const fTimeWindow = document.getElementById('fTimeWindow');
    fTimeWindow.value = String(savedTimeWindowMin);
    fTimeWindow.addEventListener('change', () => {
      savedTimeWindowMin = Number(fTimeWindow.value);
      if (!Number.isFinite(savedTimeWindowMin) || savedTimeWindowMin <= 0) savedTimeWindowMin = 15;
      localStorage.setItem('meshcore-time-window', fTimeWindow.value);
      updatePacketsUrl();
      loadPackets();
    });

    document.getElementById('fGroup').addEventListener('click', () => { groupByHash = !groupByHash; loadPackets(); });
    document.getElementById('fMyNodes').addEventListener('click', function () {
      filters.myNodes = !filters.myNodes;
      this.classList.toggle('active', filters.myNodes);
      updateFilterBadge();
      loadPackets();
    });

    // Observation sort dropdown
    const obsSortSel = document.getElementById('fObsSort');
    obsSortSel.value = obsSortMode;
    const sortHelpEl = document.getElementById('sortHelpIcon');
    if (sortHelpEl) {
      const tip = document.createElement('span');
      tip.className = 'sort-help-tip';
      tip.textContent = "Sort controls how observations are ordered within packet groups and which observation appears in the header row.\n\nObserver — Groups by observer station, earliest first.\nPath \u2191 — Shortest paths first.\nPath \u2193 — Longest paths first.\nTime \u2191 — Earliest observation first.\nTime \u2193 — Most recent first.";
      sortHelpEl.appendChild(tip);
    }
    obsSortSel.addEventListener('change', async function () {
      obsSortMode = this.value;
      localStorage.setItem('meshcore-obs-sort', obsSortMode);
      // For non-observer sorts, batch-fetch children for visible groups that don't have them yet
      if (obsSortMode !== SORT_OBSERVER && groupByHash) {
        const toFetch = packets.filter(p => p.hash && !p._children && (p.observation_count || 0) > 1);
        if (toFetch.length > 0) {
          const hashes = toFetch.map(p => p.hash);
          try {
            const resp = await fetch('/api/packets/observations', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({hashes})
            });
            if (resp.ok) {
              const data = await resp.json();
              const results = data.results || {};
              for (const p of toFetch) {
                const obs = results[p.hash];
                if (obs && obs.length) {
                  p._children = obs.map(o => clearParsedCache({...p, ...o, _isObservation: true}));
                  p._fetchedData = {packet: p, observations: obs};
                }
              }
            }
          } catch {}
        }
      }
      // Re-sort all groups with children
      for (const p of packets) {
        if (p._children) sortGroupChildren(p);
      }
      // Resolve any new hops from updated header paths
      const newHops = new Set();
      for (const p of packets) {
        try { getParsedPath(p).forEach(h => { if (!(h in hopNameCache)) newHops.add(h); }); } catch {}
      }
      if (newHops.size) await resolveHops([...newHops]);
      renderTableRows();
    });

    // Column visibility toggle (#71)
    const COL_DEFS = [
      { key: 'region', label: 'Region' },
      { key: 'time', label: 'Time' },
      { key: 'hash', label: 'Hash' },
      { key: 'size', label: 'Size' },
      { key: 'type', label: 'Type' },
      { key: 'observer', label: 'First Observer' },
      { key: 'rpt', label: 'Repeats' },
      { key: 'path', label: 'Path' },
      { key: 'details', label: 'Details' },
    ];
    const isNarrow = window.innerWidth <= 640;
    const defaultHidden = isNarrow ? ['region', 'hash', 'size', 'observer', 'rpt', 'path'] : [];
    const COLS_VERSION = isNarrow ? 'mob4' : 'desk1';
    let visibleCols;
    try {
      if (localStorage.getItem('packets-cols-version') === COLS_VERSION) {
        visibleCols = JSON.parse(localStorage.getItem('packets-visible-cols'));
      }
    } catch {}
    if (visibleCols) {
      const validKeys = new Set(COL_DEFS.map(c => c.key));
      visibleCols = visibleCols.filter(k => validKeys.has(k));
      if (!visibleCols.length) visibleCols = null;
    }
    if (!visibleCols) visibleCols = COL_DEFS.map(c => c.key).filter(k => !defaultHidden.includes(k));
    const colMenu = document.getElementById('colToggleMenu');
    const pktTable = document.getElementById('pktTable');
    function applyColVisibility() {
      COL_DEFS.forEach(c => {
        pktTable.classList.toggle('hide-col-' + c.key, !visibleCols.includes(c.key));
      });
      localStorage.setItem('packets-visible-cols', JSON.stringify(visibleCols));
      localStorage.setItem('packets-cols-version', COLS_VERSION);
    }
    colMenu.innerHTML = COL_DEFS.map(c =>
      `<label><input type="checkbox" data-col="${c.key}" ${visibleCols.includes(c.key) ? 'checked' : ''}> ${c.label}</label>`
    ).join('');
    colMenu.addEventListener('change', (e) => {
      const cb = e.target;
      const col = cb.dataset.col;
      if (!col) return;
      if (cb.checked) { if (!visibleCols.includes(col)) visibleCols.push(col); }
      else { visibleCols = visibleCols.filter(k => k !== col); }
      applyColVisibility();
    });
    // colToggleBtn removed from modal — columns are now inline checkboxes
    bindDocumentHandler('colmenu', 'click', () => colMenu.classList.remove('open'));
    applyColVisibility();

    // Node name filter with autocomplete
    const fNode = document.getElementById('fNode');
    const fNodeDrop = document.getElementById('fNodeDropdown');
    fNode.value = filters.nodeName || '';
    let nodeActiveIdx = -1;
    fNode.addEventListener('input', debounce(async (e) => {
      const q = e.target.value.trim();
      nodeActiveIdx = -1;
      fNode.setAttribute('aria-activedescendant', '');
      if (!q) {
        fNodeDrop.classList.add('hidden');
        fNode.setAttribute('aria-expanded', 'false');
        if (filters.node) { filters.node = undefined; filters.nodeName = undefined; updateFilterBadge(); loadPackets(); }
        return;
      }
      try {
        const resp = await fetch('/api/nodes/search?q=' + encodeURIComponent(q));
        const data = await resp.json();
        const nodes = data.nodes || [];
        if (nodes.length === 0) { fNodeDrop.classList.add('hidden'); fNode.setAttribute('aria-expanded', 'false'); return; }
        fNodeDrop.innerHTML = nodes.map((n, i) =>
          `<div class="node-filter-option" id="fNodeOpt-${i}" role="option" data-key="${n.public_key}" data-name="${escapeHtml(n.name || n.public_key.slice(0,8))}">${escapeHtml(n.name || n.public_key.slice(0,8))} <span style="color:var(--muted);font-size:0.8em">${n.public_key.slice(0,8)}</span></div>`
        ).join('');
        fNodeDrop.classList.remove('hidden');
        fNode.setAttribute('aria-expanded', 'true');
        fNodeDrop.querySelectorAll('.node-filter-option').forEach(opt => {
          opt.addEventListener('click', () => {
            selectNodeOption(opt);
          });
        });
      } catch {}
    }, 250));

    function selectNodeOption(opt) {
      filters.node = opt.dataset.key;
      filters.nodeName = opt.dataset.name;
      fNode.value = opt.dataset.name;
      fNodeDrop.classList.add('hidden');
      fNode.setAttribute('aria-expanded', 'false');
      fNode.setAttribute('aria-activedescendant', '');
      nodeActiveIdx = -1;
      updateFilterBadge();
      loadPackets();
    }

    fNode.addEventListener('keydown', (e) => {
      const options = fNodeDrop.querySelectorAll('.node-filter-option');
      if (!options.length || fNodeDrop.classList.contains('hidden')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        nodeActiveIdx = Math.min(nodeActiveIdx + 1, options.length - 1);
        updateNodeActive(options);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        nodeActiveIdx = Math.max(nodeActiveIdx - 1, 0);
        updateNodeActive(options);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (nodeActiveIdx >= 0 && options[nodeActiveIdx]) selectNodeOption(options[nodeActiveIdx]);
      } else if (e.key === 'Escape') {
        fNodeDrop.classList.add('hidden');
        fNode.setAttribute('aria-expanded', 'false');
        nodeActiveIdx = -1;
      }
    });

    function updateNodeActive(options) {
      options.forEach((o, i) => {
        o.classList.toggle('node-filter-active', i === nodeActiveIdx);
        o.setAttribute('aria-selected', i === nodeActiveIdx ? 'true' : 'false');
      });
      if (nodeActiveIdx >= 0 && options[nodeActiveIdx]) {
        fNode.setAttribute('aria-activedescendant', options[nodeActiveIdx].id);
        options[nodeActiveIdx].scrollIntoView({ block: 'nearest' });
      }
    }

    fNode.addEventListener('blur', () => { setTimeout(() => { fNodeDrop.classList.add('hidden'); fNode.setAttribute('aria-expanded', 'false'); }, 200); });

    // Delegated click/keyboard handler for table rows
    const pktBody = document.getElementById('pktBody');
    if (pktBody) {
      const handler = (e) => {
        // Let hop links navigate naturally without selecting the row
        if (e.target.closest('[data-hop-link]')) return;
        const row = e.target.closest('tr[data-action]');
        if (!row) return;
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        if (e.type === 'keydown') e.preventDefault();
        const action = row.dataset.action;
        const value = row.dataset.value;
        // Clicking the expand chevron cell only toggles group — never opens detail
        if (e.target.closest('.pkt-expand-cell')) {
          if (action === 'toggle-select') pktToggleGroup(value);
          return;
        }
        if (action === 'select') {
          const hash = row.dataset.hash;
          if (hash) selectPacket(null, hash);
          else selectPacket(Number(value));
        }
        else if (action === 'select-observation') {
          const parentHash = row.dataset.parentHash;
          const group = hashIndex.get(parentHash);
          const child = group?._children?.find(c => String(c.id) === String(value));
          if (child) {
            const parentData = group._fetchedData;
            const obsPacket = parentData ? {...parentData.packet, observer_id: child.observer_id, observer_name: child.observer_name, snr: child.snr, rssi: child.rssi, path_json: child.path_json, resolved_path: child.resolved_path, timestamp: child.timestamp, first_seen: child.timestamp} : child;
            if (parentData) { clearParsedCache(obsPacket); }
            selectPacket(child.id, parentHash, {packet: obsPacket, breakdown: parentData?.breakdown, observations: parentData?.observations}, child.id);
          }
        }
        else if (action === 'select-hash') pktSelectHash(value);
        else if (action === 'toggle-select') { pktSelectHash(value); }
      };
      pktBody.addEventListener('click', handler);
      pktBody.addEventListener('keydown', handler);
    }

    // Escape to close packet detail panel
    document.addEventListener('keydown', function pktEsc(e) {
      if (e.key === 'Escape') {
        closeDetailPanel();
      }
    });

    renderTableRows();

    // Initialize table sorting (virtual scroll — sort data array, not DOM)
    if (window.TableSort) {
      var pktTableEl = document.getElementById('pktTable');
      if (pktTableEl) {
        if (_tableSortInstance) _tableSortInstance.destroy();
        _tableSortInstance = TableSort.init(pktTableEl, {
          defaultColumn: 'time',
          defaultDirection: 'desc',
          storageKey: 'meshcore-packets-sort',
          domReorder: false,
          onSort: function(column, direction) {
            _packetSortColumn = column;
            _packetSortDirection = direction;
            sortPacketsArray();
            renderTableRows();
          }
        });
        // Apply initial sort state from TableSort
        if (_tableSortInstance) {
          var st = _tableSortInstance.getState();
          _packetSortColumn = st.column;
          _packetSortDirection = st.direction;
          sortPacketsArray();
        }
      }
    }
  }

  // Build HTML for a single grouped packet row
  function buildGroupRowHtml(p, entryIdx = -1) {
    const isExpanded = expandedHashes.has(p.hash);
    let headerObserverId = p.observer_id;
    let headerPathJson = p.path_json;
    if (_observerFilterSet && p._children?.length) {
      const match = p._children.find(c => _observerFilterSet.has(String(c.observer_id)));
      if (match) {
        headerObserverId = match.observer_id;
        headerPathJson = match.path_json;
      }
    }
    const groupRegion = headerObserverId ? (observerMap.get(headerObserverId)?.iata || '') : '';
    let groupPath = [];
    try { groupPath = JSON.parse(headerPathJson || '[]'); } catch {}
    const groupPathStr = renderPath(groupPath, headerObserverId);
    const groupTypeName = payloadTypeName(p.payload_type);
    const groupTypeClass = payloadTypeColor(p.payload_type);
    const groupSize = p.raw_hex ? Math.floor(p.raw_hex.length / 2) : 0;
    const groupHashBytes = ((parseInt(p.raw_hex?.slice(2, 4), 16) || 0) >> 6) + 1;
    const isSingle = p.count <= 1;
    // Channel color highlighting (#271)
    const _grpDecoded = getParsedDecoded(p) || {};
    const _grpChanStyle = window.ChannelColors ? window.ChannelColors.getRowStyle(_grpDecoded.type || groupTypeName, _grpDecoded.channel) : '';
    let html = `<tr class="${isSingle ? '' : 'group-header'} ${isExpanded ? 'expanded' : ''}" data-hash="${p.hash}" data-action="${isSingle ? 'select-hash' : 'toggle-select'}" data-value="${p.hash}" data-entry-idx="${entryIdx}" tabindex="0" role="row"${_grpChanStyle ? ' style="' + _grpChanStyle + '"' : ''}>
          <td class="pkt-expand-cell">${isSingle ? '' : `<span class="pkt-chevron${isExpanded ? ' expanded' : ''}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>`}</td>
          <td class="col-region">${groupRegion || '—'}</td>
          <td class="col-time">${renderTimestampCell(p.latest)}</td>
          <td class="mono col-hash">${midTruncate(p.hash || '—', 4)}</td>
          <td class="col-size">${groupSize ? groupSize + 'B' : '—'}</td>
          <td class="col-type">${p.payload_type != null ? `<span class="badge badge-${groupTypeClass}">${groupTypeName}</span>${transportBadge(p.route_type)}` : '—'}</td>
          <td class="col-observer">${truncate(obsNameOnly(headerObserverId), 25)}</td>
          <td class="col-rpt">${p.observation_count > 1 ? '<span class="badge badge-obs" title="Seen ' + p.observation_count + ' times">×' + p.observation_count + '</span>' : (isSingle ? '' : p.count)}</td>
          <td class="col-path"><span class="path-hops">${groupPathStr}</span></td>
          <td class="col-details">${getDetailPreview(getParsedDecoded(p))}</td>
        </tr>`;
    if (isExpanded && p._children) {
      let visibleChildren = p._children;
      if (_observerFilterSet) {
        visibleChildren = visibleChildren.filter(c => _observerFilterSet.has(String(c.observer_id)));
      }
      for (const c of visibleChildren) {
        const typeName = payloadTypeName(c.payload_type);
        const typeClass = payloadTypeColor(c.payload_type);
        const size = c.raw_hex ? Math.floor(c.raw_hex.length / 2) : 0;
        const childHashBytes = ((parseInt(c.raw_hex?.slice(2, 4), 16) || 0) >> 6) + 1;
        const childRegion = c.observer_id ? (observerMap.get(c.observer_id)?.iata || '') : '';
        const childPath = getParsedPath(c);
        const childPathStr = renderPath(childPath, c.observer_id);
        html += `<tr class="group-child" data-id="${c.id}" data-hash="${c.hash || ''}" data-action="select-observation" data-value="${c.id}" data-parent-hash="${p.hash}" data-entry-idx="${entryIdx}" tabindex="0" role="row">
              <td></td><td class="col-region">${childRegion || '—'}</td>
              <td class="col-time">${renderTimestampCell(c.timestamp)}</td>
              <td class="mono col-hash">${midTruncate(c.hash || '', 4)}</td>
              <td class="col-size">${size}B</td>
              <td class="col-type"><span class="badge badge-${typeClass}">${typeName}</span>${transportBadge(c.route_type)}</td>
              <td class="col-observer">${truncate(obsNameOnly(c.observer_id), 25)}</td>
              <td class="col-rpt"></td>
              <td class="col-path"><span class="path-hops">${childPathStr}</span></td>
              <td class="col-details">${getDetailPreview(getParsedDecoded(c))}</td>
            </tr>`;
      }
    }
    return html;
  }

  // Build HTML for a single flat (ungrouped) packet row
  function buildFlatRowHtml(p, entryIdx = -1) {
    const decoded = getParsedDecoded(p) || {};
    const pathHops = getParsedPath(p) || [];
    const region = p.observer_id ? (observerMap.get(p.observer_id)?.iata || '') : '';
    const typeName = payloadTypeName(p.payload_type);
    const typeClass = payloadTypeColor(p.payload_type);
    // Channel color highlighting (#271)
    const _chanStyle = window.ChannelColors ? window.ChannelColors.getRowStyle(decoded.type || typeName, decoded.channel) : '';
    const size = p.raw_hex ? Math.floor(p.raw_hex.length / 2) : 0;
    const hashBytes = ((parseInt(p.raw_hex?.slice(2, 4), 16) || 0) >> 6) + 1;
    const pathStr = renderPath(pathHops, p.observer_id);
    const detail = getDetailPreview(decoded);
    return `<tr data-id="${p.id}" data-hash="${p.hash || ''}" data-action="select-hash" data-value="${p.hash || p.id}" data-entry-idx="${entryIdx}" tabindex="0" role="row" class="${selectedId === p.id ? 'selected' : ''}"${_chanStyle ? ' style="' + _chanStyle + '"' : ''}>
        <td></td><td class="col-region">${region || '—'}</td>
        <td class="col-time">${renderTimestampCell(p.timestamp)}</td>
        <td class="mono col-hash">${midTruncate(p.hash || String(p.id), 4)}</td>
        <td class="col-size">${size}B</td>
        <td class="col-type"><span class="badge badge-${typeClass}">${typeName}</span>${transportBadge(p.route_type)}</td>
        <td class="col-observer">${truncate(obsNameOnly(p.observer_id), 25)}</td>
        <td class="col-rpt"></td>
        <td class="col-path"><span class="path-hops">${pathStr}</span></td>
        <td class="col-details">${detail}</td>
      </tr>`;
  }

  // Mark _rowCounts as stale so renderVisibleRows() recomputes them lazily.
  // Called when expanded group children change outside renderTableRows() (#410).
  function _invalidateRowCounts() {
    _rowCountsDirty = true;
    _cumulativeOffsetsCache = null;
  }

  // Recompute _rowCounts from _displayPackets if they've been invalidated.
  function _refreshRowCountsIfDirty() {
    if (!_rowCountsDirty || !_displayPackets.length) return;
    _rowCounts = _displayPackets.map(function(p) { return _getRowCount(p); });
    _cumulativeOffsetsCache = null;
    _rowCountsDirty = false;
  }

  // Compute the number of DOM <tr> rows a single entry produces.
  // Used by both row counting and renderVisibleRows to avoid divergence (#424).
  function _getRowCount(p) {
    if (!_displayGrouped) return 1;
    if (!expandedHashes.has(p.hash) || !p._children) return 1;
    let childCount = p._children.length;
    if (_observerFilterSet) {
      childCount = p._children.filter(c => _observerFilterSet.has(String(c.observer_id))).length;
    }
    return 1 + childCount;
  }

  // Get the column count from the thead (dynamic, avoids hardcoded colspan — #426)
  function _getColCount() {
    const thead = document.querySelector('#pktLeft thead tr');
    return thead ? thead.children.length : 11;
  }

  // Compute cumulative DOM row offsets from per-entry row counts.
  // Returns array where cumulativeOffsets[i] = total <tr> rows before entry i.
  function _cumulativeRowOffsets() {
    if (_cumulativeOffsetsCache) return _cumulativeOffsetsCache;
    const offsets = new Array(_rowCounts.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < _rowCounts.length; i++) {
      offsets[i + 1] = offsets[i] + _rowCounts[i];
    }
    _cumulativeOffsetsCache = offsets;
    return offsets;
  }

  function renderVisibleRows() {
    const _rvr_t0 = performance.now();
    const tbody = document.getElementById('pktBody');
    if (!tbody || !_displayPackets.length) return;

    const scrollContainer = document.getElementById('pktLeft');
    if (!scrollContainer) return;

    // Recompute row counts if they were invalidated (e.g. WS added children) (#410)
    _refreshRowCountsIfDirty();

    // Compute total DOM rows accounting for expanded groups
    const offsets = _cumulativeRowOffsets();
    const totalDomRows = offsets[offsets.length - 1];
    const totalHeight = totalDomRows * VSCROLL_ROW_HEIGHT;
    const colCount = _getColCount();

    // Get or create spacer elements
    let topSpacer = document.getElementById('vscroll-top');
    let bottomSpacer = document.getElementById('vscroll-bottom');
    if (!topSpacer) {
      topSpacer = document.createElement('tr');
      topSpacer.id = 'vscroll-top';
      topSpacer.innerHTML = '<td colspan="' + colCount + '" style="padding:0;border:0"></td>';
    }
    if (!bottomSpacer) {
      bottomSpacer = document.createElement('tr');
      bottomSpacer.id = 'vscroll-bottom';
      bottomSpacer.innerHTML = '<td colspan="' + colCount + '" style="padding:0;border:0"></td>';
    }

    // Calculate visible range based on scroll position
    const scrollTop = scrollContainer.scrollTop;
    const viewportHeight = scrollContainer.clientHeight;
    // Account for thead height (measured dynamically)
    const theadEl = scrollContainer.querySelector('thead');
    if (theadEl) _vscrollTheadHeight = theadEl.offsetHeight || _vscrollTheadHeight;

    const { startIdx, endIdx } = _calcVisibleRange(
      offsets, _displayPackets.length, scrollTop, viewportHeight,
      VSCROLL_ROW_HEIGHT, _vscrollTheadHeight, VSCROLL_BUFFER
    );

    // Skip DOM rebuild if visible range hasn't changed
    if (startIdx === _lastVisibleStart && endIdx === _lastVisibleEnd) {
      if (window.__PERF_LOG_RENDER) console.log('[perf] renderVisibleRows: skip (no change) %.2fms', performance.now() - _rvr_t0);
      return;
    }

    const prevStart = _lastVisibleStart;
    const prevEnd = _lastVisibleEnd;
    _lastVisibleStart = startIdx;
    _lastVisibleEnd = endIdx;

    // Compute padding using cumulative row counts
    const topPad = offsets[startIdx] * VSCROLL_ROW_HEIGHT;
    const bottomPad = (totalDomRows - offsets[endIdx]) * VSCROLL_ROW_HEIGHT;

    topSpacer.firstChild.style.height = topPad + 'px';
    bottomSpacer.firstChild.style.height = bottomPad + 'px';

    const builder = _displayGrouped ? buildGroupRowHtml : buildFlatRowHtml;
    const hasOverlap = prevStart !== -1 && startIdx < prevEnd && endIdx > prevStart;

    if (!hasOverlap) {
      // Full rebuild: initial render or large scroll jump past buffer
      const visibleHtml = _displayPackets.slice(startIdx, endIdx)
        .map((p, i) => builder(p, startIdx + i)).join('');
      tbody.innerHTML = '';
      tbody.appendChild(topSpacer);
      tbody.insertAdjacentHTML('beforeend', visibleHtml);
      tbody.appendChild(bottomSpacer);
      // Measure actual row height from first rendered data row (#407)
      if (!_vscrollRowHeightMeasured) {
        const firstRow = topSpacer.nextElementSibling;
        if (firstRow && firstRow !== bottomSpacer) {
          const h = firstRow.offsetHeight;
          if (h > 0) { VSCROLL_ROW_HEIGHT = h; _vscrollRowHeightMeasured = true; }
        }
      }
      if (window.__PERF_LOG_RENDER) console.log('[perf] renderVisibleRows: full rebuild %d entries, %.2fms', endIdx - startIdx, performance.now() - _rvr_t0);
      return;
    }

    // Incremental update: remove rows that scrolled out at the top (positional)
    const headRowCount = offsets[Math.min(startIdx, prevEnd)] - offsets[prevStart];
    for (let r = 0; r < headRowCount; r++) {
      const row = topSpacer.nextElementSibling;
      if (row && row !== bottomSpacer) row.remove();
    }
    // Remove rows that scrolled out at the bottom (positional)
    const tailFrom = Math.max(endIdx, prevStart);
    const tailRowCount = offsets[prevEnd] - offsets[tailFrom];
    for (let r = 0; r < tailRowCount; r++) {
      const row = bottomSpacer.previousElementSibling;
      if (row && row !== topSpacer) row.remove();
    }
    // Prepend rows that scrolled into view at the top
    if (startIdx < prevStart) {
      let html = '';
      for (let i = startIdx; i < Math.min(prevStart, endIdx); i++) {
        html += builder(_displayPackets[i], i);
      }
      topSpacer.insertAdjacentHTML('afterend', html);
    }
    // Append rows that scrolled into view at the bottom
    if (endIdx > prevEnd) {
      let html = '';
      for (let i = Math.max(prevEnd, startIdx); i < endIdx; i++) {
        html += builder(_displayPackets[i], i);
      }
      bottomSpacer.insertAdjacentHTML('beforebegin', html);
    }
    if (window.__PERF_LOG_RENDER) console.log('[perf] renderVisibleRows: incremental head=%d tail=%d, %.2fms', headRowCount, tailRowCount, performance.now() - _rvr_t0);
  }

  // Attach/detach scroll listener for virtual scrolling
  function attachVScrollListener() {
    const scrollContainer = document.getElementById('pktLeft');
    if (!scrollContainer) return;
    if (_vsScrollHandler) return; // already attached
    let scrollRaf = null;
    _vsScrollHandler = function () {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(function () {
        scrollRaf = null;
        renderVisibleRows();
      });
    };
    scrollContainer.addEventListener('scroll', _vsScrollHandler, { passive: true });
  }

  function detachVScrollListener() {
    if (!_vsScrollHandler) return;
    const scrollContainer = document.getElementById('pktLeft');
    if (scrollContainer) scrollContainer.removeEventListener('scroll', _vsScrollHandler);
    _vsScrollHandler = null;
  }

  /** Sort the packets array by the current sort column. Called before renderTableRows. */
  function sortPacketsArray() {
    if (!_packetSortColumn || !packets.length) return;
    var col = _packetSortColumn;
    var dir = _packetSortDirection === 'asc' ? 1 : -1;

    var accessor;
    switch (col) {
      case 'time': accessor = function(p) { return p.latest || p.timestamp || ''; }; break;
      case 'type': accessor = function(p) { return typeName(p.payload_type); }; break;
      case 'hash': accessor = function(p) { return p.hash || ''; }; break;
      case 'observer': accessor = function(p) { return obsName(p.observer_id); }; break;
      case 'size': accessor = function(p) { return p.packet_size || 0; }; break;
      case 'hb': accessor = function(p) { return p.hash_byte_count != null ? p.hash_byte_count : (p.hash_size || 0); }; break;
      case 'rpt': accessor = function(p) {
        try { var pj = typeof p.path_json === 'string' ? JSON.parse(p.path_json) : p.path_json; return Array.isArray(pj) ? pj.length : 0; } catch(e) { return 0; }
      }; break;
      case 'region': accessor = function(p) { return (regionMap && regionMap[p.observer_id]) || ''; }; break;
      case 'path': accessor = function(p) {
        try { var pj = typeof p.path_json === 'string' ? JSON.parse(p.path_json) : p.path_json; return Array.isArray(pj) ? pj.join(',') : ''; } catch(e) { return ''; }
      }; break;
      default: return; // unsortable column
    }

    // Choose comparator based on column type
    var isNumeric = (col === 'size' || col === 'hb' || col === 'rpt');
    var isDate = (col === 'time');

    packets.sort(function(a, b) {
      var va = accessor(a), vb = accessor(b);
      var result;
      if (isDate) {
        result = TableSort.comparators.date(va, vb);
      } else if (isNumeric) {
        result = TableSort.comparators.numeric(va, vb);
      } else {
        result = TableSort.comparators.text(va, vb);
      }
      // Stable tiebreaker: sort by timestamp (desc) when primary values are equal
      if (result === 0 && !isDate) {
        result = TableSort.comparators.date(
          a.timestamp || a.first_seen || '',
          b.timestamp || b.first_seen || ''
        ) * -1; // desc (newest first)
      }
      return dir * result;
    });
  }

  async function renderTableRows() {
    const tbody = document.getElementById('pktBody');
    if (!tbody) return;

    // Update dynamic parts of the header
    const countEl = document.querySelector('#pktLeft .count');
    const groupBtn = document.getElementById('fGroup');
    if (groupBtn) groupBtn.classList.toggle('active', groupByHash);

    // Filter to claimed/favorited nodes — pure client-side filter (no server round-trip)
    let displayPackets = packets;
    if (filters.myNodes) {
      const myNodes = JSON.parse(localStorage.getItem('meshcore-my-nodes') || '[]');
      const myKeys = myNodes.map(n => n.pubkey).filter(Boolean);
      const favs = getFavorites();
      const allKeys = [...new Set([...myKeys, ...favs])];
      if (allKeys.length > 0) {
        displayPackets = displayPackets.filter(p => {
          const dj = p.decoded_json || '';
          return allKeys.some(k => dj.includes(k));
        });
      } else {
        displayPackets = [];
      }
    }

    // Client-side type/observer filtering
    if (filters.type) {
      const types = filters.type.split(',').map(Number);
      displayPackets = displayPackets.filter(p => types.includes(p.payload_type));
    }
    if (filters.observer) {
      const obsIds = new Set(filters.observer.split(','));
      displayPackets = displayPackets.filter(p => {
        if (obsIds.has(p.observer_id)) return true;
        if (p._children) return p._children.some(c => obsIds.has(String(c.observer_id)));
        return false;
      });
    }

    if (countEl) countEl.textContent = `(${displayPackets.length})`;

    if (!displayPackets.length) {
      _displayPackets = [];
      _rowCounts = [];
      _rowCountsDirty = false;
      _cumulativeOffsetsCache = null;
      _observerFilterSet = null;
      _lastVisibleStart = -1;
      _lastVisibleEnd = -1;
      detachVScrollListener();
      const colCount = _getColCount();
      tbody.innerHTML = '<tr><td colspan="' + colCount + '" class="text-center text-muted" style="padding:24px">' + (filters.myNodes ? 'No packets from your claimed/favorited nodes' : 'No packets found') + '</td></tr>';
      return;
    }

    // Lazy virtual scroll: store display packets and row counts, but do NOT
    // pre-generate HTML strings. HTML is built on-demand in renderVisibleRows()
    // for only the visible slice + buffer (#422).
    _lastVisibleStart = -1;
    _lastVisibleEnd = -1;
    _displayPackets = displayPackets;
    _displayGrouped = groupByHash;
    _observerFilterSet = filters.observer ? new Set(filters.observer.split(',')) : null;
    _rowCounts = displayPackets.map(p => _getRowCount(p));
    _rowCountsDirty = false;
    _cumulativeOffsetsCache = null;

    attachVScrollListener();
    renderVisibleRows();
  }

  function getDetailPreview(decoded) {
    if (!decoded) return '';
    // Channel messages (GRP_TXT) — show channel name and message text
    if (decoded.type === 'CHAN' && decoded.text) {
      const ch = decoded.channel ? `<span class="chan-tag">${escapeHtml(decoded.channel)}</span> ` : '';
      const t = decoded.text.length > 80 ? decoded.text.slice(0, 80) + '…' : decoded.text;
      return `${ch}💬 ${escapeHtml(t)}`;
    }
    // Advertisements — show node name and role
    if (decoded.type === 'ADVERT' && decoded.name) {
      const role = decoded.flags?.repeater ? '📡' : decoded.flags?.room ? '🏠' : decoded.flags?.sensor ? '🌡' : '📻';
      return `${role} <a href="#/nodes/${encodeURIComponent(decoded.pubKey)}" class="hop-link hop-named" data-hop-link="true">${escapeHtml(decoded.name)}</a>`;
    }
    // Undecrypted channel messages — show channel hash and decryption status
    if (decoded.type === 'GRP_TXT' && decoded.channelHash != null) {
      const hashHex = decoded.channelHashHex || decoded.channelHash.toString(16).padStart(2, '0').toUpperCase();
      const statusLabel = decoded.decryptionStatus === 'no_key' ? 'no key' : 'decryption failed';
      return `🔒 Ch 0x${hashHex} <span class="muted">(${statusLabel})</span>`;
    }
    // Direct messages
    if (decoded.type === 'TXT_MSG') return `✉️ ${decoded.srcHash?.slice(0,8) || '?'} → ${decoded.destHash?.slice(0,8) || '?'}`;
    // Path updates
    if (decoded.type === 'PATH') return `🔀 ${decoded.srcHash?.slice(0,8) || '?'} → ${decoded.destHash?.slice(0,8) || '?'}`;
    // Requests/responses (encrypted)
    if (decoded.type === 'REQ' || decoded.type === 'RESPONSE') return `🔒 ${decoded.srcHash?.slice(0,8) || '?'} → ${decoded.destHash?.slice(0,8) || '?'}`;
    // Anonymous requests
    if (decoded.type === 'ANON_REQ') return `🔒 anon → ${decoded.destHash?.slice(0,8) || '?'}`;
    // Companion bridge text
    if (decoded.text) return escapeHtml(decoded.text.length > 80 ? decoded.text.slice(0, 80) + '…' : decoded.text);
    // Bare adverts with just pubkey
    if (decoded.public_key) return `📡 ${decoded.public_key.slice(0, 16)}…`;
    return '';
  }

  let selectedObservationId = null;

  async function selectPacket(id, hash, prefetchedData, obsRowId) {
    selectedId = id;
    selectedObservationId = obsRowId || null;
    const obsParam = selectedObservationId ? `?obs=${selectedObservationId}` : '';
    if (hash) {
      history.replaceState(null, '', `#/packets/${hash}${obsParam}`);
    } else {
      history.replaceState(null, '', `#/packets/${id}${obsParam}`);
    }
    renderTableRows();

    const overlay = document.getElementById('pktDetailOverlay');
    const body = document.getElementById('pktDetailBody');
    const title = document.getElementById('pktDetailTitle');
    if (!overlay || !body) return;

    body.innerHTML = '<div class="text-center text-muted" style="padding:40px">Loading…</div>';
    if (title) title.textContent = hash ? `Packet ${hash.slice(0, 8)}…` : `Packet #${id}`;
    overlay.style.display = 'flex';
    _pushPktMobileBack();
    document.getElementById('pktDetailClose').focus();

    try {
      const data = prefetchedData || await api(hash ? `/packets/${hash}` : `/packets/${id}`);
      const pkt = data.packet;
      try {
        const hops = getParsedPath(pkt);
        const newHops = hops.filter(h => !(h in hopNameCache));
        if (newHops.length) await resolveHops(newHops);
      } catch {}
      body.innerHTML = '';
      const detailTitle = await renderDetail(body, data);
      if (title) title.textContent = detailTitle;
      body.scrollTop = 0;
    } catch (e) {
      body.innerHTML = `<div class="text-muted" style="padding:24px">Error: ${e.message}</div>`;
    }
  }

  async function renderDetail(panel, data) {
    const pkt = data.packet;
    const breakdown = data.breakdown || {};
    const ranges = breakdown.ranges || [];
    const decoded = getParsedDecoded(pkt) || {};
    const pathHops = getParsedPath(pkt) || [];

    // Resolve sender GPS — from packet directly, or from known node in DB
    let senderLat = decoded.lat != null ? decoded.lat : (decoded.latitude || null);
    let senderLon = decoded.lon != null ? decoded.lon : (decoded.longitude || null);
    if (senderLat == null) {
      // Try to find sender node GPS from DB
      const senderKey = decoded.pubKey || decoded.srcPubKey;
      const senderName = decoded.sender || decoded.name;
      try {
        if (senderKey) {
          const nd = await api(`/nodes/${senderKey}`, { ttl: 30000 }).catch(() => null);
          if (nd?.node?.lat && nd.node.lon) { senderLat = nd.node.lat; senderLon = nd.node.lon; }
        }
        if (senderLat == null && senderName) {
          const sd = await api(`/nodes/search?q=${encodeURIComponent(senderName)}`, { ttl: 30000 }).catch(() => null);
          const match = sd?.nodes?.[0];
          if (match?.lat && match.lon) { senderLat = match.lat; senderLon = match.lon; }
        }
      } catch {}
    }

    // Resolve hops: prefer server-side resolved_path, fall back to client-side HopResolver
    if (pathHops.length) {
      try {
        const serverResolved = getResolvedPath(pkt);
        let resolved;
        if (serverResolved && serverResolved.length === pathHops.length) {
          await ensureHopResolver();
          resolved = HopResolver.resolveFromServer(pathHops, serverResolved);
        } else {
          await ensureHopResolver();
          resolved = HopResolver.resolve(pathHops);
        }
        if (resolved) {
          for (const [k, v] of Object.entries(resolved)) {
            hopNameCache[k] = v;
            if (pkt.observer_id) hopNameCache[k + ':' + pkt.observer_id] = v;
          }
        }
      } catch {}
    }

    // Parse hash size from path byte
    const rawPathByte = pkt.raw_hex ? parseInt(pkt.raw_hex.slice(2, 4), 16) : NaN;
    const hashSize = (isNaN(rawPathByte) || (rawPathByte & 0x3F) === 0) ? null : ((rawPathByte >> 6) + 1);

    const size = pkt.raw_hex ? Math.floor(pkt.raw_hex.length / 2) : 0;
    const typeName = payloadTypeName(pkt.payload_type);

    const snr = pkt.snr ?? decoded.SNR ?? decoded.snr ?? null;
    const rssi = pkt.rssi ?? decoded.RSSI ?? decoded.rssi ?? null;
    const hasRawHex = !!pkt.raw_hex;

    // Build message preview
    let messageHtml = '';
    if (decoded.text) {
      const chLabel = decoded.channel || (decoded.channel_idx != null ? `Ch ${decoded.channel_idx}` : null) || (decoded.channelHash != null ? `Ch 0x${decoded.channelHash.toString(16)}` : '');
      const hopLabel = decoded.path_len != null ? `${decoded.path_len} hops` : '';
      const snrLabel = snr != null ? `SNR ${snr} dB` : '';
      const meta = [chLabel, hopLabel, snrLabel].filter(Boolean).join(' · ');
      messageHtml = `<div class="detail-message" style="padding:12px;margin:8px 0;background:var(--card-bg);border-radius:8px;border-left:3px solid var(--accent)">
        <div style="font-size:1.1em">${escapeHtml(decoded.text)}</div>
        ${meta ? `<div style="font-size:0.85em;color:var(--muted);margin-top:4px">${meta}</div>` : ''}
      </div>`;
    } else if (decoded.type === 'GRP_TXT' && decoded.channelHash != null) {
      const hashHex = decoded.channelHashHex || decoded.channelHash.toString(16).padStart(2, '0').toUpperCase();
      const statusLabel = decoded.decryptionStatus === 'no_key' ? 'no key' : 'decryption failed';
      messageHtml = `<div class="detail-message" style="padding:12px;margin:8px 0;background:var(--card-bg);border-radius:8px;border-left:3px solid var(--warning, #f0ad4e)">
        <div style="font-size:1.1em">🔒 Channel Hash: 0x${hashHex} <span style="color:var(--muted)">(${statusLabel})</span></div>
      </div>`;
    }

    const observations = data.observations || [];
    const obsCount = data.observation_count || observations.length || 1;
    const uniqueObservers = new Set(observations.map(o => o.observer_id)).size;

    // Propagation time: spread between first and last observation
    let propagationHtml = '—';
    if (observations.length >= 2) {
      const times = observations.map(o => new Date(o.timestamp).getTime()).filter(t => !isNaN(t));
      if (times.length >= 2) {
        const first = Math.min(...times);
        const last = Math.max(...times);
        const spread = last - first;
        if (spread < 1000) {
          propagationHtml = `${spread}ms`;
        } else if (spread < 60000) {
          propagationHtml = `${(spread / 1000).toFixed(1)}s`;
        } else {
          propagationHtml = `${(spread / 60000).toFixed(1)}m`;
        }
        propagationHtml += ` <span style="color:var(--text-muted);font-size:0.85em">(${obsCount} obs × ${uniqueObservers} observers)</span>`;
      }
    }

    // Location: from ADVERT lat/lon, or from known node via pubkey/sender name
    let locationHtml = '—';
    let locationNodeKey = null;
    if (decoded.lat != null && decoded.lon != null && !(decoded.lat === 0 && decoded.lon === 0)) {
      locationNodeKey = decoded.pubKey || decoded.srcPubKey || '';
      const nodeName = decoded.name || '';
      locationHtml = `${decoded.lat.toFixed(5)}, ${decoded.lon.toFixed(5)}`;
      if (nodeName) locationHtml = `${escapeHtml(nodeName)} — ${locationHtml}`;
      if (locationNodeKey) locationHtml += ` <a href="#/map?node=${encodeURIComponent(locationNodeKey)}" style="font-size:0.85em">📍map</a>`;
    } else {
      // Try to resolve sender node location from nodes list
      const senderKey = decoded.pubKey || decoded.srcPubKey;
      const senderName = decoded.sender || decoded.name;
      if (senderKey || senderName) {
        try {
          const nodeData = senderKey ? await api(`/nodes/${senderKey}`, { ttl: 30000 }).catch(() => null) : null;
          if (nodeData && nodeData.node && nodeData.node.lat && nodeData.node.lon) {
            locationNodeKey = nodeData.node.public_key;
            locationHtml = `${nodeData.node.lat.toFixed(5)}, ${nodeData.node.lon.toFixed(5)}`;
            if (nodeData.node.name) locationHtml = `${escapeHtml(nodeData.node.name)} — ${locationHtml}`;
            locationHtml += ` <a href="#/map?node=${encodeURIComponent(locationNodeKey)}" style="font-size:0.85em">📍map</a>`;
          } else if (senderName && !senderKey) {
            // Search by name
            const searchData = await api(`/nodes/search?q=${encodeURIComponent(senderName)}`, { ttl: 30000 }).catch(() => null);
            const match = searchData && searchData.nodes && searchData.nodes[0];
            if (match && match.lat && match.lon) {
              locationNodeKey = match.public_key;
              locationHtml = `${match.lat.toFixed(5)}, ${match.lon.toFixed(5)}`;
              locationHtml = `${escapeHtml(match.name)} — ${locationHtml}`;
              locationHtml += ` <a href="#/map?node=${encodeURIComponent(locationNodeKey)}" style="font-size:0.85em">📍map</a>`;
            }
          }
        } catch {}
      }
    }

    panel.innerHTML = `

      ${messageHtml}
      <dl class="detail-meta">
        ${pkt.hash ? `<dt style="padding-top:10px">Hash ID</dt><dd class="detail-hash-id" style="padding-top:10px">${pkt.hash}</dd>` : ''}
        <dt>Observer</dt><dd>${obsName(pkt.observer_id)}</dd>
        <dt>Location</dt><dd>${locationHtml}</dd>
        <dt>SNR / RSSI</dt><dd>${snr != null ? snr + ' dB' : '—'} / ${rssi != null ? rssi + ' dBm' : '—'}</dd>
        <dt>Route Type</dt><dd>${routeTypeName(pkt.route_type)}</dd>
        <dt>Payload Type</dt><dd><span class="badge badge-${payloadTypeColor(pkt.payload_type)}">${typeName}</span></dd>
        ${hashSize ? `<dt>Hash Size</dt><dd>${hashSize} byte${hashSize !== 1 ? 's' : ''}</dd>` : ''}
        <dt>Timestamp</dt><dd>${renderTimestampCell(pkt.timestamp)}</dd>
        <dt>Propagation</dt><dd>${propagationHtml}</dd>
        <dt>Path</dt><dd>${pathHops.length ? renderPath(pathHops, pkt.observer_id) : '—'}</dd>
      </dl>
      <div class="detail-actions">
        <button class="copy-link-btn" data-packet-hash="${pkt.hash || ''}" data-packet-id="${pkt.id}" data-tooltip="Copy link to this packet">🔗 Copy Link</button>
        ${pathHops.length ? `<button class="detail-map-link" id="viewRouteBtn">🗺️ View route on map</button>` : ''}
        ${pkt.hash ? `<a href="#/traces/${pkt.hash}" class="detail-map-link" style="text-decoration:none">🔍 Trace</a>` : ''}
        <button class="replay-live-btn" data-tooltip="Replay this packet on the live map">▶ Replay</button>
      </div>

      ${hasRawHex ? `<div class="hex-legend">${buildHexLegend(ranges)}</div>
      <div class="hex-dump">${createColoredHexDump(pkt.raw_hex, ranges)}</div>` : ''}

      ${hasRawHex ? buildFieldTable(pkt, decoded, pathHops, ranges) : buildDecodedTable(decoded)}
    `;

    // Wire up copy link button
    const copyLinkBtn = panel.querySelector('.copy-link-btn');
    if (copyLinkBtn) {
      copyLinkBtn.addEventListener('click', () => {
        const pktHash = copyLinkBtn.dataset.packetHash;
        const obsParam = selectedObservationId ? `?obs=${selectedObservationId}` : '';
        const url = pktHash ? `${location.origin}/#/packets/${pktHash}${obsParam}` : `${location.origin}/#/packets/${copyLinkBtn.dataset.packetId}${obsParam}`;
        window.copyToClipboard(url, () => {
          copyLinkBtn.textContent = '✅ Copied!';
          setTimeout(() => { copyLinkBtn.textContent = '🔗 Copy Link'; }, 1500);
        });
      });
    }

    // Wire up replay button
    const replayBtn = panel.querySelector('.replay-live-btn');
    if (replayBtn) {
      replayBtn.addEventListener('click', () => {
        // Build replay packets for ALL observations of this transmission
        const obs = data.observations || [];
        const replayPackets = [];
        if (obs.length > 1) {
          for (const o of obs) {
            const oPath = getParsedPath(o);
            const oDec = getParsedDecoded(o);
            replayPackets.push({
              id: o.id, hash: pkt.hash, raw: o.raw_hex || pkt.raw_hex,
              _ts: new Date(o.timestamp).getTime(),
              decoded: { header: { payloadTypeName: typeName }, payload: oDec, path: { hops: oPath } },
              snr: o.snr, rssi: o.rssi, observer: obsName(o.observer_id)
            });
          }
        } else {
          replayPackets.push({
            id: pkt.id, hash: pkt.hash, raw: pkt.raw_hex,
            _ts: new Date(pkt.timestamp).getTime(),
            decoded: { header: { payloadTypeName: typeName }, payload: decoded, path: { hops: pathHops } },
            snr: pkt.snr, rssi: pkt.rssi, observer: obsName(pkt.observer_id)
          });
        }
        sessionStorage.setItem('replay-packet', JSON.stringify(replayPackets));
        window.location.hash = '#/live';
      });
    }

    // Wire up view route on map button
    const routeBtn = panel.querySelector('#viewRouteBtn');
    if (routeBtn && pathHops.length) {
      routeBtn.addEventListener('click', async () => {
        try {
          // Prefer server-side resolved_path if available
          const serverResolved = getResolvedPath(pkt);
          let resolvedKeys;
          if (serverResolved && serverResolved.length === pathHops.length) {
            // Use server-resolved pubkeys, fall back to short prefix for null entries
            resolvedKeys = pathHops.map((h, i) => serverResolved[i] || h);
          } else {
            // Fall back to client-side HopResolver
            const senderLat = decoded.lat || decoded.latitude;
            const senderLon = decoded.lon || decoded.longitude;
            let obsLat = null, obsLon = null;
            const obsId = obsName(pkt.observer_id);
            await ensureHopResolver();
            const data = { resolved: HopResolver.resolve(pathHops, senderLat || null, senderLon || null, obsLat, obsLon, pkt.observer_id) };
            resolvedKeys = pathHops.map(h => {
              const r = data.resolved?.[h];
              return r?.pubkey || h;
            });
          }
          // Build origin info for the sender node
          const origin = {};
          if (decoded.pubKey) origin.pubkey = decoded.pubKey;
          else if (decoded.srcHash) origin.pubkey = decoded.srcHash;
          if (decoded.adName || decoded.name) origin.name = decoded.adName || decoded.name;
          if (senderLat != null && senderLon != null) { origin.lat = senderLat; origin.lon = senderLon; }
          sessionStorage.setItem('map-route-hops', JSON.stringify({
            origin: origin,
            hops: resolvedKeys
          }));
          window.location.hash = '#/map?route=1';
        } catch {
          window.location.hash = '#/map';
        }
      });
    }
    return hasRawHex ? `Packet Byte Breakdown (${size} bytes)` : typeName + ' Packet';
  }

  function buildDecodedTable(decoded) {
    let rows = '';
    for (const [k, v] of Object.entries(decoded)) {
      if (v === null || v === undefined) continue;
      rows += `<tr><td style="font-weight:600;padding:4px 8px">${escapeHtml(k)}</td><td style="padding:4px 8px">${escapeHtml(String(v))}</td></tr>`;
    }
    return rows ? `<table class="detail-decoded" style="width:100%;border-collapse:collapse;margin-top:8px">${rows}</table>` : '';
  }

  function buildFieldTable(pkt, decoded, pathHops, ranges) {
    const buf = pkt.raw_hex || '';
    const size = Math.floor(buf.length / 2);
    let rows = '';

    // Header section
    rows += sectionRow('Header', 'section-header');
    rows += fieldRow(0, 'Header Byte', '0x' + (buf.slice(0, 2) || '??'), `Route: ${routeTypeName(pkt.route_type)}, Payload: ${payloadTypeName(pkt.payload_type)}`);
    const pathByte0 = parseInt(buf.slice(2, 4), 16);
    const hashSizeVal = isNaN(pathByte0) ? '?' : ((pathByte0 >> 6) + 1);
    const hashCountVal = isNaN(pathByte0) ? '?' : (pathByte0 & 0x3F);
    rows += fieldRow(1, 'Path Length', '0x' + (buf.slice(2, 4) || '??'), hashCountVal === 0 ? `hash_count=0 (direct advert)` : `hash_size=${hashSizeVal} byte${hashSizeVal !== 1 ? 's' : ''}, hash_count=${hashCountVal}`);

    // Transport codes
    let off = 2;
    if (pkt.route_type === 0 || pkt.route_type === 3) {
      rows += sectionRow('Transport Codes', 'section-transport');
      rows += fieldRow(off, 'Next Hop', buf.slice(off * 2, (off + 2) * 2), '');
      rows += fieldRow(off + 2, 'Last Hop', buf.slice((off + 2) * 2, (off + 4) * 2), '');
      off += 4;
    }

    // Path
    if (pathHops.length > 0) {
      rows += sectionRow('Path (' + pathHops.length + ' hops)', 'section-path');
      const pathByte = parseInt(buf.slice(2, 4), 16);
      const hashSize = (pathByte >> 6) + 1;
      for (let i = 0; i < pathHops.length; i++) {
        const hopHtml = HopDisplay.renderHop(pathHops[i], hopNameCache[pathHops[i]]);
        const label = `Hop ${i} — ${hopHtml}`;
        rows += fieldRow(off + i * hashSize, label, pathHops[i], '');
      }
      off += hashSize * pathHops.length;
    }

    // Payload
    rows += sectionRow('Payload — ' + payloadTypeName(pkt.payload_type), 'section-payload');

    if (decoded.type === 'ADVERT') {
      if (hashCountVal !== 0) rows += fieldRow(1, 'Advertised Hash Size', hashSizeVal + ' byte' + (hashSizeVal !== 1 ? 's' : ''), 'From path byte 0x' + (buf.slice(2, 4) || '??') + ' — bits 7-6 = ' + (hashSizeVal - 1));
      rows += fieldRow(off, 'Public Key (32B)', formatPubKey(decoded.pubKey || '', typeof hashSizeVal === 'number' ? hashSizeVal : 0, 24), '');
      rows += fieldRow(off + 32, 'Timestamp (4B)', decoded.timestampISO || '', 'Unix: ' + (decoded.timestamp || ''));
      rows += fieldRow(off + 36, 'Signature (64B)', truncate(decoded.signature || '', 24), '');
      if (decoded.flags) {
        const _typeLabels = {1:'Companion',2:'Repeater',3:'Room Server',4:'Sensor'};
        const _typeName = _typeLabels[decoded.flags.type] || ('Unknown(' + decoded.flags.type + ')');
        const _boolFlags = [decoded.flags.hasLocation && 'location', decoded.flags.hasName && 'name'].filter(Boolean);
        const _flagDesc = _typeName + (_boolFlags.length ? ' + ' + _boolFlags.join(', ') : '');
        rows += fieldRow(off + 100, 'App Flags', '0x' + (decoded.flags.raw?.toString(16).padStart(2,'0') || '??'), _flagDesc);
        let fOff = off + 101;
        if (decoded.flags.hasLocation) {
          rows += fieldRow(fOff, 'Latitude', decoded.lat?.toFixed(6) || '', '');
          rows += fieldRow(fOff + 4, 'Longitude', decoded.lon?.toFixed(6) || '', '');
          fOff += 8;
        }
        if (decoded.flags.hasName) {
          rows += fieldRow(fOff, 'Node Name', decoded.pubKey ? `<a href="#/nodes/${encodeURIComponent(decoded.pubKey)}" class="hop-link hop-named" data-hop-link="true">${escapeHtml(decoded.name || '')}</a>` : escapeHtml(decoded.name || ''), '');
        }
      }
    } else if (decoded.type === 'GRP_TXT') {
      const hashHex = decoded.channelHashHex || (decoded.channelHash != null ? decoded.channelHash.toString(16).padStart(2, '0').toUpperCase() : '??');
      const statusLabel = decoded.decryptionStatus === 'no_key' ? '(no key)' : decoded.decryptionStatus === 'decryption_failed' ? '(decryption failed)' : '';
      rows += fieldRow(off, 'Channel Hash', `0x${hashHex} ${statusLabel}`, '');
      rows += fieldRow(off + 1, 'MAC (2B)', decoded.mac || '', '');
      rows += fieldRow(off + 3, 'Encrypted Data', truncate(decoded.encryptedData || '', 30), '');
    } else if (decoded.type === 'CHAN') {
      rows += fieldRow(off, 'Channel', decoded.channel || `0x${(decoded.channelHash || 0).toString(16)}`, '');
      rows += fieldRow(off + 1, 'Sender', decoded.sender || '—', '');
      if (decoded.sender_timestamp) rows += fieldRow(off + 2, 'Sender Time', decoded.sender_timestamp, '');
    } else if (decoded.type === 'ACK') {
      rows += fieldRow(off, 'Checksum (4B)', decoded.ackChecksum || '', '');
    } else if (decoded.destHash !== undefined) {
      rows += fieldRow(off, 'Dest Hash (1B)', decoded.destHash || '', '');
      rows += fieldRow(off + 1, 'Src Hash (1B)', decoded.srcHash || '', '');
      rows += fieldRow(off + 2, 'MAC (2B)', decoded.mac || '', '');
      rows += fieldRow(off + 4, 'Encrypted Data', truncate(decoded.encryptedData || '', 30), '');
    } else {
      rows += fieldRow(off, 'Raw', truncate(buf.slice(off * 2), 40), '');
    }

    return `<table class="field-table">
      <thead><tr><th scope="col">Offset</th><th scope="col">Field</th><th scope="col">Value</th><th scope="col">Description</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function sectionRow(label, cls) {
    return `<tr class="section-row${cls ? ' ' + cls : ''}"><td colspan="4">${label}</td></tr>`;
  }
  function fieldRow(offset, name, value, desc) {
    return `<tr><td class="mono">${offset}</td><td>${name}</td><td class="mono">${value}</td><td class="text-muted">${desc || ''}</td></tr>`;
  }

  // BYOP modal — decode only, no DB injection
  function showBYOP() {
    removeAllByopOverlays();
    const triggerBtn = document.querySelector('[data-action="pkt-byop"]');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay byop-overlay';
    overlay.innerHTML = '<div class="modal byop-modal" role="dialog" aria-label="Decode a Packet" aria-modal="true">'
      + '<div class="byop-header"><h3>📦 Decode a Packet</h3><button class="btn-icon byop-x" data-tooltip="Close" aria-label="Close dialog">✕</button></div>'
      + '<p class="text-muted" style="margin:0 0 12px;font-size:.85rem">Paste raw hex bytes from your radio or MQTT feed:</p>'
      + '<textarea id="byopHex" class="byop-input" aria-label="Packet hex data" placeholder="e.g. 15C31A8D4674FEAE37..." spellcheck="false"></textarea>'
      + '<button class="btn-primary byop-go" id="byopDecode" style="width:100%;margin:8px 0">Decode</button>'
      + '<div id="byopResult" role="status" aria-live="polite"></div>'
      + '</div>';
    document.body.appendChild(overlay);

    const modal = overlay.querySelector('.byop-modal');
    const close = () => { removeAllByopOverlays(); _popPktMobileBack(); if (triggerBtn) triggerBtn.focus(); };
    _pushPktMobileBack();
    overlay.querySelector('.byop-x').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // Focus trap
    function getFocusable() {
      return modal.querySelectorAll('textarea, button, input, [tabindex]:not([tabindex="-1"])');
    }
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {
        const focusable = getFocusable();
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
    });

    const textarea = overlay.querySelector('#byopHex');
    textarea.focus();
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doDecode();
      }
    });

    overlay.querySelector('#byopDecode').onclick = doDecode;

    async function doDecode() {
      const hex = textarea.value.trim().replace(/[\s\n]/g, '');
      const result = overlay.querySelector('#byopResult');
      if (!hex) { result.innerHTML = '<p class="text-muted">Enter hex data</p>'; return; }
      if (!/^[0-9a-fA-F]+$/.test(hex)) { result.innerHTML = '<p class="byop-err" role="alert">Invalid hex — only 0-9 and A-F allowed</p>'; return; }
      result.innerHTML = '<p class="text-muted">Decoding...</p>';
      try {
        const res = await fetch('/api/decode', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hex })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        result.innerHTML = renderDecodedPacket(data.decoded, hex);
      } catch (e) {
        result.innerHTML = '<p class="byop-err" role="alert">❌ ' + e.message + '</p>';
      }
    }
  }

  function renderDecodedPacket(d, hex) {
    const h = d.header || {};
    const p = d.payload || {};
    const path = d.path || {};
    const size = hex ? Math.floor(hex.length / 2) : 0;

    let html = '<div class="byop-decoded">';

    // Header section
    html += '<div class="byop-section">'
      + '<div class="byop-section-title">Header</div>'
      + '<div class="byop-kv">'
      + kv('Route Type', routeTypeName(h.routeType))
      + kv('Payload Type', payloadTypeName(h.payloadType))
      + kv('Version', h.payloadVersion)
      + kv('Size', size + ' bytes')
      + '</div></div>';

    // Path section
    if (path.hops && path.hops.length) {
      html += '<div class="byop-section">'
        + '<div class="byop-section-title">Path (' + path.hops.length + ' hops)</div>'
        + '<div class="byop-path">' + path.hops.map(function(hop) { return '<span class="hop">' + hop + '</span>'; }).join('<span class="arrow">→</span>') + '</div>'
        + '</div>';
    }

    // Payload section
    html += '<div class="byop-section">'
      + '<div class="byop-section-title">Payload — ' + payloadTypeName(h.payloadType) + '</div>'
      + '<div class="byop-kv">';
    for (const [k, v] of Object.entries(p)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') {
        html += kv(k, '<pre class="byop-pre">' + JSON.stringify(v, null, 2) + '</pre>');
      } else {
        html += kv(k, String(v));
      }
    }
    html += '</div></div>';

    // Raw hex
    html += '<div class="byop-section">'
      + '<div class="byop-section-title">Raw Hex</div>'
      + '<div class="byop-hex mono">' + hex.toUpperCase().match(/.{1,2}/g).join(' ') + '</div>'
      + '</div>';

    html += '</div>';
    return html;
  }

  function kv(key, val) {
    return '<div class="byop-row"><span class="byop-key">' + key + '</span><span class="byop-val">' + val + '</span></div>';
  }

  // Load regions from config API
  (async () => {
    try {
      regionMap = await api('/config/regions', { ttl: 3600 });
    } catch {}
  })();

  // Observation sort modes
  const SORT_OBSERVER = 'observer';
  const SORT_PATH_ASC = 'path-asc';
  const SORT_PATH_DESC = 'path-desc';
  const SORT_CHRONO_ASC = 'chrono-asc';
  const SORT_CHRONO_DESC = 'chrono-desc';
  let obsSortMode = localStorage.getItem('meshcore-obs-sort') || SORT_OBSERVER;

  function getPathHopCount(c) {
    try { return getParsedPath(c).length; } catch { return 0; }
  }

  function sortGroupChildren(group) {
    if (!group || !group._children || !group._children.length) return;
    const mode = obsSortMode;

    if (mode === SORT_CHRONO_ASC || mode === SORT_CHRONO_DESC) {
      const dir = mode === SORT_CHRONO_ASC ? 1 : -1;
      group._children.sort((a, b) => {
        const tA = a.timestamp || '', tB = b.timestamp || '';
        return tA < tB ? -dir : tA > tB ? dir : 0;
      });
    } else if (mode === SORT_PATH_ASC || mode === SORT_PATH_DESC) {
      const dir = mode === SORT_PATH_ASC ? 1 : -1;
      group._children.sort((a, b) => {
        const lenA = getPathHopCount(a), lenB = getPathHopCount(b);
        if (lenA !== lenB) return (lenA - lenB) * dir;
        const oA = (a.observer_name || '').toLowerCase(), oB = (b.observer_name || '').toLowerCase();
        return oA < oB ? -1 : oA > oB ? 1 : 0;
      });
    } else {
      // Default: group by observer, earliest-observer first, then ascending time within each
      const earliest = {};
      for (const c of group._children) {
        const obs = c.observer_name || c.observer || '';
        const t = c.timestamp || c.rx_at || c.created_at || '';
        if (!earliest[obs] || t < earliest[obs]) earliest[obs] = t;
      }
      group._children.sort((a, b) => {
        const oA = a.observer_name || a.observer || '', oB = b.observer_name || b.observer || '';
        const eA = earliest[oA] || '', eB = earliest[oB] || '';
        if (eA !== eB) return eA < eB ? -1 : 1;
        if (oA !== oB) return oA < oB ? -1 : 1;
        const tA = a.timestamp || a.rx_at || '', tB = b.timestamp || b.rx_at || '';
        return tA < tB ? -1 : tA > tB ? 1 : 0;
      });
    }

    // Update header row to match first sorted child
    const first = group._children[0];
    if (first) {
      group.observer_id = first.observer_id;
      group.observer_name = first.observer_name;
      group.snr = first.snr;
      group.rssi = first.rssi;
      group.path_json = first.path_json;
      group.direction = first.direction;
    }
  }

  // Global handlers
  async function pktToggleGroup(hash) {
    if (expandedHashes.has(hash)) {
      expandedHashes.delete(hash);
      renderTableRows();
      return;
    }
    // Single fetch — gets packet + observations + path + breakdown
    try {
      const data = await api(`/packets/${hash}`);
      const pkt = data.packet;
      if (!pkt) return;
      const group = hashIndex.get(hash);
      if (group && data.observations) {
        group._children = data.observations.map(o => clearParsedCache({...pkt, ...o, _isObservation: true}));
        group._fetchedData = data;
        // Sort children based on current sort mode
        sortGroupChildren(group);
      }
      // Resolve hops from children: prefer server-side resolved_path
      await cacheResolvedPaths(group?._children || []);
      const childHops = new Set();
      for (const c of (group?._children || [])) {
        try { getParsedPath(c).forEach(h => childHops.add(h)); } catch {}
      }
      const newHops = [...childHops].filter(h => !(h in hopNameCache));
      if (newHops.length) await resolveHops(newHops);
      expandedHashes.add(hash);
      renderTableRows();
    } catch {}
  }
  async function pktSelectHash(hash) {
    // When grouped, select packet — reuse cached detail endpoint
    try {
      const data = await api(`/packets/${hash}`);
      if (data?.packet) selectPacket(data.packet.id, hash, data);
    } catch {}
  }

  let _themeRefreshHandler = null;

  registerPage('packets', {
    init: function(app, routeParam) {
      _themeRefreshHandler = () => { if (typeof renderTableRows === 'function') renderTableRows(); };
      window.addEventListener('theme-refresh', _themeRefreshHandler);
      var result = init(app, routeParam);
      // Install channel color picker on packets table (M2, #271)
      if (window.ChannelColorPicker) window.ChannelColorPicker.installPacketsTable();
      return result;
    },
    destroy: function() {
      if (_themeRefreshHandler) { window.removeEventListener('theme-refresh', _themeRefreshHandler); _themeRefreshHandler = null; }
      return destroy();
    }
  });

  // Standalone packet detail page: #/packet/123 or #/packet/HASH
  // Expose pure functions for unit testing (vm.createContext pattern)
  if (typeof window !== 'undefined') {
    document.addEventListener('channel-colors-changed', function() { renderVisibleRows(); });
    window._packetsTestAPI = {
      typeName,
      obsName,
      getDetailPreview,
      sortGroupChildren,
      getPathHopCount,
      renderDecodedPacket,
      kv,
      buildFieldTable,
      sectionRow,
      fieldRow,
      renderTimestampCell,
      renderPath,
      _getRowCount,
      _cumulativeRowOffsets,
      _invalidateRowCounts,
      _refreshRowCountsIfDirty,
      buildGroupRowHtml,
      buildFlatRowHtml,
      _calcVisibleRange,
    };
  }

  registerPage('packet-detail', {
    init: async (app, routeParam) => {
      const param = routeParam;
      app.innerHTML = `<div style="max-width:800px;margin:0 auto;padding:20px"><div class="text-center text-muted" style="padding:40px">Loading packet…</div></div>`;
      try {
        await loadObservers();
        const data = await api(`/packets/${param}`);
        if (!data?.packet) { app.innerHTML = `<div style="max-width:800px;margin:0 auto;padding:40px;text-align:center"><h2>Packet not found</h2><p>Packet ${param} doesn't exist.</p><a href="#/packets" class="btn-icon" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg> Back to packets</a></div>`; return; }
        const hops = [];
        try { hops.push(...getParsedPath(data.packet)); } catch {}
        const newHops = hops.filter(h => !(h in hopNameCache));
        if (newHops.length) await resolveHops(newHops);
        const container = document.createElement('div');
        container.style.cssText = 'max-width:800px;margin:0 auto;padding:20px';
        container.innerHTML = `<div style="margin-bottom:16px"><a href="#/packets" class="btn-icon" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg> Back to packets</a></div>`;
        const detail = document.createElement('div');
        container.appendChild(detail);
        await renderDetail(detail, data);
        app.innerHTML = '';
        app.appendChild(container);
      } catch (e) {
        app.innerHTML = `<div style="max-width:800px;margin:0 auto;padding:40px;text-align:center"><h2>Error</h2><p>${e.message}</p><a href="#/packets" class="btn-icon" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg> Back to packets</a></div>`;
      }
    },
    destroy: () => {}
  });
})();
