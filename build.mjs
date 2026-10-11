// Turns data/transactions.json into dashboard/data.js (categorized, normalized rows).
// Usage: npm run build            (real data)
//        node build.mjs --demo    (data/demo-transactions.json)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const demo = process.argv.includes('--demo');
// demo data lives in its own files (data/demo-*.json), so trying the demo never touches your real data
const dataFile = name => path.resolve('data', (demo ? 'demo-' : '') + name);
const DATA_FILE = dataFile('transactions.json');
// marks which data the dashboard shows now; server.mjs reads it to rebuild the same kind after an edit
const DEMO_MARKER = path.resolve('data/.demo');
const RULES_FILE = path.resolve('rules.json');
const OUT_FILE = path.resolve('dashboard/data.js');
const UNCATEGORIZED = 'ללא קטגוריה';
const SOURCE_NAMES = {
  hapoalim: 'הפועלים',
  leumi: 'לאומי',
  mizrahi: 'מזרחי טפחות',
  discount: 'דיסקונט',
  mercantile: 'מרכנתיל',
  beinleumi: 'הבינלאומי',
  otsarHahayal: 'אוצר החייל',
  massad: 'מסד',
  pagi: 'פאגי',
  union: 'איגוד',
  yahav: 'יהב',
  oneZero: 'וואן זירו',
  visaCal: 'כאל',
  max: 'מקס',
  isracard: 'ישראכרט',
  amex: 'אמריקן אקספרס',
  beyahadBishvilha: 'ביחד בשבילך',
  behatsdaa: 'בהצדעה',
};
const LOCAL_CURRENCY = new Set(['ILS', 'NIS', '₪']);
const MATCH_WINDOW_DAYS = 4; // a bank debit posts up to a few days after the card's charge day

if (!fs.existsSync(DATA_FILE)) {
  console.error(`${path.relative(process.cwd(), DATA_FILE)} not found. Run "npm run scrape" first (or "npm run demo").`);
  process.exit(1);
}
const store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));

// Manual changes made in the dashboard (server.mjs writes this file). Kept apart from the scraped
// data so a scrape never overwrites them. transactions: by row id; merchants: by "<in|out>|<merchant key>".
const OVERRIDES_FILE = dataFile('overrides.json');
const overrides = fs.existsSync(OVERRIDES_FILE)
  ? JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'))
  : { transactions: {}, merchants: {} };
overrides.transactions ??= {};
overrides.merchants ??= {};

const merchantKey = d => d.toLowerCase().replace(/[0-9*#\-_.\/\\:()"'׳״]+/g, ' ').replace(/\s+/g, ' ').trim();
// stable id of a stored transaction: the same fields the scraper merge uses to tell rows apart
const rowId = t => crypto.createHash('sha1').update([
  t.source, t.account, t.identifier ?? '', t.date, t.processedDate ?? '', t.chargedAmount, t.description,
  t.installments ? `${t.installments.number}/${t.installments.total}` : '',
].join('|')).digest('hex').slice(0, 16);
const OUTSIDE_IN = 'כסף שנכנס מחוץ לתזרים';
const OUTSIDE_OUT = 'כסף שיצא מחוץ לתזרים';
const overrideOf = new Map(); // row -> applied override (its flow is applied after classification)
const overrideCounts = { txn: 0, merchant: 0 };

// Applies a manual change to a row whose automatic kind/category are already set.
// naturalKind: what the row is when not excluded ('spend' or 'income').
function applyOverride(row, t, direction, naturalKind, naturalAmt, naturalCat) {
  row.id = rowId(t);
  row.mk = `${direction}|${merchantKey(row.desc)}`;
  const byTxn = overrides.transactions[row.id];
  const ov = byTxn ? { ...byTxn, scope: 'txn' } : overrides.merchants[row.mk] ? { ...overrides.merchants[row.mk], scope: 'merchant' } : null;
  if (!ov) return;
  if (ov.exclude === true && row.kind !== 'ignored') {
    Object.assign(row, { kind: 'ignored', dir: direction, amt: Math.abs(naturalAmt), cat: direction === 'in' ? OUTSIDE_IN : OUTSIDE_OUT });
  } else if (ov.exclude === false && row.kind === 'ignored') {
    Object.assign(row, { kind: naturalKind, amt: naturalAmt, cat: naturalCat });
    delete row.dir;
  }
  if (ov.cat && row.kind !== 'ignored') row.cat = ov.cat;
  if (ov.oneOff) row.oneOff = true; // counts this month, left out of later months' averages
  row.ov = ov.scope;
  overrideOf.set(row, ov);
  overrideCounts[ov.scope]++;
}

const compile = list => (list ?? []).map(r => ({ ...r, re: new RegExp(r.pattern, 'i') }));
const cardBillRules = compile(rules.cardBills);
const cardInternalRules = compile(rules.cardInternal);
const ignoreRules = compile(rules.ignore);
const categoryRules = compile(rules.categories);
const aliases = rules.aliases ?? {};

// Scraper dates are UTC instants of Israeli local midnight; convert back to the local day
// or everything on the 1st of a month lands in the previous month.
const ilDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' });
const localDay = iso => (iso ? ilDay.format(new Date(iso)) : null);
// today in Israel; DASHBOARD_TODAY=YYYY-MM-DD simulates another day (testing only)
const TODAY = process.env.DASHBOARD_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.DASHBOARD_TODAY)
  ? process.env.DASHBOARD_TODAY
  : localDay(new Date().toISOString());
const dayNum = day => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 86400000;

// optional rule filters: "sources" (scraper ids) and "kind" ("bank" or "card")
const appliesTo = (rule, t) => (!rule.sources || rule.sources.includes(t.source)) && (!rule.kind || rule.kind === t.sourceKind);
const sourceName = t => SOURCE_NAMES[t.source] ?? t.sourceName;

// Some banks (e.g. Beinleumi) append "(תאריך ערך DD/MM)" to some descriptions: the day the card charged.
const VALUE_DATE_RE = /\s*\(תאריך ערך (\d{1,2})\/(\d{1,2})\)/;
function valueDay(t, bookedDay) {
  const m = `${t.description} ${t.memo ?? ''}`.match(VALUE_DATE_RE);
  if (!m) return bookedDay;
  let year = +bookedDay.slice(0, 4);
  if (+m[2] > +bookedDay.slice(5, 7)) year--; // value date in December, booked in January
  return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
const cleanDesc = d => d.replace(VALUE_DATE_RE, '').replace(/\s+/g, ' ').trim();

// ---------- card bills on the bank account ----------
// For every scraped card: total charged per charge day, from the card's own rows.
const cardDays = new Map(); // card -> Map(day -> { card, bank })
for (const t of store.transactions) {
  if (t.sourceKind !== 'card') continue;
  if (!cardDays.has(t.source)) cardDays.set(t.source, new Map());
  const days = cardDays.get(t.source);
  const day = localDay(t.processedDate ?? t.date);
  if (!days.has(day)) days.set(day, { card: 0, bank: 0, bankRows: 0, bankSrc: null });
  days.get(day).card += -t.chargedAmount;
}
const cardCoverageStart = new Map(
  [...cardDays].map(([card, days]) => [card, [...days.keys()].sort()[0]]),
);

function matchCardDay(card, refDay) {
  const days = cardDays.get(card);
  for (let back = 0; back <= MATCH_WINDOW_DAYS; back++) {
    const d = new Date((dayNum(refDay) - back) * 86400000).toISOString().slice(0, 10);
    if (days.has(d)) return d;
  }
  return null;
}

const out = [];
const uncategorized = new Map();
const counts = { ignored: 0, cardBill: 0 };
const unmatchedBills = [];

for (const t of store.transactions) {
  const text = `${t.description} ${t.memo ?? ''}`;
  const isInstallment = t.type === 'installments' && t.installments;
  // Installment rows carry the purchase date; bucket them by the month they are charged.
  const day = localDay(isInstallment ? t.processedDate : t.date) ?? localDay(t.date);
  const amount = -t.chargedAmount; // spending is positive from here on
  const row = {
    d: day,
    m: day.slice(0, 7),
    src: sourceName(t),
    kind: 'spend',
    cat: null,
    desc: cleanDesc(t.description),
    memo: t.memo || undefined,
    amt: Math.round(amount * 100) / 100,
    pend: t.status === 'pending' || undefined,
    instN: isInstallment ? t.installments.number : undefined,
    instT: isInstallment ? t.installments.total : undefined,
    // one installment plan = one purchase: card + merchant + number of payments + full purchase amount.
    // Not the monthly amount (the first payment often differs by a few shekels: 274 then 269) and not the
    // voucher id (Amex issues a new one for every payment).
    plan: isInstallment
      ? `${t.source}|${t.account}|${t.description}|${t.installments.total}|${Math.round(Math.abs(t.originalAmount))}`
      : undefined,
    fx: t.originalCurrency && !LOCAL_CURRENCY.has(t.originalCurrency) ? `${-t.originalAmount} ${t.originalCurrency}` : undefined,
    // card rows: the day the card charges the bank (for "charges not yet taken from the account")
    pd: t.sourceKind === 'card' ? localDay(t.processedDate) ?? undefined : undefined,
  };

  // not a purchase (e.g. revolving-credit balance repeating earlier purchases): left out everywhere,
  // but it already counted in the card's charge-day total, so the bank payment for it still matches
  if (t.sourceKind === 'card' && cardInternalRules.some(r => appliesTo(r, t) && r.re.test(text))) {
    row.kind = 'card-internal';
    row.cat = 'פנימי לכרטיס';
    out.push(row);
    continue;
  }

  const bill = t.sourceKind === 'bank' ? cardBillRules.find(r => r.re.test(text)) : null;
  if (bill) {
    if (cardDays.has(bill.card)) {
      const matched = matchCardDay(bill.card, valueDay(t, day));
      if (matched) {
        // the card's itemized rows already count this money
        const slot = cardDays.get(bill.card).get(matched);
        slot.bank += amount;
        slot.bankRows++;
        slot.bankSrc = row.src;
        row.kind = 'card-bill';
        row.cat = `חיוב ${bill.label}`;
        counts.cardBill++;
        out.push(row);
        continue;
      }
      if (day >= cardCoverageStart.get(bill.card)) unmatchedBills.push(`${day} ${Math.round(amount)} ${row.desc}`);
    }
    // card not scraped, or a bill from before the card data starts: the bank row is the only record
    row.cat = `${bill.label} – ללא פירוט`;
    applyOverride(row, t, amount < 0 ? 'in' : 'out', 'spend', row.amt, row.cat);
    out.push(row);
    continue;
  }

  const direction = amount < 0 ? 'in' : 'out';
  const naturalKind = t.sourceKind === 'bank' && amount < 0 ? 'income' : 'spend';
  const naturalAmt = naturalKind === 'income' ? -row.amt : row.amt;
  const ignoredBy = ignoreRules.find(r => appliesTo(r, t) && (!r.direction || r.direction === direction) && r.re.test(text));
  if (ignoredBy) {
    row.kind = 'ignored';
    row.dir = direction;
    row.amt = Math.abs(row.amt);
    counts.ignored++;
  } else if (t.sourceKind === 'bank' && amount < 0) {
    row.kind = 'income';
    row.amt = -row.amt; // income is positive too
  }

  const rule = categoryRules.find(r => appliesTo(r, t) && r.re.test(text));
  const naturalCat = naturalKind === 'income' ? 'הכנסות'
    : rule?.category ?? (t.category ? aliases[t.category] ?? t.category : UNCATEGORIZED);
  row.cat = row.kind === 'ignored' ? (row.dir === 'in' ? OUTSIDE_IN : OUTSIDE_OUT) : naturalCat;
  applyOverride(row, t, direction, naturalKind, naturalAmt, naturalCat);
  if (row.kind === 'spend' && row.cat === UNCATEGORIZED) {
    uncategorized.set(row.desc, (uncategorized.get(row.desc) ?? 0) + amount);
  }
  out.push(row);
}

// Part of a bill the card data does not itemize (e.g. purchases from before the scrape window)
// stays as spending, so dropping the bank row never loses money.
const residuals = [];
for (const [card, days] of cardDays) {
  const label = cardBillRules.find(r => r.card === card)?.label ?? SOURCE_NAMES[card] ?? card;
  for (const [day, slot] of days) {
    if (!slot.bankRows) continue;
    const diff = slot.bank - slot.card;
    if (Math.abs(diff) <= Math.max(2, slot.bank * 0.005)) continue;
    residuals.push(`${day}: bank ${Math.round(slot.bank)} vs ${label} ${Math.round(slot.card)} → ${diff > 0 ? 'kept' : 'card has'} ${Math.round(Math.abs(diff))}`);
    if (diff > 0) {
      out.push({
        d: day,
        m: day.slice(0, 7),
        src: slot.bankSrc,
        kind: 'spend',
        cat: `${label} – ללא פירוט`,
        desc: `חלק מחיוב ${label} שאין לו פירוט בנתוני הכרטיס`,
        amt: Math.round(diff * 100) / 100,
      });
    }
  }
}
out.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));

// ---------- fixed vs variable ----------
// A merchant/payee is "fixed" when, over the complete months since it first appeared, it shows
// up in most months, about once a month, with a similar amount (rent, loans, salary, subscriptions).
// Weekly supermarket runs fail the once-a-month test and stay variable.
const fixedRules = (rules.fixed ?? []).map(p => new RegExp(p, 'i'));
const variableRules = (rules.variable ?? []).map(p => new RegExp(p, 'i'));
const currentMonth = TODAY.slice(0, 7);
const dataMonths = [...new Set(out.map(t => t.m))].sort();
const firstFullMonth = dataMonths.length > 1 ? dataMonths[1] : dataMonths[0]; // the first month is partial
const completeMonths = dataMonths.filter(m => m >= firstFullMonth && m < currentMonth);

const series = new Map();
for (const t of out) {
  if (t.kind !== 'spend' && t.kind !== 'income') continue;
  t.key = `${t.kind}|${merchantKey(t.desc)}`;
  if (t.instT || !completeMonths.includes(t.m)) continue;
  if (!series.has(t.key)) series.set(t.key, new Map());
  const months = series.get(t.key);
  const v = months.get(t.m) ?? { sum: 0, n: 0 };
  v.sum += t.amt;
  v.n++;
  months.set(t.m, v);
}
const median = a => { const s = [...a].sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
// regular over the given complete months: shows up in most of them since it first appeared,
// with a steady monthly total and the same number of charges each month (at most 4, e.g. an
// insurer charging 3 policies; a supermarket's count and total both vary, so it stays variable)
function isRegular(months, window) {
  const seen = [...months.keys()].filter(m => window.includes(m)).sort();
  if (seen.length < 3) return false;
  const span = window.filter(m => m >= seen[0]).length;
  const sums = seen.map(m => months.get(m).sum);
  const med = median(sums);
  const steady = sums.filter(v => Math.abs(v - med) <= 0.3 * Math.abs(med)).length;
  const counts = seen.map(m => months.get(m).n);
  const perMonth = median(counts);
  const steadyCount = counts.filter(n => n === perMonth).length >= 0.7 * counts.length;
  return seen.length / span >= 0.7 && steady >= 0.7 * seen.length && perMonth <= 4 && steadyCount && med > 0;
}
// whole history, or just the last 6 months (a plan that changed, e.g. new policies added, is regular again)
const recentMonths = completeMonths.slice(-6);
const fixedKeys = new Set();
for (const [key, months] of series) {
  if (isRegular(months, completeMonths) || isRegular(months, recentMonths)) fixedKeys.add(key);
}
for (const t of out) {
  if (!t.key) continue;
  const text = `${t.desc} ${t.memo ?? ''}`;
  if (variableRules.some(r => r.test(text))) t.flow = 'variable';
  else if (t.instT || fixedRules.some(r => r.test(text)) || fixedKeys.has(t.key)) t.flow = 'fixed';
  else t.flow = 'variable';
  const ovFlow = overrideOf.get(t)?.flow;
  if (ovFlow === 'fixed' || ovFlow === 'variable') t.flow = ovFlow; // manual choice in the dashboard
}

// ---------- salary paid at the end of the month funds the next month ----------
// Employers pay on the last day of the month or on the 1st, so by calendar date one month gets two
// paychecks and the next gets none. Fixed income from the 25th on moves to the next month, unless
// that month already has its own payment from the same payer. Latest first, so a chain of
// end-of-month payments shifts consistently.
const SALARY_SHIFT_FROM_DAY = 25;
const nextMonth = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7); };
const fixedIncome = out.filter(t => t.kind === 'income' && t.flow === 'fixed').sort((a, b) => (a.d < b.d ? 1 : -1));
const incomeMonths = new Map();
for (const t of fixedIncome) {
  if (!incomeMonths.has(t.key)) incomeMonths.set(t.key, new Map());
  const months = incomeMonths.get(t.key);
  months.set(t.m, (months.get(t.m) ?? 0) + 1);
}
// Only payers that pay around the month boundary: they also paid on the 1st–5th at some point
// (e.g. a salary paid on 31/7, 1/9, 1/10). ביטוח לאומי pays on the 22nd–28th for the current month, so its
// 28th payment must stay in its own month.
// A boundary payer pays on the 1st–5th at least 30% of the time; one late payment doesn't make one.
const dayOf = t => +t.d.slice(8, 10);
const boundaryPayers = new Set([...incomeMonths.keys()].filter(key => {
  const rows = fixedIncome.filter(t => t.key === key);
  return rows.filter(t => dayOf(t) <= 5).length / rows.length >= 0.3;
}));
let shifted = 0;
for (const t of fixedIncome) {
  if (+t.d.slice(8, 10) < SALARY_SHIFT_FROM_DAY || !boundaryPayers.has(t.key)) continue;
  const months = incomeMonths.get(t.key);
  const to = nextMonth(t.m);
  if (months.get(to)) continue;
  months.set(t.m, months.get(t.m) - 1);
  months.set(to, 1);
  t.m = to;
  t.early = true; // paid in the previous month, counted in this one
  shifted++;
}
// Late payment: paid on the 1st–5th while the previous month got none and this month has another one
// (ביטוח לאומי for February arrived on 1/3, next to March's on 26/3) → it belongs to the previous month.
const prevMonth = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7); };
for (const t of [...fixedIncome].reverse()) {
  if (t.early || dayOf(t) > 5 || boundaryPayers.has(t.key)) continue;
  const months = incomeMonths.get(t.key);
  const from = prevMonth(t.m);
  if ((months.get(t.m) ?? 0) < 2 || months.get(from)) continue;
  months.set(t.m, months.get(t.m) - 1);
  months.set(from, 1);
  t.m = from;
  t.late = true; // paid in the next month, counted in this one
  shifted++;
}

const futureDebits = [];
for (const [id, s] of Object.entries(store.sources ?? {})) {
  for (const f of s.futureDebits ?? []) {
    futureDebits.push({ src: SOURCE_NAMES[id] ?? s.name, amount: f.amount, currency: f.amountCurrency, date: localDay(f.chargeDate) });
  }
}

const payload = {
  generatedAt: new Date().toISOString(),
  today: TODAY,
  demo,
  // sync status per source: last successful scrape, last failure since then, newest transaction date
  sources: Object.entries(store.sources ?? {}).map(([id, s]) => ({
    id, name: SOURCE_NAMES[id] ?? s.name, kind: s.kind,
    lastScrape: s.lastScrape ?? null,
    lastFailure: s.lastFailure ?? null,
    newest: store.transactions.filter(t => t.source === id).map(t => localDay(t.date)).sort().pop() ?? null,
  })),
  futureDebits,
  tracked: rules.tracked ?? [],
  fixedGroups: rules.fixedGroups ?? [],
  extraCategories: rules.extraCategories ?? [],
  // fixed payees removed from the forecast in the dashboard: { <series key>: { from: "YYYY-MM" } }
  stopExpecting: overrides.stopExpecting ?? {},
  // bank account balances as of the last successful scrape (cards' "balance" means different things per
  // company, so only bank accounts are shown as balance)
  // planned items entered in the dashboard (server.mjs writes data/settings.json)
  ...(() => {
    const file = dataFile('settings.json');
    const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    return { planned: s.planned ?? [] };
  })(),
  balances: Object.entries(store.sources ?? {})
    .filter(([, s]) => s.kind === 'bank')
    .flatMap(([id, s]) => (s.accounts ?? []).map(a => ({
      src: SOURCE_NAMES[id] ?? s.name, account: a.accountNumber,
      balance: typeof a.balance === 'number' && Number.isFinite(a.balance) ? a.balance : null, asOf: s.lastScrape,
    }))),
  // expected amounts set in the dashboard (server.mjs writes data/budgets.json)
  budgets: fs.existsSync(dataFile('budgets.json'))
    ? JSON.parse(fs.readFileSync(dataFile('budgets.json'), 'utf8'))
    : {},
  firstFullMonth,
  transactions: out,
};
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `window.SPENDING = ${JSON.stringify(payload)};\n`);
if (demo) fs.writeFileSync(DEMO_MARKER, '');
else fs.rmSync(DEMO_MARKER, { force: true });

const spend = out.filter(t => t.kind === 'spend');
console.log(
  `${out.length} rows: ${spend.length} spending, ${counts.cardBill} card bills matched to card data (not counted), ` +
    `${counts.ignored} ignored, ${out.filter(t => t.kind === 'income').length} income.`,
);
if (overrideCounts.txn || overrideCounts.merchant) {
  console.log(`Manual changes applied: ${overrideCounts.txn} by transaction, ${overrideCounts.merchant} by merchant.`);
}
if (residuals.length) console.log(`\nCard bills that differ from the card's itemized total:\n  ${residuals.join('\n  ')}`);
if (unmatchedBills.length) {
  console.log(`\nWARNING: card bills with no matching card charge day (counted as spending):\n  ${unmatchedBills.join('\n  ')}`);
}
if (uncategorized.size) {
  const top = [...uncategorized].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`\nLargest uncategorized descriptions (add rules for these in rules.json):`);
  for (const [desc, amt] of top) console.log(`  ₪${Math.round(amt).toString().padStart(7)}  ${desc}`);
}
console.log(`\nWrote ${path.relative(process.cwd(), OUT_FILE)}. Open dashboard/index.html in your browser.`);
