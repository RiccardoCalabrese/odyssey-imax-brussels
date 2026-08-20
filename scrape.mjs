#!/usr/bin/env node
// Odyssey · IMAX 2D 70MM · Kinepolis Brussels — real seat-availability scraper.
//
// Why it's built this way:
//  - The programmation API lists showtimes but its `isSoldOut` flag is STALE.
//    Shows it marks available are often refused by the booking engine.
//  - Real seat data only exists in the Vista booking engine (tickets.kinepolis.be),
//    which is reached through kinepolis.be/fr/direct-vista-redirect/<id>/0/KBRU/0
//  - Akamai fronts both and rejects non-browser TLS, so we drive real Chrome.
//
// We stop at the seat map (step 2 of 5). No seat is ever selected, nothing is
// held or booked.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MOVIE = { id: '35300', ho: 'HO00013434', slug: 'l-odyssee' };
const COMPLEX = 'KBRU';
const FORMAT = 'IMAX 2D 70MM';
const PAGE = `https://kinepolis.be/fr/movies/detail/${MOVIE.id}/${MOVIE.ho}/0/${MOVIE.slug}`;
const API = `https://kinepolisweb-programmation.kinepolis.com/api/Sessions/BE/FR/${MOVIE.id}/WWW/Cinema/KinepolisBelgium`;

// Which slots we care about. night = from 18:00, afternoon = 12:00-18:00.
const WANT = [
  { dow: 5, from: 18, to: 24, label: 'Friday night'    },
  { dow: 6, from: 18, to: 24, label: 'Saturday night'  },
  { dow: 0, from: 12, to: 18, label: 'Sunday afternoon'},
];
const GROUPS = [8, 6, 4, 2];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Showtimes from the API are genuine UTC. Verified against the booking engine:
// API 19:00Z renders as "21:00" in Brussels. Convert via Intl, never by hand.
const BRU = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Brussels', weekday:'short',
  year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
const parts = iso => {
  const o = BRU.formatToParts(new Date(iso)).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return { d:o.day, mon:o.month, y:o.year, h:+o.hour, mi:+o.minute,
           dow: DAYS.indexOf(o.weekday), day:o.weekday,
           time:`${o.hour}:${o.minute}`, date:`${o.day} ${o.month}` };
};

async function chrome() {
  const dir = mkdtempSync(join(tmpdir(), 'ody-'));
  const proc = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0',
    `--user-data-dir=${dir}`,'--window-size=1280,1000','--lang=fr-BE',
    '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'about:blank'], { stdio:['ignore','ignore','pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('no debug port')), 30000);
    proc.stderr.on('data', d => { const m = /ws:\/\/[^\s]+/.exec(d.toString()); if (m) { clearTimeout(to); res(m[0]); } });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.addEventListener('open', r, { once:true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params={}, sessionId) => new Promise(res => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id:n, method, params, sessionId })); });
  const { result:{ targetId } } = await send('Target.createTarget', { url:'about:blank' });
  const { result:{ sessionId } } = await send('Target.attachToTarget', { targetId, flatten:true });
  await send('Page.enable', {}, sessionId);
  const evalJs = async (expression, awaitPromise=false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue:true }, sessionId);
    if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'js error');
    return r?.result?.result?.value;
  };
  const goto = async url => { await send('Page.navigate', { url }, sessionId); await sleep(2500); };
  const waitUrl = async (rx, ms=20000) => { const t0=Date.now();
    while (Date.now()-t0 < ms) { const u = await evalJs('location.href'); if (rx.test(u||'')) return u; await sleep(700); }
    return null; };
  return { evalJs, goto, waitUrl,
    clearCookies: () => send('Network.clearBrowserCookies', {}, sessionId),
    close: () => { try { ws.close(); } catch {} proc.kill('SIGKILL'); } };
}

// Largest run of consecutive free seats within a single row.
function analyseSeats(seats) {
  const free = seats.filter(s => s.free);
  const rows = {};
  for (const s of free) (rows[s.row] ||= []).push(s.col);
  let best = 0;
  for (const cols of Object.values(rows)) {
    cols.sort((a,b) => a-b);
    let run = 1;
    for (let i = 1; i <= cols.length; i++) {
      if (i < cols.length && cols[i] === cols[i-1] + 1) run++;
      else { if (run > best) best = run; run = 1; }
    }
  }
  return { total: seats.length, free: free.length, taken: seats.length - free.length, maxBlock: best };
}

async function checkSession(br, vs) {
  await br.clearCookies();
  await br.goto(`https://kinepolis.be/fr/direct-vista-redirect/${vs}/0/${COMPLEX}/0`);
  if (!await br.waitUrl(/tickets\.kinepolis\.be/)) return { status:'error', note:'no redirect' };
  await sleep(1200);
  const txt = await br.evalJs('document.body.innerText');
  if (/complète|complete|sold ?out/i.test(txt || '')) return { status:'soldout' };

  const picked = await br.evalJs(`(()=>{const s=[...document.querySelectorAll('select')].find(x=>/^ticket/.test(x.name||''));
    if(!s) return /Complet|Uitverkocht|Full/i.test(document.body.innerText)?'full':'nosel'; s.value='1'; s.dispatchEvent(new Event('change',{bubbles:true}));
    const b=[...document.querySelectorAll('button')].find(x=>/Continuer|Continue|Doorgaan/i.test(x.innerText||''));
    if(!b)return 'nobtn'; b.click(); return 'ok';})()`);
  if (picked === 'full') return { status:'soldout' };
  if (picked !== 'ok') return { status:'error', note:picked };

  if (!await br.waitUrl(/Seating/i, 20000)) {
    const t2 = await br.evalJs('document.body.innerText');
    if (/complète|sold ?out/i.test(t2 || '')) return { status:'soldout' };
    return { status:'error', note:'no seat map' };
  }
  await sleep(900);
  const seats = await br.evalJs(`(()=>[...document.querySelectorAll('.seat-input')].map(i=>{
    let v={};try{v=JSON.parse(i.value)}catch(e){}
    return {row:String(v.Row), col:Number(v.Column), free:!i.disabled};}))()`);
  if (!seats?.length) return { status:'error', note:'empty seat map' };
  return { status:'open', ...analyseSeats(seats) };
}

// ---- run ----
const br = await chrome();
try {
  // Self-test: `node scrape.mjs --probe <vistaSessionId>` runs one session through
  // the full pipeline. Used to prove the "open" path still works when every
  // Odyssey show happens to be sold out.
  const probeIx = process.argv.indexOf('--probe');
  if (probeIx > -1) {
    const vs = process.argv[probeIx + 1];
    console.log(`probe ${vs}:`, JSON.stringify(await checkSession(br, vs)));
    br.close(); process.exit(0);
  }
  await br.goto(PAGE);
  const all = await br.evalJs(`fetch(${JSON.stringify(API)}).then(r=>r.json())`, true);
  if (!Array.isArray(all)) throw new Error('programmation API blocked');

  const now = Date.now();

  const targets = all
    .filter(s => s.mainComplex === COMPLEX && s.film?.format?.name === FORMAT)
    .filter(s => { const p = parts(s.showtime);
      return WANT.some(w => w.dow === p.dow && p.h >= w.from && p.h < w.to); })
    .filter(s => new Date(s.showtime).getTime() > now)
    .sort((a,b) => a.showtime < b.showtime ? -1 : 1);

  console.log(`Checking ${targets.length} sessions…`);
  const shows = [];
  for (const s of targets) {
    const p = parts(s.showtime);
    const slot = WANT.find(w => w.dow === p.dow && p.h >= w.from && p.h < w.to);
    let r; try { r = await checkSession(br, s.vistaSessionId); }
    catch (e) { r = { status:'error', note:e.message }; }
    const fits = {}; for (const g of GROUPS) fits[g] = r.status === 'open' && r.maxBlock >= g;
    shows.push({
      vistaSessionId: s.vistaSessionId,
      iso: s.showtime.slice(0,16),
      day: p.day, date: p.date, time: p.time,
      slot: slot.label, hall: s.hall,
      status: r.status, note: r.note || null,
      seatsFree: r.free ?? 0, seatsTotal: r.total ?? 0, maxBlock: r.maxBlock ?? 0, fits,
      bookUrl: `https://kinepolis.be/fr/direct-vista-redirect/${s.vistaSessionId}/0/${COMPLEX}/0`,
    });
    console.log(`  ${p.day} ${p.date} ${p.time}  ${r.status.padEnd(8)} free=${r.free ?? '-'} block=${r.maxBlock ?? '-'}`);
    await sleep(1500); // be polite
  }

  const out = {
    updated: new Date().toISOString(),
    movie: "L'Odyssée", cinema: 'Kinepolis Brussel', format: FORMAT,
    version: 'Version Anglaise · ST FR/NL',
    groups: GROUPS, slots: WANT.map(w => w.label), shows,
  };
  writeFileSync(join(HERE, 'data.json'), JSON.stringify(out, null, 2));
  console.log(`\nWrote data.json — ${shows.filter(s=>s.status==='open').length}/${shows.length} open`);
} finally { br.close(); }
