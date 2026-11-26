// Smoke test: run the real debug-console module inside jsdom against a live
// proxy, so DOM lookups, rendering paths and event wiring are exercised. Not a
// replacement for a browser, but it catches runtime errors a syntax check won't.
//
// jsdom is optional (dev-only). Install it with `npm i -D jsdom` or point
// JSDOM_PATH at a jsdom module; the script skips cleanly if it is unavailable.

import { readFileSync } from 'node:fs';
import { buildConfig } from '../src/config.js';
import { startProxy } from '../src/server.js';
import http from 'node:http';

async function loadJsdom() {
  const specifiers = [
    process.env.JSDOM_PATH,
    'jsdom',
    '/tmp/node_modules/jsdom/lib/api.js',
  ].filter(Boolean);
  for (const spec of specifiers) {
    try {
      const mod = await import(spec);
      const JSDOM = mod.JSDOM || mod.default?.JSDOM;
      if (JSDOM) return JSDOM;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const JSDOM = await loadJsdom();
if (!JSDOM) {
  console.log('ui-smoke: jsdom not installed (npm i -D jsdom) — skipping.');
  process.exit(0);
}

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');

function upstream(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function call(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      res.resume();
      res.on('end', resolve);
      res.on('error', resolve);
    }).on('error', reject);
  });
}

const good = await upstream((req, res) => { res.writeHead(200); res.end('{"ok":true}'); });
const weak = await upstream((req, res) => { res.writeHead(503); res.end('busy'); });
const port0 = good.address().port;
const port1 = weak.address().port;

const config = buildConfig([
  '--upstream', `127.0.0.1:${port0},127.0.0.1:${port1}`,
  '--maxAttempts', '3',
]);
config.port = 0;
const app = await startProxy(config);
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;

await call(app.server.address().port, '/ok');
await call(app.server.address().port, '/weak?status=503');

// Serve the real page and let jsdom load app.js by URL, so the module runs with
// the window's document exactly as it does in a browser. We pre-seed browser
// APIs that jsdom lacks (fetch, EventSource) before the resources load.
const dom = new JSDOM(html, {
  url: `${base}/`,
  pretendToBeVisual: true,
  resources: 'usable',
  runScripts: 'dangerously',
  beforeParse(window) {
    window.fetch = (u, o) => fetch(new URL(u, base).toString(), o);
    window.EventSource = class {
      constructor() {
        this.listeners = {};
        setTimeout(async () => {
          const stats = await (await fetch(`${base}/admin/stats`)).json();
          this.emit('snapshot', { data: JSON.stringify(stats) });
          const traces = (await (await fetch(`${base}/admin/traces`)).json()).traces;
          for (const t of traces) this.emit('trace', { data: JSON.stringify(t) });
          this.emit('open', {});
        }, 0);
      }
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
      emit(type, ev) { for (const fn of this.listeners[type] || []) fn(ev); }
      close() {}
    };
    window.document.createElementNS = function (ns, tag) {
      const n = window.document.createElement(tag);
      n.__attrs = {};
      n.setAttribute = (k, v) => { n.__attrs[k] = String(v); };
      n.setAttributeNS = () => {};
      return n;
    };
  },
});
const { window } = dom;
const errors = [];
window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${e.reason}`));

// jsdom does not execute type="module" scripts, so load app.js explicitly as a
// classic script once the document exists. It has no import statements, so this
// runs the same code in the same window a browser would.
const script = window.document.createElement('script');
script.textContent = appJs;
window.document.body.appendChild(script);

// Let the script's first fetch/EventSource round-trip and render complete.
await new Promise((r) => setTimeout(r, 900));

// Assertions on the rendered document.
const doc = window.document;
function assert(cond, msg) {
  if (!cond) errors.push(`assert: ${msg}`);
}
assert(doc.getElementById('kpiTotal').textContent !== '—', 'KPI total rendered');
assert(doc.getElementById('traceList').children.length > 0, 'trace list has rows');
const rows = [...doc.querySelectorAll('.trace')];
assert(rows.length === 2, `expected 2 trace rows, saw ${rows.length}`);
for (const row of rows) {
  assert(row.querySelector('.wf'), 'each row has a waterfall');
  assert(row.querySelector('.pill'), 'each row has an outcome pill');
}
if (errors.length) {
  console.error('FAILED before interaction\n' + errors.join('\n'));
  console.error('traceList children:', doc.getElementById('traceList')?.children.length);
  process.exit(1);
}
// Expand the first row and check the detail (decision log) renders.
rows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
assert(doc.querySelector('.detail'), 'detail panel opens on click');
assert(doc.querySelectorAll('.decision').length > 0, 'decision log populated');
// Charts build DOM nodes.
assert(doc.getElementById('stageSvg').childNodes.length > 0, 'stage chart drew');
assert(doc.getElementById('budgetSvg').childNodes.length > 0, 'budget chart drew');

// Reset the drives the page relies on.
await new Promise((r) => setTimeout(r, 50));
window.close();
await app.close();
await new Promise((r) => good.close(r));
await new Promise((r) => weak.close(r));

if (errors.length) {
  console.error('FAILED\n' + errors.join('\n'));
  process.exit(1);
}
console.log('UI smoke test passed: rendered KPIs, trace rows, waterfall, detail, charts.');
