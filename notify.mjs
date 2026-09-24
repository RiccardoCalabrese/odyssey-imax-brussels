#!/usr/bin/env node
// Telegram alerts — only when something NEW appears.
//
// Compares the freshly scraped data.json against the previously published copy and
// messages only screenings that have just crossed the threshold. An hourly job that
// messaged every run would be noise, and noise gets muted.
//
// Credentials come from the environment (GitHub Actions secrets). They are never
// read from, or written to, this repository.
//
//   TELEGRAM_TOKEN   from @BotFather
//   TELEGRAM_CHAT    your chat id
//   KIN_ALERT_SEATS  how many seats together to care about (default 2)
//   KIN_ALERT_CENTRE "true" = only count seats in the centre block (default true)

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = 'https://riccardocalabrese.github.io/odyssey-imax-brussels/';
const NEED   = Number(process.env.KIN_ALERT_SEATS || 2);
const CENTRE = (process.env.KIN_ALERT_CENTRE ?? 'true') !== 'false';
const TOKEN  = process.env.TELEGRAM_TOKEN;
let   CHAT   = process.env.TELEGRAM_CHAT;

// TELEGRAM_CHAT is optional. If it isn't set we ask Telegram who has messaged the bot
// and reply to the most recent chat, so only the token has to be configured. Telegram
// keeps those updates for ~24h, so setting TELEGRAM_CHAT makes it permanent.
async function resolveChat() {
  if (CHAT) return CHAT;
  if (!TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    const b = await r.json();
    const ids = (b.result || []).map(u => u.message?.chat?.id ?? u.edited_message?.chat?.id).filter(Boolean);
    if (!ids.length) {
      console.log('No chat found. Send your bot a message (any message), then re-run.');
      return null;
    }
    CHAT = String(ids[ids.length - 1]);
    console.log('Replying to the most recent chat that messaged the bot.');
    return CHAT;
  } catch (e) { console.log('Could not reach Telegram:', e.message); return null; }
}
const DRY    = process.argv.includes('--dry-run');
const TEST   = process.argv.includes('--test');

const read = f => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
const now  = read(join(HERE, 'data.json'));
const prev = read(join(HERE, process.env.KIN_PREV || 'prev.json'));
if (!now) { console.log('no data.json — nothing to do'); process.exit(0); }

// isoDate has appeared as 2026-Sept-25 and as 2026-09-25. Normalise before comparing,
// or a format change alone would announce every date as new.
const MON={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
const normDate = v => {
  const m=/^(\d{4})-([A-Za-z]+|\d{1,2})-(\d{1,2})$/.exec(String(v||''));
  if(!m) return String(v||'');
  const mo = isNaN(+m[2]) ? MON[m[2].toLowerCase()] : +m[2];
  return mo ? `${m[1]}-${String(mo).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}` : String(v);
};
const pretty = iso => { const [y,m,d]=iso.split('-');
  return `${+d} ${['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m]}`; };

// Restrict alerts to certain slots: 'any', 'weekend', 'golden', or 'weekend+golden'
// (either one - the safer reading, so nothing worth knowing about is dropped).
const GOLDEN_SLOTS={Fri:['late','evening'],Sat:['afternoon','late','evening'],Sun:['afternoon','late']};
const bandOf = t => { let h=+((/^(\d{1,2}):/.exec(t)||[])[1]||0); if(h<5)h+=24;
  return h<12?'morning':h<16?'afternoon':h<19?'late':'evening'; };
const WHEN = (process.env.KIN_ALERT_WHEN || 'any').toLowerCase();
const isGolden  = s => (GOLDEN_SLOTS[s.day]||[]).includes(bandOf(s.time));
const isWeekend = s => s.day==='Sat' || s.day==='Sun'
  || (s.day==='Fri' && (+(/^(\d{1,2}):/.exec(s.time)||[])[1]||0) >= 18);
const inWindow = s => WHEN==='golden' ? isGolden(s)
  : WHEN==='weekend' ? isWeekend(s)
  : (WHEN==='weekend+golden' || WHEN==='golden+weekend') ? (isWeekend(s) || isGolden(s))
  : true;

const qualifies = s => inWindow(s) && s.status === 'open'
  && (CENTRE ? (s.goldenMaxBlock || 0) : (s.maxBlock || 0)) >= NEED;

const esc = t => String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

async function send(text) {
  const chat = DRY ? null : await resolveChat();
  if (DRY || !TOKEN || !chat) {
    console.log(DRY ? '--- dry run, would send ---' : '--- no Telegram credentials, would send ---');
    console.log(text.replace(/<[^>]+>/g, ''));
    return;
  }
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) throw new Error(`Telegram refused: ${r.status} ${JSON.stringify(body).slice(0,200)}`);
  console.log('Telegram message sent.');
}

// A plumbing check you can fire any time, since a normal run stays silent unless
// something has actually changed.
if (TEST) {
  const n = now.shows.filter(qualifies).length;
  // Telegram only remembers who messaged the bot for ~24h, so auto-discovery is a
  // convenience, not a foundation. Tell the owner their chat id HERE, in a private
  // message, rather than in a public Actions log, so they can pin it down for good.
  const id = await resolveChat();
  const pin = (id && !process.env.TELEGRAM_CHAT)
    ? `\n\n<b>Make this permanent:</b> add <code>${esc(id)}</code> as a repository secret `
      + `named <code>TELEGRAM_CHAT</code>, otherwise alerts may stop once Telegram `
      + `forgets this chat.\nhttps://github.com/RiccardoCalabrese/odyssey-imax-brussels/settings/secrets/actions/new`
    : '';
  await send(`✅ <b>Alerts are working.</b>\n`
    + `Watching <b>${esc(now.movie)}</b> · ${esc(now.format)} at ${esc(now.cinema)}.\n`
    + `Right now <b>${n}</b> screening${n===1?'':'s'} ${n===1?'has':'have'} ${NEED}+ seats `
    + `${CENTRE?'together in the centre':'together'}.\n\n`
    + `You'll only hear from me when that changes.\n\n${SITE}${pin}`);
  process.exit(0);
}

// The scraper going blind and the cinema being full look identical from outside.
// Say so rather than going quiet.
if (now.verified === false) {
  await send(`⚠️ <b>${esc(now.movie)}</b> — the check could not verify itself.\n`
    + `Treat the page as unreliable until the next run.\n\n${SITE}`);
  process.exit(0);
}

if (!prev) { console.log('no previous data — recording a baseline, no alert'); process.exit(0); }

// New dates on the programme - the thing worth knowing about the moment it happens.
const hadDates = new Set(prev.shows.map(s => normDate(s.isoDate)));
const nowDates = [...new Set(now.shows.map(s => normDate(s.isoDate)))].sort();
const addedDates = nowDates.filter(d => !hadDates.has(d));
if (addedDates.length) {
  const withSeats = addedDates.filter(d =>
    now.shows.some(s => normDate(s.isoDate) === d && qualifies(s)));
  const span = addedDates.length === 1
    ? pretty(addedDates[0])
    : `${pretty(addedDates[0])} – ${pretty(addedDates.at(-1))}`;
  await send(
    `🗓 <b>New dates on the programme</b>\n`
    + `<b>${esc(now.movie)}</b> · ${esc(now.format)} at ${esc(now.cinema)}\n\n`
    + `${addedDates.length} new date${addedDates.length===1?'':'s'}: <b>${esc(span)}</b>\n`
    + (withSeats.length
        ? `${withSeats.length} of them already ${withSeats.length===1?'has':'have'} ${NEED}+ seats ${CENTRE?'together in the centre':'together'}.`
        : `None with ${NEED}+ seats ${CENTRE?'in the centre':'together'} yet — worth watching.`)
    + `\n\n${SITE}`);
}

const was = new Map(prev.shows.map(s => [s.vistaSessionId, s]));
const fresh = now.shows.filter(s => qualifies(s) && !(was.get(s.vistaSessionId) && qualifies(was.get(s.vistaSessionId))));

if (!fresh.length) { console.log('nothing newly available'); process.exit(0); }

fresh.sort((a,b) => (a.isoDate + a.time) < (b.isoDate + b.time) ? -1 : 1);
const what = CENTRE ? `together in the centre` : `together`;
const lines = fresh.slice(0, 12).map(s => {
  const n = CENTRE ? s.goldenMaxBlock : s.maxBlock;
  const run = CENTRE && s.goldenRuns?.[0]
    ? ` — row ${s.goldenRuns[0].row}, seats ${s.goldenRuns[0].seats[0]}–${s.goldenRuns[0].seats.at(-1)}`
    : '';
  return `• <b>${esc(s.day)} ${esc(s.date)} · ${esc(s.time)}</b> — ${n} ${what}${esc(run)}`;
});
const more = fresh.length > 12 ? `\n…and ${fresh.length - 12} more.` : '';

await send(
  `🎟 <b>${esc(now.movie)}</b> · ${esc(now.format)}\n`
  + `${fresh.length} new screening${fresh.length === 1 ? '' : 's'} with ${NEED}+ seats ${what}.\n\n`
  + lines.join('\n') + more + `\n\n${SITE}`
);
