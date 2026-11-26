// Pointwise delivery console — live view of real forwards.
// Uses textContent for all untrusted strings (paths, headers, upstream labels).

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
const S1 = 'var(--series-1)';
const S2 = 'var(--series-2)';
const S3 = 'var(--series-3)';
const STAGE_COLORS = {
  'pre-headers': 'var(--stage-1)',
  'headers-committed': 'var(--stage-2)',
  'body-partial': 'var(--stage-3)',
};
const STAGE_LABELS = ['pre-headers', 'headers-committed', 'body-partial'];
const MAX_TRACES = 40;

const el = (id) => document.getElementById(id);
const tooltip = el('tooltip');
const budgetHistory = [];
let latestStats = null;
let traces = [];
const expanded = new Set();

// ---------------------------------------------------------------- helpers
function money(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
function ms(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`;
}
function bytes(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function text(node, value) { node.textContent = value; return node; }
function make(tag, cls, value) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (value !== undefined) n.textContent = value;
  return n;
}

function showTip(evt, rows, title) {
  const t = el('tooltip');
  t.replaceChildren();
  if (title) {
    const h = make('div', 't-title', title);
    t.appendChild(h);
  }
  for (const row of rows) {
    const line = make('div', 't-row');
    const key = make('div', 't-key');
    if (row.color) {
      const sw = make('span', 'sw');
      sw.style.background = row.color;
      key.appendChild(sw);
    }
    key.appendChild(make('span', '', row.label));
    line.appendChild(key);
    line.appendChild(make('span', 't-val', row.value));
    t.appendChild(line);
  }
  t.style.display = 'block';
  positionTip(evt);
}
function positionTip(evt) {
  const t = el('tooltip');
  const pad = 14;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}
function hideTip() { el('tooltip').style.display = 'none'; }
document.addEventListener('pointermove', (e) => {
  if (el('tooltip').style.display === 'block') positionTip(e);
});

// ---------------------------------------------------------------- KPIs
function renderStats(stats) {
  latestStats = stats;
  const t = stats.totals;
  text(el('kpiTotal'), String(t.finished));
  text(el('kpiTotalNote'), `${t.traces} in buffer · ${t.traces - t.finished} in flight`);
  text(el('kpiDelivered'), String(t.delivered));
  text(el('kpiDeliveredNote'),
    t.retried ? `${t.retried} of them needed a retry` : 'no retries needed');
  text(el('kpiRetried'), String(t.retried));
  text(el('kpiRetriedNote'), `${t.weakRelayed || 0} weak relayed · ${t.truncated || 0} truncated`);
  text(el('kpiGaveUp'), String(t.gaveUp));
  text(el('kpiGaveUpNote'), t.gaveUp ? 'client got an error page' : 'none');
  text(el('kpiP95'), t.p95Ms === null ? '—' : ms(t.p95Ms));

  const b = stats.budget;
  const pct = b.capacity > 0 ? Math.max(0, Math.min(100, (b.tokens / b.capacity) * 100)) : 0;
  text(el('budgetRatio'), `${b.tokens.toFixed(2)} / ${b.capacity}`);
  el('budgetFill').style.width = `${pct}%`;
  el('budgetFill').className = `fill${pct < 34 ? ' low' : ''}`;
  el('budgetMeter').setAttribute('aria-valuenow', String(Math.round(b.tokens)));
  el('budgetMeter').setAttribute('aria-valuemax', String(b.capacity));
  text(el('budgetRefill'), `refill ${b.refillPerSecond}/s`);
  text(el('budgetCounts'), `${b.granted} granted · ${b.denied} denied`);

  text(el('modeChip'), stats.config.demo ? 'demo mode' : 'live');
  const r = stats.config.retry;
  text(el('footConfig'),
    `max ${r.maxAttempts} attempts · first-hop ${ms(r.firstHopTimeoutMs)} · connect ${ms(r.connectTimeoutMs)} · commit window ${ms(r.commitAfterMs)} / ${bytes(r.commitAfterBytes)} · ${stats.upstreams.length} upstreams · cap ${stats.config.upstreamPolicy.maxInFlightPerUpstream} each`);

  renderUpstreams(stats.upstreams);
  renderBudgetHistory(b);
  pushBudgetSample(b);
  renderStageChart();
}

function renderUpstreams(ups) {
  const host = el('upstreams');
  host.replaceChildren();
  if (!ups || ups.length === 0) {
    host.appendChild(make('div', 'up', 'No upstreams configured.'));
    return;
  }
  const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
  ups.forEach((u, i) => {
    const card = make('div', `up up-${letters[i] || 'a'}`);
    const dot = make('span', 'dot');
    card.appendChild(dot);

    const main = make('div');
    main.appendChild(make('div', 'name', u.id));
    main.appendChild(make('div', 'addr', u.url.host + ':' + (u.url.port || 80)));
    card.appendChild(main);

    const state = make('span', 'state');
    state.dataset.state = u.state;
    const sdot = make('span', 'sdot');
    state.appendChild(sdot);
    state.appendChild(make('span', '', u.state === 'open' ? `open · cooldown ${ms(u.openForMs)}` : u.state));
    card.appendChild(state);

    const load = make('div', 'loadline');
    const bar = make('div', 'loadbar');
    const fill = make('i');
    const pct = u.maxInFlight ? Math.min(100, (u.inFlight / u.maxInFlight) * 100) : 0;
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    load.appendChild(bar);
    load.appendChild(make('span', 'loadtext', `${u.inFlight}/${u.maxInFlight} in flight · ${u.successes} ok · ${u.failures} fail`));
    card.appendChild(load);

    card.addEventListener('pointermove', (e) => {
      showTip(e, [
        { label: 'successes', value: String(u.successes) },
        { label: 'failures', value: String(u.failures) },
        { label: 'consecutive', value: String(u.consecutiveFailures) },
      ], u.id);
    });
    card.addEventListener('pointerleave', hideTip);
    host.appendChild(card);
  });
}

// ---------------------------------------------------------------- budget chart
function pushBudgetSample(b) {
  const now = Date.now();
  const last = budgetHistory[budgetHistory.length - 1];
  if (last && now - last.t < 800 && Math.abs(last.tokens - b.tokens) < 0.05 &&
      last.granted === b.granted && last.denied === b.denied) return;
  budgetHistory.push({ t: now, tokens: b.tokens, capacity: b.capacity, granted: b.granted, denied: b.denied });
  while (budgetHistory.length && now - budgetHistory[0].t > 75_000) budgetHistory.shift();
}

function renderBudgetHistory(b) {
  const svg = el('budgetSvg');
  const W = 600, H = 140;
  const pad = { l: 34, r: 8, t: 10, b: 22 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const now = Date.now();
  const windowMs = 60_000;
  const t0 = now - windowMs;

  svg.replaceChildren();
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // gridlines + y labels at capacity quarters
  for (let i = 0; i <= 4; i++) {
    const v = (b.capacity / 4) * i;
    const y = pad.t + plotH - (v / (b.capacity || 1)) * plotH;
    svg.appendChild(mk('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: 'var(--grid)', 'stroke-width': 1 }));
    const lab = mk('text', { x: pad.l - 6, y: y + 3, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 9 });
    lab.textContent = String(Math.round(v));
    svg.appendChild(lab);
  }
  // x labels
  for (let m = 0; m <= 60; m += 20) {
    const x = pad.l + ((m / 60) * plotW);
    const lab = mk('text', { x, y: H - 6, 'text-anchor': m === 0 ? 'start' : m === 60 ? 'end' : 'middle', fill: 'var(--muted)', 'font-size': 9 });
    lab.textContent = m === 60 ? 'now' : `−${60 - m}s`;
    svg.appendChild(lab);
  }

  const pts = budgetHistory.filter((s) => s.t >= t0 - 2000);
  if (pts.length === 0) return;
  const xOf = (t) => pad.l + Math.max(0, Math.min(1, (t - t0) / windowMs)) * plotW;
  const yOf = (v) => pad.t + plotH - Math.max(0, Math.min(1, v / (b.capacity || 1))) * plotH;

  // area wash
  const line = pts.map((s, i) => `${i === 0 ? 'M' : 'L'}${xOf(s.t).toFixed(1)},${yOf(s.tokens).toFixed(1)}`).join(' ');
  const lastX = xOf(pts.at(-1).t);
  const area = `${line} L${lastX.toFixed(1)},${(pad.t + plotH).toFixed(1)} L${xOf(pts[0].t).toFixed(1)},${(pad.t + plotH).toFixed(1)} Z`;
  svg.appendChild(mk('path', { d: area, fill: 'var(--stage-2)', 'fill-opacity': '0.10' }));
  svg.appendChild(mk('path', { d: line, fill: 'none', stroke: 'var(--stage-2)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // grant/deny event dots
  const events = [];
  for (let i = 1; i < pts.length; i++) {
    const dg = pts[i].granted - pts[i - 1].granted;
    const dd = pts[i].denied - pts[i - 1].denied;
    if (dg > 0) events.push({ t: pts[i].t, v: pts[i].tokens, type: 'granted' });
    if (dd > 0) events.push({ t: pts[i].t, v: pts[i].tokens, type: 'denied' });
  }
  for (const e of events.slice(-30)) {
    const c = mk('circle', {
      cx: xOf(e.t), cy: yOf(e.v), r: 4,
      fill: e.type === 'granted' ? 'var(--good)' : 'var(--warning)',
      stroke: 'var(--surface-1)', 'stroke-width': 2,
    });
    c.style.cursor = 'pointer';
    c.addEventListener('pointermove', (ev) => {
      showTip(ev, [{ label: e.type, value: timeAgo(e.t) }], 'budget event');
    });
    c.addEventListener('pointerleave', hideTip);
    svg.appendChild(c);
  }

  // end dot with direct label (the value the reader came for)
  svg.appendChild(mk('circle', { cx: lastX, cy: yOf(pts.at(-1).tokens), r: 4, fill: 'var(--stage-2)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));

  // table view
  const tbody = el('budgetTableBody');
  tbody.replaceChildren();
  for (const s of [...pts].reverse().slice(0, 20)) {
    const row = document.createElement('tr');
    row.appendChild(make('td', '', timeAgo(s.t)));
    row.appendChild(make('td', 'num', s.tokens.toFixed(2)));
    row.appendChild(make('td', 'num', String(s.granted)));
    row.appendChild(make('td', 'num', String(s.denied)));
    tbody.appendChild(row);
  }
}

function timeAgo(t) {
  const d = Math.max(0, Math.round((Date.now() - t) / 1000));
  return d === 0 ? 'just now' : `${d}s ago`;
}

// ---------------------------------------------------------------- stage chart
function renderStageChart() {
  const svg = el('stageSvg');
  const W = 600, H = 180;
  const pad = { l: 96, r: 12, t: 8, b: 8 };
  const plotW = W - pad.l - pad.r;
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  svg.replaceChildren();

  const buckets = [
    { key: 'delivered', label: 'delivered' },
    { key: 'truncated', label: 'truncated' },
    { key: 'weak', label: 'weak relayed' },
    { key: 'failed', label: 'gave up' },
  ];
  const data = buckets.map((b) => ({ ...b, counts: { 'pre-headers': 0, 'headers-committed': 0, 'body-partial': 0 } }));

  const finished = traces.filter((t) => t.result);
  for (const tr of finished) {
    const b = classifyTrace(tr);
    const bucket = data.find((d) => d.key === b.bucket);
    if (!bucket) continue;
    const stage = b.stage || 'pre-headers';
    bucket.counts[stage] = (bucket.counts[stage] || 0) + 1;
  }

  const max = Math.max(1, ...data.flatMap((d) => STAGE_LABELS.map((s) => d.counts[s])));
  const rowH = (H - pad.t - pad.b) / data.length;
  const barCap = 24;

  data.forEach((d, i) => {
    const y = pad.t + i * rowH + rowH / 2;
    const label = mk('text', {
      x: pad.l - 10, y: y + 4, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 11,
    });
    label.textContent = d.label;
    svg.appendChild(label);

    let x = pad.l;
    const total = STAGE_LABELS.reduce((s, k) => s + d.counts[k], 0);

    // Recessive baseline for the row; full-strength once it has data.
    svg.appendChild(mk('line', {
      x1: pad.l, x2: W - pad.r, y1: y + barCap / 2 + 3, y2: y + barCap / 2 + 3,
      stroke: 'var(--grid)', 'stroke-width': 1, opacity: total > 0 ? 1 : 0.4,
    }));
    if (total === 0) {
      const empty = mk('text', { x: pad.l + 4, y: y + 4, fill: 'var(--muted)', 'font-size': 10 });
      empty.textContent = 'no attempts';
      svg.appendChild(empty);
      return;
    }
    STAGE_LABELS.forEach((stage) => {
      const count = d.counts[stage];
      if (count === 0) return;
      const w = (count / max) * plotW;
      // 2px surface gap between touching segments (the same width for every seam).
      const drawW = Math.max(2, w - 2);
      const rect = mk('rect', {
        x, y: y - barCap / 2, width: drawW, height: barCap,
        rx: 4, ry: 4, fill: STAGE_COLORS[stage],
      });
      svg.appendChild(rect);

      // Only label when the number fits comfortably after the bar end.
      const labelX = x + drawW + 6;
      if (labelX + 12 <= W - pad.r) {
        const val = mk('text', {
          x: labelX, y: y + 4, fill: 'var(--ink-2)', 'font-size': 10,
          'font-variant-numeric': 'tabular-nums',
        });
        val.textContent = String(count);
        svg.appendChild(val);
      }

      rect.addEventListener('pointermove', (ev) => {
        showTip(ev, [{ label: stage, value: String(count), color: STAGE_COLORS[stage] }], d.label);
      });
      rect.addEventListener('pointerleave', hideTip);
      x += w;
    });
  });
}

// ---------------------------------------------------------------- traces
/**
 * The server has already resolved the outcome. Map it onto a chart bucket plus
 * the terminal delivery stage of the attempt that ended the request, so the
 * stage chart and the trace list agree.
 */
function classifyTrace(t) {
  const last = t.attempts.at(-1) || {};
  const r = t.result || {};
  const stage = r.stage || last.stage || 'pre-headers';
  switch (r.outcome) {
    case 'delivered':
      return { bucket: 'delivered', label: 'delivered', stage };
    case 'truncated':
      return { bucket: 'truncated', label: 'truncated', stage: 'body-partial' };
    case 'weak-relayed':
      return { bucket: 'weak', label: 'weak relayed', stage };
    case 'gave-up-weak':
      return { bucket: 'weak', label: 'weak relayed', stage: 'pre-headers' };
    case 'client-gone':
      return { bucket: 'failed', label: 'client gone', stage };
    case 'gave-up':
      return { bucket: 'failed', label: 'gave up', stage: 'pre-headers' };
    default:
      return { bucket: 'pending', label: 'in flight', stage };
  }
}

function traceBadge(t) {
  const r = t.result;
  if (!r) return { cls: 'pending', text: 'in flight' };
  if (r.outcome === 'truncated') return { cls: 'truncated', text: 'truncated mid-body' };
  if (r.outcome === 'gave-up' || r.outcome === 'gave-up-weak') return { cls: 'failed', text: 'gave up' };
  if (r.outcome === 'weak-relayed') {
    return t.attempts.length > 1
      ? { cls: 'retried', text: `weak ${r.status}, relayed after ${t.attempts.length}` }
      : { cls: 'retried', text: `weak ${r.status}, no retry possible` };
  }
  if (r.outcome === 'client-gone') return { cls: 'failed', text: 'client gone' };
  if (t.attempts.length > 1) return { cls: 'retried', text: `delivered after ${t.attempts.length} tries` };
  return { cls: 'delivered', text: 'delivered' };
}

function upstreamClass(upId) {
  const n = String(upId || '');
  const m = n.match(/up-(\d+)/);
  if (!m) return 'unknown';
  return { 1: 's1', 2: 's2', 3: 's3' }[m[1]] || 'unknown';
}

function renderTraces() {
  const host = el('traceList');
  const finished = traces.filter((t) => t.result);
  if (traces.length === 0) {
    host.replaceChildren();
    host.appendChild(make('div', 'empty', 'No traffic yet. Send a request above — or curl the proxy directly.'));
    return;
  }
  host.replaceChildren();
  const list = [...traces].slice(0, MAX_TRACES);
  let shown = 0;
  for (const tr of list) {
    if (!tr.result && shown > 4) continue;
    shown += 1;
    host.appendChild(renderTrace(tr));
  }
  if (traces.length > list.length) {
    host.appendChild(make('div', 'empty', `${traces.length - list.length} older traces in the buffer — see /admin/traces`));
  }
}

function renderTrace(tr) {
  const card = make('div', 'trace');
  const open = expanded.has(tr.id);
  card.setAttribute('aria-expanded', open ? 'true' : 'false');
  card.setAttribute('tabindex', '0');
  card.setAttribute('role', 'button');

  const top = make('div', 'trace-top');
  top.appendChild(make('span', 'method', tr.method));
  const pathEl = make('span', 'path');
  pathEl.textContent = tr.path;
  pathEl.title = tr.path;
  top.appendChild(pathEl);

  const badge = traceBadge(tr);
  const pill = make('span', `pill ${badge.cls}`);
  pill.appendChild(make('span', 'pdot'));
  pill.appendChild(make('span', '', badge.text));
  top.appendChild(pill);

  top.appendChild(make('span', 'spacer'));
  const statusText = tr.result?.status !== null && tr.result?.status !== undefined ? String(tr.result.status) : '—';
  top.appendChild(make('span', 'meta', `HTTP ${statusText}`));
  top.appendChild(make('span', 'meta', ms(tr.result?.durationMs ?? (Date.now() - tr.createdAt))));
  top.appendChild(make('span', 'meta', `${tr.attempts.length} attempt${tr.attempts.length === 1 ? '' : 's'}`));
  card.appendChild(top);

  // waterfall
  const wf = renderWaterfall(tr);
  card.appendChild(wf);

  const toggle = () => {
    if (expanded.has(tr.id)) expanded.delete(tr.id);
    else expanded.add(tr.id);
    renderTraces();
  };
  card.addEventListener('click', (e) => {
    if (e.target.closest('.detail')) return;
    toggle();
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  if (open) card.appendChild(renderDetail(tr));
  return card;
}

function renderWaterfall(tr) {
  const wrap = make('div', 'wf');
  const fallback = tr.attempts.reduce((s, a) => s + a.durationMs, 0) || 1;
  const total = Math.max(1, tr.result?.durationMs ?? fallback);
  const lanes = new Map();
  for (const a of tr.attempts) {
    if (!lanes.has(a.upstreamId)) lanes.set(a.upstreamId, []);
    lanes.get(a.upstreamId).push(a);
  }
  if (lanes.size === 0) {
    const pending = make('div', 'wf-lane');
    pending.appendChild(make('div', 'lane-name', 'waiting'));
    const track = make('div', 'lane-track');
    wrap.appendChild(pending);
    return wrap;
  }
  const rows = [...lanes.entries()].sort((a, b) => a[1][0].attempt - b[1][0].attempt);

  for (const [upId, attempts] of rows) {
    const lane = make('div', 'wf-lane');
    const name = make('div', 'lane-name');
    name.appendChild(make('span', `dot ${upstreamClass(upId)}`));
    name.appendChild(make('span', '', upId));
    lane.appendChild(name);
    const track = make('div', 'lane-track');

    for (const a of attempts) {
      const left = ((a.attemptStartOffsetMs ?? 0) / total) * 100;
      const width = Math.max(1.2, (a.durationMs / total) * 100);
      const block = make('div', `block ${upstreamClass(upId)}`);
      block.style.left = `${left}%`;
      block.style.width = `${Math.min(100 - left, Math.max(1.2, width))}%`;
      if (a.reason && !a.committed) block.classList.add('failed');
      block.setAttribute('tabindex', '0');
      block.setAttribute('aria-label', `attempt ${a.attempt} on ${upId}: ${a.reason || 'delivered'}`);
      const facts = [
        { label: 'attempt', value: String(a.attempt) },
        { label: 'upstream', value: upId, color: SERIES[(Number(upId.match(/\d+/)?.[0] || 1) - 1) % 3] },
        { label: 'duration', value: ms(a.durationMs), color: null },
        { label: 'ttfb', value: a.ttfbMs === null ? '—' : ms(a.ttfbMs) },
        { label: 'stage', value: a.stage },
        { label: 'from upstream', value: bytes(a.bytesFromUpstream) },
        { label: 'to client', value: bytes(a.bytesToClient) },
      ];
      if (a.reason) facts.push({ label: 'failure', value: a.reason });
      block.addEventListener('pointermove', (e) => showTip(e, facts.filter((f) => f.value !== '—'), `Attempt ${a.attempt}`));
      block.addEventListener('pointerleave', hideTip);
      block.addEventListener('focus', (e) => {
        const r = block.getBoundingClientRect();
        showTip({ clientX: r.left + r.width / 2, clientY: r.top }, facts.filter((f) => f.value !== '—'), `Attempt ${a.attempt}`);
      });
      block.addEventListener('blur', hideTip);
      track.appendChild(block);
    }
    // commit markers
    for (const a of attempts) {
      if (a.committed) {
        const at = ((a.attemptStartOffsetMs + (a.ttfbMs || 0)) / total) * 100;
        const marker = make('div', 'marker');
        marker.style.left = `${Math.min(100, at)}%`;
        marker.title = 'commit point';
        track.appendChild(marker);
      }
    }
    lane.appendChild(track);
    wrap.appendChild(lane);
  }
  const axis = make('div', 'wf-axis');
  axis.appendChild(make('span', '', '0 ms'));
  axis.appendChild(make('span', '', `${ms(total)}`));
  wrap.appendChild(axis);
  return wrap;
}

function renderDetail(tr) {
  const detail = make('div', 'detail');
  detail.addEventListener('click', (e) => e.stopPropagation());

  const left = make('div');
  left.appendChild(make('h3', '', 'Attempts'));
  if (tr.attempts.length === 0) left.appendChild(make('div', 'err', 'No attempt was started.'));
  for (const a of tr.attempts) {
    const row = make('div', 'attempt-row');
    row.appendChild(make('div', 'idx', `#${a.attempt}`));
    const main = make('div', 'attempt-main');
    const u = make('div', 'u');
    u.appendChild(make('span', `dot ${upstreamClass(a.upstreamId)}`));
    u.appendChild(make('span', '', a.upstreamId));
    u.appendChild(make('span', 'meta', a.upstreamUrl));
    main.appendChild(u);
    const facts = make('div', 'facts');
    facts.appendChild(make('span', '', `status ${a.status ?? '—'}`));
    facts.appendChild(make('span', '', `ttfb ${a.ttfbMs === null ? '—' : ms(a.ttfbMs)}`));
    facts.appendChild(make('span', '', `total ${ms(a.durationMs)}`));
    facts.appendChild(make('span', '', `↑ ${bytes(a.bytesFromUpstream)}`));
    facts.appendChild(make('span', '', `↓ ${bytes(a.bytesToClient)}`));
    main.appendChild(facts);
    if (a.reason) main.appendChild(make('div', 'err', `${a.reason}${a.error ? ` — ${a.error}` : ''}`));
    row.appendChild(main);
    const stage = make('span', `stage-badge ${STAGE_LABELS.includes(a.stage) ? a.stage : 'none'}`, a.stage || 'none');
    row.appendChild(stage);
    left.appendChild(row);
  }

  const right = make('div');
  right.appendChild(make('h3', '', 'Decision log'));
  const decisions = make('div', 'decisions');
  for (const d of tr.decisions) {
    const item = make('div', 'decision');
    item.appendChild(make('div', 'di', decisionIcon(d.kind)));
    const body = make('div');
    body.appendChild(make('strong', '', decisionTitle(d)));
    body.appendChild(make('span', '', ' ' + decisionText(d)));
    item.appendChild(body);
    decisions.appendChild(item);
  }
  right.appendChild(decisions);

  const r = tr.result;
  if (r) {
    const box = make('div', 'result-box');
    const lines = [
      ['Outcome', r.outcome],
      ['Final status', r.status ?? '—'],
      ['Final upstream', r.finalUpstream ?? '—'],
      ['Terminal stage', r.stage ?? '—'],
      ['Bytes to client', bytes(r.bytesToClient)],
      ['Total attempts', String(r.attempts)],
      ['Budget at finish', `${r.budget?.tokens?.toFixed?.(2) ?? r.budget?.tokens} tokens · ${r.budget?.granted ?? 0} granted / ${r.budget?.denied ?? 0} denied`],
    ];
    for (const [k, v] of lines) {
      const line = make('div', 'rline');
      line.appendChild(make('span', '', k));
      line.appendChild(make('span', 'rval', String(v)));
      box.appendChild(line);
    }
    right.appendChild(box);
  }

  detail.appendChild(left);
  detail.appendChild(right);
  return detail;
}

function decisionIcon(kind) {
  return {
    eligibility: '◇',
    'attempt-start': '▶',
    commit: '●',
    'retry-decision': '↻',
    'budget-denied': '⊘',
    'no-upstream': '∅',
    'give-up': '✕',
  }[kind] || '·';
}
function decisionTitle(d) {
  return {
    eligibility: 'Replayable?',
    'attempt-start': `Attempt ${d.attempt} → ${d.upstreamId}`,
    commit: `Committed on attempt ${d.attempt}`,
    'retry-decision': d.retry ? `Retry after attempt ${d.attempt}` : `Stop after attempt ${d.attempt}`,
    'budget-denied': 'Budget denied — relaying weak reply',
    'no-upstream': 'No upstream available',
    'give-up': 'Gave up',
  }[d.kind] || d.kind;
}
function decisionText(d) {
  switch (d.kind) {
    case 'eligibility': return d.reason;
    case 'attempt-start': return `${d.upstreamUrl} · x-proxy-attempt ${d.attempt}`;
    case 'commit': return 'response head is on the wire — no further replay';
    case 'retry-decision': return d.reason;
    case 'budget-denied': return `${d.reason} (status ${d.status})`;
    case 'no-upstream': return d.reason;
    case 'give-up': return `after ${d.attempts} attempt${d.attempts === 1 ? '' : 's'}${d.lastFailure ? ` · last: ${d.lastFailure}` : ''}`;
    default: return '';
  }
}

// ---------------------------------------------------------------- actions
function parseScenario(value) {
  const sp = value.indexOf(' ');
  const method = value.slice(0, sp);
  const path = value.slice(sp + 1);
  return { method, path };
}

async function sendOnce(value) {
  const { method, path } = parseScenario(value);
  const headers = { accept: 'application/json' };
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    body = JSON.stringify({ hello: 'world', at: Date.now() });
    headers['content-type'] = 'application/json';
    if (path.includes('key=1')) headers['idempotency-key'] = `demo-${Date.now()}`;
  }
  const cleanPath = path.replace(/[?&]key=1/, '');
  await fetch(cleanPath, { method, headers, body });
}

async function sendBurst() {
  await Promise.allSettled(Array.from({ length: 8 }, () => sendOnce('GET /weak?status=503')));
}

async function resetBudget() {
  await fetch('/admin/reset-budget', { method: 'POST' });
  budgetHistory.length = 0;
  await refreshStats();
}

async function clearTraces() {
  // The server owns the buffer; clearing means arrowing back to now, so we drop
  // client-side rows and let new traffic repopulate. Server buffer is capped.
  traces = [];
  expanded.clear();
  renderTraces();
  renderStageChart();
  await refreshStats();
}

// ---------------------------------------------------------------- data
async function refreshStats() {
  try {
    const r = await fetch('/admin/stats');
    if (!r.ok) return;
    const stats = await r.json();
    renderStats(stats);
  } catch {
    setLive(false);
  }
}

function setLive(on) {
  el('liveDot').className = `live-dot${on ? '' : ' stale'}`;
  text(el('liveText'), on ? 'live' : 'disconnected');
}

let es;
function connectStream() {
  if (es) es.close();
  es = new EventSource('/admin/stream');
  es.addEventListener('open', () => setLive(true));
  es.addEventListener('snapshot', (e) => {
    const stats = JSON.parse(e.data);
    setLive(true);
    latestStats = stats;
    renderStats(stats);
  });
  es.addEventListener('trace', (e) => {
    const t = JSON.parse(e.data);
    const idx = traces.findIndex((x) => x.id === t.id);
    if (idx >= 0) traces[idx] = t;
    else traces.unshift(t);
    // Keep a bounded client window.
    traces = traces.slice(0, 200);
    renderTraces();
    renderStageChart();
    // cheap stats refresh for KPI counters
    scheduleStats();
  });
  es.addEventListener('finished', () => scheduleStats());
  es.addEventListener('heartbeat', () => setLive(true));
  es.addEventListener('error', () => setLive(false));
}

let statsTimer = null;
function scheduleStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(async () => {
    statsTimer = null;
    await refreshStats();
  }, 250);
}

// ---------------------------------------------------------------- wiring
el('sendBtn').addEventListener('click', async () => {
  const sel = el('scenario');
  const btn = el('sendBtn');
  btn.disabled = true;
  try { await sendOnce(sel.value); } finally {
    btn.disabled = false;
    setTimeout(scheduleStats, 300);
  }
});
el('burstBtn').addEventListener('click', async () => {
  const btn = el('burstBtn');
  btn.disabled = true;
  try { await sendBurst(); } finally {
    btn.disabled = false;
    setTimeout(scheduleStats, 400);
  }
});
el('clearBtn').addEventListener('click', clearTraces);
el('budgetResetBtn').addEventListener('click', resetBudget);

el('budgetTableToggle').addEventListener('click', () => {
  const wrap = el('budgetTableWrap');
  const hidden = wrap.hasAttribute('hidden');
  if (hidden) wrap.removeAttribute('hidden'); else wrap.setAttribute('hidden', '');
  el('budgetTableToggle').setAttribute('aria-expanded', hidden ? 'true' : 'false');
  text(el('budgetTableToggle'), hidden ? 'Hide table' : 'Show table');
});
el('stageTableToggle').addEventListener('click', () => {
  const wrap = el('stageTableWrap');
  const hidden = wrap.hasAttribute('hidden');
  if (hidden) wrap.removeAttribute('hidden'); else wrap.setAttribute('hidden', '');
  el('stageTableToggle').setAttribute('aria-expanded', hidden ? 'true' : 'false');
  text(el('stageTableToggle'), hidden ? 'Hide table' : 'Show table');
  renderStageTable();
});

function renderStageTable() {
  const data = [
    { key: 'delivered', label: 'delivered' },
    { key: 'truncated', label: 'truncated' },
    { key: 'weak', label: 'weak relayed' },
    { key: 'failed', label: 'gave up' },
  ];
  const counts = data.map((d) => ({ ...d, pre: 0, hc: 0, bp: 0 }));
  for (const tr of traces.filter((t) => t.result)) {
    const b = classifyTrace(tr);
    const bucket = counts.find((c) => c.key === b.bucket);
    if (!bucket) continue;
    const stage = b.stage || 'pre-headers';
    if (stage === 'pre-headers') bucket.pre += 1;
    else if (stage === 'headers-committed') bucket.hc += 1;
    else bucket.bp += 1;
  }
  const body = el('stageTableBody');
  body.replaceChildren();
  for (const c of counts) {
    const row = document.createElement('tr');
    row.appendChild(make('td', '', c.label));
    row.appendChild(make('td', 'num', String(c.pre)));
    row.appendChild(make('td', 'num', String(c.hc)));
    row.appendChild(make('td', 'num', String(c.bp)));
    body.appendChild(row);
  }
}

connectStream();
refreshStats();
setInterval(refreshStats, 10_000);
