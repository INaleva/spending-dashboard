// Scrapes the configured institutions and merges the results into data/transactions.json.
// Usage: npm run scrape [-- --months 12] [-- --show]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { backupFile } from './backup.mjs';

// the same puppeteer copy the scraper library uses
const puppeteer = createRequire(import.meta.resolve('israeli-bank-scrapers'))('puppeteer');

const DATA_FILE = path.resolve('data/transactions.json');
const INITIAL_MONTHS = 12; // some banks (e.g. Beinleumi) only allow one year back
// Each source saves a checkpoint (when its last successful scrape started). The next scrape starts
// OVERLAP_DAYS before it, to catch late postings (e.g. purchases abroad), and early enough to
// re-fetch any row still pending so it can settle.
const OVERLAP_DAYS = 14;

// Every institution israeli-bank-scrapers supports. A source runs when all its env vars are set in .env.
// env: scraper login field -> env var name. kind: 'bank' (an account: money in and out) or 'card' (purchases).
const SOURCES = [
  // banks
  { id: CompanyTypes.hapoalim, name: 'Hapoalim', kind: 'bank', env: { userCode: 'HAPOALIM_USER_CODE', password: 'HAPOALIM_PASSWORD' } },
  { id: CompanyTypes.leumi, name: 'Leumi', kind: 'bank', env: { username: 'LEUMI_USERNAME', password: 'LEUMI_PASSWORD' } },
  { id: CompanyTypes.mizrahi, name: 'Mizrahi', kind: 'bank', env: { username: 'MIZRAHI_USERNAME', password: 'MIZRAHI_PASSWORD' } },
  { id: CompanyTypes.discount, name: 'Discount', kind: 'bank', env: { id: 'DISCOUNT_ID', password: 'DISCOUNT_PASSWORD', num: 'DISCOUNT_NUM' } },
  { id: CompanyTypes.mercantile, name: 'Mercantile', kind: 'bank', env: { id: 'MERCANTILE_ID', password: 'MERCANTILE_PASSWORD', num: 'MERCANTILE_NUM' } },
  { id: CompanyTypes.beinleumi, name: 'Beinleumi', kind: 'bank', env: { username: 'BEINLEUMI_USERNAME', password: 'BEINLEUMI_PASSWORD' } },
  { id: CompanyTypes.otsarHahayal, name: 'Otsar Hahayal', kind: 'bank', env: { username: 'OTSAR_HAHAYAL_USERNAME', password: 'OTSAR_HAHAYAL_PASSWORD' } },
  { id: CompanyTypes.massad, name: 'Massad', kind: 'bank', env: { username: 'MASSAD_USERNAME', password: 'MASSAD_PASSWORD' } },
  { id: CompanyTypes.pagi, name: 'Pagi', kind: 'bank', env: { username: 'PAGI_USERNAME', password: 'PAGI_PASSWORD' } },
  { id: CompanyTypes.union, name: 'Union', kind: 'bank', env: { username: 'UNION_USERNAME', password: 'UNION_PASSWORD' } },
  { id: CompanyTypes.yahav, name: 'Yahav', kind: 'bank', env: { username: 'YAHAV_USERNAME', nationalID: 'YAHAV_NATIONAL_ID', password: 'YAHAV_PASSWORD' } },
  // One Zero logs in with an SMS code; this script can't ask for one, so it needs a long-term token (see .env.example)
  { id: CompanyTypes.oneZero, name: 'One Zero', kind: 'bank', env: { email: 'ONEZERO_EMAIL', password: 'ONEZERO_PASSWORD', otpLongTermToken: 'ONEZERO_OTP_LONG_TERM_TOKEN' } },
  // credit cards
  { id: CompanyTypes.visaCal, name: 'Cal', kind: 'card', env: { username: 'CAL_USERNAME', password: 'CAL_PASSWORD' } },
  { id: CompanyTypes.max, name: 'Max', kind: 'card', env: { username: 'MAX_USERNAME', password: 'MAX_PASSWORD' } },
  { id: CompanyTypes.isracard, name: 'Isracard', kind: 'card', env: { id: 'ISRACARD_ID', card6Digits: 'ISRACARD_CARD6', password: 'ISRACARD_PASSWORD' } },
  { id: CompanyTypes.amex, name: 'Amex', kind: 'card', env: { id: 'AMEX_ID', card6Digits: 'AMEX_CARD6', password: 'AMEX_PASSWORD' } },
  { id: CompanyTypes.beyahadBishvilha, name: 'Beyahad Bishvilha', kind: 'card', env: { id: 'BEYAHAD_ID', password: 'BEYAHAD_PASSWORD' } },
  { id: CompanyTypes.behatsdaa, name: 'Behatsdaa', kind: 'card', env: { id: 'BEHATSDAA_ID', password: 'BEHATSDAA_PASSWORD' } },
];

// Isracard Group sites (Isracard, Amex) answer automated logins with a Cloudflare/Akamai block page.
// Workaround from upstream issue eshaham/israeli-bank-scrapers#1181 (fix pending in PR #1186):
// launch Chromium without the --enable-automation flag, hide navigator.webdriver, send a Hebrew
// accept-language header, and retry failed navigations.
const BOT_PROTECTED = new Set([CompanyTypes.amex, CompanyTypes.isracard]);

async function botProtectedOptions() {
  const browser = await puppeteer.launch({ headless: !showBrowser, ignoreDefaultArgs: ['--enable-automation'] });
  return {
    browser,
    skipCloseBrowser: true, // closed in scrapeSource, also when the scrape throws
    navigationRetryCount: 3,
    preparePage: async page => {
      await page.setExtraHTTPHeaders({ 'accept-language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7' });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
    },
  };
}

const args = process.argv.slice(2);
const monthsArg = args.includes('--months') ? Number(args[args.indexOf('--months') + 1]) : null;
const fullArg = args.includes('--full'); // ignore checkpoints, fetch the full first-sync window again
const showBrowser = args.includes('--show');
// --only amex,max : scrape just these sources (ids as in SOURCES)
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

function loadStore() {
  if (!fs.existsSync(DATA_FILE)) return { sources: {}, transactions: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  backupFile(DATA_FILE, { daily: true, keep: 30 }); // one copy per day of the data as it was before this sync
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}

function readCredentials(source) {
  const creds = {};
  for (const [field, envName] of Object.entries(source.env)) {
    const value = process.env[envName]?.trim();
    if (!value) return null;
    creds[field] = value;
  }
  return creds;
}

const DAY = 86400000;
function startDateFor(source, store) {
  const now = new Date();
  if (monthsArg) return { start: new Date(now.getFullYear(), now.getMonth() - monthsArg, now.getDate()), why: `--months ${monthsArg}` };
  const meta = store.sources[source.id];
  const checkpoint = meta?.checkpoint ?? meta?.lastScrape; // lastScrape: data saved before checkpoints existed
  const hasRows = store.transactions.some(t => t.source === source.id);
  if (fullArg || !checkpoint || !hasRows) {
    return { start: new Date(now.getFullYear(), now.getMonth() - INITIAL_MONTHS, now.getDate() + 1), why: fullArg ? '--full' : 'first sync' };
  }
  let start = new Date(new Date(checkpoint).getTime() - OVERLAP_DAYS * DAY);
  let why = `checkpoint ${checkpoint.slice(0, 10)} − ${OVERLAP_DAYS} days`;
  const oldestPending = store.transactions
    .filter(t => t.source === source.id && t.status === 'pending')
    .map(t => t.date)
    .sort()[0];
  if (oldestPending && new Date(oldestPending) < start) {
    start = new Date(new Date(oldestPending).getTime() - DAY);
    why += ', extended to the oldest pending row';
  }
  return { start, why };
}

function baseKey(t) {
  return [
    t.source,
    t.account,
    t.identifier ?? '',
    t.date,
    t.processedDate ?? '',
    t.chargedAmount,
    t.description,
    t.installments ? `${t.installments.number}/${t.installments.total}` : '',
  ].join('|');
}

function groupByKey(rows) {
  const groups = new Map();
  for (const t of rows) {
    const k = baseKey(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return groups;
}

// Identical rows can be legitimate (two coffees, same day, same price), so per key keep
// whichever side has more copies instead of collapsing to one. Pending rows of this
// source are dropped first: the fresh scrape returns them again, pending or settled.
function merge(existing, fresh, sourceId) {
  const kept = existing.filter(t => !(t.source === sourceId && t.status === 'pending'));
  const oldGroups = groupByKey(kept);
  const newGroups = groupByKey(fresh);
  const out = [];
  for (const [k, rows] of oldGroups) {
    const newer = newGroups.get(k);
    if (!newer || rows.length > newer.length) out.push(...rows);
  }
  for (const [k, rows] of newGroups) {
    const older = oldGroups.get(k);
    if (!older || rows.length >= older.length) out.push(...rows);
  }
  return out;
}

// Shown in the dashboard's sync status. Only the error type is kept: the message can contain request data.
// A successful scrape replaces the source's entry, which clears it.
function recordFailure(store, source, errorType) {
  const prev = store.sources[source.id] ?? { name: source.name, kind: source.kind };
  store.sources[source.id] = { ...prev, lastFailure: { at: new Date().toISOString(), errorType: String(errorType || 'UNKNOWN') } };
}

async function scrapeSource(source, credentials, store) {
  const { start: startDate, why } = startDateFor(source, store);
  const startedAt = new Date().toISOString(); // becomes the checkpoint if this scrape succeeds
  console.log(`${source.name}: scraping from ${startDate.toISOString().slice(0, 10)} (${why})...`);
  const browserOptions = BOT_PROTECTED.has(source.id) ? await botProtectedOptions() : { showBrowser };
  let result;
  try {
    const scraper = createScraper({
      companyId: source.id,
      startDate,
      combineInstallments: false,
      additionalTransactionInformation: true, // Isracard: fetches the merchant category per transaction
      defaultTimeout: 60000,
      // Cards fetch whole billing months; keep every row they return. With the default filter, an
      // installment of an older purchase charged this month is dropped because its purchase date is
      // before startDate. The merge below removes rows already stored.
      outputData: { enableTransactionsFilterByDate: false },
      ...browserOptions,
    });
    result = await scraper.scrape(credentials);
  } finally {
    await browserOptions.browser?.close().catch(() => {});
  }
  if (!result.success) {
    // errorMessage can echo request bodies (password included) on some failures, so mask every credential value
    let message = result.errorMessage ?? '';
    for (const value of Object.values(credentials)) {
      if (typeof value === 'string' && value) message = message.split(value).join('***');
    }
    message = message.split('\n')[0].slice(0, 300);
    console.error(`${source.name}: FAILED (${result.errorType})${message ? `: ${message}` : ''}`);
    console.error(`${source.name}: re-run with --show to watch the login.`);
    recordFailure(store, source, result.errorType);
    return false;
  }
  const fresh = [];
  for (const account of result.accounts ?? []) {
    for (const t of account.txns) {
      fresh.push({
        source: source.id,
        sourceName: source.name,
        sourceKind: source.kind,
        account: account.accountNumber,
        identifier: t.identifier ?? null,
        type: t.type,
        status: t.status,
        date: t.date,
        processedDate: t.processedDate,
        originalAmount: t.originalAmount,
        originalCurrency: t.originalCurrency,
        chargedAmount: t.chargedAmount,
        chargedCurrency: t.chargedCurrency ?? 'ILS',
        description: t.description,
        memo: t.memo ?? null,
        category: t.category ?? null,
        installments: t.installments ?? null,
      });
    }
  }
  const before = store.transactions.length;
  store.transactions = merge(store.transactions, fresh, source.id);
  store.sources[source.id] = {
    name: source.name,
    kind: source.kind,
    lastScrape: new Date().toISOString(),
    checkpoint: startedAt,
    accounts: (result.accounts ?? []).map(a => ({ accountNumber: a.accountNumber, balance: a.balance ?? null })),
    futureDebits: result.futureDebits ?? [],
  };
  console.log(
    `${source.name}: ${fresh.length} rows fetched, ${store.transactions.length - before >= 0 ? '+' : ''}${store.transactions.length - before} net new.`,
  );
  return true;
}

const store = loadStore();
const configured = SOURCES.filter(s => !only || only.has(s.id))
  .map(s => ({ source: s, creds: readCredentials(s) }))
  .filter(x => x.creds);
if (!configured.length) {
  console.error('No credentials found. Copy .env.example to .env and fill in at least one institution.');
  process.exit(1);
}

let failures = 0;
for (const { source, creds } of configured) {
  try {
    if (!(await scrapeSource(source, creds, store))) failures++;
  } catch (e) {
    failures++;
    let message = String(e?.message ?? e).split('\n')[0].slice(0, 300);
    for (const value of Object.values(creds)) if (typeof value === 'string' && value) message = message.split(value).join('***');
    console.error(`${source.name}: crashed: ${message}`);
    recordFailure(store, source, 'CRASH');
  }
  saveStore(store); // save after each source so one failure doesn't lose the others
}
console.log(`Saved ${store.transactions.length} transactions to ${path.relative(process.cwd(), DATA_FILE)}.`);
process.exit(failures ? 2 : 0);
