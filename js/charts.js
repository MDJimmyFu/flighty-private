/* Chart.js configuration with dark theme */

const CHART_DEFAULTS = {
  color: '#8899b4',
  font: { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', size: 12 },
};
Chart.defaults.color = CHART_DEFAULTS.color;
Chart.defaults.font  = CHART_DEFAULTS.font;

const PALETTE = [
  '#4f9cf9', '#22d3a0', '#a78bfa', '#f59e0b',
  '#f43f5e', '#22d3ee', '#fb923c', '#86efac',
  '#c084fc', '#fbbf24', '#34d399', '#60a5fa',
];

function destroyChart(key) {
  if (STATE.charts[key]) {
    STATE.charts[key].destroy();
    delete STATE.charts[key];
  }
}

function renderCharts(history) {
  renderAirlineChart(history);
  renderAircraftChart(history);
  renderDelayChart(history);
  renderMonthlyChart(history);
}

/* ── Airline donut chart ── */
function renderAirlineChart(history) {
  destroyChart('airlines');
  const counts = {};
  history.forEach(f => {
    const k = f.airline || f.airline_iata || 'Unknown';
    counts[k] = (counts[k] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const ctx = document.getElementById('chart-airlines');
  if (!ctx) return;
  STATE.charts['airlines'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: sorted.map(([k]) => k),
      datasets: [{
        data: sorted.map(([, v]) => v),
        backgroundColor: PALETTE,
        borderColor: '#151f2e',
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            boxWidth: 12,
            padding: 10,
            font: { size: 11 },
          },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${ctx.raw} flights`,
          },
        },
      },
    },
  });
}

/* ── Aircraft type bar chart ── */
function renderAircraftChart(history) {
  destroyChart('aircraft');
  const counts = {};
  history.forEach(f => {
    const k = f.aircraft_type || 'Unknown';
    counts[k] = (counts[k] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const ctx = document.getElementById('chart-aircraft');
  if (!ctx) return;
  STATE.charts['aircraft'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(([k]) => k),
      datasets: [{
        data: sorted.map(([, v]) => v),
        backgroundColor: sorted.map((_, i) => PALETTE[i % PALETTE.length] + 'cc'),
        borderColor: sorted.map((_, i) => PALETTE[i % PALETTE.length]),
        borderWidth: 1,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.raw} flights` },
        },
      },
      scales: {
        x: {
          grid: { color: '#1e2d42' },
          ticks: { stepSize: 1 },
        },
        y: {
          grid: { display: false },
        },
      },
    },
  });
}

/* ── Delay distribution bar chart ── */
function renderDelayChart(history) {
  destroyChart('delays');
  const buckets = {
    'Early': 0,
    'On Time\n(≤15min)': 0,
    '15–30\nmin': 0,
    '30–60\nmin': 0,
    '60–120\nmin': 0,
    '>120\nmin': 0,
    'Cancelled': 0,
  };
  history.forEach(f => {
    if ((f.status || '').toLowerCase() === 'cancelled') { buckets['Cancelled']++; return; }
    const d = f.delay_arrival || 0;
    if (d < 0) buckets['Early']++;
    else if (d <= 15) buckets['On Time\n(≤15min)']++;
    else if (d <= 30) buckets['15–30\nmin']++;
    else if (d <= 60) buckets['30–60\nmin']++;
    else if (d <= 120) buckets['60–120\nmin']++;
    else buckets['>120\nmin']++;
  });

  const colors = ['#22d3a0', '#4f9cf9', '#f59e0b', '#fb923c', '#f43f5e', '#ef4444', '#6b7280'];
  const ctx = document.getElementById('chart-delays');
  if (!ctx) return;
  STATE.charts['delays'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(buckets),
      datasets: [{
        label: 'Flights',
        data: Object.values(buckets),
        backgroundColor: colors.map(c => c + 'bb'),
        borderColor: colors,
        borderWidth: 1,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.raw} flights` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          grid: { color: '#1e2d42' },
          ticks: { stepSize: 1 },
          beginAtZero: true,
        },
      },
    },
  });
}

/* ── Monthly flights line chart ── */
function renderMonthlyChart(history) {
  destroyChart('monthly');
  const counts = {};
  history.forEach(f => {
    const month = (f.date || '').slice(0, 7); // YYYY-MM
    if (month) counts[month] = (counts[month] || 0) + 1;
  });

  // Fill in missing months
  if (Object.keys(counts).length > 1) {
    const months = Object.keys(counts).sort();
    const start = new Date(months[0] + '-01');
    const end   = new Date(months[months.length - 1] + '-01');
    const cur   = new Date(start);
    while (cur <= end) {
      const key = cur.toISOString().slice(0, 7);
      if (!counts[key]) counts[key] = 0;
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  const sorted = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  const labels = sorted.map(([k]) => {
    const [y, m] = k.split('-');
    return new Date(+y, +m - 1).toLocaleDateString([], { month: 'short', year: '2-digit' });
  });

  const ctx = document.getElementById('chart-monthly');
  if (!ctx) return;
  STATE.charts['monthly'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Flights',
        data: sorted.map(([, v]) => v),
        backgroundColor: 'rgba(79,156,249,0.25)',
        borderColor: '#4f9cf9',
        borderWidth: 2,
        borderRadius: 4,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.raw} flights` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          grid: { color: '#1e2d42' },
          ticks: { stepSize: 1 },
          beginAtZero: true,
        },
      },
    },
  });
}
