// Local backups of data files before they are overwritten. Everything stays in data/backups/.
//   backupFile(file, { keep, daily }) copies <file> to data/backups/<name>.<timestamp>.json
//   daily: at most one copy per day (for the large scraped data file)
//   keep:  how many copies of that file to keep (oldest are deleted)
import fs from 'node:fs';
import path from 'node:path';

export function backupFile(file, { keep = 50, daily = false, root = path.dirname(file) } = {}) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(root, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(file, '.json');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, ''); // 2026-10-09T16-24-22-123
  const day = stamp.slice(0, 10);
  const existing = fs.readdirSync(dir).filter(f => f.startsWith(`${base}.`) && f.endsWith('.json')).sort();
  if (daily && existing.some(f => f.startsWith(`${base}.${day}`))) return null;
  // never overwrite an earlier copy, even for two saves within the same millisecond
  let target = path.join(dir, `${base}.${stamp}.json`);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base}.${stamp}-${i}.json`);
  fs.copyFileSync(file, target);
  existing.push(path.basename(target));
  for (const old of existing.slice(0, Math.max(0, existing.length - keep))) fs.rmSync(path.join(dir, old), { force: true });
  return target;
}
