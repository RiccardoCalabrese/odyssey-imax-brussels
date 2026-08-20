#!/usr/bin/env node
// Odyssey · IMAX 2D 70MM · Kinepolis Brussels — real seat-availability scraper.
//
// Trust model — the whole point of this file:
//  - The programmation API's `isSoldOut` flag is NOT trustworthy. It marks shows
//    available that the booking engine then refuses. We never use it to decide
//    anything; every screening is verified against the real seat map.
//  - "Everything is sold out" and "the scraper is silently broken" produce
//    identical output. So each run also checks a CONTROL session from a different
//    film that is known-bookable. If we cannot prove the open-path still works,
//    the run is published as UNVERIFIED rather than as a confident "all sold out".
//  - Akamai fronts both hosts and rejects non-browser TLS, so we drive real Chrome.
//
// We stop at the seat map (step 2 of 5). No seat is selected, held, or booked.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH
  || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome');
const EXTRA_FLAGS = process.platform === 'darwin' ? [] : ['--no-sandbox','--disable-dev-shm-usage'];

const MOVIE   = { id:'35300', ho:'HO00013434', slug:'l-odyssee' };
const COMPLEX = 'KBRU';
const FORMAT  = 'IMAX 2D 70MM';
const PAGE = `https://kinepolis.be/fr/movies/detail/${MOVIE.id}/${MOVIE.ho}/0/${MOVIE.slug}`;
const HOME = 'https://kinepolis.be/fr';
const API  = `https://kinepolisweb-programmation.kinepolis.com/api/Sessions/BE/FR/${MOVIE.id}/WWW/Cinema/KinepolisBelgium`;
const GROUPS = [8, 6, 4, 2];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MAX_CONTROLS = 5;   // how many control sessions to try before giving up

const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i > -1 ? argv[i+1] : null; };
const LIMIT = Number(argOf('--limit') || 0);   // for quick local testing

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Showtimes from the API are genuine UTC. Verified against the booking engine:
// API 19:00Z renders as "21:00" in Brussels. Convert via Intl, never by hand.
const BRU = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Brussels', weekday:'short',
  year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
const parts = iso => {
  const o = BRU.formatToParts(new Date(iso)).reduce((a,x)=>(a[x.type]=x.value,a),{});
  const mon = o.month.slice(0,3); // en-GB yields 'Sept'; keep all months 3 letters
  return { h:+o.hour, dow: DAYS.indexOf(o.weekday), day:o.weekday,
           time:`${o.hour}:${o.minute}`, date:`${o.day} ${mon}`, iso:`${o.year}-${o.month}-${o.day}` };
};

async function chrome() {
  const dir = mkdtempSync(join(tmpdir(), 'ody-'));
  const proc = spawn(CHROME, [...EXTRA_FLAGS,'--headless=new','--disable-gpu','--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`,'--window-size=1280,1000','--lang=fr-BE',
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
  // document.body can be null while a navigation is committing; poll until it exists.
  const bodyText = async (ms=15000) => { const t0 = Date.now();
    while (Date.now()-t0 < ms) {
      const t = await evalJs('(document.body && document.body.innerText) || ""');
      if (t && t.trim()) return t; await sleep(600);
    } return ''; };
  const waitUrl = async (rx, ms=20000) => { const t0=Date.now();
    while (Date.now()-t0 < ms) { const u = await evalJs('location.href'); if (rx.test(u||'')) return u; await sleep(700); }
    return null; };
  return { evalJs, goto, waitUrl, bodyText,
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
  const txt = await br.bodyText();
  if (/complète|complete|sold ?out/i.test(txt)) return { status:'soldout' };

  const picked = await br.evalJs(`(()=>{const s=[...document.querySelectorAll('select')].find(x=>/^ticket/.test(x.name||''));
    if(!s) return /Complet|Uitverkocht|Full/i.test((document.body&&document.body.innerText)||'')?'full':'nosel';
    s.value='1'; s.dispatchEvent(new Event('change',{bubbles:true}));
    const b=[...document.querySelectorAll('button')].find(x=>/Continuer|Continue|Doorgaan/i.test(x.innerText||''));
    if(!b)return 'nobtn'; b.click(); return 'ok';})()`);
  if (picked === 'full') return { status:'soldout' };
  if (picked !== 'ok')  return { status:'error', note:picked };

  if (!await br.waitUrl(/Seating/i, 20000)) {
    if (/complète|sold ?out/i.test(await br.bodyText())) return { status:'soldout' };
    return { status:'error', note:'no seat map' };
  }
  await sleep(900);
  const seats = await br.evalJs(`(()=>[...document.querySelectorAll('.seat-input')].map(i=>{
    let v={};try{v=JSON.parse(i.value)}catch(e){}
    return {row:String(v.Row), col:Number(v.Column), free:!i.disabled};}))()`);
  if (!seats?.length) return { status:'error', note:'empty seat map' };
  return { status:'open', ...analyseSeats(seats) };
}

// Prove the open-path still works, using a bookable session from a DIFFERENT film.
// Without this, a broken scraper and a genuinely sold-out cinema look identical.
async function verifyPipeline(br) {
  await br.goto(HOME);
  const candidates = await br.evalJs(`(()=>{const cm=(Drupal.settings.variables||{}).current_movies;
    if(!cm||!cm.sessions)return [];
    const now=Date.now();
    return cm.sessions
      .filter(s=>s.mainComplex==='${COMPLEX}'&&!s.isSoldOut&&new Date(s.showtime).getTime()>now+3*86400000)
      .slice(0,20).map(s=>s.vistaSessionId);})()`);
  if (!candidates?.length) return { ok:false, reason:'no control candidates found' };
  const tried = [];
  for (const vs of candidates.slice(0, MAX_CONTROLS)) {
    let r; try { r = await checkSession(br, vs); } catch (e) { r = { status:'error', note:e.message }; }
    tried.push({ vs, status:r.status });
    if (r.status === 'open') return { ok:true, controlSessionId:vs, controlSeatsFree:r.free, tried };
    await sleep(1200);
  }
  return { ok:false, reason:`no control session reached its seat map (${MAX_CONTROLS} tried)`, tried };
}

// ---- run ----
const br = await chrome();
try {
  const probeIx = argv.indexOf('--probe');
  if (probeIx > -1) {
    console.log(`probe ${argv[probeIx+1]}:`, JSON.stringify(await checkSession(br, argv[probeIx+1])));
    br.close(); process.exit(0);
  }

  await br.goto(PAGE);
  const all = await br.evalJs(`fetch(${JSON.stringify(API)}).then(r=>r.json())`, true);
  if (!Array.isArray(all)) throw new Error('programmation API blocked');

  const now = Date.now();
  let targets = all
    .filter(s => s.mainComplex === COMPLEX && s.film?.format?.name === FORMAT)
    .filter(s => new Date(s.showtime).getTime() > now)
    .sort((a,b) => a.showtime < b.showtime ? -1 : 1);
  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log(`Checking ${targets.length} screenings (every future ${FORMAT} show at ${COMPLEX})…`);
  const shows = [];
  for (const s of targets) {
    const p = parts(s.showtime);
    let r; try { r = await checkSession(br, s.vistaSessionId); }
    catch (e) { r = { status:'error', note:e.message }; }
    const fits = {}; for (const g of GROUPS) fits[g] = r.status === 'open' && r.maxBlock >= g;
    shows.push({
      vistaSessionId: s.vistaSessionId, isoDate: p.iso,
      day: p.day, date: p.date, time: p.time, hall: s.hall,
      status: r.status, note: r.note || null,
      seatsFree: r.free ?? 0, seatsTotal: r.total ?? 0, maxBlock: r.maxBlock ?? 0, fits,
      apiSaidSoldOut: !!s.isSoldOut,   // kept only to show how wrong the flag is
      bookUrl: `https://kinepolis.be/fr/direct-vista-redirect/${s.vistaSessionId}/0/${COMPLEX}/0`,
    });
    console.log(`  ${p.day} ${p.date} ${p.time}  ${r.status.padEnd(8)} free=${r.free ?? '-'} block=${r.maxBlock ?? '-'}`);
    await sleep(900);
  }

  console.log('\nVerifying the scraper can still detect availability…');
  const verification = await verifyPipeline(br);
  console.log(verification.ok
    ? `  OK — control session ${verification.controlSessionId} reported ${verification.controlSeatsFree} free seats.`
    : `  FAILED — ${verification.reason}`);

  const open = shows.filter(s => s.status === 'open' && s.seatsFree > 0);
  const errors = shows.filter(s => s.status === 'error');
  const out = {
    updated: new Date().toISOString(),
    movie: "L'Odyssée", cinema:'Kinepolis Brussel', format:FORMAT,
    version:'Version Anglaise · ST FR/NL',
    groups: GROUPS,
    verified: verification.ok,
    verification,
    counts: { checked: shows.length, open: open.length,
              soldOut: shows.filter(s=>s.status==='soldout').length, errors: errors.length },
    shows,
  };
  writeFileSync(join(HERE,'data.json'), JSON.stringify(out, null, 2));
  console.log(`\nWrote data.json — ${open.length} with seats, ${out.counts.soldOut} sold out, ${errors.length} errors, verified=${verification.ok}`);
} finally { br.close(); }
