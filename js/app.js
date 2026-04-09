/* ===== State ===== */
const STATE = {
  flights: [],   // active flights (from data/status.json)
  history: [],   // past flights  (from data/history.json)
  tracked: [],   // flight list   (from flights.json)
  settings: {},
  charts: {},
  maps: {},
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
  if (name === 'stats') renderStats();
  if (name === 'history') renderHistory();
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
  const url = `https://api.github.com/repos/${ghRepo()}/contents/${path}?ref=${ghBranch()}`;
  const r = await fetch(url, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${path}`);
  return r.json();
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

/* ===== Load flight data ===== */
async function loadData() {
  const btn = el('btn-refresh');
  btn.classList.add('spinning');
  try {
    const [statusResult, historyResult, trackedResult] = await Promise.allSettled([
      fetchRaw('data/status.json'),
      fetchRaw('data/history.json'),
      fetchRaw('flights.json'),
    ]);

    if (statusResult.status === 'fulfilled') {
      STATE.flights = statusResult.value.data.flights || [];
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
      const next  = meta.next_fetch_at ? ' · next ' + timeAgo(meta.next_fetch_at).replace(' ago','') : '';
      el('last-updated').textContent = (el('last-updated').textContent || '') + `  ${label}`;
    } catch { /* meta not yet available */ }
    if (historyResult.status === 'fulfilled') {
      STATE.history = historyResult.value.data.flights || [];
    }
    if (trackedResult.status === 'fulfilled') {
      STATE.tracked = trackedResult.value.data.tracked || [];
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
    </div>
    <div class="route-line"><span class="route-plane">✈</span></div>
    <div class="route-airport">
      <div class="route-iata">${dest}</div>
      <div class="route-name" title="${destName}">${destName || 'Destination'}</div>
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
    const f = await ghGetFile('flights.json');
    const decoded = JSON.parse(decodeURIComponent(escape(atob(f.content.replace(/\n/g, '')))));
    decoded.tracked = decoded.tracked.filter(t => t.id !== id);
    await ghPutFile('flights.json', decoded, f.sha, `Remove flight`);
    STATE.tracked = decoded.tracked;
    STATE.flights = STATE.flights.filter(f => f.id !== id);
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
    let sha = null, current = { tracked: [] };
    try {
      const f = await ghGetFile('flights.json');
      sha = f.sha;
      current = JSON.parse(decodeURIComponent(escape(atob(f.content.replace(/\n/g, '')))));
    } catch { /* file may not exist yet */ }

    current.tracked = current.tracked || [];
    current.tracked.push(newFlight);

    await ghPutFile('flights.json', current, sha, `Add flight ${flightNum} on ${date}`);
    STATE.tracked.push(newFlight);

    toast(`✓ Added ${flightNum} — GitHub Actions will fetch data within 5 minutes`);
    el('add-flight-form').reset();
    switchTab('dashboard');
    renderDashboard();
  } catch (err) {
    toast('⚠️ Error: ' + err.message);
  }
}

/* ===== Auto-lookup via AviationStack ===== */
async function lookupFlight() {
  const key = getSetting('aviationstackKey');
  if (!key) { toast('Add AviationStack API key in Settings first'); return; }

  const flightNum = el('flight-number').value.trim().toUpperCase();
  const date      = el('flight-date').value;
  if (!flightNum) { toast('Enter flight number first'); return; }

  toast('🔍 Looking up...');
  try {
    const url = `http://api.aviationstack.com/v1/flights?access_key=${key}&flight_iata=${flightNum}${date ? '&flight_date=' + date : ''}`;
    const r = await fetch(url);
    const data = await r.json();
    const f = data.data?.[0];
    if (!f) { toast('Flight not found'); return; }

    // Fill form
    el('airline').value = f.airline?.name || '';
    el('aircraft-type').value = f.aircraft?.iata || '';
    if (f.departure?.iata) el('origin').value = f.departure.iata;
    if (f.arrival?.iata)   el('destination').value = f.arrival.iata;
    if (f.departure?.scheduled) el('sched-dep').value = toLocalDatetimeInput(f.departure.scheduled);
    if (f.arrival?.scheduled)   el('sched-arr').value = toLocalDatetimeInput(f.arrival.scheduled);

    show('lookup-result');
    el('lookup-result-content').innerHTML = `
      <p><strong>${f.flight?.iata}</strong> — ${f.airline?.name}</p>
      <p>${f.departure?.iata} → ${f.arrival?.iata}</p>
      <p>Dep: ${fmtTime(f.departure?.scheduled)} | Arr: ${fmtTime(f.arrival?.scheduled)}</p>
      <p>Aircraft: ${f.aircraft?.iata || '—'}</p>
      <p>Status: ${f.flight_status || '—'}</p>`;
    toast('✓ Data filled from AviationStack');
  } catch (e) {
    toast('⚠️ Lookup failed: ' + e.message);
  }
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
  el('btn-use-lookup').addEventListener('click', () => hide('lookup-result'));

  // History filters
  el('history-filter-airline').addEventListener('change', renderHistory);
  el('history-filter-year').addEventListener('change', renderHistory);

  // Settings
  el('btn-save-github').addEventListener('click', testGitHub);
  el('btn-save-ntfy').addEventListener('click', () => {
    const t = el('ntfy-topic').value.trim();
    saveSettings({ ntfyTopic: t });
    el('ntfy-status').textContent = '✓ Saved';
    setTimeout(() => el('ntfy-status').textContent = '', 2000);
  });
  el('btn-test-ntfy').addEventListener('click', testNtfy);
  el('btn-gen-topic').addEventListener('click', genTopic);
  el('ntfy-topic').addEventListener('input', updateNtfyUrl);
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
