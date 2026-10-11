// Local dashboard server with a "sync" button: serves dashboard/ and runs scrape + build on demand.
// Usage: npm run dashboard            (opens the browser)
//        npm run dashboard -- --no-open
//
// Security: listens on 127.0.0.1 only. Every start generates a random token that is injected into
// the served page; data.js and the sync API refuse requests without it, so another website open in
// your browser can neither read your data (e.g. via <script src>) nor trigger a scrape. The Host
// header is checked to block DNS-rebinding.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { backupFile } from './backup.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PORT = Number(process.env.PORT) || 4321;
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const LOG_LINES = 200;

const job = { running: false, startedAt: null, finishedAt: null, ok: null, failed: [], log: [] };
let child = null;

function log(line) {
  for (const l of String(line).split(/\r?\n/)) {
    if (!l.trim()) continue;
    job.log.push(l);
    if (job.log.length > LOG_LINES) job.log.shift();
  }
}

function run(args) {
  return new Promise(resolve => {
    child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    child.stdout.on('data', log);
    child.stderr.on('data', d => {
      log(d);
      for (const l of String(d).split(/\r?\n/)) if (/FAILED|crashed|Error/.test(l)) job.failed.push(l.trim());
    });
    child.on('close', code => { child = null; resolve(code); });
    child.on('error', e => { log(e.message); child = null; resolve(1); });
  });
}

// The dashboard shows either your data or demo data (build.mjs --demo leaves data/.demo behind).
// Edits made while the demo is shown go to data/demo-*.json, never to your own files.
const isDemo = () => fs.existsSync(path.join(ROOT, 'data/.demo'));
const dataFile = name => path.join(ROOT, 'data', (isDemo() ? 'demo-' : '') + name);
const buildArgs = () => (isDemo() ? ['build.mjs', '--demo'] : ['build.mjs']);

// "נתוני דוגמה" button: on = generate fresh demo data and show it; off = back to your own data
async function demoMode(on) {
  Object.assign(job, { running: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null, failed: [], log: [] });
  let ok;
  if (on) {
    log('— generating demo data —');
    ok = (await run(['demo.mjs'])) === 0 && (await run(['build.mjs', '--demo'])) === 0;
  } else if (fs.existsSync(path.join(ROOT, 'data/transactions.json'))) {
    log('— building your data —');
    ok = (await run(['build.mjs'])) === 0;
  } else {
    // no data of your own yet: back to the empty page, which offers sync and the demo
    fs.rmSync(path.join(ROOT, 'dashboard/data.js'), { force: true });
    fs.rmSync(path.join(ROOT, 'data/.demo'), { force: true });
    ok = true;
  }
  Object.assign(job, { running: false, finishedAt: new Date().toISOString(), ok });
}

async function sync() {
  Object.assign(job, { running: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null, failed: [], log: [] });
  if (!fs.existsSync(path.join(ROOT, '.env'))) {
    log('.env not found. Copy .env.example to .env and fill in your logins.');
    Object.assign(job, { running: false, finishedAt: new Date().toISOString(), ok: false, failed: ['.env not found'] });
    return;
  }
  log('— scraping —');
  const scrapeCode = await run(['--env-file=.env', 'scrape.mjs']);
  // exit 2 = some sources failed, the others were saved: still rebuild
  log('— building —');
  const buildCode = scrapeCode === 1 ? 1 : await run(['build.mjs']);
  Object.assign(job, { running: false, finishedAt: new Date().toISOString(), ok: scrapeCode === 0 && buildCode === 0 });
}

// ---------- manual changes (category / fixed-variable / outside the cash flow) ----------
const FLOWS = new Set(['fixed', 'variable']);
let saving = false;

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Validates one change request from the dashboard and writes it to data/overrides.json (demo: data/demo-overrides.json).
// scope 'txn' targets one transaction by id; scope 'merchant' every transaction (also future ones)
// with the same direction + merchant key. reset removes the change.
function applyChange(change) {
  const { scope, id, mk, cat, flow, exclude, oneOff, reset } = change;
  if (scope !== 'txn' && scope !== 'merchant') throw new Error('bad scope');
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new Error('bad id');
  if (typeof mk !== 'string' || !/^(in|out)\|/.test(mk) || mk.length > 200) throw new Error('bad merchant');
  const entry = {};
  if (!reset) {
    if (cat != null) {
      if (typeof cat !== 'string' || !cat.trim() || cat.length > 60) throw new Error('bad category');
      entry.cat = cat.trim();
    }
    if (flow != null && !FLOWS.has(flow)) throw new Error('bad flow');
    if (flow) entry.flow = flow;
    if (exclude != null && typeof exclude !== 'boolean') throw new Error('bad exclude');
    if (exclude != null) entry.exclude = exclude;
    // one-off (e.g. an unplanned flight): counts this month, left out of the averages for later months
    if (oneOff != null && typeof oneOff !== 'boolean') throw new Error('bad oneOff');
    if (oneOff) entry.oneOff = true;
    entry.updatedAt = new Date().toISOString();
  }
  const file = dataFile('overrides.json');
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  data.transactions ??= {};
  data.merchants ??= {};
  // a transaction-level change would hide a merchant-level one, so saving for the merchant clears it
  delete data.transactions[id];
  if (scope === 'merchant') delete data.merchants[mk];
  if (!reset) (scope === 'txn' ? data.transactions : data.merchants)[scope === 'txn' ? id : mk] = entry;
  writeJson(file, data);
}

// Saves a data file atomically, after keeping a timestamped copy of the previous version in data/backups/.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupFile(file, { keep: 50 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

// ---------- expected amounts ("צפוי לצאת") per category ----------
// data/budgets.json: { "<group:name | cat:name>": [{ from: "YYYY-MM", amount: number | null }, ...] }.
// Each change applies from the current month on; earlier months keep the value they had.
// amount null = back to the automatic 3-month average.
const ilMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()).slice(0, 7);

function applyBudget({ key, amount, reset }) {
  if (typeof key !== 'string' || !/^(group|cat):.{1,60}$/.test(key)) throw new Error('bad key');
  if (!reset && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e7)) throw new Error('bad amount');
  const file = dataFile('budgets.json');
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const from = ilMonth();
  const history = (data[key] ?? []).filter(e => e.from !== from); // one entry per month: the latest wins
  history.push({ from, amount: reset ? null : Math.round(amount), updatedAt: new Date().toISOString() });
  history.sort((a, b) => (a.from < b.from ? -1 : 1));
  data[key] = history;
  writeJson(file, data);
}

// Stop expecting a fixed payee (cancelled policy, finished loan) from the current month on.
// Stored in data/overrides.json → stopExpecting[<series key>] = { from }. reset removes it.
function applyStop({ key, reset }) {
  if (typeof key !== 'string' || key.length > 250 || !/^(spend|income)\|/.test(key)) throw new Error('bad key');
  const file = dataFile('overrides.json');
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  data.transactions ??= {};
  data.merchants ??= {};
  data.stopExpecting ??= {};
  if (reset) delete data.stopExpecting[key];
  else data.stopExpecting[key] = { from: ilMonth(), updatedAt: new Date().toISOString() };
  writeJson(file, data);
}

// ---------- planned items (data/settings.json) ----------
// planned:  money you already arranged that the bank doesn't show yet, for the balance forecast
//           [{ id, day: "YYYY-MM-DD", amount (+ in / − out), label }]
const settingsFile = () => dataFile('settings.json');
const readSettings = () => {
  const file = settingsFile();
  const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  s.planned ??= [];
  return s;
};
const cleanLabel = (v, max = 60) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('bad label');
  return v.trim();
};
const cleanAmount = v => {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e7) throw new Error('bad amount');
  return Math.round(v * 100) / 100;
};

function applyPlanned({ action, id, day, amount, label }) {
  const s = readSettings();
  if (action === 'delete') {
    if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) throw new Error('bad id');
    s.planned = s.planned.filter(p => p.id !== id);
  } else if (action === 'add') {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw new Error('bad day');
    const value = cleanAmount(amount);
    if (!value) throw new Error('bad amount');
    s.planned.push({ id: crypto.randomBytes(6).toString('hex'), day, amount: value, label: cleanLabel(label), createdAt: new Date().toISOString() });
  } else throw new Error('bad action');
  writeJson(settingsFile(), s);
}

// POST handler shared by /api/override, /api/budget, /api/stop-expect, /api/planned: validate, save, rebuild data.js
function saveAndRebuild(req, res, apply) {
  if (!tokenOk(req.headers['x-sync-token'])) return send(res, 403, 'forbidden');
  if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, 'json only');
  if (job.running || saving) return send(res, 409, JSON.stringify({ ok: false, error: 'busy' }), 'application/json');
  saving = true;
  readBody(req)
    .then(body => { apply(JSON.parse(body)); return run(buildArgs()); })
    .then(code => send(res, code === 0 ? 200 : 500, JSON.stringify({ ok: code === 0 }), 'application/json'))
    .catch(e => send(res, 400, JSON.stringify({ ok: false, error: e.message }), 'application/json'))
    .finally(() => { saving = false; });
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
}

const tokenOk = (given) => {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const server = http.createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, 'forbidden host');
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8').replace(
      '<script src="data.js"></script>',
      `<script>window.SYNC_TOKEN = ${JSON.stringify(TOKEN)};</script><script src="data.js?t=${TOKEN}"></script>`,
    );
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  // the locally stored Rubik font files, and nothing else from dashboard/fonts
  const font = url.pathname.match(/^\/fonts\/(rubik-(?:hebrew|latin)-(?:400|500|600|700)-normal\.woff2)$/);
  if (req.method === 'GET' && font) {
    const file = path.join(ROOT, 'dashboard/fonts', font[1]);
    if (!fs.existsSync(file)) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(file), 'font/woff2');
  }

  if (req.method === 'GET' && url.pathname === '/data.js') {
    if (!tokenOk(url.searchParams.get('t'))) return send(res, 403, 'forbidden');
    const file = path.join(ROOT, 'dashboard/data.js');
    if (!fs.existsSync(file)) return send(res, 200, '', 'text/javascript; charset=utf-8');
    return send(res, 200, fs.readFileSync(file), 'text/javascript; charset=utf-8');
  }

  if (url.pathname === '/api/sync') {
    if (!tokenOk(req.headers['x-sync-token'])) return send(res, 403, 'forbidden');
    if (req.method === 'POST') {
      if (job.running || saving) return send(res, 409, JSON.stringify(job), 'application/json');
      sync();
      return send(res, 202, JSON.stringify(job), 'application/json');
    }
    if (req.method === 'GET') return send(res, 200, JSON.stringify(job), 'application/json');
  }

  if (url.pathname === '/api/demo' && req.method === 'POST') {
    if (!tokenOk(req.headers['x-sync-token'])) return send(res, 403, 'forbidden');
    if (job.running || saving) return send(res, 409, JSON.stringify(job), 'application/json');
    demoMode(url.searchParams.get('on') === '1');
    return send(res, 202, JSON.stringify(job), 'application/json');
  }

  if (url.pathname === '/api/override' && req.method === 'POST') return saveAndRebuild(req, res, applyChange);
  if (url.pathname === '/api/budget' && req.method === 'POST') return saveAndRebuild(req, res, applyBudget);
  if (url.pathname === '/api/stop-expect' && req.method === 'POST') return saveAndRebuild(req, res, applyStop);
  if (url.pathname === '/api/planned' && req.method === 'POST') return saveAndRebuild(req, res, applyPlanned);

  send(res, 404, 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`Dashboard: ${url}  (Ctrl+C to stop)`);
  if (process.argv.includes('--no-open')) return;
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
});

const stop = () => { child?.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
