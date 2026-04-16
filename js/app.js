/* ===== State ===== */
const STATE = {
  flights: [],   // active flights (from data/status.json)
  history: [],   // past flights  (from data/history.json)
  tracked: [],   // flight list   (from flights.json)
  settings: {},
  charts: {},
  maps: {},
  weather: {},   // icao → metar data (30-min in-memory cache)
  weatherTs: {}, // icao → fetch timestamp
  refreshTimer: null,
};

/* ===== Settings helpers ===== */
function loadSettings() {
  try { STATE.settings = JSON.parse(localStorage.getItem('flighty_settings') || '{}'); }
  catch { STATE.settings = {}; }
  const s = STATE.settings;
  el('github-token').value = s.githubToken || '';
  el('github-repo').value = s.githubRepo || 'MDJimmyFu/flighty-private';
  el('github-branch').value = s.githubBranch || 'main';
  el('ntfy-topic').value = s.ntfyTopic || '';
  el('aerodatabox-key').value = s.aeroDataBoxKey || '';
  el('aviationstack-key').value = s.aviationstackKey || '';
  updateNtfyUrl();
}
function saveSettings(updates) {
  Object.assign(STATE.settings, updates);
  localStorage.setItem('flighty_settings', JSON.stringify(STATE.settings));
}
function getSetting(k) { return STATE.settings[k] || ''; }

/* ===== DOM helpers ===== */
function el(id) { return document.getElementById(id); }
function show(id) { el(id).classList.remove('hidden'); }
function hide(id) { el(id).classList.add('hidden'); }
function toast(msg, duration = 3000) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.classList.add('hidden'), 300);
  }, duration);
}

/* ===== Tab routing ===== */
function switchTab(name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  el(`tab-${name}`).classList.add('active');
  document.querySelector(`[data-tab="${name}"]`)?.classList.add('active');
  el('nav-tabs').classList.remove('open');
  if (name === 'stats')    renderStats();
  if (name === 'history')  renderHistory();
  if (name === 'map')      setTimeout(initRouteMap, 50); // after tab is visible
}

/* ===== GitHub API ===== */
function ghHeaders() {
  const token = getSetting('githubToken');
  const h = { 'Content-Type': 'application/json', Accept: 'application/vnd.github.v3+json' };
  if (token) h.Authorization = `token ${token}`;
  return h;
}
function ghRepo() { return getSetting('githubRepo') || 'MDJimmyFu/flighty-private'; }
function ghBranch() { return getSetting('githubBranch') || 'main'; }

async function ghGetFile(path) {
  // t= busts GitHub's CDN cache so we always get the current SHA
  const url = `https://api.github.com/repos/${ghRepo()}/contents/${path}?ref=${ghBranch()}&t=${Date.now()}`;
  const r = await fetch(url, { headers: { ...ghHeaders(), 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${path}`);
  return r.json();
}
/**
 * Read-modify-write a JSON file on GitHub with automatic SHA-conflict retry.
 * updateFn receives the current parsed content and returns the new content.
 */
async function ghUpdateFile(path, updateFn, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let sha = null, current = null;
    try {
      const f = await ghGetFile(path);
      sha     = f.sha;
      current = JSON.parse(decodeURIComponent(escape(atob(f.content.replace(/\n/g, '')))));
    } catch {
      current = null; // file doesn't exist yet
    }
    const updated = updateFn(current);
    try {
      return await ghPutFile(path, updated, sha, message);
    } catch (e) {
      if (attempt === 0 && e.message.includes('does not match')) continue; // retry
      throw e;
    }
  }
}

async function ghPutFile(path, content, sha, message) {
  const url = `https://api.github.com/repos/${ghRepo()}/contents/${path}`;
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))),
    branch: ghBranch(),
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!r.ok) {
    const e = await r.json();
    const msg = e.message || String(r.status);
    if (msg.includes('Resource not accessible') || msg.includes('not accessible by personal access token')) {
      throw new Error(
        'Token permission denied. Use a Classic PAT (not fine-grained) with the "repo" scope. ' +
        'Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic).'
      );
    }
    throw new Error(msg);
  }
  return r.json();
}

/* Read raw file (works for public repos without token too) */
async function fetchRaw(path) {
  const repo = ghRepo();
  const branch = ghBranch();
  // Try GitHub API first (supports private repos with token)
  try {
    const f = await ghGetFile(path);
    const decoded = decodeURIComponent(escape(atob(f.content.replace(/\n/g, ''))));
    return { data: JSON.parse(decoded), sha: f.sha };
  } catch {
    // Fallback: raw.githubusercontent.com (public repos only)
    const raw = `https://raw.githubusercontent.com/${repo}/${branch}/${path}?t=${Date.now()}`;
    const r = await fetch(raw);
    if (!r.ok) throw new Error(`Failed to fetch ${path}`);
    return { data: await r.json(), sha: null };
  }
}

/* ===== AviationWeather (NOAA) — free, no API key ===== */

const WEATHER_CACHE_MS = 30 * 60 * 1000; // 30 minutes

const SKY_ICON = { CLR: '☀️', SKC: '☀️', CAVOK: '☀️', FEW: '🌤', SCT: '⛅', BKN: '🌥', OVC: '☁️' };
const FLTCAT_COLOR = { VFR: '#22d3a0', MVFR: '#4f9cf9', IFR: '#f43f5e', LIFR: '#a78bfa' };

function windDir(deg) {
  if (deg === null || deg === undefined) return '—';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function fmtMetar(m) {
  if (!m) return null;
  const icon  = SKY_ICON[m.cover] || '🌡';
  const temp  = m.temp != null ? `${m.temp}°C` : '';
  const wind  = m.wspd != null ? `${windDir(m.wdir)} ${m.wspd}kt` : '';
  const vis   = m.visib ? (m.visib === '6+' || parseFloat(m.visib) >= 6 ? '' : `vis ${m.visib}SM`) : '';
  const cat   = m.fltCat || '';
  return { icon, temp, wind, vis, cat, color: FLTCAT_COLOR[cat] || '#8899b4' };
}

async function fetchWeather(icaoCodes) {
  // Remove codes already cached and fresh
  const now = Date.now();
  const toFetch = icaoCodes.filter(c => c && (!STATE.weatherTs[c] || now - STATE.weatherTs[c] > WEATHER_CACHE_MS));
  if (toFetch.length === 0) return;

  try {
    const ids = toFetch.join(',');
    const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${ids}&format=json`);
    if (!r.ok) return;
    const data = await r.json();
    for (const m of data) {
      STATE.weather[m.icaoId]   = m;
      STATE.weatherTs[m.icaoId] = now;
    }
  } catch { /* weather is non-critical */ }
}

function weatherBadge(iata) {
  const icao = iataToIcaoAirport(iata);
  if (!icao) return '';
  const m = STATE.weather[icao];
  if (!m) return `<span class="wx-loading" data-icao="${icao}">…</span>`;
  const w = fmtMetar(m);
  return `
<div class="wx-badge">
  <span class="wx-icon">${w.icon}</span>
  <span class="wx-temp">${w.temp}</span>
  <span class="wx-wind">${w.wind}</span>
  ${w.vis ? `<span class="wx-vis">${w.vis}</span>` : ''}
  ${w.cat ? `<span class="wx-cat" style="color:${w.color}">${w.cat}</span>` : ''}
</div>`;
}

async function loadWeatherForFlights(flights) {
  const icaos = [];
  for (const f of flights) {
    const depIata = f.origin?.iata || f.origin;
    const arrIata = f.destination?.iata || f.destination;
    const depIcao = iataToIcaoAirport(depIata);
    const arrIcao = iataToIcaoAirport(arrIata);
    if (depIcao) icaos.push(depIcao);
    if (arrIcao) icaos.push(arrIcao);
  }
  if (icaos.length === 0) return;
  await fetchWeather([...new Set(icaos)]);
}

/* ===== Local cache helpers ===== */
const CACHE_KEYS = {
  tracked: 'flighty_cache_tracked',
  flights: 'flighty_cache_flights',
  history: 'flighty_cache_history',
};
function saveCache(key, data) {
  try { localStorage.setItem(CACHE_KEYS[key], JSON.stringify(data)); } catch {}
}
function loadCache(key) {
  try { return JSON.parse(localStorage.getItem(CACHE_KEYS[key])) || null; } catch { return null; }
}

/* ===== Load flight data ===== */
async function loadData() {
  const btn = el('btn-refresh');
  btn.classList.add('spinning');

  // Restore from cache immediately so the UI isn't blank on refresh
  const cachedTracked = loadCache('tracked');
  const cachedFlights = loadCache('flights');
  const cachedHistory = loadCache('history');
  if (cachedTracked) STATE.tracked = cachedTracked;
  if (cachedFlights) STATE.flights = cachedFlights;
  if (cachedHistory) STATE.history = cachedHistory;
  if (cachedTracked || cachedFlights) renderDashboard();

  try {
    const [statusResult, historyResult, trackedResult] = await Promise.allSettled([
      fetchRaw('data/status.json'),
      fetchRaw('data/history.json'),
      fetchRaw('flights.json'),
    ]);

    if (statusResult.status === 'fulfilled') {
      STATE.flights = statusResult.value.data.flights || [];
      saveCache('flights', STATE.flights);
      const upd = statusResult.value.data.updated_at;
      if (upd) el('last-updated').textContent = 'Updated ' + timeAgo(upd);
    }
    // Show fetch phase from meta
    try {
      const metaResult = await fetchRaw('data/meta.json');
      const meta = metaResult.data;
      const phaseLabel = {
        'every-5min': '⚡ Live (every 5min)',
        'hourly':     '🕐 Hourly',
        'daily':      '📅 Daily',
        'weekly':     '📆 Weekly',
        'monthly':    '🗓 Monthly',
        'no-flights': '💤 Standby',
      };
      const label = phaseLabel[meta.phase] || meta.phase;
      el('last-updated').textContent = (el('last-updated').textContent || '') + `  ${label}`;
    } catch { /* meta not yet available */ }

    if (historyResult.status === 'fulfilled') {
      STATE.history = historyResult.value.data.flights || [];
      saveCache('history', STATE.history);
    }
    if (trackedResult.status === 'fulfilled') {
      STATE.tracked = trackedResult.value.data.tracked || [];
      saveCache('tracked', STATE.tracked);
    }

    renderDashboard();
  } catch (e) {
    toast('⚠️ Failed to load data: ' + e.message);
  } finally {
    btn.classList.remove('spinning');
  }
}

/* ===== Time helpers ===== */
function timeAgo(isoStr) {
  const d = new Date(isoStr);
  const sec = Math.floor((Date.now() - d) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return d.toLocaleDateString();
}
function fmtTime(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}
function fmtDate(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return isoStr; }
}

/* ===== Status helpers ===== */
function statusBadge(flight) {
  const s = (flight.status || '').toLowerCase();
  const delay = (flight.delay_arrival || 0);
  if (s === 'cancelled') return `<span class="badge badge-red">Cancelled</span>`;
  if (s === 'landed')    return `<span class="badge badge-gray">Landed</span>`;
  if (s === 'active' || flight.live?.on_ground === false)
    return `<span class="live-dot">LIVE</span>`;
  if (delay > 60) return `<span class="badge badge-red">+${delay}min</span>`;
  if (delay > 15) return `<span class="badge badge-yellow">+${delay}min</span>`;
  if (delay > 0)  return `<span class="badge badge-yellow">+${delay}min</span>`;
  return `<span class="badge badge-blue">Scheduled</span>`;
}
function statusClass(flight) {
  const s = (flight.status || '').toLowerCase();
  if (s === 'cancelled') return 'status-cancelled';
  if (s === 'landed')    return 'status-landed';
  if (s === 'active' || flight.live?.on_ground === false) return 'status-active';
  if ((flight.delay_arrival || 0) > 0) return 'status-delayed';
  return 'status-scheduled';
}
function delayLabel(min) {
  if (!min || min === 0) return `<span class="time-delay delay-none">On time</span>`;
  if (min < 0) return `<span class="time-delay delay-none">${Math.abs(min)}min early</span>`;
  return `<span class="time-delay delay-positive">+${min}min</span>`;
}

/* ===== Dashboard rendering ===== */
function renderDashboard() {
  const container = el('flights-container');
  const allFlights = [...STATE.flights];

  // Merge tracked flights that have no status yet
  const statusIds = new Set(allFlights.map(f => f.id));
  for (const t of STATE.tracked) {
    if (!statusIds.has(t.id)) {
      allFlights.push({
        id: t.id,
        flight_number: t.flight_number,
        date: t.date,
        origin: { iata: t.origin || '', name: '' },
        destination: { iata: t.destination || '', name: '' },
        airline: t.airline || '',
        aircraft_type: t.aircraft_type || '',
        scheduled_departure: t.scheduled_departure || '',
        scheduled_arrival: t.scheduled_arrival || '',
        status: 'scheduled',
        delay_departure: 0, delay_arrival: 0, live: null,
      });
    }
  }

  if (allFlights.length === 0) {
    container.innerHTML = '';
    show('empty-dashboard');
    return;
  }
  hide('empty-dashboard');

  container.innerHTML = allFlights.map(f => renderFlightCard(f)).join('');

  // Init maps for airborne flights
  for (const f of allFlights) {
    if (f.live && !f.live.on_ground) {
      initMiniMap(f);
    }
  }

  // Load weather in background, then re-render cards with weather data
  loadWeatherForFlights(allFlights).then(() => {
    for (const f of allFlights) {
      const card = document.getElementById(`card-${f.id}`);
      if (!card) continue;
      const depIata = f.origin?.iata || f.origin || '';
      const arrIata = f.destination?.iata || f.destination || '';
      card.querySelectorAll('.wx-loading').forEach(el => {
        const icao = el.dataset.icao;
        const m = STATE.weather[icao];
        if (m) el.outerHTML = weatherBadge(
          Object.keys(IATA_TO_ICAO_AIRPORT).find(k => IATA_TO_ICAO_AIRPORT[k] === icao) || ''
        );
      });
      // Also fill if wx-dep / wx-arr placeholders exist
      const wxDep = card.querySelector('.wx-dep');
      const wxArr = card.querySelector('.wx-arr');
      if (wxDep) wxDep.innerHTML = weatherBadge(depIata);
      if (wxArr) wxArr.innerHTML = weatherBadge(arrIata);
    }
  });
}

function renderFlightCard(f) {
  const origin = f.origin?.iata || f.origin || '???';
  const dest = f.destination?.iata || f.destination || '???';
  const originName = f.origin?.name || '';
  const destName = f.destination?.name || '';
  const hasLive = f.live && !f.live.on_ground;

  return `
<div class="flight-card ${statusClass(f)}" id="card-${f.id}">
  <div class="flight-card-header">
    <div>
      <div class="flight-number">${f.flight_number}</div>
      <div class="flight-airline">${f.airline || ''} ${f.date ? '· ' + fmtDate(f.date) : ''}</div>
    </div>
    <div class="flight-card-badges">
      ${f.aircraft_type ? `<span class="aircraft-tag">${f.aircraft_type}</span>` : ''}
      ${statusBadge(f)}
    </div>
  </div>

  <div class="route">
    <div class="route-airport">
      <div class="route-iata">${origin}</div>
      <div class="route-name" title="${originName}">${originName || 'Origin'}</div>
      <div class="wx-dep">${weatherBadge(origin)}</div>
    </div>
    <div class="route-line"><span class="route-plane">✈</span></div>
    <div class="route-airport">
      <div class="route-iata">${dest}</div>
      <div class="route-name" title="${destName}">${destName || 'Destination'}</div>
      <div class="wx-arr">${weatherBadge(dest)}</div>
    </div>
  </div>

  <div class="times">
    <div class="time-block">
      <div class="time-label">Departure</div>
      <div class="time-value">${fmtTime(f.scheduled_departure)}</div>
      ${f.actual_departure && f.actual_departure !== f.scheduled_departure
        ? `<div class="time-actual">Actual: ${fmtTime(f.actual_departure)}</div>` : ''}
      ${delayLabel(f.delay_departure)}
    </div>
    <div class="time-block">
      <div class="time-label">Arrival</div>
      <div class="time-value">${fmtTime(f.scheduled_arrival)}</div>
      ${f.actual_arrival && f.actual_arrival !== f.scheduled_arrival
        ? `<div class="time-actual">Actual: ${fmtTime(f.actual_arrival)}</div>` : ''}
      ${delayLabel(f.delay_arrival)}
    </div>
  </div>

  ${hasLive ? `
  <div class="live-info">
    <div class="live-stat">
      <div class="live-stat-label">Altitude</div>
      <div class="live-stat-value">${(f.live.altitude_ft || 0).toLocaleString()} ft</div>
    </div>
    <div class="live-stat">
      <div class="live-stat-label">Speed</div>
      <div class="live-stat-value">${f.live.speed_kt || 0} kt</div>
    </div>
    <div class="live-stat">
      <div class="live-stat-label">Heading</div>
      <div class="live-stat-value">${f.live.heading ? Math.round(f.live.heading) + '°' : '—'}</div>
    </div>
    <div class="live-stat">
      <div class="live-stat-label">Position</div>
      <div class="live-stat-value">${f.live.latitude?.toFixed(2)}, ${f.live.longitude?.toFixed(2)}</div>
    </div>
  </div>
  <div class="flight-map" id="map-${f.id}"></div>
  ` : ''}

  <div class="card-actions">
    <button class="btn-remove btn-sm" onclick="removeFlight('${f.id}')">Remove</button>
  </div>
</div>`;
}

function initMiniMap(f) {
  if (!f.live || !f.live.latitude) return;
  setTimeout(() => {
    const mapEl = el(`map-${f.id}`);
    if (!mapEl || STATE.maps[f.id]) return;
    const lat = f.live.latitude, lng = f.live.longitude;
    const map = L.map(mapEl, { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© CartoDB',
      maxZoom: 8,
    }).addTo(map);
    map.setView([lat, lng], 5);

    const planeIcon = L.divIcon({
      html: `<div style="font-size:20px;transform:rotate(${f.live.heading || 0}deg);filter:drop-shadow(0 2px 4px #000)">✈</div>`,
      className: '', iconSize: [24, 24], iconAnchor: [12, 12],
    });
    L.marker([lat, lng], { icon: planeIcon }).addTo(map);

    // Draw route arc if we have airports (simplified straight line)
    STATE.maps[f.id] = map;
  }, 100);
}

/* ===== Remove flight ===== */
async function removeFlight(id) {
  if (!confirm('Remove this flight?')) return;
  if (!getSetting('githubToken')) {
    toast('⚠️ Set your GitHub token in Settings first');
    return;
  }
  try {
    let newTracked;
    await ghUpdateFile(
      'flights.json',
      cur => { const c = cur || { tracked: [] }; c.tracked = (c.tracked || []).filter(t => t.id !== id); newTracked = c.tracked; return c; },
      `Remove flight`
    );
    STATE.tracked = newTracked;
    STATE.flights  = STATE.flights.filter(f => f.id !== id);
    saveCache('tracked', STATE.tracked);
    saveCache('flights', STATE.flights);
    renderDashboard();
    toast('✓ Flight removed');
  } catch (e) {
    toast('⚠️ Error: ' + e.message);
  }
}

/* ===== History rendering ===== */
function renderHistory() {
  const container = el('history-container');
  const filterAirline = el('history-filter-airline').value;
  const filterYear   = el('history-filter-year').value;

  let flights = [...STATE.history].reverse();
  if (filterAirline) flights = flights.filter(f => f.airline === filterAirline || f.airline_iata === filterAirline);
  if (filterYear)    flights = flights.filter(f => (f.date || '').startsWith(filterYear));

  if (flights.length === 0) {
    container.innerHTML = '';
    show('empty-history');
    return;
  }
  hide('empty-history');

  // Populate filter options
  const airlines = [...new Set(STATE.history.map(f => f.airline || f.airline_iata).filter(Boolean))];
  const years    = [...new Set(STATE.history.map(f => (f.date || '').slice(0, 4)).filter(Boolean))].sort().reverse();

  const airlineOpts = `<option value="">All Airlines</option>` +
    airlines.map(a => `<option value="${a}" ${a === filterAirline ? 'selected' : ''}>${a}</option>`).join('');
  const yearOpts = `<option value="">All Years</option>` +
    years.map(y => `<option value="${y}" ${y === filterYear ? 'selected' : ''}>${y}</option>`).join('');

  el('history-filter-airline').innerHTML = airlineOpts;
  el('history-filter-year').innerHTML = yearOpts;

  container.innerHTML = flights.map(f => {
    const origin = f.origin?.iata || f.origin || '???';
    const dest   = f.destination?.iata || f.destination || '???';
    const delay  = f.delay_arrival || 0;
    const delayStr = delay > 0
      ? `<span class="delay-positive">+${delay}min late</span>`
      : `<span class="delay-none">On time</span>`;
    const status = (f.status || '').toLowerCase();
    const statusDot = status === 'cancelled' ? 'var(--red)' : status === 'landed' ? 'var(--text3)' : 'var(--green)';

    return `
<div class="history-item">
  <div class="history-airline-dot" style="background:${statusDot}"></div>
  <div class="history-main">
    <div class="history-route">${f.flight_number} &nbsp; ${origin} → ${dest}</div>
    <div class="history-meta">
      <span>${f.airline || f.airline_iata || ''}</span>
      ${f.aircraft_type ? `<span>· ${f.aircraft_type}</span>` : ''}
      <span>· ${delayStr}</span>
    </div>
  </div>
  <div class="history-right">
    <div class="history-date">${fmtDate(f.date)}</div>
    <div class="history-delay">${status === 'cancelled' ? '<span style="color:var(--red)">Cancelled</span>' : (status === 'landed' ? '✓ Landed' : status)}</div>
  </div>
</div>`;
  }).join('');
}

/* ===== Statistics ===== */
function renderStats() {
  const all = [...STATE.history];
  if (all.length === 0) {
    show('empty-stats');
    return;
  }
  hide('empty-stats');

  // Summary
  const total = all.length;
  const delays = all.map(f => f.delay_arrival || 0);
  const avgDelay = Math.round(delays.reduce((a, b) => a + b, 0) / total);
  const onTimeCount = delays.filter(d => d <= 15).length;
  const onTimeRate = Math.round(onTimeCount / total * 100);
  const airlines = [...new Set(all.map(f => f.airline || f.airline_iata).filter(Boolean))];
  const topAirline = modeOf(all.map(f => f.airline || f.airline_iata).filter(Boolean));

  el('stat-total').textContent = total;
  el('stat-avg-delay').textContent = avgDelay;
  el('stat-ontime').textContent = onTimeRate + '%';
  el('stat-top-airline').textContent = topAirline || '—';

  // Charts
  renderCharts(all);
}

function modeOf(arr) {
  if (!arr.length) return null;
  const cnt = {};
  arr.forEach(v => cnt[v] = (cnt[v] || 0) + 1);
  return Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0];
}

/* ===== Add Flight ===== */
async function addFlight(e) {
  e.preventDefault();
  if (!getSetting('githubToken')) {
    toast('⚠️ Set your GitHub token in Settings first');
    return;
  }

  const flightNum = el('flight-number').value.trim().toUpperCase();
  const date      = el('flight-date').value;
  const origin    = el('origin').value.trim().toUpperCase();
  const dest      = el('destination').value.trim().toUpperCase();

  const newFlight = {
    id: `${flightNum}-${date}-${Date.now()}`,
    flight_number: flightNum,
    date,
    origin,
    destination: dest,
    airline: el('airline').value.trim(),
    aircraft_type: el('aircraft-type').value.trim(),
    scheduled_departure: el('sched-dep').value ? new Date(el('sched-dep').value).toISOString() : '',
    scheduled_arrival:   el('sched-arr').value ? new Date(el('sched-arr').value).toISOString() : '',
    added_at: new Date().toISOString(),
  };

  try {
    await ghUpdateFile(
      'flights.json',
      cur => { const c = cur || { tracked: [] }; c.tracked = c.tracked || []; c.tracked.push(newFlight); return c; },
      `Add flight ${flightNum} on ${date}`
    );
    STATE.tracked.push(newFlight);
    saveCache('tracked', STATE.tracked);

    toast(`✓ Added ${flightNum} — GitHub Actions will fetch data within 5 minutes`);
    el('add-flight-form').reset();
    clearLookupStatus();
    switchTab('dashboard');
    renderDashboard();
  } catch (err) {
    toast('⚠️ Error: ' + err.message);
  }
}

/* ===== Flight Lookup ===== */

let _lookupTimer = null;

function setLookupStatus(type, html) {
  const s = el('lookup-status');
  s.className = `lookup-status ${type}`;
  s.innerHTML = html;
  s.classList.remove('hidden');
}
function clearLookupStatus() {
  el('lookup-status').classList.add('hidden');
  hide('lookup-options');
}

/** Called automatically when flight number + date are both filled */
function scheduleAutoLookup() {
  clearTimeout(_lookupTimer);
  const num  = el('flight-number').value.trim();
  const date = el('flight-date').value;
  // Need at least "XX0" (prefix + 1 digit) and a date
  if (!date || !/^[A-Za-z]{1,3}\d{1,4}$/.test(num)) return;
  _lookupTimer = setTimeout(() => doLookup(num.toUpperCase(), date), 700);
}

/* ── AeroDataBox lookup ── */
async function fetchAeroDataBox(flightNum, date) {
  const key = getSetting('aeroDataBoxKey');
  if (!key) return null;
  const r = await fetch(
    `https://aerodatabox.p.rapidapi.com/flights/number/${flightNum}/${date}`,
    { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' } }
  );
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`AeroDataBox ${r.status}`);
  const data = await r.json();
  // Normalize to common format
  return (Array.isArray(data) ? data : []).map(f => ({
    departure: {
      iata:      f.departure?.airport?.iata,
      airport:   f.departure?.airport?.name,
      scheduled: adbTime(f.departure?.scheduledTimeUtc),
      actual:    adbTime(f.departure?.actualTimeUtc),
      delay:     f.departure?.delay ?? null,
    },
    arrival: {
      iata:      f.arrival?.airport?.iata,
      airport:   f.arrival?.airport?.name,
      scheduled: adbTime(f.arrival?.scheduledTimeUtc),
      actual:    adbTime(f.arrival?.actualTimeUtc),
      delay:     f.arrival?.delay ?? null,
    },
    airline:      { name: f.airline?.name, iata: f.airline?.iata },
    aircraft:     { iata: f.aircraft?.model, registration: f.aircraft?.reg },
    flight_status: adbStatus(f.status),
    _source: 'aerodatabox',
  }));
}

// AeroDataBox time: "2024-01-15 02:00Z" → ISO string
function adbTime(t) {
  if (!t) return null;
  return t.replace(' ', 'T').replace(/Z$/, '+00:00');
}
function adbStatus(s) {
  if (!s) return 'scheduled';
  const m = { EnRoute: 'active', Landed: 'landed', Cancelled: 'cancelled',
               Diverted: 'diverted', Departed: 'active', Expected: 'scheduled' };
  return m[s] || 'scheduled';
}

/* ── AviationStack lookup ── */
async function fetchAviationStack(flightNum, date) {
  const key = getSetting('aviationstackKey');
  if (!key) return null;
  // AviationStack free tier only supports HTTP
  const r = await fetch(
    `http://api.aviationstack.com/v1/flights?access_key=${key}&flight_iata=${flightNum}&flight_date=${date}`
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || 'AviationStack error');
  return (data.data || []).map(f => ({ ...f, _source: 'aviationstack' }));
}

/* ── Main lookup orchestrator ── */
async function doLookup(flightNum, date) {
  const hasAdb = !!getSetting('aeroDataBoxKey');
  const hasAs  = !!getSetting('aviationstackKey');

  if (!hasAdb && !hasAs) {
    setLookupStatus('error',
      '⚠️ 尚未設定 API Key — 請至 Settings 加入 AeroDataBox 或 AviationStack Key，或手動填寫。');
    return;
  }

  setLookupStatus('loading',
    `<span class="lookup-spinner"></span> 查詢 ${flightNum} (${date})…`);
  hide('lookup-options');

  let flights = null;
  let source  = '';

  try {
    if (hasAdb) {
      flights = await fetchAeroDataBox(flightNum, date);
      source  = 'AeroDataBox';
    }
    if ((!flights || flights.length === 0) && hasAs) {
      flights = await fetchAviationStack(flightNum, date);
      source  = 'AviationStack';
    }
  } catch (e) {
    setLookupStatus('error', `⚠️ 查詢失敗：${e.message}`);
    return;
  }

  const valid = (flights || []).filter(f => f.departure?.iata && f.arrival?.iata);
  if (valid.length === 0) {
    setLookupStatus('error', `✕ 找不到 ${flightNum} 在 ${date} 的班次，請手動填寫。`);
    return;
  }

  // Deduplicate by route
  const seen = new Set();
  const unique = valid.filter(f => {
    const k = `${f.departure.iata}-${f.arrival.iata}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  if (unique.length === 1) {
    applyFlightData(unique[0]);
    setLookupStatus('success', `✓ 已自動填入（來源：${source}）`);
  } else {
    setLookupStatus('success', `✓ 找到 ${unique.length} 個航線（來源：${source}）— 請選擇`);
    showLookupOptions(unique);
  }
}

function showLookupOptions(flights) {
  const grid = el('lookup-options-grid');
  grid.innerHTML = flights.map((f, i) => {
    const dep = f.departure || {};
    const arr = f.arrival   || {};
    const airline  = f.airline?.name  || '';
    const aircraft = f.aircraft?.iata || '';
    const depTime  = dep.scheduled ? fmtTime(dep.scheduled) : '—';
    const arrTime  = arr.scheduled ? fmtTime(arr.scheduled) : '—';
    const depName  = dep.airport ? `<span>${dep.airport}</span>` : '';
    const arrName  = arr.airport ? `<span>${arr.airport}</span>` : '';
    return `
<div class="lookup-option-card" id="opt-${i}" onclick="selectLookupOption(${i})">
  <div class="lookup-option-route">${dep.iata} → ${arr.iata}</div>
  <div class="lookup-option-times">${depTime} → ${arrTime}</div>
  <div class="lookup-option-meta">
    ${airline ? `<span>${airline}</span>` : ''}
    ${aircraft ? `<span>${aircraft}</span>` : ''}
    ${depName}${arrName ? ` → ${arrName}` : ''}
  </div>
</div>`;
  }).join('');
  // Store flights for later selection
  el('lookup-options-grid').dataset.flights = JSON.stringify(flights);
  show('lookup-options');
}

window.selectLookupOption = function(i) {
  const flights = JSON.parse(el('lookup-options-grid').dataset.flights || '[]');
  const f = flights[i];
  if (!f) return;
  // Highlight selected
  document.querySelectorAll('.lookup-option-card').forEach((c, idx) => {
    c.classList.toggle('selected', idx === i);
  });
  applyFlightData(f);
  setLookupStatus('success', `✓ Route selected: ${f.departure?.iata} → ${f.arrival?.iata}`);
};

function applyFlightData(f) {
  const dep = f.departure || {};
  const arr = f.arrival   || {};
  if (dep.iata)       el('origin').value       = dep.iata;
  if (arr.iata)       el('destination').value  = arr.iata;
  if (dep.scheduled)  el('sched-dep').value    = toLocalDatetimeInput(dep.scheduled);
  if (arr.scheduled)  el('sched-arr').value    = toLocalDatetimeInput(arr.scheduled);
  if (f.airline?.name)  el('airline').value       = f.airline.name;
  if (f.aircraft?.iata) el('aircraft-type').value = f.aircraft.iata;
}

/** Manual lookup button */
async function lookupFlight() {
  const num  = el('flight-number').value.trim().toUpperCase();
  const date = el('flight-date').value;
  if (!num)  { toast('Enter a flight number first'); return; }
  if (!date) { toast('Select a date first'); return; }
  await doLookup(num, date);
}

function toLocalDatetimeInput(isoStr) {
  try {
    const d = new Date(isoStr);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ''; }
}

/* ===== Settings save ===== */
async function testGitHub() {
  const token = el('github-token').value.trim();
  const repo  = el('github-repo').value.trim();
  const branch = el('github-branch').value.trim() || 'main';
  saveSettings({ githubToken: token, githubRepo: repo, githubBranch: branch });

  if (!token) { el('github-status').textContent = ''; return; }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders() });
    const data = await r.json();
    if (r.ok) {
      el('github-status').textContent = `✓ Connected (${data.private ? 'private' : 'public'})`;
      el('github-status').style.color = 'var(--green)';
    } else {
      el('github-status').textContent = `✗ ${data.message}`;
      el('github-status').style.color = 'var(--red)';
    }
  } catch (e) {
    el('github-status').textContent = '✗ Network error';
    el('github-status').style.color = 'var(--red)';
  }
}

async function testNtfy() {
  const topic = el('ntfy-topic').value.trim();
  if (!topic) { toast('Enter ntfy topic first'); return; }
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      body: '✈️ Flighty Private — test notification!',
      headers: { Title: 'Test Notification', Tags: 'airplane' },
    });
    toast('✓ Test notification sent — check your ntfy app');
  } catch (e) {
    toast('⚠️ Failed: ' + e.message);
  }
}

function updateNtfyUrl() {
  const t = el('ntfy-topic').value.trim();
  el('ntfy-subscribe-url').textContent = t ? `https://ntfy.sh/${t}` : 'https://ntfy.sh/your-topic';
}

function genTopic() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const random = Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map(b => chars[b % chars.length]).join('');
  el('ntfy-topic').value = `flighty-${random}`;
  updateNtfyUrl();
}

/* ===== Data export ===== */
function exportData() {
  const data = { flights: STATE.flights, history: STATE.history, tracked: STATE.tracked, exported_at: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `flighty-export-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
}

/* ===== Auto-refresh every 5 min ===== */
function startAutoRefresh() {
  clearInterval(STATE.refreshTimer);
  STATE.refreshTimer = setInterval(loadData, 5 * 60 * 1000);
}

/* ===== Init ===== */
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  // Tab navigation
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  el('nav-menu-btn').addEventListener('click', () => {
    el('nav-tabs').classList.toggle('open');
  });

  // Refresh
  el('btn-refresh').addEventListener('click', loadData);

  // Add flight form
  el('add-flight-form').addEventListener('submit', addFlight);
  el('btn-lookup').addEventListener('click', lookupFlight);
  // Auto-lookup when flight number + date are both filled
  el('flight-number').addEventListener('input', scheduleAutoLookup);
  el('flight-date').addEventListener('change', scheduleAutoLookup);
  // Clear lookup state when flight number is cleared
  el('flight-number').addEventListener('input', () => {
    if (!el('flight-number').value.trim()) clearLookupStatus();
  });

  // History filters
  el('history-filter-airline').addEventListener('change', renderHistory);
  el('history-filter-year').addEventListener('change', renderHistory);

  // Settings — auto-save on input so refreshing never loses data
  function autoSave(inputId, settingKey, statusId) {
    const input = el(inputId);
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        saveSettings({ [settingKey]: input.value.trim() });
        if (statusId) {
          const s = el(statusId);
          s.textContent = '✓ Saved';
          setTimeout(() => { s.textContent = ''; }, 1500);
        }
      }, 600);
    });
  }
  autoSave('github-token',    'githubToken',      null);
  autoSave('github-repo',     'githubRepo',       null);
  autoSave('github-branch',   'githubBranch',     null);
  autoSave('ntfy-topic',      'ntfyTopic',        'ntfy-status');
  autoSave('aerodatabox-key', 'aeroDataBoxKey',   'adb-status');
  autoSave('aviationstack-key','aviationstackKey', 'as-status');

  // Keep Save buttons for explicit confirm + GitHub connectivity test
  el('btn-save-github').addEventListener('click', testGitHub);
  el('btn-save-ntfy').addEventListener('click', () => {
    saveSettings({ ntfyTopic: el('ntfy-topic').value.trim() });
    el('ntfy-status').textContent = '✓ Saved';
    setTimeout(() => el('ntfy-status').textContent = '', 2000);
  });
  el('btn-test-ntfy').addEventListener('click', testNtfy);
  el('btn-gen-topic').addEventListener('click', genTopic);
  el('ntfy-topic').addEventListener('input', updateNtfyUrl);
  el('btn-save-adb').addEventListener('click', () => {
    saveSettings({ aeroDataBoxKey: el('aerodatabox-key').value.trim() });
    el('adb-status').textContent = '✓ Saved';
    setTimeout(() => el('adb-status').textContent = '', 2000);
  });
  el('btn-save-as').addEventListener('click', () => {
    saveSettings({ aviationstackKey: el('aviationstack-key').value.trim() });
    el('as-status').textContent = '✓ Saved';
    setTimeout(() => el('as-status').textContent = '', 2000);
  });
  el('btn-export').addEventListener('click', exportData);
  el('btn-clear-settings').addEventListener('click', () => {
    if (confirm('Clear all saved settings?')) {
      localStorage.removeItem('flighty_settings');
      loadSettings();
      toast('Settings cleared');
    }
  });

  // Modal
  el('modal-close').addEventListener('click', () => hide('modal-overlay'));
  el('modal-overlay').addEventListener('click', e => {
    if (e.target === el('modal-overlay')) hide('modal-overlay');
  });

  // Load data
  loadData();
  startAutoRefresh();
});

// Expose globals
window.switchTab = switchTab;
window.removeFlight = removeFlight;
