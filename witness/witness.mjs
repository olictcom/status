/* The independent witness: asks olict.com for its homepage from GitHub's network, outside the
   hosting it checks, and keeps the answer in witness.json (branch `witness` of this repository).
   status.olict.com reads that file, so it has something true to say when its own monitoring
   cannot be reached.

   node witness/witness.mjs <path to witness.json>
   Exits 1 when olict.com did not answer 200 twice in a row, so the workflow run fails and GitHub
   e-mails the repository's owner. The file is written either way. */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DAY = 86400000;
const WINDOW = 90;
const TIMEOUT = 8000;
const dayId = (ms) => new Date(ms).toISOString().slice(0, 10);   // UTC

const usable = (p) => p && typeof p.from === 'string' && !Number.isNaN(Date.parse(`${p.from}T00:00:00Z`))
  && [p.ok90, p.total90].every((a) => Array.isArray(a) && a.length === WINDOW && a.every(Number.isFinite));

// The last 90 UTC days, oldest first, today last. Days with no run stay zero.
export function update(prev, check, now) {
  const from = dayId(now - (WINDOW - 1) * DAY);
  const shift = usable(prev) ? Math.round((Date.parse(`${from}T00:00:00Z`) - Date.parse(`${prev.from}T00:00:00Z`)) / DAY) : WINDOW;
  const roll = (arr) => {
    const kept = shift >= 0 && shift < WINDOW ? arr.slice(shift) : [];
    return kept.concat(Array(WINDOW - kept.length).fill(0));
  };
  const ok90 = roll(usable(prev) ? prev.ok90 : []);
  const total90 = roll(usable(prev) ? prev.total90 : []);
  total90[WINDOW - 1] += 1;
  if (check.ok) ok90[WINDOW - 1] += 1;
  return { at: now, ok: check.ok, ms: check.ms, status: check.status, from, ok90, total90 };
}

async function check(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), cache: 'no-store', headers: { 'user-agent': 'olict-status-witness' } });
    await res.arrayBuffer();
    return { ok: res.status === 200, ms: Date.now() - t0, status: res.status };
  } catch {
    return { ok: false, ms: Date.now() - t0, status: 0 };
  }
}

async function main(file) {
  const url = process.env.WITNESS_URL || 'https://olict.com/';
  let prev = {};
  try { prev = JSON.parse(await readFile(file, 'utf8')); } catch { /* first run */ }
  let result = await check(url);
  if (!result.ok) {   // one slow answer is not an outage: ask again before saying so
    await new Promise((r) => setTimeout(r, 10000));
    result = await check(url);
  }
  await writeFile(file, JSON.stringify(update(prev, result, Date.now())));
  console.log(`${url} → ${result.status || 'no answer'} in ${result.ms} ms`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('usage: node witness.mjs <path to witness.json>'); process.exit(2); }
  main(process.argv[2]);
}
