# spending-dashboard

Local cash-flow dashboard (Hebrew, RTL) for Israeli bank and card accounts, built on the npm
package `israeli-bank-scrapers` (pinned, with `patches/` applied by patch-package on install).
User-facing docs: README.md.

## Files
- `scrape.mjs` — scrapes every source in `SOURCES` whose env vars are all set in `.env`, merges into
  `data/transactions.json`. `--only a,b`, `--show`, `--months N`, `--full`.
- `build.mjs` — categorizes, reconciles card bills, classifies fixed/variable, writes `dashboard/data.js`.
  `--demo` reads/writes `data/demo-*.json` instead and leaves the marker `data/.demo`; a normal build removes it.
- `demo.mjs` — seeded fake data → `data/demo-transactions.json`, `data/demo-settings.json`.
- `rules.json` — all user-tunable rules (`_help` documents each section).
- `server.mjs` — `npm run dashboard`: serves the page on 127.0.0.1:4321; sync (scrape + build), demo on/off
  (`POST /api/demo?on=1|0`), and the edit APIs. While `data/.demo` exists, edits go to `data/demo-*.json`
  and rebuild with `--demo`, so the demo never touches real data.
- `backup.mjs` — copies a file to `data/backups/<name>.<timestamp-ms>.json` before it's overwritten.
- `onezero-token.mjs` — one-time SMS flow that prints a One Zero long-term token for `.env`.
- `dashboard/index.html` — the whole UI, vanilla JS, no build step.
- `dashboard/fonts/` — Rubik woff2 files stored locally (SIL OFL). The page must load **nothing** from the
  internet: no CDNs, Google Fonts, analytics. Keep it that way.

## Privacy rules
- `.env`, `data/` and `dashboard/data.js` hold credentials / financial data: never print, commit, upload or
  publish them. Don't put real merchant names, account numbers or amounts in code, comments, rules or docs.
- Scraper `errorMessage` can echo request bodies incl. the password; `scrape.mjs` masks credential values
  before printing. `sources.<id>.lastFailure` keeps only `{at, errorType}`, never the message.

## Library patch
`patches/israeli-bank-scrapers+6.12.2.patch`: Beinleumi-group `getCurrentBalance` used `parseFloat` on the
`.main_balance` text → NaN when it starts with a bidi mark/label, and a trailing minus ("1,234.56-") read as
positive. Adds `parseBalance` (strips bidi marks, first number, minus on either side). Re-check after upgrading.

## Hard-won knowledge
- **Isracard/Amex bot protection**: `ValidateIdData` can return an HTML block page →
  `GENERIC: fetchPostWithinPage parse error: Unexpected token '<'`. `scrape.mjs` (`BOT_PROTECTED`) launches its
  own puppeteer with `ignoreDefaultArgs: ['--enable-automation']`, hides `navigator.webdriver`, sends a Hebrew
  `accept-language`, `navigationRetryCount: 3` (upstream issue #1181, PR #1186). Don't retry blocked logins in a
  loop — Isracard can block the IP.
- `card6Digits` for Isracard/Amex = the **last** 6 digits of the card.
- **Checkpoints**: each source stores `sources.<id>.checkpoint` (start of its last *successful* scrape); the next
  scrape starts checkpoint − 14 days (earlier if a pending row is older). No checkpoint → 12 months back.
  Cards run with `outputData.enableTransactionsFilterByDate: false` so installments of older purchases aren't
  dropped; the merge dedupes (identical rows are kept by count, not collapsed).
- **Card bills on the bank** (`rules.json` → `cardBills`): each bank row is matched to the card's charge day
  (value date "(תאריך ערך DD/MM)" when present, up to 4 days back) and excluded; the un-itemized remainder is kept as
  "<card> – ללא פירוט" on the paying bank.
- Rules can be limited by `sources` (scraper ids) and/or `kind` (`bank` | `card`).
- **Manual changes** live in `data/overrides.json` (never touched by scrapes): `transactions[<16-hex row id>]` or
  `merchants["in|out|<merchant key>"]` → `{cat, flow, exclude, oneOff}`; transaction-level wins. Row id = sha1 of the
  merge-key fields (changes when a pending row settles → prefer merchant scope). `stopExpecting[<series key>] = {from}`.
- **Expected amounts**: variable spending is split into parts — each `tracked` group (`group:<name>`) and every other
  variable category (`cat:<name>`). Part expected = saved amount from `data/budgets.json`
  (`{key: [{from: "YYYY-MM", amount|null}]}`) else the previous-3-month average (one-offs excluded). Month forecast
  for variable = Σ max(spent, expected) per part; "נשאר להוציא" = Σ max(0, expected − spent).
- **Fixed detection** (`isRegular` in build.mjs): regular over the whole history OR the last 6 complete months;
  up to 4 charges/month if the count is steady (insurers charge several policies).
- **Income month alignment**: "early" (day ≥25, boundary payers only — ≥30% of their payments on the 1st–5th)
  moves to the next month; "late" (day ≤5 when the previous month has none and this month has two) moves back.
  Fixed income stays expected up to one missed cycle; fixed expenses don't.
- **Installment plan identity** (`row.plan`) = source|card|merchant|number of payments|full purchase amount — not the
  monthly amount (first payment often differs) and not the voucher id (Amex issues one per payment).
- **Balance forecast** ("תחזית יתרה"): bank balance → day by day to the 5th of next month: known card charges on
  their `pd`; estimated rest-of-month card spending on the main card's next charge day; bank fixed items on their
  usual day; bank share of remaining variable at month end; next month's bank fixed items due 1st–5th; planned items
  until a matching bank row (same sign, amount ±1%, day −3…+7) arrives or a week passes.
- **Month rollover**: the page's "today" = later of the browser date (Asia/Jerusalem) and the build's.
  `DASHBOARD_TODAY=YYYY-MM-DD node build.mjs` simulates a day (testing only).
- Card purchases count by purchase date; installments by charge month. Data dates are UTC instants of Israeli
  midnight → always convert with Asia/Jerusalem.
- `Element.append(null)` renders the text "null" — filter before appending (the `h()` helper already does).
