// One Zero logs in with an SMS code. Run this once to get a long-term token for .env:
//   node onezero-token.mjs
// It asks for your phone number, One Zero sends an SMS, you type the code, and it prints the token.
// Put it in .env as ONEZERO_OTP_LONG_TERM_TOKEN. Treat it like a password.
import readline from 'node:readline/promises';
import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const phone = (await rl.question('Phone number in international format (e.g. +972501234567): ')).trim();
const scraper = createScraper({ companyId: CompanyTypes.oneZero, startDate: new Date() });
const sent = await scraper.triggerTwoFactorAuth(phone);
if (!sent.success) {
  console.error(`Could not send the SMS: ${sent.errorMessage ?? sent.errorType}`);
  process.exit(1);
}
const code = (await rl.question('Code from the SMS: ')).trim();
rl.close();
const result = await scraper.getLongTermTwoFactorToken(code);
if (!result.success) {
  console.error(`The code was not accepted: ${result.errorMessage ?? result.errorType}`);
  process.exit(1);
}
console.log(`\nONEZERO_OTP_LONG_TERM_TOKEN=${result.longTermTwoFactorAuthToken}`);
