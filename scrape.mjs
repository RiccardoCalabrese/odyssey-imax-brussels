#!/usr/bin/env node
// Kinepolis seat watcher — rebuilt for the September 2026 site rebuild.
//
// What changed on their side:
//   - The old Drupal site is gone. /movies/detail/... and /direct-vista-redirect/...
//     no longer exist, which is what broke the previous version.
//   - Booking moved to a Next.js app at web.kinepolis.be with a DIRECT seat URL:
//       https://web.kinepolis.be/fr-fr/order/showtimes/<CINEMA>-<vistaSessionId>/seats
//     No ticket-quantity step, so no multi-page walk and no shared booking state.
//   - The seat map is an SVG. Each seat carries its availability in its class, its
//     identity in aria-label ("Siège normal Rangée 01 Siège 19") and a real on-screen
//     position — which is what makes "centre of the theatre" computable.
//
// What did NOT change: the programmation feed still lists showtimes, and its
// `isSoldOut` flag is still untrustworthy, so it is never used to decide anything.
//
// Both hosts reject non-browser TLS (Akamai / Cloudflare), so we drive real Chrome.
// We only ever READ the seat page. Nothing is selected, held or booked.

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

const MOVIE_ID = process.env.KIN_MOVIE   || '35300';            // The Odyssey
const COMPLEX  = process.env.KIN_CINEMA  || 'KBRU';             // Kinepolis Brussel
const FORMAT   = process.env.KIN_FORMAT  || 'IMAX 2D 70MM';
const LANGUAGE = process.env.KIN_LANG    || 'Version Anglaise';
const OUTFILE  = process.env.KIN_OUT     || 'data.json';
const CONTROL_MOVIE = process.env.KIN_CONTROL || '35287';       // a film that normally has seats
const API = id => `https://kinepolisweb-programmation.kinepolis.com/api/Sessions/BE/FR/${id}/WWW/Cinema/KinepolisBelgium`;
const seatsUrl = vs => `https://web.kinepolis.be/fr-fr/order/showtimes/${COMPLEX}-${vs}/seats`;

// "Golden square": the central block people actually want. Defined on real geometry,
// not row numbers, so it works in any auditorium.
//   lateral 0 = dead centre of the row, 1 = far side wall
//   depth   0 = front row (nearest screen), 1 = back row
// "Golden square": the prime central block. Defined the way a person points at it -
// the middle seating block only (never the side blocks, however central a side seat
// looks in raw pixels), the middle slice of that block's width, and the middle rows.
const GOLDEN = {
  widthFrac: Number(process.env.KIN_GOLD_WIDTH ?? 0.50),  // middle 50% of the centre block
  depthFrom: Number(process.env.KIN_GOLD_FROM  ?? 0.33),  // from a third of the way back...
  depthTo:   Number(process.env.KIN_GOLD_TO    ?? 0.67),  // ...to two thirds back
};
const GROUPS = [8, 6, 4, 2];
const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i > -1 ? argv[i+1] : null; };
const LIMIT = Number(argOf('--limit') || 0);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MONTH_NUM={Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
const eq = (a,b) => String(a??'').trim().toLowerCase() === String(b??'').trim().toLowerCase();
const BRU = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Brussels', weekday:'short',
  year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
const parts = iso => {
  const o = BRU.formatToParts(new Date(iso)).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return { day:o.weekday, date:`${o.day} ${o.month.slice(0,3)}`, time:`${o.hour}:${o.minute}`,
           isoDate:`${o.year}-${String(MONTH_NUM[o.month.slice(0,3)]).padStart(2,'0')}-${o.day}`, dayNum:o.day };
};

async function chrome() {
  const dir = mkdtempSync(join(tmpdir(), 'kin-'));
  const proc = spawn(CHROME, [...EXTRA_FLAGS,'--headless=new','--disable-gpu','--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`,'--window-size=1600,1200','--lang=fr-BE',
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
  const goto = async url => { await send('Page.navigate', { url }, sessionId); };
  const reset = async () => { await send('Page.navigate', { url:'about:blank' }, sessionId); await sleep(300); };
  return { evalJs, goto, reset,
    close: () => { try { ws.close(); } catch {} proc.kill('SIGKILL'); } };
}

// Read every seat with its state, identity and true on-screen position.
const READ_SEATS = `(()=>{
  const els=[...document.querySelectorAll('svg.v-seat-picker-seat')];
  if(!els.length) return null;
  const screenEl=document.querySelector('[class*=seat-picker-screen]');
  const sr=screenEl?screenEl.getBoundingClientRect():null;
  const seats=els.map(e=>{
    const cls=e.getAttribute('class')||'';
    const lab=e.getAttribute('aria-label')||'';
    const m=/Rang[eé]+e?\\s*(\\S+)[\\s\\S]*?Si[eè]ge\\s*(\\S+)/i.exec(lab);
    const r=e.getBoundingClientRect();
    return { row:m?m[1]:null, seat:m?m[2]:null,
             cx:r.left+r.width/2, cy:r.top+r.height/2, w:r.width,
             available:/--available/.test(cls), cosy:/sofa/.test(cls) };
  });
  return { seats, screenY: sr ? sr.top+sr.height/2 : null };
})()`;

function analyse(raw) {
  const all = raw.seats.filter(s => s.w > 0);
  const standard = all.filter(s => !s.cosy);
  if (!standard.length) return null;

  const seatW = standard.reduce((a,s)=>a+s.w,0) / standard.length || 24;

  // Group seats into physical rows by their vertical position.
  const rowsMap = new Map();
  for (const s of standard) {
    const key = Math.round(s.cy / Math.max(seatW * 0.6, 1));
    if (!rowsMap.has(key)) rowsMap.set(key, []);
    rowsMap.get(key).push(s);
  }
  // Sorted front-to-back. Row 1 sits at the top of the map, nearest the screen, and
  // auditoria are drawn screen-at-top - verified against a real hall.
  const rows = [...rowsMap.entries()].sort((a,b) => a[0] - b[0]).map(e => e[1]);
  const rowCount = rows.length;
  // Depth uses the row's ORDER, not its pixel position: halls are split into seating
  // zones with big blank gaps between them, which makes raw pixel depth meaningless.
  const depthByRow = new Map();
  rows.forEach((row, i) => { const d = rowCount > 1 ? i / (rowCount - 1) : 0.5;
    row.forEach(s => depthByRow.set(s, d)); });

  // Split the hall into seating blocks: a horizontal gap wider than a couple of seats
  // is an aisle between blocks, not a gap between neighbours.
  const uniqX = [...new Set(standard.map(s => Math.round(s.cx)))].sort((a,b) => a-b);
  const blocks = [];
  let cur = [uniqX[0]];
  for (let i = 1; i < uniqX.length; i++) {
    if (uniqX[i] - uniqX[i-1] <= seatW * 2) cur.push(uniqX[i]);
    else { blocks.push(cur); cur = [uniqX[i]]; }
  }
  blocks.push(cur);
  const hallMid = (uniqX[0] + uniqX[uniqX.length-1]) / 2;
  // The centre block is the one containing the middle of the hall.
  const centreBlock = blocks.find(b => hallMid >= b[0] - seatW && hallMid <= b[b.length-1] + seatW)
    || blocks.sort((a,b) => b.length - a.length)[0];
  const bMin = centreBlock[0], bMax = centreBlock[centreBlock.length-1];
  const bMid = (bMin + bMax) / 2, bHalf = Math.max((bMax - bMin) / 2, 1);

  const inGolden = s => s.cx >= bMin - seatW && s.cx <= bMax + seatW        // centre block only
                     && Math.abs(s.cx - bMid) / bHalf <= GOLDEN.widthFrac   // its middle slice
                     && depthByRow.get(s) >= GOLDEN.depthFrom
                     && depthByRow.get(s) <= GOLDEN.depthTo;

  // Adjacency from geometry, so an aisle breaks a run even when seat numbers don't.
  const runsOf = list => {
    const byRow = new Map();
    for (const s of list) {
      const key = Math.round(s.cy / Math.max(seatW * 0.6, 1));
      if (!byRow.has(key)) byRow.set(key, []);
      byRow.get(key).push(s);
    }
    const runs = [];
    for (const row of byRow.values()) {
      row.sort((a,b) => a.cx - b.cx);
      let cur = [row[0]];
      for (let i = 1; i < row.length; i++) {
        if (row[i].cx - row[i-1].cx <= seatW * 1.6) cur.push(row[i]);
        else { runs.push(cur); cur = [row[i]]; }
      }
      runs.push(cur);
    }
    return runs;
  };

  const free = standard.filter(s => s.available);
  const goldenFree = free.filter(inGolden);
  const bestRun = rs => rs.reduce((m,r) => Math.max(m, r.length), 0);
  const goldenRuns = runsOf(goldenFree).filter(r => r.length >= 2)
    .sort((a,b) => b.length - a.length).slice(0, 6)
    .map(r => {
      const nums = r.map(s => s.seat).filter(Boolean).sort((a,b) => Number(a) - Number(b));
      return { row: r[0].row, seats: nums, size: r.length };
    });

  return {
    seatsTotal: standard.length,
    seatsFree: free.length,
    maxBlock: bestRun(runsOf(free)),
    rows: rowCount,
    blocks: blocks.length,
    goldenTotal: standard.filter(inGolden).length,
    goldenFree: goldenFree.length,
    goldenMaxBlock: bestRun(runsOf(goldenFree)),
    goldenRuns,
    cosyFree: all.filter(s => s.cosy && s.available).length,
  };
}

async function checkSession(br, vs, expect) {
  await br.reset();
  await br.goto(seatsUrl(vs));
  // The page renders a skeleton first; wait for a real outcome, not a timer.
  const outcome = await br.evalJs(`(async()=>{
    const t0=Date.now();
    while(Date.now()-t0<45000){
      const txt=(document.body&&document.body.innerText)||'';
      if(/compl[èe]te/i.test(txt)) return {kind:'soldout',txt:txt.slice(0,400)};
      if(document.querySelectorAll('svg.v-seat-picker-seat').length>0) return {kind:'seats',txt:txt.slice(0,400)};
      if(/introuvable|not found|error|erreur/i.test(txt) && txt.length>80) return {kind:'error',txt:txt.slice(0,300)};
      await new Promise(r=>setTimeout(r,700));
    }
    return {kind:'timeout',txt:((document.body&&document.body.innerText)||'').slice(0,300)};
  })()`, true);
  if (!outcome) return { status:'error', note:'no page' };

  // Identity gate: the page prints the hall and the local start time.
  if (expect) {
    const okTime = outcome.txt.includes(expect.time);
    const okHall = expect.hall == null || new RegExp(`Zaal\\s*0*${expect.hall}\\b`, 'i').test(outcome.txt);
    if (!okTime || !okHall) {
      return { status:'error', note:`session mismatch (wanted ${expect.time}, hall ${expect.hall})` };
    }
  }
  if (outcome.kind === 'soldout') return { status:'soldout' };
  if (outcome.kind !== 'seats')   return { status:'error', note:outcome.kind };

  await sleep(1200);                       // let the map settle before measuring geometry
  const raw = await br.evalJs(READ_SEATS);
  if (!raw?.seats?.length) return { status:'error', note:'seat map unreadable' };
  const a = analyse(raw);
  if (!a) return { status:'error', note:'no standard seats' };
  if (a.seatsFree === 0) return { status:'soldout' };
  return { status:'open', ...a };
}

// Prove the scraper can still SEE availability. Without it, "all sold out" and
// "quietly broken" are the same output.
async function verifyPipeline(br) {
  let list;
  try { list = await br.evalJs(`fetch(${JSON.stringify(API(CONTROL_MOVIE))}).then(r=>r.json())`, true); }
  catch { return { ok:false, reason:'control film feed unreachable' }; }
  if (!Array.isArray(list)) return { ok:false, reason:'control film feed unreachable' };
  const now = Date.now();
  const cands = list.filter(s => s.mainComplex === COMPLEX && new Date(s.showtime).getTime() > now + 2*86400000)
                    .sort((a,b) => a.showtime < b.showtime ? -1 : 1).slice(0, 6);
  const tried = [];
  for (const c of cands) {
    const p = parts(c.showtime);
    let r; try { r = await checkSession(br, c.vistaSessionId, { time:p.time, hall:c.hall }); }
    catch (e) { r = { status:'error', note:e.message }; }
    tried.push({ vs:c.vistaSessionId, status:r.status });
    if (r.status === 'open') return { ok:true, controlSessionId:c.vistaSessionId, controlSeatsFree:r.seatsFree, tried };
    await sleep(800);
  }
  return { ok:false, reason:'no control session showed seats', tried };
}

// ---- run ----
const br = await chrome();
try {
  const probeIx = argv.indexOf('--probe');
  if (probeIx > -1) {
    console.log(`probe ${argv[probeIx+1]}:`, JSON.stringify(await checkSession(br, argv[probeIx+1]), null, 1));
    br.close(); process.exit(0);
  }

  await br.goto('https://web.kinepolis.be/fr-fr/'); await sleep(2500);
  const all = await br.evalJs(`fetch(${JSON.stringify(API(MOVIE_ID))}).then(r=>r.json())`, true);
  if (!Array.isArray(all)) throw new Error('programmation feed blocked or changed');

  const now = Date.now();
  let targets = all
    // Case-insensitive: they renamed "Version Anglaise" to "version anglaise" in the
    // rebuild, which silently matched nothing.
    .filter(s => s.mainComplex === COMPLEX
              && eq(s.film?.format?.name, FORMAT)
              && eq(s.film?.data?.spokenLanguage?.name, LANGUAGE)
              && new Date(s.showtime).getTime() > now)
    .sort((a,b) => a.showtime < b.showtime ? -1 : 1);
  if (LIMIT) targets = targets.slice(0, LIMIT);
  if (!targets.length) throw new Error(`no future screenings matched ${FORMAT} / ${LANGUAGE} at ${COMPLEX}`);

  console.log(`Checking ${targets.length} screenings — ${targets[0].film.data.title} · ${FORMAT} · ${LANGUAGE} · ${COMPLEX}…`);
  const shows = [];
  for (const s of targets) {
    const p = parts(s.showtime);
    let r; try { r = await checkSession(br, s.vistaSessionId, { time:p.time, hall:s.hall }); }
    catch (e) { r = { status:'error', note:e.message }; }
    const fits = {}; for (const g of GROUPS) fits[g] = r.status === 'open' && r.maxBlock >= g;
    shows.push({
      vistaSessionId: s.vistaSessionId, isoDate: p.isoDate,
      day: p.day, date: p.date, time: p.time, hall: s.hall,
      status: r.status, note: r.note || null,
      seatsFree: r.seatsFree ?? 0, seatsTotal: r.seatsTotal ?? 0, maxBlock: r.maxBlock ?? 0,
      goldenFree: r.goldenFree ?? 0, goldenTotal: r.goldenTotal ?? 0,
      goldenMaxBlock: r.goldenMaxBlock ?? 0, goldenRuns: r.goldenRuns ?? [],
      cosyFree: r.cosyFree ?? 0, fits,
      bookUrl: seatsUrl(s.vistaSessionId),
    });
    const g = r.status === 'open' ? ` golden=${r.goldenFree}(max ${r.goldenMaxBlock})` : '';
    console.log(`  ${p.day} ${p.date} ${p.time}  ${r.status.padEnd(8)} free=${r.seatsFree ?? '-'} block=${r.maxBlock ?? '-'}${g}${r.note?' ('+r.note+')':''}`);
    await sleep(600);
  }

  console.log('\nVerifying the scraper can still detect availability…');
  const verification = await verifyPipeline(br);
  console.log(verification.ok
    ? `  OK — control session ${verification.controlSessionId} showed ${verification.controlSeatsFree} free seats.`
    : `  FAILED — ${verification.reason}`);

  const open = shows.filter(s => s.status === 'open');
  const out = {
    updated: new Date().toISOString(),
    movie: targets[0].film.data.title, cinema: targets[0].cinemaLabel || 'Kinepolis Brussel',
    format: FORMAT, version: LANGUAGE, movieId: MOVIE_ID, complex: COMPLEX,
    groups: GROUPS, golden: GOLDEN,
    verified: verification.ok, verification,
    counts: { checked: shows.length, open: open.length,
              soldOut: shows.filter(s=>s.status==='soldout').length,
              errors: shows.filter(s=>s.status==='error').length,
              withGolden: open.filter(s=>s.goldenMaxBlock>=2).length },
    shows,
  };
  writeFileSync(join(HERE, OUTFILE), JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUTFILE} — ${open.length} with seats, ${out.counts.withGolden} with 2+ together in the centre, ${out.counts.soldOut} sold out, ${out.counts.errors} errors, verified=${verification.ok}`);
} finally { br.close(); }
