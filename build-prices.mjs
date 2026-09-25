// Scotland's Wild price feed builder, v1.0 (25 Sep 2026)
// Reads every upcoming departure from Checkfront, finds each tour's lowest adult
// price, and writes docs/prices.json for the website to read.
// Run by .github/workflows/update-prices.yml. Needs Node 20+ (built-in fetch).

import { readFile, writeFile, appendFile } from 'node:fs/promises';

// ---------- core (no Node-only code, so it can also be tested in a browser) ----------
export async function computeFeed(config, fetchJson, now = new Date()) {
  const today = londonDate(now);
  const dates = [];
  for (let i = 0; i <= config.horizonDays; i += 1) dates.push(addDays(today, i));

  const departures = {};            // id -> { yyyymmdd: adultPrice }
  Object.keys(config.tours).forEach(id => { departures[id] = {}; });

  const jobs = [];
  config.categories.forEach(cat => dates.forEach(d => jobs.push({ cat, d })));

  let failures = 0;
  let lastError = '';
  await pool(jobs, 4, async ({ cat, d }) => {
    const url = `${config.checkfront}/item?category_id=${cat}&start_date=${d}&end_date=${d}&param[adults]=1`;
    let data;
    try { data = await fetchJson(url); } catch (e) { failures += 1; lastError = String(e && e.message || e); return; }
    const items = (data && data.items) || {};
    Object.values(items).forEach(item => {
      const id = String(item.item_id);
      const rate = item.rate || {};
      if (!departures[id] || rate.status !== 'AVAILABLE' || !rate.slip) return;
      const m = String(rate.slip).match(/^\d+\.(\d{8})/);
      if (!m || m[1] < today) return;
      const available = rate.available === undefined ? 1 : Number(rate.available);
      const adult = Number(rate.sub_total);
      if (!(available > 0) || !(adult > 0)) return;
      departures[id][m[1]] = adult;
    });
  });

  const tours = {};
  Object.entries(config.tours).forEach(([id, t]) => {
    const list = Object.entries(departures[id]).sort((a, b) => a[0].localeCompare(b[0]));
    if (!list.length) {
      tours[id] = { name: t.name, from: null, deposit: null, depositPct: t.depositPct, departures: 0 };
      return;
    }
    const from = Math.min(...list.map(x => x[1]));
    const atFrom = list.filter(x => x[1] === from).map(x => x[0]);
    const needed = Math.max(config.selectedDatesMinCount, Math.ceil(config.selectedDatesShare * list.length));
    tours[id] = {
      name: t.name,
      from: round2(from),
      deposit: round2(from * t.depositPct / 100),
      depositPct: t.depositPct,
      selectedDates: atFrom.length < needed,
      cheapestDates: atFrom.slice(0, 8),
      departuresAtFrom: atFrom.length,
      departures: list.length,
      nextDeparture: list[0][0]
    };
  });

  const groups = {};
  Object.entries(config.groups).forEach(([name, cats]) => {
    const vals = Object.entries(config.tours)
      .filter(([id, t]) => cats.includes(t.category) && tours[id].from != null)
      .map(([id]) => tours[id].from);
    groups[name] = vals.length ? Math.min(...vals) : null;
  });

  return {
    version: 1,
    generated: now.toISOString(),
    checkedFrom: today,
    requests: jobs.length,
    failedRequests: failures,
    lastError: lastError || undefined,
    tours,
    groups
  };
}

function londonDate(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return p.year + p.month + p.day;
}
function addDays(yyyymmdd, n) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
function round2(n) { return Math.round(n * 100) / 100; }
async function pool(items, size, worker) {
  let i = 0;
  const runners = Array.from({ length: size }, async () => {
    while (i < items.length) { const item = items[i++]; await worker(item); }
  });
  await Promise.all(runners);
}

// ---------- Node runner ----------
async function main() {
  const config = JSON.parse(await readFile('tours.json', 'utf8'));
  let previous = null;
  try { previous = JSON.parse(await readFile('docs/prices.json', 'utf8')); } catch (e) { /* first run */ }

  const headers = { 'Accept': 'application/json', 'User-Agent': 'scotlandswild-price-feed/1.0' };
  if (process.env.CF_KEY && process.env.CF_SECRET) {
    headers.Authorization = 'Basic ' + Buffer.from(process.env.CF_KEY + ':' + process.env.CF_SECRET).toString('base64');
  }
  const fetchJson = async (url) => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await fetch(url, { headers });
      if (res.ok) return res.json();
      if (res.status === 401 || res.status === 403) throw new Error('Checkfront refused the request (' + res.status + '). Add CF_KEY and CF_SECRET secrets.');
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
    throw new Error('Checkfront request failed: ' + url);
  };

  const feed = await computeFeed(config, fetchJson);

  // Safety checks: never publish a broken or half-empty feed.
  const total = Object.values(feed.tours).reduce((s, t) => s + t.departures, 0);
  const prevTotal = previous ? Object.values(previous.tours || {}).reduce((s, t) => s + (t.departures || 0), 0) : 0;
  if (feed.failedRequests > feed.requests * 0.05) throw new Error(`Too many failed Checkfront requests (${feed.failedRequests}/${feed.requests}). Last error: ${feed.lastError}. Feed not updated.`);
  if (total === 0 || (prevTotal && total < prevTotal * 0.5)) throw new Error(`Only ${total} departures found (last run: ${prevTotal}). Feed not updated.`);

  // Keep a tour's last known price if it has nothing on sale right now.
  if (previous) {
    Object.entries(feed.tours).forEach(([id, t]) => {
      const old = previous.tours && previous.tours[id];
      if (t.from == null && old && old.from != null) {
        feed.tours[id] = Object.assign({}, old, { departures: 0, onSale: false });
      }
    });
  }

  // What changed on the website?
  const changes = [];
  Object.entries(feed.tours).forEach(([id, t]) => {
    const old = previous && previous.tours && previous.tours[id];
    if (!old || old.from !== t.from || old.selectedDates !== t.selectedDates) {
      changes.push(`- ${t.name} (item ${id}): ${old && old.from != null ? '£' + old.from : 'new'} → ${t.from != null ? '£' + t.from : 'not on sale'}${t.selectedDates ? ' (on selected dates)' : ''}`);
    }
  });
  Object.entries(feed.groups).forEach(([name, v]) => {
    const old = previous && previous.groups && previous.groups[name];
    if (old !== v) changes.push(`- Lowest "${name}" price: ${old != null ? '£' + old : 'new'} → £${v}`);
  });

  const today = feed.checkedFrom;
  const prevDay = previous && previous.checkedFrom;
  const changed = changes.length > 0 || prevDay !== today;
  if (changed) await writeFile('docs/prices.json', JSON.stringify(feed, null, 1) + '\n');

  if (changes.length && previous) {
    await writeFile('changes.md', [
      'The website "from" prices have changed:', '', ...changes, '',
      'The website updates itself. Please also update by hand:',
      '- Squarespace SEO titles and descriptions that mention these prices',
      '- llms.txt',
      '- VisitScotland, TripAdvisor, Google Business Profile, OTAs and ads', ''
    ].join('\n'));
  }
  console.log(`Departures: ${total}. Requests: ${feed.requests}, failed: ${feed.failedRequests}.`);
  console.log(changes.length ? changes.join('\n') : 'No price changes.');
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nheadline=${changes.length > 0 && !!previous}\n`);
  }
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('build-prices.mjs')) {
  main().catch(err => { console.error(err.message || err); process.exit(1); });
}
