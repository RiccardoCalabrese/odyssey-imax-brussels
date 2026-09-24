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
const CHAT   = process.env.TELEGRAM_CHAT;
const DRY    = process.argv.includes('--dry-run');

const read = f => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
const now  = read(join(HERE, 'data.json'));
const prev = read(join(HERE, process.env.KIN_PREV || 'prev.json'));
if (!now) { console.log('no data.json — nothing to do'); process.exit(0); }

const qualifies = s => s.status === 'open'
  && (CENTRE ? (s.goldenMaxBlock || 0) : (s.maxBlock || 0)) >= NEED;

const esc = t => String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

async function send(text) {
  if (DRY || !TOKEN || !CHAT) {
    console.log(DRY ? '--- dry run, would send ---' : '--- no TELEGRAM_TOKEN/CHAT set, would send ---');
    console.log(text.replace(/<[^>]+>/g, ''));
    return;
  }
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) throw new Error(`Telegram refused: ${r.status} ${JSON.stringify(body).slice(0,200)}`);
  console.log('Telegram message sent.');
}

// The scraper going blind and the cinema being full look identical from outside.
// Say so rather than going quiet.
if (now.verified === false) {
  await send(`⚠️ <b>${esc(now.movie)}</b> — the check could not verify itself.\n`
    + `Treat the page as unreliable until the next run.\n\n${SITE}`);
  process.exit(0);
}

if (!prev) { console.log('no previous data — recording a baseline, no alert'); process.exit(0); }

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
