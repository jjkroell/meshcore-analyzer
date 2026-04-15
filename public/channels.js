/* === CoreScope — channels.js === */
'use strict';

(function () {
  let channels = [];
  let selectedHash = null;
  let messages = [];
  let wsHandler = null;
  let autoScroll = true;
  let nodeCache = {};
  let selectedNode = null;
  let observerIataById = {};
  let observerIataByName = {};
  let messageRequestId = 0;
  let msgSortOrder = 'newest'; // 'newest' | 'oldest'
  let _mobileNavPushed = false;   // true when we pushState'd for mobile channel view
  let _skipNextPopstate = false;  // suppress the popstate triggered by our own history.back()
  let _popstateHandler = null;    // stored so destroy() can remove it
  var _nodeCacheTTL = 5 * 60 * 1000; // 5 minutes
  const INACTIVE_MS = 8 * 60 * 60 * 1000; // 8 hours
  const unreadChannels = new Set(); // hashes with new unread messages
  const USER_CHANNELS_KEY = 'meshcore-user-channels';
  const PRIVATE_KEYS_KEY = 'meshcore-private-keys';
  const PERMANENT_BLOCK_NAMES = new Set(['#wardriving', '#wardrive', 'unknown']); // hardcoded

  // Sort order: public first, then user-added private channels (🔒), then #channels, all alpha within group
  function channelSortKey(ch) {
    const name = (ch.name || ch.hash || '').toLowerCase();
    if (name === 'public') return 0;
    if (ch.isPrivate) return 1;
    return 2;
  }
  function compareChannels(a, b) {
    const ka = channelSortKey(a), kb = channelSortKey(b);
    if (ka !== kb) return ka - kb;
    const an = a.name || a.hash, bn = b.name || b.hash;
    return an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' });
  }

  function getUserAddedChannels() {
    try { return JSON.parse(localStorage.getItem(USER_CHANNELS_KEY) || '[]'); } catch (_) { return []; }
  }
  function saveUserAddedChannel(name) {
    const list = getUserAddedChannels();
    if (!list.includes(name)) { list.push(name); localStorage.setItem(USER_CHANNELS_KEY, JSON.stringify(list)); }
  }
  function removeUserAddedChannel(name) {
    const list = getUserAddedChannels().filter(n => n !== name);
    localStorage.setItem(USER_CHANNELS_KEY, JSON.stringify(list));
  }

  // Private channel key management
  function getPrivateKeys() {
    try { return JSON.parse(localStorage.getItem(PRIVATE_KEYS_KEY) || '[]'); } catch (_) { return []; }
  }
  function savePrivateKey(entry) { // {name, keyHex, hashByte}
    const list = getPrivateKeys().filter(k => k.hashByte !== entry.hashByte);
    list.push(entry);
    localStorage.setItem(PRIVATE_KEYS_KEY, JSON.stringify(list));
  }
  function removePrivateKey(hashByte) {
    const list = getPrivateKeys().filter(k => k.hashByte !== hashByte);
    localStorage.setItem(PRIVATE_KEYS_KEY, JSON.stringify(list));
  }
  function getPrivateKeyForHash(hashByte) {
    return getPrivateKeys().find(k => k.hashByte === hashByte) || null;
  }
  // Synthetic hash string used in channels[] for private channels: "priv:NN" (NN = decimal hashByte)
  function privateChannelId(hashByte) { return 'priv:' + hashByte; }

  // Compute SHA256(keyBytes)[0] — returns Promise<number>
  async function computeChannelHashByte(keyHex) {
    const keyBytes = hexToUint8(keyHex);
    const digest = await crypto.subtle.digest('SHA-256', keyBytes);
    return new Uint8Array(digest)[0];
  }

  function hexToUint8(hex) {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return arr;
  }

  // AES-128-ECB decrypt using Web Crypto.
  // SubtleCrypto has no ECB mode and validates PKCS#7 padding on AES-CBC, so we:
  // 1. Use AES-CTR to compute a proper trailing PKCS#7 padding block (0x10 * 16)
  //    C_extra = AES_encrypt(C_last XOR 0x10*16) satisfies: AES_decrypt(C_extra) XOR C_last = 0x10*16
  // 2. Append C_extra and decrypt the whole ciphertext with AES-CBC (IV=0)
  // 3. Undo the CBC XOR chaining: P_ecb[i] = P_cbc[i] XOR C[i-1] (P_cbc[0] = P_ecb[0] already, IV=0)
  async function aesEcbDecrypt(keyHex, ciphertextHex) {
    const keyBytes = hexToUint8(keyHex);
    const C = hexToUint8(ciphertextHex);
    if (C.length === 0 || C.length % 16 !== 0) return null;
    try {
      // Step 1: build a trailing block that gives valid 0x10*16 PKCS#7 padding in CBC decrypt.
      //   In CBC: P_extra = AES_decrypt(C_extra) XOR C_last
      //   We want P_extra = 0x10*16, so AES_decrypt(C_extra) = C_last XOR 0x10*16
      //   i.e. C_extra = AES_encrypt(C_last XOR 0x10*16)
      //   AES-CTR with counter = (C_last XOR 0x10*16) encrypting 16 zero bytes = AES_encrypt(counter).
      const counterBlock = new Uint8Array(16);
      for (let i = 0; i < 16; i++) counterBlock[i] = C[C.length - 16 + i] ^ 0x10;
      const ctrKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, ['encrypt']);
      const C_extra = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-CTR', counter: counterBlock, length: 128 }, ctrKey, new Uint8Array(16)));

      // Step 2: decrypt [C | C_extra] with AES-CBC, IV=0. Padding = 0x10*16 → stripped, result = C.length bytes.
      const extended = new Uint8Array(C.length + 16);
      extended.set(C); extended.set(C_extra, C.length);
      const cbcKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
      const cbcResult = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: new Uint8Array(16) }, cbcKey, extended));

      // Step 3: undo CBC chaining to get ECB plaintext.
      //   cbcResult[block i] = AES_decrypt(C[i]) XOR C[i-1]  (C[-1] = IV = 0)
      //   plain_ecb[block i] = cbcResult[block i] XOR C[i-1]
      //   For block 0 (i=0): cbcResult[0] = AES_decrypt(C[0]) XOR 0 = plain_ecb[0] — already correct.
      const plain = new Uint8Array(C.length);
      for (let i = 0; i < C.length; i++) {
        plain[i] = cbcResult[i] ^ (i < 16 ? 0 : C[i - 16]);
      }
      return plain;
    } catch (_) { return null; }
  }

  // Verify MAC: HMAC-SHA256(key || 16_zero_bytes, ciphertext), compare first 2 bytes
  async function verifyMac(keyHex, ciphertextHex, macHex) {
    const keyBytes = hexToUint8(keyHex);
    const secret = new Uint8Array(32);
    secret.set(keyBytes, 0); // key || 16 zero bytes
    const cryptoKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const cipherBytes = hexToUint8(ciphertextHex);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, cipherBytes));
    const mac = hexToUint8(macHex);
    return sig[0] === mac[0] && sig[1] === mac[1];
  }

  // Parse decrypted plaintext: [timestamp 4 LE][flags 1][null-terminated UTF-8]
  function parsePlaintext(plain) {
    if (!plain || plain.length < 6) return null;
    const timestamp = plain[0] | (plain[1] << 8) | (plain[2] << 16) | (plain[3] << 24);
    // flags = plain[4]
    // message text starts at byte 5, null-terminated
    let end = 5;
    while (end < plain.length && plain[end] !== 0) end++;
    const text = new TextDecoder().decode(plain.slice(5, end));
    return { timestamp, text };
  }

  function removeFromSidebar(hash) {
    const ch = channels.find(c => c.hash === hash);
    if (ch) {
      ch.userAdded = false;
      if (ch.isPrivate && ch.hashByte !== undefined) {
        removePrivateKey(ch.hashByte);
        channels.splice(channels.indexOf(ch), 1);
      } else if (ch.name) {
        removeUserAddedChannel(ch.name);
      }
    }
    if (selectedHash === hash) {
      selectedHash = null; messages = [];
      history.replaceState(null, '', '#/channels');
      const hdr = document.getElementById('chHeader');
      if (hdr) hdr.querySelector('.ch-header-text').innerHTML = '<span class="ch-header-name">Select a channel</span>';
      const msgEl = document.getElementById('chMessages');
      if (msgEl) msgEl.innerHTML = '<div class="ch-empty">Choose a channel from the sidebar to view messages</div>';
      document.querySelector('.ch-layout')?.classList.remove('ch-show-main');
    }
    renderChannelList();
  }

  function getSelectedRegionsSnapshot() {
    var rp = RegionFilter.getRegionParam();
    return rp ? rp.split(',').filter(Boolean) : null;
  }

  function normalizeObserverNameKey(name) {
    if (!name) return '';
    return String(name).trim().toLowerCase();
  }

  function shouldProcessWSMessageForRegion(msg, selectedRegions, observerRegionsById, observerRegionsByName) {
    if (!selectedRegions || !selectedRegions.length) return true;
    if (observerRegionsById && observerRegionsById.byId) {
      observerRegionsByName = observerRegionsById.byName || {};
      observerRegionsById = observerRegionsById.byId || {};
    }
    observerRegionsById = observerRegionsById || {};
    observerRegionsByName = observerRegionsByName || {};

    var observerId = msg?.data?.packet?.observer_id || msg?.data?.observer_id || null;
    var observerRegion = observerId ? observerRegionsById[observerId] : null;
    if (!observerRegion) {
      var observerName = msg?.data?.packet?.observer_name || msg?.data?.observer_name || msg?.data?.observer || null;
      var observerNameKey = normalizeObserverNameKey(observerName);
      if (observerName) observerRegion = observerRegionsByName[observerName];
      if (!observerRegion && observerNameKey) observerRegion = observerRegionsByName[observerNameKey];
    }
    if (!observerRegion) return false;
    return selectedRegions.indexOf(observerRegion) !== -1;
  }

  async function loadObserverRegions() {
    try {
      var data = await api('/observers', { ttl: CLIENT_TTL.observers });
      var list = data && data.observers ? data.observers : [];
      var byId = {};
      var byName = {};
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        var id = o.id || o.observer_id;
        var name = o.name || o.observer_name;
        if (!o.iata) continue;
        if (id) byId[id] = o.iata;
        if (name) {
          byName[name] = o.iata;
          var key = normalizeObserverNameKey(name);
          if (key) byName[key] = o.iata;
        }
      }
      observerIataById = byId;
      observerIataByName = byName;
    } catch {}
  }

  function beginMessageRequest(hash, regionParam) {
    return { id: ++messageRequestId, hash: hash, regionParam: regionParam || '' };
  }

  function isStaleMessageRequest(req) {
    if (!req) return true;
    var currentRegion = RegionFilter.getRegionParam() || '';
    if (req.id !== messageRequestId) return true;
    if (selectedHash !== req.hash) return true;
    if (currentRegion !== req.regionParam) return true;
    return false;
  }

  function reconcileSelectionAfterChannelRefresh() {
    if (!selectedHash || channels.some(ch => ch.hash === selectedHash)) return false;
    selectedHash = null;
    messages = [];
    history.replaceState(null, '', '#/channels');
    renderChannelList();
    const header = document.getElementById('chHeader');
    if (header) header.querySelector('.ch-header-text').innerHTML = '<span class="ch-header-name">Select a channel</span>';
    const msgEl = document.getElementById('chMessages');
    if (msgEl) msgEl.innerHTML = '<div class="ch-empty">Choose a channel from the sidebar to view messages</div>';
    document.querySelector('.ch-layout')?.classList.remove('ch-show-main');
    return true;
  }

  async function lookupNode(name) {
    var cached = nodeCache[name];
    if (cached !== undefined) {
      if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt < _nodeCacheTTL)) return cached.data;
      if (cached && !cached.fetchedAt) return cached; // legacy null entries
    }
    try {
      const data = await api('/nodes/search?q=' + encodeURIComponent(name), { ttl: CLIENT_TTL.channelMessages });
      // Try exact match first, then case-insensitive, then contains
      const nodes = data.nodes || [];
      const match = nodes.find(n => n.name === name)
        || nodes.find(n => n.name && n.name.toLowerCase() === name.toLowerCase())
        || nodes.find(n => n.name && n.name.toLowerCase().includes(name.toLowerCase()))
        || nodes[0] || null;
      nodeCache[name] = { data: match, fetchedAt: Date.now() };
      return match;
    } catch { nodeCache[name] = null; return null; }
  }

  async function showNodeTooltip(e, name) {
    const node = await lookupNode(name);
    let existing = document.getElementById('chNodeTooltip');
    if (existing) existing.remove();
    if (!node) return;

    const tip = document.createElement('div');
    tip.id = 'chNodeTooltip';
    tip.className = 'ch-node-tooltip';
    tip.setAttribute('role', 'tooltip');
    const roleKey = node.role || (node.is_repeater ? 'repeater' : node.is_room ? 'room' : node.is_sensor ? 'sensor' : 'companion');
    const role = (ROLE_EMOJI[roleKey] || '●') + ' ' + (ROLE_LABELS[roleKey] || roleKey);
    const lastActivity = node.last_heard || node.last_seen;
    const lastSeen = lastActivity ? timeAgo(lastActivity) : 'unknown';
    tip.innerHTML = `<div class="ch-tooltip-name">${escapeHtml(node.name)}</div>
      <div class="ch-tooltip-role">${role}</div>
      <div class="ch-tooltip-meta">Last seen: ${lastSeen}</div>
      <div class="ch-tooltip-key mono">${formatPubKey(node.public_key, node.hash_size, 16)}…</div>`;
    document.body.appendChild(tip);
    var trigger = e.target.closest('[data-node]') || e.target;
    trigger.setAttribute('aria-describedby', 'chNodeTooltip');
    const rect = trigger.getBoundingClientRect();
    tip.style.left = Math.min(rect.left, window.innerWidth - 220) + 'px';
    tip.style.top = (rect.bottom + 4) + 'px';
  }

  function hideNodeTooltip() {
    var trigger = document.querySelector('[aria-describedby="chNodeTooltip"]');
    if (trigger) trigger.removeAttribute('aria-describedby');
    const tip = document.getElementById('chNodeTooltip');
    if (tip) tip.remove();
  }

  let _focusTrapCleanup = null;
  let _nodePanelTrigger = null;

  function trapFocus(container) {
    function handler(e) {
      if (e.key === 'Escape') { closeNodeDetail(); return; }
      if (e.key !== 'Tab') return;
      const focusable = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    container.addEventListener('keydown', handler);
    return function () { container.removeEventListener('keydown', handler); };
  }

  async function showNodeDetail(name) {
    _nodePanelTrigger = document.activeElement;
    if (_focusTrapCleanup) { _focusTrapCleanup(); _focusTrapCleanup = null; }
    var _capturedHash = selectedHash;
    const node = await lookupNode(name);
    selectedNode = name;
    var _chBase = _capturedHash ? '#/channels/' + encodeURIComponent(_capturedHash) : '#/channels';
    history.replaceState(null, '', _chBase + '?node=' + encodeURIComponent(name));

    let panel = document.getElementById('chNodePanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'chNodePanel';
      panel.className = 'ch-node-panel';
      document.querySelector('.ch-main').appendChild(panel);
    }
    panel.classList.add('open');

    if (!node) {
      panel.innerHTML = `<div class="ch-node-panel-header">
          <strong>${escapeHtml(name)}</strong>
          <button class="ch-node-close" data-action="ch-close-node" aria-label="Close">✕</button>
        </div>
        <div class="ch-node-panel-body">
          <div class="ch-node-field" style="color:var(--text-muted)">No node record found — this sender has only been seen in channel messages, not via adverts.</div>
        </div>`;
      _focusTrapCleanup = trapFocus(panel);
      panel.querySelector('.ch-node-close')?.focus();
      return;
    }

    try {
      const detail = await api('/nodes/' + encodeURIComponent(node.public_key), { ttl: CLIENT_TTL.nodeDetail });
      const n = detail.node;
      const adverts = detail.recentAdverts || [];
      const roleKey = n.role || (n.is_repeater ? 'repeater' : n.is_room ? 'room' : n.is_sensor ? 'sensor' : 'companion');
      const role = (ROLE_EMOJI[roleKey] || '●') + ' ' + (ROLE_LABELS[roleKey] || roleKey);
      const lastActivity = n.last_heard || n.last_seen;
      const lastSeen = lastActivity ? timeAgo(lastActivity) : 'unknown';

      panel.innerHTML = `<div class="ch-node-panel-header">
          <strong>${escapeHtml(n.name || 'Unknown')}</strong>
          <button class="ch-node-close" data-action="ch-close-node" aria-label="Close">✕</button>
        </div>
        <div class="ch-node-panel-body">
          <div class="ch-node-field"><span class="ch-node-label">Role</span> ${role}</div>
          <div class="ch-node-field"><span class="ch-node-label">Last Seen</span> ${lastSeen}</div>
          <div class="ch-node-field"><span class="ch-node-label">Adverts</span> ${n.advert_count || 0}</div>
          ${n.lat && n.lon ? `<div class="ch-node-field"><span class="ch-node-label">Location</span> ${Number(n.lat).toFixed(4)}, ${Number(n.lon).toFixed(4)}</div>` : ''}
          <div class="ch-node-field mono" style="font-size:11px;word-break:break-all"><span class="ch-node-label">Key</span> ${formatPubKey(n.public_key, n.hash_size)}</div>
          ${adverts.length ? `<div class="ch-node-adverts"><span class="ch-node-label">Recent Adverts</span>
            ${adverts.slice(0, 5).map(a => `<div class="ch-node-advert">${timeAgo(a.timestamp)} · SNR ${a.snr != null ? a.snr + 'dB' : '?'}</div>`).join('')}
          </div>` : ''}
          <a href="#/nodes/${n.public_key}" class="ch-node-link">View full node detail →</a>
        </div>`;
      _focusTrapCleanup = trapFocus(panel);
      panel.querySelector('.ch-node-close')?.focus();
    } catch (e) {
      panel.innerHTML = `<div class="ch-node-panel-header"><strong>${escapeHtml(name)}</strong><button class="ch-node-close" data-action="ch-close-node">✕</button></div><div class="ch-node-panel-body ch-empty">Failed to load</div>`;
      _focusTrapCleanup = trapFocus(panel);
      panel.querySelector('.ch-node-close')?.focus();
    }
  }

  function closeNodeDetail() {
    if (_focusTrapCleanup) { _focusTrapCleanup(); _focusTrapCleanup = null; }
    const panel = document.getElementById('chNodePanel');
    if (panel) panel.classList.remove('open');
    selectedNode = null;
    var _chRestoreUrl = selectedHash ? '#/channels/' + encodeURIComponent(selectedHash) : '#/channels';
    history.replaceState(null, '', _chRestoreUrl);
    if (_nodePanelTrigger && typeof _nodePanelTrigger.focus === 'function') {
      _nodePanelTrigger.focus();
      _nodePanelTrigger = null;
    }
  }

  function chBack() {
    closeNodeDetail();
    var layout = document.querySelector('.ch-layout');
    if (layout) layout.classList.remove('ch-show-main');
    var sidebar = document.querySelector('.ch-sidebar');
    if (sidebar) sidebar.style.pointerEvents = '';
    if (_mobileNavPushed) {
      // Button path: pop the duplicate entry; URL cleanup happens in _popstateHandler
      _mobileNavPushed = false;
      _skipNextPopstate = true;
      history.back();
    } else {
      // Swipe path: browser already popped, just clean up the URL
      history.replaceState(null, '', '#/channels');
    }
  }

  // WCAG AA compliant colors — ≥4.5:1 contrast on both white and dark backgrounds
  // Channel badge colors (white text on colored background)
  const CHANNEL_COLORS = [
    '#1d4ed8', '#b91c1c', '#15803d', '#b45309', '#7e22ce',
    '#0e7490', '#a16207', '#0f766e', '#be185d', '#1e40af',
  ];
  // Sender name colors — must be readable on --card-bg (light: ~#fff, dark: ~#1e293b)
  // Using CSS vars via inline style would be ideal, but these are reasonable middle-ground
  // Light mode bg ~white: need dark enough. Dark mode bg ~#1e293b: need light enough.
  // Solution: use medium-bright saturated colors that work on both.
  const SENDER_COLORS_LIGHT = [
    '#16a34a', '#2563eb', '#db2777', '#ca8a04', '#7c3aed',
    '#0d9488', '#ea580c', '#c026d3', '#0284c7', '#dc2626',
    '#059669', '#4f46e5', '#e11d48', '#d97706', '#9333ea',
  ];
  const SENDER_COLORS_DARK = [
    '#4ade80', '#60a5fa', '#f472b6', '#facc15', '#a78bfa',
    '#2dd4bf', '#fb923c', '#e879f9', '#38bdf8', '#f87171',
    '#34d399', '#818cf8', '#fb7185', '#fbbf24', '#c084fc',
  ];

  function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function formatHashHex(hash) {
    return typeof hash === 'number' ? '0x' + hash.toString(16).toUpperCase().padStart(2, '0') : hash;
  }
  function getChannelColor(hash) { return CHANNEL_COLORS[hashCode(String(hash)) % CHANNEL_COLORS.length]; }
  function getSenderColor(name) {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const palette = isDark ? SENDER_COLORS_DARK : SENDER_COLORS_LIGHT;
    return palette[hashCode(String(name)) % palette.length];
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function formatSecondsAgo(sec) {
    if (sec < 0) sec = 0;
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return Math.floor(sec / 86400) + 'd ago';
  }

  function linkifyUrls(html) {
    // Match http/https URLs not already inside an href attribute
    return html.replace(/(?<![="])https?:\/\/[^\s<>"']+/g, function(url) {
      // Strip trailing punctuation that's likely not part of the URL
      var clean = url.replace(/[.,;:!?)]+$/, '');
      var trailing = url.slice(clean.length);
      var safeUrl = clean.replace(/&amp;/g, '&'); // decode HTML entity for href
      return '<a href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noopener noreferrer" class="ch-url-link">' + clean + '</a>' + trailing;
    });
  }

  function highlightMentions(text) {
    if (!text) return '';
    var html = escapeHtml(text).replace(/@\[([^\]]+)\]/g, function(_, name) {
      const safeId = btoa(encodeURIComponent(name));
      return '<span class="ch-mention ch-sender-link" tabindex="0" role="button" data-node="' + safeId + '">@' + name + '</span>';
    });
    return linkifyUrls(html);
  }

  let regionChangeHandler = null;
  let availModalOpen = false;
  let modalChannels = null; // full unfiltered channel list for the modal

  function openAvailModal() {
    availModalOpen = true;
    modalChannels = null;
    const modal = document.getElementById('chAvailModal');
    if (modal) modal.classList.remove('hidden');
    const search = document.getElementById('chAvailSearch');
    if (search) { search.value = ''; search.focus(); }
    renderAvailModal();
    // Fetch all channels (no region filter) for complete modal list
    api('/channels', { ttl: 3000 }).then(data => {
      if (!availModalOpen) return;
      const serverChannels = (data.channels || []).map(ch => {
        ch.lastActivityMs = ch.lastActivity ? new Date(ch.lastActivity).getTime() : 0;
        return ch;
      });
      // Mark which are user-added; include user-added stubs not returned by server
      const userNames = new Set(getUserAddedChannels());
      serverChannels.forEach(ch => { if (userNames.has(ch.name)) ch.userAdded = true; });
      const stubs = channels.filter(ch => ch.userAdded && !serverChannels.some(s => s.name === ch.name));
      modalChannels = [...serverChannels, ...stubs];
      renderAvailModal();
    }).catch(() => {});
  }

  function closeAvailModal() {
    availModalOpen = false;
    modalChannels = null;
    const modal = document.getElementById('chAvailModal');
    if (modal) modal.classList.add('hidden');
  }

  function renderAvailModal() {
    const listEl = document.getElementById('chAvailList');
    if (!listEl) return;
    const userAdded = new Set(getUserAddedChannels());
    const query = (document.getElementById('chAvailSearch')?.value || '').trim().toLowerCase();
    const visible = [...(modalChannels || channels)]
      .filter(ch => {
        if (ch.name && PERMANENT_BLOCK_NAMES.has(ch.name.toLowerCase())) return false;
        if (ch.name && ch.name.startsWith('~')) return false; // encrypted, not yet decrypted
        if (query && !(ch.name || ch.hash).toLowerCase().includes(query)) return false;
        return true;
      })
      .sort((a, b) => {
        const an = a.name || a.hash, bn = b.name || b.hash;
        if (an === 'public') return -1; if (bn === 'public') return 1;
        return an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' });
      });
    if (!visible.length) {
      listEl.innerHTML = `<div class="ch-empty">${query ? 'No channels match your search' : 'No channels discovered yet'}</div>`;
      return;
    }
    const now = Date.now();
    listEl.innerHTML = visible.map(ch => {
      const name = ch.name || ch.hash;
      const color = getChannelColor(ch.hash);
      const abbr = name.startsWith('#') ? name.slice(1, 3).toUpperCase() : name.slice(0, 2).toUpperCase();
      const isPublic = name.toLowerCase() === 'public';
      const isAdded = isPublic || ch.userAdded || userAdded.has(name);
      const count = ch.messageCount ? `${ch.messageCount} msg${ch.messageCount === 1 ? '' : 's'}` : '';
      const time = ch.lastActivityMs ? formatSecondsAgo(Math.floor((now - ch.lastActivityMs) / 1000)) : '';
      return `<div class="ch-avail-item">
        <div class="ch-badge ch-avail-badge" style="--ch-color:${color};background:${color}" aria-hidden="true"><span class="ch-badge-shine"></span>${escapeHtml(abbr)}</div>
        <div class="ch-avail-item-info">
          <span class="ch-avail-item-name">${escapeHtml(name)}</span>
          ${count || time ? `<span class="ch-avail-item-meta">${[count, time].filter(Boolean).join(' · ')}</span>` : ''}
        </div>
        ${isAdded
          ? `<span class="ch-avail-added">Added ✓</span>`
          : `<button class="ch-avail-add-btn" data-channel-name="${escapeHtml(name)}" data-channel-hash="${escapeHtml(ch.hash)}">Add</button>`
        }
      </div>`;
    }).join('');
    listEl.querySelectorAll('.ch-avail-add-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.channelName;
        const hash = btn.dataset.channelHash;
        saveUserAddedChannel(name);
        const ch = channels.find(c => c.hash === hash);
        if (ch) ch.userAdded = true;
        else channels.push({ hash, name, lastActivityMs: 0, messageCount: 0, userAdded: true });
        if (modalChannels) {
          const mch = modalChannels.find(c => c.hash === hash);
          if (mch) mch.userAdded = true;
        }
        renderChannelList();
        renderAvailModal();
      });
    });
  }

  function init(app, routeParam) {
    var _initUrlParams = getHashParams();
    var _pendingNode = _initUrlParams.get('node');

    app.innerHTML = `<div class="ch-layout">
      <div class="ch-sidebar" aria-label="Channel list">
        <div class="ch-sidebar-header">
          <div class="ch-sidebar-title">
            <span class="ch-icon">💬</span> Channels
          </div>
          <button class="ch-add-btn" id="chAddBtn" title="Browse available channels">Available Channels</button>
          <button class="ch-add-btn ch-add-btn-private" id="chPrivateToggle" type="button" title="Add a private channel with a local AES key">🔒 Add Private Channel</button>
        </div>
        <div id="chRegionFilter" class="region-filter-container" style="padding:0 8px"></div>
        <div class="ch-channel-list" id="chList" role="listbox" aria-label="Channels">
          <div class="ch-loading">Loading channels…</div>
        </div>
        <div class="ch-sidebar-resize" aria-hidden="true"></div>
      </div>
      <div class="ch-main" role="region" aria-label="Channel messages">
        <div class="ch-main-header" id="chHeader">
          <button class="ch-back-btn" id="chBackBtn" aria-label="Back to channels" data-action="ch-back"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg></button>
          <span class="ch-header-text"><span class="ch-header-name">Select a channel</span></span>
          <button class="ch-add-btn ch-sort-pill" id="chSortBtn">Sort: newest at top</button>
        </div>
        <div class="ch-messages" id="chMessages">
          <div class="ch-empty">Choose a channel from the sidebar to view messages</div>
        </div>
        <span id="chAriaLive" class="sr-only" aria-live="polite"></span>
      </div>
    </div>`;

    // Inject Available Channels modal
    const modalEl = document.createElement('div');
    modalEl.id = 'chAvailModal';
    modalEl.className = 'ch-avail-modal hidden';
    modalEl.innerHTML = `
      <div class="ch-avail-backdrop" id="chAvailBackdrop"></div>
      <div class="ch-avail-panel">
        <div class="ch-avail-header">
          <span class="ch-avail-title">Available Channels</span>
          <button class="ch-avail-close" id="chAvailClose" aria-label="Close">✕</button>
        </div>
        <div class="ch-avail-search-wrap">
          <input class="ch-avail-search" id="chAvailSearch" type="search" placeholder="Search channels…" autocomplete="off" spellcheck="false" />
        </div>
        <p class="ch-avail-hint">Channels heard by the server. Tap <strong>Add</strong> to pin a channel to your sidebar.</p>
        <div class="ch-avail-list" id="chAvailList"><div class="ch-loading">Loading…</div></div>
        <div class="ch-avail-add-manual">
          <span class="ch-avail-add-manual-label">Add a # channel not yet heard:</span>
          <div class="ch-avail-add-manual-row">
            <input class="ch-avail-manual-input" id="chManualInput" type="text" placeholder="#channel-name" maxlength="64" autocomplete="off" spellcheck="false" />
            <button class="ch-avail-manual-btn" id="chManualAddBtn">Add</button>
          </div>
          <div class="ch-avail-manual-error hidden" id="chManualError"></div>
        </div>
      </div>`;
    app.appendChild(modalEl);

    // Private channel modal
    const privateModalEl = document.createElement('div');
    privateModalEl.id = 'chPrivateModal';
    privateModalEl.className = 'ch-avail-modal hidden';
    privateModalEl.innerHTML = `
      <div class="ch-avail-backdrop" id="chPrivateBackdrop"></div>
      <div class="ch-avail-panel ch-private-panel">
        <div class="ch-avail-header">
          <span class="ch-avail-title">🔒 Add Private Channel</span>
          <button class="ch-avail-close" id="chPrivateClose" aria-label="Close">✕</button>
        </div>
        <div class="ch-private-modal-body">
          <p class="ch-private-hint">Enter a display name and paste your 32-character hex AES-128 key. The key is stored locally only — it is never sent to the server.</p>
          <div class="ch-private-field">
            <label for="chPrivateName">Display name</label>
            <input type="text" id="chPrivateName" placeholder="e.g. My Private Channel" maxlength="64" autocomplete="off" spellcheck="false" />
          </div>
          <div class="ch-private-field">
            <label for="chPrivateKey">AES key (32 hex chars)</label>
            <input type="text" id="chPrivateKey" placeholder="e.g. 0123456789abcdef0123456789abcdef" maxlength="32" autocomplete="off" spellcheck="false" class="mono" />
          </div>
          <div class="ch-private-error hidden" id="chPrivateError"></div>
          <button class="ch-private-save" id="chPrivateSave" type="button">Save Private Channel</button>
        </div>
      </div>`;
    app.appendChild(privateModalEl);

    // Sort toggle
    document.getElementById('chSortBtn').addEventListener('click', () => {
      msgSortOrder = msgSortOrder === 'newest' ? 'oldest' : 'newest';
      document.getElementById('chSortBtn').textContent = msgSortOrder === 'newest' ? 'Sort: newest at top' : 'Sort: newest at bottom';
      renderMessages();
      const msgEl = document.getElementById('chMessages');
      if (msgEl) { if (msgSortOrder === 'newest') msgEl.scrollTop = 0; else msgEl.scrollTop = msgEl.scrollHeight; }
    });

    // Available Channels button + modal wiring
    const addBtn = document.getElementById('chAddBtn');
    if (addBtn) addBtn.addEventListener('click', openAvailModal);
    document.getElementById('chAvailClose').addEventListener('click', closeAvailModal);
    document.getElementById('chAvailBackdrop').addEventListener('click', closeAvailModal);
    document.getElementById('chAvailSearch').addEventListener('input', renderAvailModal);

    // Manual channel add wiring
    async function doManualAdd() {
      const input = document.getElementById('chManualInput');
      const errEl = document.getElementById('chManualError');
      const btn = document.getElementById('chManualAddBtn');
      let name = (input.value || '').trim();
      errEl.classList.add('hidden');
      if (!name.startsWith('#')) name = '#' + name;
      if (name.length < 2) {
        errEl.textContent = 'Channel name must start with # (e.g. #bot-islands)';
        errEl.classList.remove('hidden');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Adding…';
      try {
        const resp = await fetch('/api/channels/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        if (!resp.ok) {
          const msg = await resp.text();
          errEl.textContent = msg || 'Failed to add channel';
          errEl.classList.remove('hidden');
          return;
        }
        // Also pin it to the sidebar (localStorage)
        saveUserAddedChannel(name);
        const alreadyKnown = (modalChannels || channels).some(c => c.name === name);
        if (!alreadyKnown) {
          const stub = { hash: name, name, lastActivityMs: 0, messageCount: 0, userAdded: true };
          channels.push(stub);
          if (modalChannels) modalChannels.push(stub);
        } else {
          if (modalChannels) { const mch = modalChannels.find(c => c.name === name); if (mch) mch.userAdded = true; }
          const ch = channels.find(c => c.name === name); if (ch) ch.userAdded = true;
        }
        input.value = '';
        renderChannelList();
        renderAvailModal();
      } catch (e) {
        errEl.textContent = 'Network error — could not reach server';
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Add';
      }
    }
    document.getElementById('chManualAddBtn').addEventListener('click', doManualAdd);
    document.getElementById('chManualInput').addEventListener('keydown', e => { if (e.key === 'Enter') doManualAdd(); });

    // Private channel modal wiring
    function openPrivateModal() {
      document.getElementById('chPrivateModal').classList.remove('hidden');
      document.getElementById('chPrivateError').classList.add('hidden');
      document.getElementById('chPrivateName').focus();
    }
    function closePrivateModal() {
      document.getElementById('chPrivateModal').classList.add('hidden');
      document.getElementById('chPrivateName').value = '';
      document.getElementById('chPrivateKey').value = '';
      document.getElementById('chPrivateError').classList.add('hidden');
    }
    document.getElementById('chPrivateToggle').addEventListener('click', openPrivateModal);
    document.getElementById('chPrivateClose').addEventListener('click', closePrivateModal);
    document.getElementById('chPrivateBackdrop').addEventListener('click', closePrivateModal);
    document.getElementById('chPrivateModal').addEventListener('keydown', e => {
      if (e.key === 'Escape') closePrivateModal();
    });
    document.getElementById('chPrivateSave').addEventListener('click', async () => {
      const nameEl = document.getElementById('chPrivateName');
      const keyEl = document.getElementById('chPrivateKey');
      const errEl = document.getElementById('chPrivateError');
      const name = nameEl.value.trim();
      const keyHex = keyEl.value.trim().toLowerCase();
      errEl.classList.add('hidden');
      errEl.textContent = '';
      if (!name) { errEl.textContent = 'Display name is required.'; errEl.classList.remove('hidden'); return; }
      if (!/^[0-9a-f]{32}$/.test(keyHex)) { errEl.textContent = 'Key must be exactly 32 hex characters (a-f, 0-9).'; errEl.classList.remove('hidden'); return; }
      const saveBtn = document.getElementById('chPrivateSave');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const hashByte = await computeChannelHashByte(keyHex);
        // Check for hash collision with existing private key
        const existing = getPrivateKeyForHash(hashByte);
        if (existing && existing.keyHex !== keyHex) {
          errEl.textContent = `Hash collision: this key byte (${hashByte}) is already used by "${existing.name}".`;
          errEl.classList.remove('hidden');
          return;
        }
        savePrivateKey({ name, keyHex, hashByte });
        // Add to channels sidebar
        const id = privateChannelId(hashByte);
        if (!channels.some(c => c.hash === id)) {
          channels.push({ hash: id, name, lastActivityMs: 0, messageCount: 0, userAdded: true, isPrivate: true, hashByte });
        }
        renderChannelList();
        closePrivateModal();
      } catch (e) {
        errEl.textContent = 'Error: ' + e.message;
        errEl.classList.remove('hidden');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Private Channel';
      }
    });

    RegionFilter.init(document.getElementById('chRegionFilter'));
    regionChangeHandler = RegionFilter.onChange(function () {
      loadChannels(true).then(async function () {
        if (!selectedHash) return;
        await refreshMessages({ regionSwitch: true, forceNoCache: true });
      });
    });

    loadObserverRegions();
    loadChannels().then(async function () {
      if (routeParam) await selectChannel(routeParam);
      if (_pendingNode && _pendingNode.length < 200) await showNodeDetail(_pendingNode);
    });

    // #89: Sidebar resize handle
    (function () {
      var sidebar = app.querySelector('.ch-sidebar');
      var handle = app.querySelector('.ch-sidebar-resize');
      var saved = localStorage.getItem('channels-sidebar-width');
      if (saved) { var w = parseInt(saved, 10); if (w >= 180 && w <= 600) { sidebar.style.width = w + 'px'; sidebar.style.minWidth = w + 'px'; } }
      var dragging = false, startX, startW;
      handle.addEventListener('mousedown', function (e) { dragging = true; startX = e.clientX; startW = sidebar.getBoundingClientRect().width; e.preventDefault(); });
      document.addEventListener('mousemove', function (e) { if (!dragging) return; var w = Math.max(180, Math.min(600, startW + e.clientX - startX)); sidebar.style.width = w + 'px'; sidebar.style.minWidth = w + 'px'; });
      document.addEventListener('mouseup', function () { if (!dragging) return; dragging = false; localStorage.setItem('channels-sidebar-width', parseInt(sidebar.style.width, 10)); });
    })();

    // #90: Theme change observer — re-render messages on theme toggle
    var _themeObserver = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].attributeName === 'data-theme') { if (selectedHash) renderMessages(); break; }
      }
    });
    _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Mobile: intercept browser back gesture while in channel message view
    _popstateHandler = function () {
      if (_skipNextPopstate) {
        _skipNextPopstate = false;
        if (location.hash.startsWith('#/channels')) {
          history.replaceState(null, '', '#/channels');
        }
        return;
      }
      // Only intercept back gesture when we pushed a duplicate mobile history entry.
      // Without this guard, popstate fires on desktop during forward navigation (nav link click)
      // and incorrectly calls chBack(), replacing the URL with #/channels.
      if (!_mobileNavPushed) return;
      var layout = app.querySelector('.ch-layout');
      if (layout && layout.classList.contains('ch-show-main')) {
        _mobileNavPushed = false; // browser already popped the entry
        chBack();
      }
    };
    window.addEventListener('popstate', _popstateHandler);

    // #87: Fix pointer-events during mobile slide transition
    var chMain = app.querySelector('.ch-main');
    var chSidebar = app.querySelector('.ch-sidebar');
    chMain.addEventListener('transitionend', function (e) {
      if (e.target !== chMain) return;
      var layout = app.querySelector('.ch-layout');
      if (layout && layout.classList.contains('ch-show-main')) {
        chSidebar.style.pointerEvents = 'none';
      } else {
        chSidebar.style.pointerEvents = '';
      }
    });

    // Event delegation for data-action buttons
    app.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      if (action === 'ch-close-node') closeNodeDetail();
      else if (action === 'ch-back') chBack();
    });

    // Event delegation for channel selection (touch-friendly)
    document.getElementById('chList').addEventListener('click', (e) => {
      // Color dot click — open picker, don't select channel
      const dot = e.target.closest('.ch-color-dot');
      if (dot && window.ChannelColorPicker) {
        e.stopPropagation();
        var ch = dot.getAttribute('data-channel');
        if (ch) ChannelColorPicker.show(ch, e.clientX, e.clientY);
        return;
      }
      const item = e.target.closest('.ch-item[data-hash]');
      if (item) selectChannel(item.dataset.hash);
    });

    const msgEl = document.getElementById('chMessages');
    msgEl.addEventListener('scroll', () => {
      const atBottom = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 60;
      autoScroll = atBottom;
    });

    // Event delegation for node clicks and hovers (click + touchend for mobile reliability)
    function handleNodeTap(e) {
      const el = e.target.closest('[data-node]');
      if (el) {
        e.preventDefault();
        const name = decodeURIComponent(atob(el.dataset.node));
        showNodeDetail(name);
      } else if (selectedNode && !e.target.closest('.ch-node-panel')) {
        closeNodeDetail();
      }
    }
    // Keyboard support for data-node elements (Bug #82)
    msgEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        const el = e.target.closest('[data-node]');
        if (el) {
          e.preventDefault();
          const name = decodeURIComponent(atob(el.dataset.node));
          showNodeDetail(name);
        }
      }
    });

    msgEl.addEventListener('click', handleNodeTap);
    // touchend fires more reliably on mobile for non-button elements
    let touchMoved = false;
    msgEl.addEventListener('touchstart', () => { touchMoved = false; }, { passive: true });
    msgEl.addEventListener('touchmove', () => { touchMoved = true; }, { passive: true });
    msgEl.addEventListener('touchend', (e) => {
      if (touchMoved) return;
      const el = e.target.closest('[data-node]');
      if (el) {
        e.preventDefault();
        const name = decodeURIComponent(atob(el.dataset.node));
        showNodeDetail(name);
      } else if (selectedNode && !e.target.closest('.ch-node-panel')) {
        closeNodeDetail();
      }
    });
    let hoverTimeout = null;
    msgEl.addEventListener('mouseover', (e) => {
      const el = e.target.closest('[data-node]');
      if (el) {
        clearTimeout(hoverTimeout);
        const name = decodeURIComponent(atob(el.dataset.node));
        showNodeTooltip(e, name);
      }
    });
    msgEl.addEventListener('mouseout', (e) => {
      const el = e.target.closest('[data-node]');
      if (el) {
        hoverTimeout = setTimeout(hideNodeTooltip, 100);
      }
    });
    // #86: Show tooltip on focus for keyboard users
    msgEl.addEventListener('focusin', (e) => {
      const el = e.target.closest('[data-node]');
      if (el) {
        clearTimeout(hoverTimeout);
        const name = decodeURIComponent(atob(el.dataset.node));
        showNodeTooltip(e, name);
      }
    });
    msgEl.addEventListener('focusout', (e) => {
      const el = e.target.closest('[data-node]');
      if (el) {
        hoverTimeout = setTimeout(hideNodeTooltip, 100);
      }
    });

    function processWSBatch(msgs, selectedRegions) {
      var dominated = msgs.filter(function (m) {
        return m.type === 'message' || (m.type === 'packet' && m.data?.decoded?.header?.payloadTypeName === 'GRP_TXT');
      });
      if (!dominated.length) return;

      var channelListDirty = false;
      var messagesDirty = false;
      var seenHashes = new Set();

      for (var i = 0; i < dominated.length; i++) {
        var m = dominated[i];
        if (!shouldProcessWSMessageForRegion(m, selectedRegions, observerIataById, observerIataByName)) continue;
        var payload = m.data?.decoded?.payload;
        if (!payload) continue;

        var channelName = payload.channel;
        if (!channelName) continue;
        var rawText = payload.text || '';
        var sender = payload.sender || null;
        var displayText = rawText;

        // Parse "sender: message" format
        if (rawText && !sender) {
          var colonIdx = rawText.indexOf(': ');
          if (colonIdx > 0 && colonIdx < 50) {
            sender = rawText.slice(0, colonIdx);
            displayText = rawText.slice(colonIdx + 2);
          }
        } else if (rawText && sender) {
          var colonIdx2 = rawText.indexOf(': ');
          if (colonIdx2 > 0 && colonIdx2 < 50) {
            displayText = rawText.slice(colonIdx2 + 2);
          }
        }
        if (!sender) sender = 'Unknown';

        var ts = new Date().toISOString();
        var pktHash = m.data?.hash || m.data?.packet?.hash || null;
        var pktId = m.data?.id || null;
        var snr = m.data?.snr ?? m.data?.packet?.snr ?? payload.SNR ?? null;
        var observer = m.data?.packet?.observer_name || m.data?.observer || null;

        // Update channel list entry — only once per unique packet hash
        var isFirstObservation = pktHash && !seenHashes.has(pktHash + ':' + channelName);
        if (pktHash) seenHashes.add(pktHash + ':' + channelName);

        // Skip permanently blocked channels entirely
        if (PERMANENT_BLOCK_NAMES.has((channelName || '').toLowerCase())) continue;

        var ch = channels.find(function (c) { return c.hash === channelName; });
        if (ch) {
          if (isFirstObservation) ch.messageCount = (ch.messageCount || 0) + 1;
          ch.lastActivityMs = Date.now();
          ch.lastSender = sender;
          ch.lastMessage = truncate(displayText, 100);
          channelListDirty = true;
          if (isFirstObservation && channelName !== selectedHash) unreadChannels.add(channelName);
        } else {
          // New channel — channels.find() guard above ensures no duplicates.
          // Do not gate on isFirstObservation: pktHash can be null for some
          // GRP_TXT packets, which would cause the channel to never appear.
          channels.push({
            hash: channelName,
            name: channelName,
            messageCount: 1,
            lastActivityMs: Date.now(),
            lastSender: sender,
            lastMessage: truncate(displayText, 100),
          });
          channelListDirty = true;
          if (channelName !== selectedHash) unreadChannels.add(channelName);
        }

        // If this message is for the selected channel, append to messages
        if (selectedHash && channelName === selectedHash) {
          // Deduplicate by packet hash — same message seen by multiple observers
          var existing = pktHash ? messages.find(function (msg) { return msg.packetHash === pktHash; }) : null;
          if (existing) {
            existing.repeats = (existing.repeats || 1) + 1;
            if (observer && existing.observers && existing.observers.indexOf(observer) === -1) {
              existing.observers.push(observer);
            }
          } else {
            messages.push({
              sender: sender,
              text: displayText,
              timestamp: ts,
              sender_timestamp: payload.sender_timestamp || null,
              packetId: pktId,
              packetHash: pktHash,
              repeats: 1,
              observers: observer ? [observer] : [],
              hops: payload.path_len || 0,
              snr: snr,
            });
          }
          messagesDirty = true;
        }
      }

      if (channelListDirty) {
        channels.sort((a, b) => { return compareChannels(a, b); });
        renderChannelList();
        if (availModalOpen) renderAvailModal();
      }
      if (messagesDirty) {
        renderMessages();
        // Update header count
        var ch2 = channels.find(function (c) { return c.hash === selectedHash; });
        var header = document.getElementById('chHeader');
        if (header && ch2) {
          header.querySelector('.ch-header-text').innerHTML = `<span class="ch-header-name">${escapeHtml(ch2.name || 'Channel ' + selectedHash)}</span><span class="ch-header-count">${messages.length} messages</span>`;
        }
        var msgEl = document.getElementById('chMessages');
        if (msgEl && autoScroll) scrollToBottom();
      }
    }

    async function processPrivateWSBatch(msgs, selectedRegions) {
      var privateKeys = getPrivateKeys();
      if (!privateKeys.length) return;

      // Only look at raw GRP_TXT packets (no .channel — server couldn't decrypt)
      var grpPkts = msgs.filter(function (m) {
        if (m.type !== 'packet') return false;
        var payload = m.data?.decoded?.payload;
        return payload && !payload.channel && payload.encryptedData && payload.mac;
      });
      if (!grpPkts.length) return;

      for (var i = 0; i < grpPkts.length; i++) {
        var m = grpPkts[i];
        if (!shouldProcessWSMessageForRegion(m, selectedRegions, observerIataById, observerIataByName)) continue;
        var payload = m.data.decoded.payload;
        var hashHex = payload.channelHashHex;
        if (!hashHex) continue;
        var hashByte = parseInt(hashHex, 16);
        var pk = privateKeys.find(function (k) { return k.hashByte === hashByte; });
        if (!pk) continue;

        var pktHash = m.data?.hash || null;
        var chId = privateChannelId(hashByte);

        // Deduplicate by packet hash
        if (pktHash && messages.some(function (msg) { return msg.packetHash === pktHash && selectedHash === chId; })) continue;

        var macOk = await verifyMac(pk.keyHex, payload.encryptedData, payload.mac);
        if (!macOk) continue;
        var plain = await aesEcbDecrypt(pk.keyHex, payload.encryptedData);
        var parsed = parsePlaintext(plain);
        if (!parsed || !parsed.text) continue;

        var sender = 'Unknown', text = parsed.text;
        var ci = text.indexOf(': ');
        if (ci > 0 && ci < 50) { sender = text.slice(0, ci); text = text.slice(ci + 2); }

        // Update channel sidebar entry
        var ch = channels.find(function (c) { return c.hash === chId; });
        if (ch) {
          ch.messageCount = (ch.messageCount || 0) + 1;
          ch.lastActivityMs = Date.now();
          ch.lastSender = sender;
          ch.lastMessage = truncate(text, 100);
        }
        if (chId !== selectedHash) {
          unreadChannels.add(chId);
        }
        renderChannelList();

        // Append to open message view
        if (selectedHash === chId) {
          messages.push({
            sender: sender,
            text: text,
            timestamp: new Date().toISOString(),
            packetHash: pktHash,
            repeats: 1,
            observers: [],
            hops: 0,
            snr: null,
            _private: true,
          });
          renderMessages();
          var hdr = document.getElementById('chHeader');
          if (hdr && ch) {
            hdr.querySelector('.ch-header-text').innerHTML = `<span class="ch-header-name">🔒 ${escapeHtml(ch.name)}</span><span class="ch-header-count">${messages.length} messages</span>`;
          }
          var msgElP = document.getElementById('chMessages');
          if (msgElP && autoScroll) scrollToBottom();
        }
      }
    }

    function handleWSBatch(msgs) {
      var selectedRegions = getSelectedRegionsSnapshot();
      processWSBatch(msgs, selectedRegions);
      processPrivateWSBatch(msgs, selectedRegions);
    }

    wsHandler = debouncedOnWS(function (msgs) {
      handleWSBatch(msgs);
    });
    window._channelsHandleWSBatchForTest = handleWSBatch;
    window._channelsProcessWSBatchForTest = processWSBatch;

    // Tick relative timestamps every 1s — iterates channels array, updates DOM text only
    timeAgoTimer = setInterval(function () {
      var now = Date.now();
      for (var i = 0; i < channels.length; i++) {
        var ch = channels[i];
        if (!ch.lastActivityMs) continue;
        var el = document.querySelector('.ch-item-time[data-channel-hash="' + ch.hash + '"]');
        if (el) el.textContent = formatSecondsAgo(Math.floor((now - ch.lastActivityMs) / 1000));
      }
    }, 1000);
  }

  var timeAgoTimer = null;

  function destroy() {
    if (wsHandler) offWS(wsHandler);
    wsHandler = null;
    if (timeAgoTimer) clearInterval(timeAgoTimer);
    timeAgoTimer = null;
    if (regionChangeHandler) RegionFilter.offChange(regionChangeHandler);
    regionChangeHandler = null;
    availModalOpen = false;
    channels = [];
    messages = [];
    selectedHash = null;
    selectedNode = null;
    _mobileNavPushed = false;
    if (_popstateHandler) { window.removeEventListener('popstate', _popstateHandler); _popstateHandler = null; }
    hideNodeTooltip();
    const panel = document.getElementById('chNodePanel');
    if (panel) panel.remove();
  }

  async function loadChannels(silent) {
    try {
      const rp = RegionFilter.getRegionParam();
      const qs = rp ? '?region=' + encodeURIComponent(rp) : '';
      const data = await api('/channels' + qs, { ttl: CLIENT_TTL.channels });
      channels = (data.channels || []).map(ch => {
        ch.lastActivityMs = ch.lastActivity ? new Date(ch.lastActivity).getTime() : 0;
        return ch;
      }).sort((a, b) => { return compareChannels(a, b); });
      // Public channel must always be present regardless of server response or region filter
      if (!channels.some(ch => ch.name && ch.name.toLowerCase() === 'public')) {
        channels.unshift({ hash: 'public', name: 'public', lastActivityMs: 0, messageCount: 0 });
      }
      // Merge locally-added channels not already returned by the server
      getUserAddedChannels().forEach(name => {
        if (!channels.some(ch => ch.name === name)) {
          channels.push({ hash: name, name, lastActivityMs: 0, messageCount: 0, userAdded: true });
        } else {
          const ch = channels.find(c => c.name === name);
          if (ch) ch.userAdded = true;
        }
      });
      // Merge private channels (locally stored, key never sent to server)
      getPrivateKeys().forEach(pk => {
        const id = privateChannelId(pk.hashByte);
        if (!channels.some(ch => ch.hash === id)) {
          channels.push({ hash: id, name: pk.name, lastActivityMs: 0, messageCount: 0, userAdded: true, isPrivate: true, hashByte: pk.hashByte });
        } else {
          const ch = channels.find(c => c.hash === id);
          if (ch) { ch.userAdded = true; ch.isPrivate = true; ch.hashByte = pk.hashByte; }
        }
      });
      renderChannelList();
      reconcileSelectionAfterChannelRefresh();
    } catch (e) {
      if (!silent) {
        const el = document.getElementById('chList');
        if (el) el.innerHTML = `<div class="ch-empty">Failed to load channels</div>`;
      }
    }
  }

  function renderChannelList() {
    const el = document.getElementById('chList');
    if (!el) return;

    const now = Date.now();

    // Filter: only public channel + user-added channels (not permanently blocked)
    const visible = [...channels]
      .filter(ch => {
        if (ch.name && PERMANENT_BLOCK_NAMES.has(ch.name.toLowerCase())) return false;
        const isPublic = ch.name && ch.name.toLowerCase() === 'public';
        if (!isPublic && !ch.userAdded) return false;
        return true;
      })
      .sort((a, b) => { return compareChannels(a, b); });

    if (visible.length === 0) {
      el.innerHTML = '<div class="ch-empty">No active channels</div>';
      return;
    }

    el.innerHTML = visible.map(ch => {
      const name = ch.name || `Channel ${formatHashHex(ch.hash)}`;
      const isPublic = name.toLowerCase() === 'public';
      const color = getChannelColor(ch.hash);
      const time = ch.lastActivityMs ? formatSecondsAgo(Math.floor((now - ch.lastActivityMs) / 1000)) : '';
      const preview = ch.lastSender && ch.lastMessage
        ? `${ch.lastSender}: ${truncate(ch.lastMessage, 28)}`
        : ch.messageCount ? `${ch.messageCount} message${ch.messageCount === 1 ? '' : 's'}` : 'No messages yet';
      const sel = selectedHash === ch.hash ? ' selected' : '';
      const displayName = ch.isPrivate ? '🔒 ' + name : name;
      const abbr = name.startsWith('#') ? name.slice(1, 3).toUpperCase() : name.slice(0, 2).toUpperCase();
      const chColor = window.ChannelColors ? window.ChannelColors.get(ch.hash) : null;
      const borderStyle = chColor ? ` style="border-left:3px solid ${chColor}"` : '';

      return `<div class="ch-item${sel}" data-hash="${ch.hash}"${borderStyle} role="option" tabindex="0" aria-selected="${selectedHash === ch.hash ? 'true' : 'false'}" aria-label="${escapeHtml(displayName)}">
        <div class="ch-badge" style="--ch-color:${color};background:${color}" aria-hidden="true"><span class="ch-badge-shine"></span>${escapeHtml(abbr)}</div>
        <span class="ch-pulse-dot" aria-hidden="true"></span>
        <div class="ch-item-body">
          <div class="ch-item-top">
            <span class="ch-item-name">${escapeHtml(displayName)}</span>
            <span class="ch-item-time" data-channel-hash="${ch.hash}">${time}</span>
          </div>
          <div class="ch-item-preview">${escapeHtml(preview)}</div>
        </div>
        ${!isPublic ? `<span class="ch-block-btn" data-hash="${ch.hash}" aria-label="Remove ${escapeHtml(name)}" role="button" tabindex="0">✕</span>` : ''}
      </div>`;
    }).join('');

    // Apply unread pulse to rows with new messages
    el.querySelectorAll('.ch-item').forEach(row => {
      if (unreadChannels.has(row.dataset.hash)) row.classList.add('ch-has-unread');
    });

    // Wire clicks on channel rows and remove buttons
    el.querySelectorAll('.ch-item').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.ch-block-btn') || e.target.closest('.ch-color-dot')) return;
        selectChannel(row.dataset.hash);
      });
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectChannel(row.dataset.hash); }
      });
    });
    el.querySelectorAll('.ch-block-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); removeFromSidebar(btn.dataset.hash); });
      btn.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); removeFromSidebar(btn.dataset.hash); }
      });
    });
  }

  async function selectChannel(hash) {
    const rp = RegionFilter.getRegionParam() || '';
    const request = beginMessageRequest(hash, rp);
    selectedHash = hash;
    unreadChannels.delete(hash);
    // Always update the URL first via replaceState (no hashchange, no router re-render).
    history.replaceState(null, '', `#/channels/${encodeURIComponent(hash)}`);
    // On mobile: push a duplicate entry with the same URL so the back gesture only fires
    // popstate (not hashchange), letting us intercept it and show the channel list instead
    // of triggering the SPA router. Only push once — subsequent channel switches reuse it.
    if (window.matchMedia('(max-width: 640px)').matches && !_mobileNavPushed) {
      _mobileNavPushed = true;
      history.pushState({ _chMobileBack: true }, '', location.href);
    }
    renderChannelList();
    const ch = channels.find(c => c.hash === hash);
    const name = ch?.name || `Channel ${formatHashHex(hash)}`;
    const header = document.getElementById('chHeader');
    header.querySelector('.ch-header-text').innerHTML = `<span class="ch-header-name">${escapeHtml(name)}</span><span class="ch-header-count">${ch?.messageCount || 0} messages</span>`;

    // On mobile, show the message view
    document.querySelector('.ch-layout')?.classList.add('ch-show-main');

    const msgEl = document.getElementById('chMessages');
    msgEl.innerHTML = '<div class="ch-loading">Loading messages…</div>';

    // Private channel: fetch raw GRP_TXT packets and decrypt client-side
    if (ch && ch.isPrivate) {
      await loadPrivateChannelMessages(ch, request, header, msgEl);
      return;
    }

    try {
      const regionQs = rp ? '&region=' + encodeURIComponent(rp) : '';
      const data = await api(`/channels/${encodeURIComponent(hash)}/messages?limit=200${regionQs}`, { ttl: CLIENT_TTL.channelMessages });
      if (isStaleMessageRequest(request)) return;
      messages = data.messages || [];
      if (messages.length === 0 && rp) {
        msgEl.innerHTML = '<div class="ch-empty">Channel not available in selected region</div>';
      } else {
        renderMessages();
        scrollToLatest();
      }
    } catch (e) {
      if (isStaleMessageRequest(request)) return;
      msgEl.innerHTML = `<div class="ch-empty">Failed to load messages: ${e.message}</div>`;
    }
  }

  async function loadPrivateChannelMessages(ch, request, header, msgEl) {
    const pk = getPrivateKeyForHash(ch.hashByte);
    if (!pk) { msgEl.innerHTML = '<div class="ch-empty">Private key not found — try removing and re-adding this channel</div>'; return; }
    try {
      // Fetch newest 200 GRP_TXT packets (DESC), then reverse for chronological display
      const data = await api('/packets?type=5&limit=200', { ttl: 10000 });
      if (isStaleMessageRequest(request)) return;
      const pkts = (data.packets || data.Packets || []).slice().reverse();
      const decrypted = [];
      for (const pkt of pkts) {
        let decoded = pkt.decoded_json;
        if (typeof decoded === 'string') { try { decoded = JSON.parse(decoded); } catch (_) { continue; } }
        if (!decoded) continue;
        // channelHash int is omitted when 0 in old packets — use channelHashHex ("00".."FF") as primary.
        let channelHash;
        if (decoded.channelHashHex !== undefined) {
          channelHash = parseInt(decoded.channelHashHex, 16);
        } else if (decoded.channelHash !== undefined) {
          channelHash = decoded.channelHash;
        } else {
          continue; // no hash info — skip
        }
        if (channelHash !== ch.hashByte) continue;
        const mac = decoded.mac ?? decoded.payload?.mac;
        const encryptedData = decoded.encryptedData ?? decoded.payload?.encryptedData;
        if (!encryptedData || !mac) continue;
        const macOk = await verifyMac(pk.keyHex, encryptedData, mac);
        if (!macOk) continue;
        const plain = await aesEcbDecrypt(pk.keyHex, encryptedData);
        const parsed = parsePlaintext(plain);
        if (!parsed || !parsed.text) continue;
        // Parse "sender: message" format
        let sender = 'Unknown', text = parsed.text;
        const ci = text.indexOf(': ');
        if (ci > 0 && ci < 50) { sender = text.slice(0, ci); text = text.slice(ci + 2); }
        decrypted.push({
          sender,
          text,
          timestamp: pkt.timestamp || new Date(parsed.timestamp * 1000).toISOString(),
          packetHash: pkt.hash || null,
          repeats: 1,
          observers: pkt.observer_name ? [pkt.observer_name] : [],
          hops: 0,
          snr: pkt.snr ?? null,
          _private: true,
        });
      }
      if (isStaleMessageRequest(request)) return;
      messages = decrypted;
      if (ch) { ch.messageCount = decrypted.length; }
      if (header) header.querySelector('.ch-header-text').innerHTML = `<span class="ch-header-name">🔒 ${escapeHtml(ch.name)}</span><span class="ch-header-count">${decrypted.length} messages</span>`;
      renderMessages();
      scrollToLatest();
    } catch (e) {
      if (isStaleMessageRequest(request)) return;
      msgEl.innerHTML = `<div class="ch-empty">Failed to decrypt messages: ${e.message}</div>`;
    }
  }

  async function refreshMessages(opts) {
    if (!selectedHash) return;
    opts = opts || {};
    const msgEl = document.getElementById('chMessages');
    if (!msgEl) return;
    const wasAtBottom = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 60;
    try {
      const requestHash = selectedHash;
      const rp = RegionFilter.getRegionParam() || '';
      const request = beginMessageRequest(requestHash, rp);
      const regionQs = rp ? '&region=' + encodeURIComponent(rp) : '';
      const data = await api(`/channels/${encodeURIComponent(requestHash)}/messages?limit=200${regionQs}`, { ttl: CLIENT_TTL.channelMessages, bust: !!opts.forceNoCache });
      if (isStaleMessageRequest(request)) return;
      const newMsgs = data.messages || [];
      if (opts.regionSwitch && rp && newMsgs.length === 0) {
        messages = [];
        msgEl.innerHTML = '<div class="ch-empty">Channel not available in selected region</div>';
        return;
      }
      // #92: Use message ID/hash for change detection instead of count + timestamp
      var _getLastId = function (arr) { var m = arr.length ? arr[arr.length - 1] : null; return m ? (m.id || m.packetId || m.timestamp || '') : ''; };
      if (newMsgs.length === messages.length && _getLastId(newMsgs) === _getLastId(messages)) return;
      var prevLen = messages.length;
      messages = newMsgs;
      renderMessages();
      if (wasAtBottom) scrollToLatest();
    } catch {}
  }

  function renderMessages() {
    const msgEl = document.getElementById('chMessages');
    if (!msgEl) return;
    if (messages.length === 0) { msgEl.innerHTML = '<div class="ch-empty">No messages in this channel yet</div>'; return; }

    const sorted = msgSortOrder === 'oldest' ? messages.slice() : messages.slice().reverse();
    msgEl.innerHTML = sorted.map(msg => {
      const sender = msg.sender || 'Unknown';
      const senderColor = getSenderColor(sender);
      const senderLetter = sender.replace(/[^\w]/g, '').charAt(0).toUpperCase() || '?';

      let displayText;
      displayText = highlightMentions(msg.text || '');

      const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const date = msg.timestamp ? new Date(msg.timestamp).toLocaleDateString() : '';

      const meta = [];
      meta.push(date + ' ' + time);
      if (msg.repeats > 1) meta.push(`${msg.repeats}× heard`);
      if (msg.observers?.length > 1) meta.push(`${msg.observers.length} observers`);
      if (msg.hops > 0) meta.push(`${msg.hops} hops`);
      if (msg.snr !== null && msg.snr !== undefined) meta.push(`SNR ${msg.snr}`);

      const safeId = btoa(encodeURIComponent(sender));
      return `<div class="ch-msg">
        <div class="ch-avatar ch-tappable" style="--ch-color:${senderColor};background:${senderColor}" tabindex="0" role="button" data-node="${safeId}"><span class="ch-badge-shine"></span>${senderLetter}</div>
        <div class="ch-msg-content">
          <div class="ch-msg-sender ch-sender-link ch-tappable" style="color:${senderColor}" tabindex="0" role="button" data-node="${safeId}">${escapeHtml(sender)}</div>
          <div class="ch-msg-bubble">${displayText}</div>
          <div class="ch-msg-meta">${meta.join(' · ')}${msg.packetHash ? ` · <a href="#/packets/${msg.packetHash}" class="ch-analyze-link">View packet →</a>` : ''}</div>
        </div>
      </div>`;
    }).join('');
  }

  function scrollToBottom() {
    const msgEl = document.getElementById('chMessages');
    if (msgEl) { msgEl.scrollTop = msgEl.scrollHeight; autoScroll = true; }
  }

  function scrollToLatest() {
    const msgEl = document.getElementById('chMessages');
    if (!msgEl) return;
    if (msgSortOrder === 'newest') { msgEl.scrollTop = 0; } else { msgEl.scrollTop = msgEl.scrollHeight; autoScroll = true; }
  }

  window._channelsSetStateForTest = function (state) {
    if (!state) return;
    if (Array.isArray(state.channels)) channels = state.channels;
    if (Array.isArray(state.messages)) messages = state.messages;
    if (Object.prototype.hasOwnProperty.call(state, 'selectedHash')) selectedHash = state.selectedHash;
  };
  window._channelsSetObserverRegionsForTest = function (byId, byName) {
    observerIataById = byId || {};
    observerIataByName = byName || {};
  };
  window._channelsSelectChannelForTest = selectChannel;
  window._channelsRefreshMessagesForTest = refreshMessages;
  window._channelsLoadChannelsForTest = loadChannels;
  window._channelsBeginMessageRequestForTest = beginMessageRequest;
  window._channelsIsStaleMessageRequestForTest = isStaleMessageRequest;
  window._channelsReconcileSelectionForTest = reconcileSelectionAfterChannelRefresh;
  window._channelsGetStateForTest = function () {
    return { channels: channels, messages: messages, selectedHash: selectedHash };
  };
  window._channelsShouldProcessWSMessageForRegion = shouldProcessWSMessageForRegion;
  registerPage('channels', { init, destroy });
})();
