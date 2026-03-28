'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Config file loading
const CONFIG_PATHS = [
  path.join(__dirname, 'config.json'),
  path.join(__dirname, 'data', 'config.json')
];

function loadConfigFile(configPaths) {
  const paths = process.env.CONFIG_PATH
    ? [process.env.CONFIG_PATH]
    : (configPaths || CONFIG_PATHS);
  for (const p of paths) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return {};
}

// Theme file loading
const THEME_PATHS = [
  path.join(__dirname, 'theme.json'),
  path.join(__dirname, 'data', 'theme.json')
];

function loadThemeFile(themePaths) {
  const paths = themePaths || THEME_PATHS;
  for (const p of paths) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return {};
}

// Health thresholds
function buildHealthConfig(config) {
  const _ht = (config && config.healthThresholds) || {};
  return {
    infraDegradedMs: _ht.infraDegradedMs || 172800000,
    infraSilentMs:   _ht.infraSilentMs   || 259200000,
    nodeDegradedMs:  _ht.nodeDegradedMs  || 86400000,
    nodeSilentMs:    _ht.nodeSilentMs    || 172800000
  };
}

function getHealthMs(role, HEALTH) {
  const isInfra = role === 'repeater' || role === 'room';
  return {
    degradedMs: isInfra ? HEALTH.infraDegradedMs : HEALTH.nodeDegradedMs,
    silentMs:   isInfra ? HEALTH.infraSilentMs   : HEALTH.nodeSilentMs
  };
}

// Hash size flip-flop detection (pure — operates on provided maps)
function isHashSizeFlipFlop(seq, allSizes) {
  if (!seq || seq.length < 3) return false;
  if (!allSizes || allSizes.size < 2) return false;
  let transitions = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] !== seq[i - 1]) transitions++;
  }
  return transitions >= 2;
}

// Compute content hash from raw hex
function computeContentHash(rawHex) {
  try {
    const buf = Buffer.from(rawHex, 'hex');
    if (buf.length < 2) return rawHex.slice(0, 16);
    const pathByte = buf[1];
    const hashSize = ((pathByte >> 6) & 0x3) + 1;
    const hashCount = pathByte & 0x3F;
    const pathBytes = hashSize * hashCount;
    const payloadStart = 2 + pathBytes;
    const payload = buf.subarray(payloadStart);
    const toHash = Buffer.concat([Buffer.from([buf[0]]), payload]);
    return crypto.createHash('sha256').update(toHash).digest('hex').slice(0, 16);
  } catch { return rawHex.slice(0, 16); }
}

// Distance helper (degrees)
function geoDist(lat1, lon1, lat2, lon2) {
  return Math.sqrt((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2);
}

// Point-in-polygon: ray-casting algorithm
// coords: array of [lat, lon] pairs
function isPointInPolygon(lat, lon, coords) {
  if (!coords || coords.length < 3) return false;
  let inside = false;
  const n = coords.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = coords[i][0], xi = coords[i][1];
    const yj = coords[j][0], xj = coords[j][1];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Derive hashtag channel key
function deriveHashtagChannelKey(channelName) {
  return crypto.createHash('sha256').update(channelName).digest('hex').slice(0, 32);
}

// Build hex breakdown ranges for packet detail view
function buildBreakdown(rawHex, decoded, decodePacketFn, channelKeys) {
  if (!rawHex) return {};
  const buf = Buffer.from(rawHex, 'hex');
  const ranges = [];

  ranges.push({ start: 0, end: 0, color: 'red', label: 'Header' });
  if (buf.length < 2) return { ranges };

  ranges.push({ start: 1, end: 1, color: 'orange', label: 'Path Length' });

  const header = decodePacketFn ? decodePacketFn(rawHex, channelKeys || {}) : null;
  let offset = 2;

  if (header && header.transportCodes) {
    ranges.push({ start: 2, end: 5, color: 'blue', label: 'Transport Codes' });
    offset = 6;
  }

  const pathByte = buf[1];
  const hashSize = (pathByte >> 6) + 1;
  const hashCount = pathByte & 0x3F;
  const pathBytes = hashSize * hashCount;
  if (pathBytes > 0) {
    ranges.push({ start: offset, end: offset + pathBytes - 1, color: 'green', label: 'Path' });
  }
  const payloadStart = offset + pathBytes;

  if (payloadStart < buf.length) {
    ranges.push({ start: payloadStart, end: buf.length - 1, color: 'yellow', label: 'Payload' });

    if (decoded && decoded.type === 'ADVERT') {
      const ps = payloadStart;
      const subRanges = [];
      subRanges.push({ start: ps, end: ps + 31, color: '#FFD700', label: 'PubKey' });
      subRanges.push({ start: ps + 32, end: ps + 35, color: '#FFA500', label: 'Timestamp' });
      subRanges.push({ start: ps + 36, end: ps + 99, color: '#FF6347', label: 'Signature' });
      if (buf.length > ps + 100) {
        subRanges.push({ start: ps + 100, end: ps + 100, color: '#7FFFD4', label: 'Flags' });
        let off = ps + 101;
        const flags = buf[ps + 100];
        if (flags & 0x10 && buf.length >= off + 8) {
          subRanges.push({ start: off, end: off + 3, color: '#87CEEB', label: 'Latitude' });
          subRanges.push({ start: off + 4, end: off + 7, color: '#87CEEB', label: 'Longitude' });
          off += 8;
        }
        if (flags & 0x80 && off < buf.length) {
          subRanges.push({ start: off, end: buf.length - 1, color: '#DDA0DD', label: 'Name' });
        }
      }
      ranges.push(...subRanges);
    }
  }

  return { ranges };
}

// Disambiguate hop prefixes to full nodes
function disambiguateHops(hops, allNodes, maxHopDist) {
  const MAX_HOP_DIST = maxHopDist || 1.8;

  if (!allNodes._prefixIdx) {
    allNodes._prefixIdx = {};
    allNodes._prefixIdxName = {};
    for (const n of allNodes) {
      if (n.role === 'companion') continue; // companions are not routing infrastructure
      const pk = n.public_key.toLowerCase();
      for (let len = 1; len <= 3; len++) {
        const p = pk.slice(0, len * 2);
        if (!allNodes._prefixIdx[p]) allNodes._prefixIdx[p] = [];
        allNodes._prefixIdx[p].push(n);
        if (!allNodes._prefixIdxName[p]) allNodes._prefixIdxName[p] = n;
      }
    }
  }

  const resolved = hops.map(hop => {
    const h = hop.toLowerCase();
    const withCoords = (allNodes._prefixIdx[h] || []).filter(n => n.lat && n.lon && !(n.lat === 0 && n.lon === 0));
    if (withCoords.length === 1) {
      return { hop, name: withCoords[0].name, lat: withCoords[0].lat, lon: withCoords[0].lon, pubkey: withCoords[0].public_key, known: true };
    } else if (withCoords.length > 1) {
      return { hop, name: hop, lat: null, lon: null, pubkey: null, known: false, candidates: withCoords };
    }
    const nameMatch = allNodes._prefixIdxName[h];
    return { hop, name: nameMatch?.name || hop, lat: null, lon: null, pubkey: nameMatch?.public_key || null, known: false };
  });

  let lastPos = null;
  for (const r of resolved) {
    if (r.known && r.lat) { lastPos = [r.lat, r.lon]; continue; }
    if (!r.candidates) continue;
    if (lastPos) r.candidates.sort((a, b) => geoDist(a.lat, a.lon, lastPos[0], lastPos[1]) - geoDist(b.lat, b.lon, lastPos[0], lastPos[1]));
    const best = r.candidates[0];
    r.name = best.name; r.lat = best.lat; r.lon = best.lon; r.pubkey = best.public_key; r.known = true;
    lastPos = [r.lat, r.lon];
  }

  let nextPos = null;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const r = resolved[i];
    if (r.known && r.lat) { nextPos = [r.lat, r.lon]; continue; }
    if (!r.candidates || !nextPos) continue;
    r.candidates.sort((a, b) => geoDist(a.lat, a.lon, nextPos[0], nextPos[1]) - geoDist(b.lat, b.lon, nextPos[0], nextPos[1]));
    const best = r.candidates[0];
    r.name = best.name; r.lat = best.lat; r.lon = best.lon; r.pubkey = best.public_key; r.known = true;
    nextPos = [r.lat, r.lon];
  }

  // Distance sanity check
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    if (!r.lat) continue;
    const prev = i > 0 && resolved[i-1].lat ? resolved[i-1] : null;
    const next = i < resolved.length-1 && resolved[i+1].lat ? resolved[i+1] : null;
    if (!prev && !next) continue;
    const dPrev = prev ? geoDist(r.lat, r.lon, prev.lat, prev.lon) : 0;
    const dNext = next ? geoDist(r.lat, r.lon, next.lat, next.lon) : 0;
    if ((prev && dPrev > MAX_HOP_DIST) || (next && dNext > MAX_HOP_DIST)) {
      r.unreliable = true;
    }
  }

  return resolved;
}

// Update hash_size maps for a single packet
function updateHashSizeForPacket(p, hashSizeMap, hashSizeAllMap, hashSizeSeqMap) {
  if (p.payload_type === 4 && p.raw_hex) {
    try {
      const d = typeof p.decoded_json === 'string' ? JSON.parse(p.decoded_json || '{}') : (p.decoded_json || {});
      const pk = d.pubKey || d.public_key;
      if (pk) {
        const pathByte = parseInt(p.raw_hex.slice(2, 4), 16);
        const hs = ((pathByte >> 6) & 0x3) + 1;
        hashSizeMap.set(pk, hs);
        if (!hashSizeAllMap.has(pk)) hashSizeAllMap.set(pk, new Set());
        hashSizeAllMap.get(pk).add(hs);
        if (!hashSizeSeqMap.has(pk)) hashSizeSeqMap.set(pk, []);
        hashSizeSeqMap.get(pk).push(hs);
      }
    } catch {}
  } else if (p.path_json && p.decoded_json) {
    try {
      const d = typeof p.decoded_json === 'string' ? JSON.parse(p.decoded_json) : p.decoded_json;
      const pk = d.pubKey || d.public_key;
      if (pk && !hashSizeMap.has(pk)) {
        const hops = typeof p.path_json === 'string' ? JSON.parse(p.path_json) : p.path_json;
        if (hops.length > 0) {
          const pathByte = p.raw_hex ? parseInt(p.raw_hex.slice(2, 4), 16) : -1;
          const hs = pathByte >= 0 ? ((pathByte >> 6) & 0x3) + 1 : (hops[0].length / 2);
          if (hs >= 1 && hs <= 4) hashSizeMap.set(pk, hs);
        }
      }
    } catch {}
  }
}

// Rebuild all hash size maps from packet store
function rebuildHashSizeMap(packets, hashSizeMap, hashSizeAllMap, hashSizeSeqMap) {
  hashSizeMap.clear();
  hashSizeAllMap.clear();
  hashSizeSeqMap.clear();

  // Pass 1: ADVERT packets
  for (const p of packets) {
    if (p.payload_type === 4 && p.raw_hex) {
      try {
        const d = JSON.parse(p.decoded_json || '{}');
        const pk = d.pubKey || d.public_key;
        if (pk) {
          const pathByte = parseInt(p.raw_hex.slice(2, 4), 16);
          const hs = ((pathByte >> 6) & 0x3) + 1;
          if (!hashSizeMap.has(pk)) hashSizeMap.set(pk, hs);
          if (!hashSizeAllMap.has(pk)) hashSizeAllMap.set(pk, new Set());
          hashSizeAllMap.get(pk).add(hs);
          if (!hashSizeSeqMap.has(pk)) hashSizeSeqMap.set(pk, []);
          hashSizeSeqMap.get(pk).push(hs);
        }
      } catch {}
    }
  }
  for (const [, seq] of hashSizeSeqMap) seq.reverse();

  // Pass 2: fallback from path hops
  for (const p of packets) {
    if (p.path_json) {
      try {
        const hops = JSON.parse(p.path_json);
        if (hops.length > 0) {
          const hopLen = hops[0].length / 2;
          if (hopLen >= 1 && hopLen <= 4) {
            const pathByte = p.raw_hex ? parseInt(p.raw_hex.slice(2, 4), 16) : -1;
            const hs = pathByte >= 0 ? ((pathByte >> 6) & 0x3) + 1 : hopLen;
            if (p.decoded_json) {
              const d = JSON.parse(p.decoded_json);
              const pk = d.pubKey || d.public_key;
              if (pk && !hashSizeMap.has(pk)) hashSizeMap.set(pk, hs);
            }
          }
        }
      } catch {}
    }
  }
}

// Deterministic location anonymization — consistent per-node, ~200m radius
// Uses the public key as a seed so the same node always gets the same offset.
function _locHash(pk, salt) {
  let h = (salt >>> 0) ^ 0x12345678;
  for (let i = 0; i < Math.min(pk.length, 32); i++) {
    h = Math.imul(h ^ pk.charCodeAt(i), 0x9e3779b9) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xFFFFFFFF; // [0, 1]
}

function anonymizeNodeLocation(node) {
  if (!node) return node;
  const lat = node.lat, lon = node.lon;
  if (!lat || !lon || (lat === 0 && lon === 0)) return node;
  const pk = (node.public_key || '').toLowerCase();
  if (!pk) return node;

  // ~100 m in degrees: 0.0009° lat, lon scaled by cos(lat) for accuracy
  const MAX_M = 100;
  const DEG_PER_M_LAT = 1 / 111320;
  const DEG_PER_M_LON = 1 / (111320 * Math.cos(lat * Math.PI / 180));

  // Map [0,1] floats to [-1, 1]
  const latFrac = _locHash(pk, 0xA1B2C3D4) * 2 - 1;
  const lonFrac = _locHash(pk, 0xDEADBEEF) * 2 - 1;

  // Clamp to circle: scale down if outside unit circle
  const mag = Math.sqrt(latFrac * latFrac + lonFrac * lonFrac);
  const scale = mag > 1 ? 1 / mag : 1;

  return {
    ...node,
    lat: lat + latFrac * scale * MAX_M * DEG_PER_M_LAT,
    lon: lon + lonFrac * scale * MAX_M * DEG_PER_M_LON
  };
}

// API key middleware factory
function requireApiKey(apiKey) {
  return function(req, res, next) {
    if (!apiKey) return next();
    const provided = req.headers['x-api-key'] || req.query.apiKey;
    if (provided === apiKey) return next();
    return res.status(401).json({ error: 'Invalid or missing API key' });
  };
}

module.exports = {
  loadConfigFile,
  loadThemeFile,
  buildHealthConfig,
  getHealthMs,
  isHashSizeFlipFlop,
  computeContentHash,
  geoDist,
  isPointInPolygon,
  deriveHashtagChannelKey,
  buildBreakdown,
  disambiguateHops,
  updateHashSizeForPacket,
  rebuildHashSizeMap,
  requireApiKey,
  anonymizeNodeLocation,
  CONFIG_PATHS,
  THEME_PATHS
};
