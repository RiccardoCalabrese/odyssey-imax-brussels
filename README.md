# Odyssey · IMAX 70mm · Kinepolis Brussels

Live seat-availability tracker for **The Odyssey** in **IMAX 2D 70MM** (Version Anglaise,
ST FR/NL) at **Kinepolis Brussel** — limited to Friday nights, Saturday nights and
Sunday afternoons.

**Site:** https://riccardocalabrese.github.io/odyssey-imax-brussels/

## Why it exists

Kinepolis' own site is slow to check and its public API is misleading: the `isSoldOut`
flag it returns is stale, marking shows as available that the booking engine refuses.
The only trustworthy source is the Vista booking engine's seat map.

## Rebuilt September 2026

Kinepolis replaced their Drupal site with a React front-end and a Next.js booking app,
which broke the original scraper. The current version targets the new stack:

| | Old (until Sep 2026) | New |
|---|---|---|
| Film page | `/fr/movies/detail/…` (Drupal) | `/fr/films/<slug>/<HO>/` (React) |
| Booking entry | `/fr/direct-vista-redirect/…` + 2-step flow | `web.kinepolis.be/fr-fr/order/showtimes/<CINEMA>-<id>/seats` |
| Seat data | HTML checkboxes, `data-seats-status` | SVG seats, `aria-label` + class + position |

The showtime feed (`kinepolisweb-programmation.kinepolis.com`) is unchanged — including
its unreliable `isSoldOut` flag, which is still ignored.

## How it works

`scrape.mjs` drives real Chrome (Akamai rejects non-browser TLS on both hosts):

1. Reads the showtime list from the programmation API.
2. Keeps only Brussels · IMAX 2D 70MM · Fri night / Sat night / Sun afternoon.
3. For each one, opens the booking flow and reads the **actual seat map**.
4. Counts free seats and the largest run of *consecutive seats in one row* (aisles
   break a run, detected from real seat geometry).
5. Works out how many of those sit in the **centre of the auditorium** — the middle
   50% of each row, between 40% and 75% of the way back. Tunable via `KIN_GOLD_*`.
5. Writes `data.json`, which `index.html` renders.

It stops at the seat map (step 2 of 5). No seat is selected, nothing is held or booked.

## Automatic refresh

A GitHub Actions workflow (`.github/workflows/refresh.yml`) runs **hourly**, scrapes,
and commits `data.json` — so the site stays current with nothing running locally.
Verified working from GitHub's runners: Akamai does not block them.

Trigger it by hand from the **Actions** tab, or:

```bash
gh workflow run refresh.yml
```

### Self-test

Because every Odyssey screening is currently sold out, a green run doesn't by itself
prove the scraper can still *detect* availability. Probe a known-bookable session
(any `vistaSessionId` from the Kinepolis site) to exercise the "open" path:

```bash
gh workflow run refresh.yml -f probe=375290
```

Expected output: `probe 375290: {"status":"open","total":422,"free":374,...}`

## Run it locally

```bash
./refresh.sh                 # scrape, commit, push
node scrape.mjs              # scrape only
node scrape.mjs --probe <id> # self-test one session
```

Both the workflow and `refresh.sh` rebase-and-retry on push, so a manual run and a
scheduled run can't clobber each other.

## Telegram alerts

`notify.mjs` messages a Telegram bot **only when a screening newly crosses the
threshold** — it diffs the fresh scrape against the previously published `data.json`.
An hourly job that messaged every run would just get muted. It also speaks up if a run
fails its own verification, since a blind scraper and a full cinema look identical.

Setup — run `./setup-telegram.sh`, which prompts for the token, finds your chat id and
stores both as encrypted GitHub secrets without ever printing or saving them. Manually:

1. Message **@BotFather** on Telegram → `/newbot` → copy the token.
2. Send your new bot any message (it can't message you until you do).
3. Get your chat id:
   `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"id":[0-9-]*' | head -1`
4. Add both as repository secrets:
   ```
   gh secret set TELEGRAM_TOKEN
   gh secret set TELEGRAM_CHAT
   ```

Tune what you get alerted about in the workflow's env block:
`KIN_ALERT_SEATS` (default 2) and `KIN_ALERT_CENTRE` (default true).

Test locally without sending anything: `node notify.mjs --dry-run`

## Being a good citizen

Each run opens the booking flow once per tracked screening (18 at the moment) and stops
at the seat map. Hourly is a deliberate ceiling — don't raise it much. Nothing is ever
selected, held, or purchased.
