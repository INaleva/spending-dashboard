# Spending dashboard (התזרים שלי)

A private, local cash-flow dashboard for Israeli bank and credit-card accounts.
The UI is in Hebrew (RTL). It runs entirely on your own computer and is built on
[israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers).

- **Private by design.** Your logins and transactions stay on your machine, in plain files under `data/`.
  The page loads nothing from the internet (no CDNs, fonts, or analytics). The only outside connections
  are the scraper logging in to your own bank and card sites.
- **Monthly cash flow.** Income − fixed expenses − variable expenses, with a forecast for the rest of the month.
- **Automatic fixed vs. variable.** Rent, loans, salary and subscriptions are detected from their monthly pattern.
- **Card bills reconciled.** The card's monthly charge on your bank account is matched to the card's itemized
  purchases, so nothing is counted twice.
- **Balance forecast.** Your bank balance projected day by day until early next month, with an overdraft warning.
- **Editable.** Move any transaction (or every transaction of a merchant) between categories, fixed/variable, or
  out of the cash flow. Set an expected monthly amount per category. Add planned payments and fund balances.
- **Demo mode.** One click fills the dashboard with made-up data, so you can try it before connecting anything.

## Requirements

- [Node.js](https://nodejs.org/) **22.22.2 or newer**
- Windows, macOS or Linux. `npm install` downloads a Chromium build (about 150 MB) that the scraper uses
  to log in.

## Install

```sh
git clone <this repository's URL> spending-dashboard
cd spending-dashboard
npm install
```

`npm install` also applies a small fix to the scraper library from `patches/` (see [Library patch](#library-patch)).

## Try it with demo data

```sh
npm run dashboard
```

This opens http://127.0.0.1:4321/ in your browser. Click **מילוי בנתוני דוגמה** (fill with demo data).
The dashboard fills with 14 months of made-up transactions. Every feature works on it, including edits.

Demo data and any edits you make to it live in separate files (`data/demo-*.json`), so they never mix with your
real data. Click **חזרה לנתונים שלי** (back to my data) in the top bar to leave the demo.

## Connect your accounts

1. Copy `.env.example` to `.env`:

   ```sh
   cp .env.example .env        # Windows (cmd): copy .env.example .env
   ```

2. Open `.env` and fill in the login details for the institutions you use. Leave the rest empty.
   A source is scraped only when all of its values are filled in.
3. Run `npm run dashboard` and click **סנכרון** (sync).

The first sync of each source fetches the last 12 months, which takes a few minutes. Later syncs fetch only
what's new: each source starts 14 days before its last successful sync.

### Supported institutions

| Institution | Kind | `.env` variables |
|---|---|---|
| Bank Hapoalim (הפועלים) | bank | `HAPOALIM_USER_CODE`, `HAPOALIM_PASSWORD` |
| Bank Leumi (לאומי) | bank | `LEUMI_USERNAME`, `LEUMI_PASSWORD` |
| Mizrahi Tefahot (מזרחי טפחות) | bank | `MIZRAHI_USERNAME`, `MIZRAHI_PASSWORD` |
| Discount (דיסקונט) | bank | `DISCOUNT_ID`, `DISCOUNT_PASSWORD`, `DISCOUNT_NUM` |
| Mercantile (מרכנתיל) | bank | `MERCANTILE_ID`, `MERCANTILE_PASSWORD`, `MERCANTILE_NUM` |
| Beinleumi (הבינלאומי) | bank | `BEINLEUMI_USERNAME`, `BEINLEUMI_PASSWORD` |
| Otsar Hahayal (אוצר החייל) | bank | `OTSAR_HAHAYAL_USERNAME`, `OTSAR_HAHAYAL_PASSWORD` |
| Massad (מסד) | bank | `MASSAD_USERNAME`, `MASSAD_PASSWORD` |
| Pagi (פאגי) | bank | `PAGI_USERNAME`, `PAGI_PASSWORD` |
| Union (איגוד) | bank | `UNION_USERNAME`, `UNION_PASSWORD` |
| Yahav (יהב) | bank | `YAHAV_USERNAME`, `YAHAV_NATIONAL_ID`, `YAHAV_PASSWORD` |
| One Zero (וואן זירו) | bank | `ONEZERO_EMAIL`, `ONEZERO_PASSWORD`, `ONEZERO_OTP_LONG_TERM_TOKEN` |
| Cal / Visa Cal (כאל) | card | `CAL_USERNAME`, `CAL_PASSWORD` |
| Max (מקס) | card | `MAX_USERNAME`, `MAX_PASSWORD` |
| Isracard (ישראכרט) | card | `ISRACARD_ID`, `ISRACARD_CARD6`, `ISRACARD_PASSWORD` |
| American Express (אמריקן אקספרס) | card | `AMEX_ID`, `AMEX_CARD6`, `AMEX_PASSWORD` |
| Beyahad Bishvilha (ביחד בשבילך) | card | `BEYAHAD_ID`, `BEYAHAD_PASSWORD` |
| Behatsdaa (בהצדעה) | card | `BEHATSDAA_ID`, `BEHATSDAA_PASSWORD` |

- `*_ID` is your national ID (תעודת זהות), 9 digits including a leading 0.
- `*_CARD6` is the **last** 6 digits of the card.
- **One Zero** logs in with an SMS code. Run `node onezero-token.mjs` once: it asks for your phone number and
  the code, then prints a long-term token for `ONEZERO_OTP_LONG_TERM_TOKEN`. Treat the token like a password.

## Commands

| Command | What it does |
|---|---|
| `npm run dashboard` | Start the local server (127.0.0.1:4321) and open the dashboard, with the sync and demo buttons |
| `npm run update` | Scrape all configured accounts, then rebuild the dashboard data |
| `npm run scrape -- --only leumi,max` | Scrape only some sources (ids listed below) |
| `npm run scrape -- --show` | Scrape with a visible browser, to watch a failing login |
| `npm run scrape -- --full` | Ignore the last sync and fetch the full 12 months again |
| `npm run scrape -- --months 6` | Fetch a specific number of months back |
| `npm run build` | Re-apply `rules.json` and your edits without scraping |
| `npm run demo` | Generate demo data from the command line (same as the button) |

Source ids for `--only`: `hapoalim`, `leumi`, `mizrahi`, `discount`, `mercantile`, `beinleumi`,
`otsarHahayal`, `massad`, `pagi`, `union`, `yahav`, `oneZero`, `visaCal`, `max`, `isracard`, `amex`,
`beyahadBishvilha`, `behatsdaa`.

## Using the dashboard

- **שינוי** (change), on any transaction: change its category, move it between fixed and variable, mark it
  outside the cash flow (לא בתזרים), or mark it one-off (חד־פעמי: counts this month, left out of later averages).
  Apply it to that transaction only, or to every transaction of the merchant, including future ones.
  **החזרה לאוטומטי** undoes a change.
- **שינוי הצפי** (change the expectation), on a category: set how much you expect to spend in it each month.
  It applies from this month on. **חזרה לממוצע 3 חודשים** goes back to the automatic 3-month average.
- **הסרה מהצפי** (stop expecting), on a fixed charge that hasn't arrived yet: use it for a cancelled policy or a
  finished loan. **החזרה** brings it back.
- **תנועות מתוכננות** (planned items), in the balance card: money you've arranged that the bank doesn't show yet.
  The forecast counts it until a matching bank row arrives.

## How the numbers are calculated

- **Cash flow (תזרים)** = income − fixed expenses − variable expenses. Card purchases count on the purchase date;
  installments count in the month they are charged.
- **Fixed** (income or expense): a payee that appears about once a month, almost every month, with a similar
  amount, plus installments and anything matched by `rules.json` → `fixed`.
- **Expected this month**: fixed items not paid yet (by their usual gap), the next installments, and for
  variable spending the expected amount per category (your saved amount, else the average of the previous
  3 months).
- **Card bills on the bank account**: when the card is scraped too, the bank row is matched to the card's charge
  day and dropped, because the card's itemized purchases already count. Any part of the bill the card data
  doesn't itemize stays as "<card> – ללא פירוט". If you don't scrape a card, its bank charge counts as spending.
- **Outside the cash flow (לא בתזרים)**: savings, investments, pension deposits and loans received
  (`rules.json` → `ignore`).
- **Salary at the end of the month**: a payer who sometimes pays on the 1st–5th and sometimes on the 25th+ is
  counted in the month the money is for, so each month gets one payment.

## Customizing: `rules.json`

`rules.json` holds every rule you can tune. Its `_help` section explains each part:

- `cardBills`: how each card's bill appears on your bank account, so it can be matched to the card.
- `ignore`: rows outside the cash flow.
- `fixed` / `variable`: force a description into fixed or variable.
- `categories`: map descriptions to categories. Bank rows have no category of their own.
- `tracked`: the category cards on the dashboard and which categories each one groups.
- `fixedGroups`: how the fixed-expenses breakdown is grouped.
- `aliases`: rename or merge the card companies' categories.
- `extraCategories`: extra categories offered in the שינוי dialog.

Patterns are case-insensitive regular expressions. After `npm run build`, the console lists the largest
uncategorized descriptions, so you know which rules to add. Edits made in the dashboard don't change
`rules.json`; they're saved in `data/overrides.json`.

## Where your data lives

| File | Contents |
|---|---|
| `.env` | Your logins |
| `data/transactions.json` | Scraped transactions, sync status and bank balances |
| `data/overrides.json` | Your edits from the dashboard |
| `data/budgets.json` | Expected amounts per category |
| `data/settings.json` | Planned items and fund balances |
| `data/backups/` | A copy of each of these files before it's overwritten |
| `data/demo-*.json` | Demo data and edits made while in demo mode |
| `dashboard/data.js` | What the page reads; rebuilt from the files above |

All of these are listed in `.gitignore`. Don't commit, upload or share them. They aren't encrypted, so keep
your disk encrypted (BitLocker / FileVault) if your computer is shared or portable.

## Security

- The server listens on `127.0.0.1` only. Every start creates a random token that the page needs for its data
  and for the sync and save requests, so other websites open in your browser can't read your data or start a sync.
- When a scrape fails, the error is printed with your credential values replaced by `***`.

## Troubleshooting

- **A login fails.** Run `npm run scrape -- --only <id> --show` to watch it in a visible browser. Many failures
  are a password that needs changing on the bank's website, or a one-time confirmation screen.
- **Isracard / Amex: `GENERIC: fetchPostWithinPage parse error: Unexpected token '<', "<!DOCTYPE"`.** The site's bot
  protection returned a block page. `scrape.mjs` already applies the workaround from upstream issue
  [#1181](https://github.com/eshaham/israeli-bank-scrapers/issues/1181). Don't retry in a loop: Isracard can
  block your IP address.
- **A card's bill shows up as "<card> – ללא פירוט" every month.** Add or fix its pattern in `rules.json` →
  `cardBills`, so the bank row is recognized as that card's bill.
- **The sync button doesn't appear.** You opened `dashboard/index.html` as a file. Use `npm run dashboard` instead.

## Library patch

`patches/israeli-bank-scrapers+6.12.2.patch` fixes how the Beinleumi-group banks (Beinleumi, Otsar Hahayal,
Massad, Pagi) read the account balance. Without it, a balance with a hidden direction mark or a trailing minus
(`1,234.56-`) is read as empty or positive. [patch-package](https://github.com/ds300/patch-package) applies it
on `npm install`. If you upgrade `israeli-bank-scrapers`, check whether the patch is still needed.

## Disclaimer

This is a personal project, not affiliated with any bank or credit-card company. Automated access to
your accounts may be against an institution's terms of use. You use it at your own risk. The numbers are
estimates, not financial advice.

## Credits

- [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers) does the scraping.
- The [Rubik](https://fonts.google.com/specimen/Rubik) font is included under the SIL Open Font License
  (`dashboard/fonts/OFL-LICENSE.txt`).
