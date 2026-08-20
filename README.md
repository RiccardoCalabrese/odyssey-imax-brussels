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

## Run it

```bash
node scrape.mjs              # full check, writes data.json
node scrape.mjs --probe <id> # self-test one session
```

Then commit `data.json` to refresh the site.
