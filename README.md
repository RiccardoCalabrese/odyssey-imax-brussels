# Odyssey · IMAX 70mm · Kinepolis Brussels

Live seat-availability tracker for **The Odyssey** in **IMAX 2D 70MM** (Version Anglaise,
ST FR/NL) at **Kinepolis Brussel** — limited to Friday nights, Saturday nights and
Sunday afternoons.

**Site:** https://riccardocalabrese.github.io/odyssey-imax-brussels/

## Why it exists

Kinepolis' own site is slow to check and its public API is misleading: the `isSoldOut`
flag it returns is stale, marking shows as available that the booking engine refuses.
The only trustworthy source is the Vista booking engine's seat map.

## How it works

`scrape.mjs` drives real Chrome (Akamai rejects non-browser TLS on both hosts):

1. Reads the showtime list from the programmation API.
2. Keeps only Brussels · IMAX 2D 70MM · Fri night / Sat night / Sun afternoon.
3. For each one, opens the booking flow and reads the **actual seat map**.
4. Counts free seats and the largest run of *consecutive seats in one row* —
   the number that matters for a group.
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

## Being a good citizen

Each run opens the booking flow once per tracked screening (18 at the moment) and stops
at the seat map. Hourly is a deliberate ceiling — don't raise it much. Nothing is ever
selected, held, or purchased.
