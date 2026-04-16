/**
 * Route Map — visualises all tracked flight routes as great-circle arcs
 * on a full-screen Leaflet map.
 *
 * Libraries used:
 *  - Leaflet.js  (already loaded in index.html)
 *  - CartoDB Dark Matter tiles  (free, no key)
 *  - NOAA AviationWeather METAR  (free, no key) via weatherBadge() in app.js
 */

let _map       = null;   // Leaflet map instance
let _layers    = [];     // all layers we've added (cleared on re-render)
let _animFrame = null;   // requestAnimationFrame handle for plane animations

/* ── Great-circle arc ───────────────────────────────────────────────────── */

function greatCirclePoints(lat1, lon1, lat2, lon2, n = 80) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);
  const d  = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2
  ));
  if (d < 0.0001) return [[lat1, lon1], [lat2, lon2]];

  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d)       / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1)                 + B * Math.sin(φ2);
    pts.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
  }
  return pts;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function addLayer(layer) { layer.addTo(_map); _layers.push(layer); return layer; }

function clearLayers() {
  cancelAnimationFrame(_animFrame);
  _layers.forEach(l => _map.removeLayer(l));
  _layers = [];
}

function planeIcon(heading, color = '#f59e0b', size = 18) {
  return L.divIcon({
    html: `<div class="rm-plane" style="font-size:${size}px;transform:rotate(${heading}deg);color:${color}">✈</div>`,
    className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  });
}

function popupHtml(f) {
  const orig = f.origin?.iata  || f.origin || '???';
  const dest = f.destination?.iata || f.destination || '???';
  const st   = (f.status || 'scheduled').toLowerCase();
  const stColor = { active: '#f59e0b', landed: '#8899b4', cancelled: '#f43f5e', scheduled: '#22d3ee' };
  return `
<div class="rm-popup">
  <div class="rm-popup-fn">${f.flight_number || '—'}</div>
  <div class="rm-popup-route">${orig} → ${dest}</div>
  <div class="rm-popup-airline">${f.airline || ''}</div>
  <div class="rm-popup-status" style="color:${stColor[st] || '#22d3ee'}">${st}</div>
  ${f.delay_arrival > 0 ? `<div class="rm-popup-delay">+${f.delay_arrival}min delay</div>` : ''}
</div>`;
}

/* ── Arc drawing ────────────────────────────────────────────────────────── */

function drawArc(pts, opts) {
  const { color, weight, opacity, dashArray, className } = opts;
  return addLayer(L.polyline(pts, {
    color, weight, opacity,
    dashArray: dashArray || null,
    smoothFactor: 1,
    className: className || '',
  }));
}

function drawRoute(f, depCoords, arrCoords) {
  const pts    = greatCirclePoints(...depCoords, ...arrCoords);
  const st     = (f.status || 'scheduled').toLowerCase();
  const isActive   = st === 'active' || (f.live && f.live.on_ground === false);
  const isLanded   = st === 'landed' || st === 'cancelled';
  const isCancelled = st === 'cancelled';

  let color, opacity;
  if (isCancelled)   { color = '#f43f5e'; opacity = 0.25; }
  else if (isLanded) { color = '#4a5c78'; opacity = 0.35; }
  else if (isActive) { color = '#f59e0b'; opacity = 0.90; }
  else               { color = '#22d3ee'; opacity = 0.65; }

  const popup = popupHtml(f);

  // Glow (wide, faint)
  drawArc(pts, { color, weight: 6,   opacity: opacity * 0.2 }).bindPopup(popup);
  // Core line
  drawArc(pts, { color, weight: 1.5, opacity,
    dashArray: isActive ? null : '6 4',
    className: isActive ? 'rm-arc-active' : '',
  }).bindPopup(popup);

  // Live plane marker for airborne flights
  if (isActive && f.live?.latitude) {
    addLayer(L.marker([f.live.latitude, f.live.longitude], {
      icon: planeIcon(f.live.heading || 0, '#f59e0b', 18),
      zIndexOffset: 1000,
    }).bindPopup(popup));
  }

  return { pts, isActive };
}

/* ── Airport markers ────────────────────────────────────────────────────── */

function drawAirport(iata, coords, routeCount) {
  const r = Math.min(9, 3 + routeCount * 1.5);
  addLayer(L.circleMarker(coords, {
    radius:      r,
    color:       '#22d3ee',
    fillColor:   '#22d3ee',
    fillOpacity: 0.85,
    weight:      1.5,
    className:   'rm-airport-dot',
  }));
  // Label
  addLayer(L.marker(coords, {
    icon: L.divIcon({
      html: `<span class="rm-airport-label">${iata}</span>`,
      className: '',
      iconAnchor: [-6, 8],
    }),
    interactive: false,
  }));
}

/* ── Stats overlay ──────────────────────────────────────────────────────── */

function updateStats(flights) {
  const total   = flights.length;
  const active  = flights.filter(f => (f.status || '').toLowerCase() === 'active' || (f.live && f.live.on_ground === false)).length;
  const landed  = flights.filter(f => (f.status || '').toLowerCase() === 'landed').length;
  const sched   = total - active - landed;
  const el = document.getElementById('rm-stats');
  if (!el) return;
  el.innerHTML = `
    <div class="rm-stat"><span class="rm-stat-val">${total}</span><span class="rm-stat-lbl">Routes</span></div>
    <div class="rm-stat"><span class="rm-stat-val" style="color:#f59e0b">${active}</span><span class="rm-stat-lbl">Airborne</span></div>
    <div class="rm-stat"><span class="rm-stat-val" style="color:#22d3ee">${sched}</span><span class="rm-stat-lbl">Scheduled</span></div>
    <div class="rm-stat"><span class="rm-stat-val" style="color:#4a5c78">${landed}</span><span class="rm-stat-lbl">Landed</span></div>`;
}

/* ── Main render ────────────────────────────────────────────────────────── */

function renderRouteMap() {
  if (!_map) return;
  clearLayers();

  // Merge active + tracked (show even if no status yet), excluding archived flights
  const activeIds  = new Set(STATE.flights.map(f => f.id));
  const historyIds = new Set(STATE.history.map(f => f.id));
  const allFlights = [
    ...STATE.flights,
    ...STATE.tracked
      .filter(t => !activeIds.has(t.id) && !historyIds.has(t.id))
      .map(t => ({
        ...t,
        origin:      { iata: t.origin || '' },
        destination: { iata: t.destination || '' },
        status: 'scheduled',
        live: null,
      })),
  ];

  updateStats(allFlights);

  const airports = new Map(); // iata → { coords, count }

  for (const f of allFlights) {
    const depIata = f.origin?.iata  || f.origin  || '';
    const arrIata = f.destination?.iata || f.destination || '';
    const dep = getAirportCoords(depIata);
    const arr = getAirportCoords(arrIata);
    if (!dep || !arr) continue;

    drawRoute(f, dep, arr);

    for (const [iata, coords] of [[depIata, dep], [arrIata, arr]]) {
      if (!airports.has(iata)) airports.set(iata, { coords, count: 0 });
      airports.get(iata).count++;
    }
  }

  // Draw airport markers on top
  for (const [iata, info] of airports) {
    drawAirport(iata, info.coords, info.count);
  }

  // Fit map to routes if any
  if (airports.size > 0) {
    const coordsList = [...airports.values()].map(a => a.coords);
    _map.fitBounds(L.latLngBounds(coordsList), { padding: [40, 40], maxZoom: 6 });
  }
}

/* ── Init ───────────────────────────────────────────────────────────────── */

function initRouteMap() {
  const container = document.getElementById('route-map');
  if (!container) return;

  if (_map) {
    _map.invalidateSize();
    renderRouteMap();
    return;
  }

  _map = L.map('route-map', {
    zoomControl:       true,
    attributionControl: true,
    minZoom: 2,
    maxZoom: 10,
    worldCopyJump: true,
  }).setView([25, 115], 3);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://carto.com">CartoDB</a> © <a href="https://openstreetmap.org">OSM</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(_map);

  renderRouteMap();
}

// Expose for app.js tab switch
window.initRouteMap   = initRouteMap;
window.renderRouteMap = renderRouteMap;
