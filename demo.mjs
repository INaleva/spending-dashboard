// Generates fake data in data/demo-transactions.json (and data/demo-settings.json) so the dashboard can be
// previewed without logging in anywhere. Seeded, so every run produces the same data. Your own data files
// (data/transactions.json etc.) are never touched.
import fs from 'node:fs';
import path from 'node:path';

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const between = (a, b) => Math.round((a + rand() * (b - a)) * 100) / 100;
const pick = arr => arr[Math.floor(rand() * arr.length)];

const today = new Date();
const start = new Date(today.getFullYear(), today.getMonth() - 14, 1);
// Israeli local midnight as a UTC instant, like the scrapers return
const iso = (y, m, d) => new Date(Date.UTC(y, m, d) - 2 * 3600000).toISOString();
const isPast = (y, m, d) => new Date(y, m, d) <= today;

const sources = {
  beinleumi: { name: 'Beinleumi', kind: 'bank' },
  visaCal: { name: 'Cal', kind: 'card' },
  isracard: { name: 'Isracard', kind: 'card' },
};
const rows = [];
let n = 1;
function add(source, y, m, d, amount, description, category, extra = {}) {
  if (!isPast(y, m, d)) return;
  const s = sources[source];
  const card = s.kind === 'card';
  const recent = (today - new Date(y, m, d)) / 86400000 < 3;
  rows.push({
    source,
    sourceName: s.name,
    sourceKind: s.kind,
    account: card ? '1234' : '12-345-678901',
    identifier: n++,
    type: 'normal',
    status: recent ? 'pending' : 'completed',
    date: iso(y, m, d),
    processedDate: card ? iso(y, m + 1, 10) : iso(y, m, d),
    originalAmount: -amount,
    originalCurrency: 'ILS',
    chargedAmount: -amount,
    chargedCurrency: 'ILS',
    description,
    memo: null,
    category: card ? category : null,
    installments: null,
    ...extra,
  });
}

for (let dt = new Date(start); dt <= today; dt.setMonth(dt.getMonth() + 1)) {
  const y = dt.getFullYear();
  const m = dt.getMonth();
  const monthsAgo = (today.getFullYear() - y) * 12 + today.getMonth() - m;

  // bank account
  add('beinleumi', y, m, 1, -18500, 'משכורת', null);
  add('beinleumi', y, m, 2, 4200, 'הלוואה משכנתא', null);
  add('beinleumi', y, m, 2, 12, 'עמלת פעולה בערוץ ישיר', null);
  if (m % 2 === 0) add('beinleumi', y, m, 15, 640, 'עיריית תל אביב ארנונה', null);
  if (m % 2 === 1) add('beinleumi', y, m, 20, between(330, m >= 6 && m <= 8 ? 690 : 450), 'חברת החשמל לישראל', null);
  add('beinleumi', y, m, 5, 1500, 'העברה לחיסכון', null);

  // Cal
  for (const d of [3, 10, 17, 24]) add('visaCal', y, m, d, between(320, 640), pick(['שופרסל דיל', 'רמי לוי', 'יוחננוף']), 'מזון וצריכה');
  for (let i = 0; i < 2 + Math.floor(rand() * 4); i++)
    add('visaCal', y, m, 1 + Math.floor(rand() * 27), between(45, 260), pick(['קפה קפה', 'ארומה', 'מוזס', 'פיצה האט']), 'מסעדות, קפה וברים');
  for (const d of [6, 19]) add('visaCal', y, m, d, between(260, 340), pick(['פז דלק', 'סונול']), 'תחבורה ורכבים');
  add('visaCal', y, m, 12, 54.9, 'NETFLIX.COM', 'שירותי תקשורת');
  add('visaCal', y, m, 14, 21.9, 'SPOTIFY', 'שירותי תקשורת');
  if (rand() < 0.5) add('visaCal', y, m, 8, between(40, 180), 'סופר-פארם', 'רפואה ובתי מרקחת');

  // Isracard
  add('isracard', y, m, 4, 59, 'פרטנר תקשורת', 'שירותי תקשורת');
  add('isracard', y, m, 1, monthsAgo <= 1 ? 279 : 249, 'הולמס פלייס', 'פנאי, בידור וספורט');
  if (rand() < 0.4) add('isracard', y, m, 16, between(150, 520), pick(['קסטרו', 'ZARA', 'H&M']), 'אופנה');
  if (rand() < 0.25) add('isracard', y, m, 22, between(120, 600), 'איקאה', 'ריהוט ובית');
  for (let i = 0; i < 2; i++) add('isracard', y, m, 9 + i * 11, between(30, 140), pick(['גט טקסי', 'רב-קו']), 'תחבורה ורכבים');

  // planted signals: a new subscription, and a one-off car repair
  if (monthsAgo <= 2) add('visaCal', y, m, 18, 39.9, 'DISNEY PLUS', 'שירותי תקשורת');
  if (monthsAgo === 2) add('isracard', y, m, 11, 3400, 'מוסך השלום', 'תחבורה ורכבים');
}

// a TV bought in 12 installments five months ago
const tv = new Date(today.getFullYear(), today.getMonth() - 5, 13);
for (let i = 1; i <= 12; i++) {
  const charge = new Date(tv.getFullYear(), tv.getMonth() + i, 10);
  if (charge > today) break;
  rows.push({
    source: 'isracard', sourceName: 'Isracard', sourceKind: 'card', account: '1234', identifier: n++,
    type: 'installments', status: 'completed',
    date: iso(tv.getFullYear(), tv.getMonth(), tv.getDate()),
    processedDate: iso(charge.getFullYear(), charge.getMonth(), 10),
    originalAmount: -4800, originalCurrency: 'ILS', chargedAmount: -400, chargedCurrency: 'ILS',
    description: 'KSP מחשבים', memo: `תשלום ${i} מתוך 12`, category: 'מוצרי חשמל',
    installments: { number: i, total: 12 },
  });
}

// each card's monthly bill on the bank account = the card's charges for that charge day
const BILL_DESC = { visaCal: 'כאל-כרטיסי אשראי', isracard: 'ישראכרט' };
const bills = new Map();
for (const t of [...rows]) {
  if (t.sourceKind !== 'card') continue;
  const day = new Date(Date.parse(t.processedDate) + 2 * 3600000); // back to the Israeli calendar day
  const key = `${t.source}|${day.getUTCFullYear()}|${day.getUTCMonth()}|${day.getUTCDate()}`;
  bills.set(key, (bills.get(key) ?? 0) - t.chargedAmount);
}
for (const [key, total] of bills) {
  const [card, y, m, d] = key.split('|');
  add('beinleumi', +y, +m, +d, Math.round(total * 100) / 100, BILL_DESC[card], null);
}

const store = {
  sources: Object.fromEntries(
    Object.entries(sources).map(([id, s]) => [
      id,
      { ...s, lastScrape: today.toISOString(),
        accounts: s.kind === 'bank' ? [{ accountNumber: '12-345-678901', balance: 6230.5 }] : [],
        futureDebits: s.kind === 'card'
        ? [{ amount: id === 'visaCal' ? 4630 : 6120, amountCurrency: 'ILS', chargeDate: iso(today.getFullYear(), today.getMonth(), 10) }]
        : [] },
    ]),
  ),
  transactions: rows,
};
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(path.resolve('data/demo-transactions.json'), JSON.stringify(store, null, 1));

// one planned payment, so the balance card shows it
const inDays = k => new Date(today.getFullYear(), today.getMonth(), today.getDate() + k).toLocaleDateString('en-CA');
fs.writeFileSync(path.resolve('data/demo-settings.json'), JSON.stringify({
  planned: [{ id: 'de0de0de0de0', day: inDays(6), amount: -1200, label: 'מקדמה לחופשה (דוגמה)', createdAt: today.toISOString() }],
}, null, 1));
console.log(`Demo: ${rows.length} fake transactions written to data/demo-transactions.json`);
