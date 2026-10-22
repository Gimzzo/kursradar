// Kursradar-Datenfeed: läuft alle 15 Minuten in GitHub Actions und schreibt data/*.json.
// Die App lädt diese Dateien von derselben Domain (kein CORS, keine fremden Proxys).
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const NOW = Date.now();
const status = { at: NOW, ok: {}, errors: {} };

async function get(url, { timeout = 20000, json = false, headers = {} } = {}) {
  const ctl = new AbortController(); const id = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA, 'accept': json ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*', 'accept-language': 'de-DE,de;q=0.9,en;q=0.7', ...headers }, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return json ? r.json() : r.text();
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'Timeout' : e.message); }
  finally { clearTimeout(id); }
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(s) { return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g) => { if (g[0] === '#') { const n = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10); return isFinite(n) ? String.fromCodePoint(n) : m; } return ENT[g.toLowerCase()] ?? m; }); }
const stripTags = s => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function tag(block, name) { const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i')); return m ? m[1].trim() : ''; }
export function parseRss(xml, { limit = 25, feed = '' } = {}) {
  const out = [];
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const it of items) {
    let title = stripTags(tag(it, 'title')); if (!title) continue;
    let url = decode(tag(it, 'link')).trim(); if (!url) { const m = it.match(/<link[^>]*href="([^"]+)"/i); url = m ? decode(m[1]) : ''; }
    if (!/^https?:\/\//.test(url)) continue;
    const srcTag = stripTags(tag(it, 'source')); const dc = stripTags(tag(it, 'dc:creator'));
    let source = srcTag || ''; if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    if (!source && /google/.test(feed)) { const m = title.match(/\s-\s([^-]{2,40})$/); if (m) { source = m[1].trim(); title = title.slice(0, -m[0].length).trim(); } }
    if (!source) { try { source = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { } }
    const time = Date.parse(tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated') || tag(it, 'dc:date')) || 0;
    let summary = /news\.google\./.test(url) ? '' : stripTags(tag(it, 'description') || tag(it, 'summary') || tag(it, 'content:encoded')).slice(0, 220);
    if (summary && summary.toLowerCase().startsWith(title.toLowerCase().slice(0, 40))) summary = '';
    out.push({ title, url, source, time, summary, dc });
    if (out.length >= limit) break;
  }
  return out;
}
const normTitle = t => t.toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim().slice(0, 70);
function merge(lists, limit = 20) {
  const seen = new Set(); const out = [];
  for (const { items, feed } of lists) for (const it of items) { const k = normTitle(it.title); const u = it.url.replace(/[?#].*$/, ''); if (seen.has(k) || seen.has(u)) continue; seen.add(k); seen.add(u); out.push({ ...it, feed }); }
  const cutoff = NOW - 10 * 86400000;
  return out.filter(x => !x.time || x.time > cutoff).sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, limit).map(({ dc, ...rest }) => rest);
}
const gnews = (q, lang) => lang === 'en' ? `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=en-US&gl=US&ceid=US:en` : `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=de&gl=DE&ceid=DE:de`;
async function cryptoCompare(cat) { const j = await get(`https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=${cat}&excludeCategories=Sponsored`, { json: true }); return (j.Data || []).map(n => ({ title: n.title, url: n.url, source: n.source_info?.name || n.source || '', time: (n.published_on || 0) * 1000, summary: String(n.body || '').slice(0, 220), image: n.imageurl || '' })).filter(x => x.title && /^https?:/.test(x.url)); }

const NEWS = {
  XRP: [
    ['Google News (DE)', () => get(gnews('XRP Ripple', 'de')).then(x => parseRss(x, { feed: 'google' }))],
    ['Cointelegraph', () => get('https://cointelegraph.com/rss/tag/ripple').then(x => parseRss(x, { limit: 12 }))],
    ['CryptoCompare', () => cryptoCompare('XRP')],
    ['Google News (EN)', () => get(gnews('XRP Ripple', 'en')).then(x => parseRss(x, { feed: 'google', limit: 12 }))],
  ],
  ADA: [
    ['Google News (DE)', () => get(gnews('Cardano ADA', 'de')).then(x => parseRss(x, { feed: 'google' }))],
    ['Cointelegraph', () => get('https://cointelegraph.com/rss/tag/cardano').then(x => parseRss(x, { limit: 12 }))],
    ['CryptoCompare', () => cryptoCompare('ADA')],
    ['Google News (EN)', () => get(gnews('Cardano ADA', 'en')).then(x => parseRss(x, { feed: 'google', limit: 12 }))],
  ],
  SPCX: [
    ['Google News (DE)', () => get(gnews('SpaceX Aktie OR SPCX', 'de')).then(x => parseRss(x, { feed: 'google' }))],
    ['Yahoo Finance', () => get('https://feeds.finance.yahoo.com/rss/2.0/headline?s=SPCX&region=US&lang=en-US').then(x => parseRss(x, { limit: 12 }))],
    ['Google News (EN)', () => get(gnews('SpaceX stock OR SPCX', 'en')).then(x => parseRss(x, { feed: 'google', limit: 12 }))],
  ],
};

async function readJson(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { return null; } }
async function writeJson(p, obj) { await writeFile(p, JSON.stringify(obj)); }

async function updateNews(id) {
  const results = await Promise.allSettled(NEWS[id].map(async ([feed, fn]) => ({ feed, items: await fn() })));
  const lists = []; const errs = [];
  results.forEach((r, i) => { if (r.status === 'fulfilled' && r.value.items.length) lists.push(r.value); else errs.push(NEWS[id][i][0] + ': ' + (r.status === 'rejected' ? r.reason.message : 'leer')); });
  const items = merge(lists);
  if (!items.length) { status.errors['news-' + id] = errs.join(' · '); console.log('news', id, 'FEHLER', errs.join(' · ')); return; }
  await writeJson(`data/news-${id}.json`, { at: NOW, feeds: lists.map(l => l.feed), items });
  status.ok['news-' + id] = { items: items.length, feeds: lists.map(l => l.feed) }; if (errs.length) status.errors['news-' + id + '-partial'] = errs.join(' · ');
  console.log('news', id, items.length, 'Einträge aus', lists.map(l => l.feed).join(', '), errs.length ? '| teilweise: ' + errs.join(' · ') : '');
}

const YQ = { '1h': { interval: '60m', range: '6mo' }, '1d': { interval: '1d', range: '5y' }, '1w': { interval: '1wk', range: '10y' } };
async function yahooChart(sym, tf) {
  const { interval, range } = YQ[tf];
  const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}&includePrePost=false&events=div%2Csplit`, { json: true });
  const res = j?.chart?.result?.[0]; if (!res) throw new Error(j?.chart?.error?.description || 'keine Daten');
  const ts = res.timestamp || []; const q = res.indicators?.quote?.[0] || {};
  const r4 = x => Math.round(x * 10000) / 10000;
  const bars = ts.map((t, i) => [t, q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i], q.volume?.[i] || 0]).filter(b => b[1] != null && b[2] != null && b[3] != null && b[4] != null).map(b => [b[0], r4(b[1]), r4(b[2]), r4(b[3]), r4(b[4]), Math.round(b[5])]);
  if (!bars.length) throw new Error('keine Kurse');
  const m = res.meta || {}; const meta = {}; for (const k of ['regularMarketPrice', 'previousClose', 'chartPreviousClose', 'regularMarketDayHigh', 'regularMarketDayLow', 'regularMarketVolume', 'fiftyTwoWeekHigh', 'fiftyTwoWeekLow', 'regularMarketTime', 'exchangeName', 'fullExchangeName', 'currency', 'currentTradingPeriod']) if (m[k] != null) meta[k] = m[k];
  return { bars, meta, source: 'Yahoo Finance' };
}
async function stooq(sym, tf) {
  const csv = await get(`https://stooq.com/q/d/l/?s=${sym.toLowerCase()}.us&i=${tf === '1w' ? 'w' : 'd'}`);
  const lines = csv.trim().split(/\r?\n/); if (lines.length < 3 || !/^Date/i.test(lines[0])) throw new Error('keine Daten');
  const bars = lines.slice(1).map(l => l.split(',')).filter(p => p.length >= 5 && isFinite(+p[1])).map(p => [Math.floor(Date.parse(p[0] + 'T00:00:00Z') / 1000), +p[1], +p[2], +p[3], +p[4], +(p[5] || 0)]);
  if (!bars.length) throw new Error('keine Kurse');
  return { bars, meta: {}, source: 'Stooq' };
}
async function updateStock(sym) {
  for (const tf of ['1h', '1d', '1w']) {
    const file = `data/${sym.toLowerCase()}-${tf}.json`; const errs = [];
    for (const [name, fn] of [['Yahoo', () => yahooChart(sym, tf)], ['Stooq', () => tf === '1h' ? Promise.reject(new Error('nur Tages-/Wochendaten')) : stooq(sym, tf)]]) {
      try { const r = await fn(); await writeJson(file, { at: NOW, symbol: sym, tf, source: r.source, meta: r.meta, bars: r.bars }); status.ok[`${sym}-${tf}`] = { bars: r.bars.length, source: r.source }; console.log('kurse', sym, tf, r.bars.length, 'Kerzen von', r.source); errs.length = 0; break; }
      catch (e) { errs.push(name + ': ' + e.message); }
    }
    if (errs.length) { status.errors[`${sym}-${tf}`] = errs.join(' · '); console.log('kurse', sym, tf, 'FEHLER', errs.join(' · ')); }
  }
}

async function main() {
  await mkdir('data', { recursive: true });
  await Promise.all([updateNews('XRP'), updateNews('ADA'), updateNews('SPCX'), updateStock('SPCX')]);
  const prev = await readJson('data/status.json'); const keep = (prev && prev.ok) || {};
  await writeJson('data/status.json', { at: NOW, ok: { ...keep, ...status.ok }, errors: status.errors });
  console.log('fertig', new Date(NOW).toISOString(), 'Fehler:', Object.keys(status.errors).length);
}
if (process.argv[1] && /fetch-data\.mjs$/.test(process.argv[1])) main().catch(e => { console.error(e); process.exit(1); });
