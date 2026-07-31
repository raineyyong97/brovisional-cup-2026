# Brovisional Championship — Golf Scoring App

## What this is

A single-page web app for scoring a 4-day, 8-player golf trip in Phuket. `phuket-golf-scorer.html`
(HTML + CSS + vanilla JS) holds the scoring and UI; `sync.js` holds the shared-scoreboard sync
layer it imports. No build step and no framework — the only dependencies are two Google Fonts via
`@import` and the Supabase client, both loaded from a CDN at runtime.

It was built iteratively in a chat conversation with Claude and is now being handed off for
ongoing development in Claude Code. This file exists so a fresh Claude Code session (or a human
contributor) has the context that conversation had.

## The core idea

8 friends are playing a 4-round golf trip. Each day:

1. They play **Net Stableford** individually (points-based scoring adjusted for each player's
   handicap on that specific course).
2. Within their daily 4-person "flight," they also play a partners format called **Sixes**
   (partners rotate every 6 holes so everyone partners with each of their 3 flight-mates once
   per round). Sixes doesn't produce a separate team score — it produces **bonus points**
   (+5 / +2 / 0 / −2 depending on rank within the flight) that get added on top of that day's
   Stableford total.
3. `Day score = Net Stableford points + Sixes bonus`. The 4 daily scores sum to one individual
   championship leaderboard.

Flights reshuffle every day (a designed rotation ensures every player shares a flight with every
other player at least once across the 4 days, and total handicap is balanced between the two
flights each day). Course Handicaps and "who gives strokes to whom, on which holes" are
calculated automatically per day per flight, since both the flights and the course ratings
change daily.

## Data model (all defined at the top of the `<script>` block)

- `COURSES` — array of 4 courses in play order. Each has `rating`, `slope`, `par`, and an 18-item
  `holes` array of `{par, si}` (si = stroke index, 1–18, used to allocate handicap strokes to
  specific holes).
- `PLAYERS` — array of `{name, hi}` (hi = Handicap Index). Editable live in the UI.
- `DAILY_FLIGHTS` — array of 4 `{X, Y}` objects, each listing which 4 players are in Flight 1 /
  Flight 2 that day. This was manually designed (see "Flight rotation logic" below) — don't
  regenerate it casually, it encodes a specific fairness property.
- `SCORES` — nested state `SCORES[dayIndex][playerName] = [18 gross scores]`, the only thing the
  user actually inputs.

Everything else (Course Handicap, net scores, Stableford points, Sixes results, strokes-given
tables, leaderboard) is **derived** from those four structures on every render. There is no
separate "computed state" to keep in sync — `computeNets()`, `computeSixes()`, and
`strokesGivenRows()` are pure functions of `PLAYERS`, `COURSES`, `DAILY_FLIGHTS`, and `SCORES`.

## Course data — please verify before trusting it

Course ratings/pars/stroke-indexes were sourced from public scorecard sites (phuketgolfcourse.com,
GolfPass, offcourse.co, birdie.in.th) during the original conversation, using **White tees**
throughout. One course (Loch Palm) was initially entered with outdated pre-2019 data and had to
be corrected once a layout change came to light — so treat all four course data blocks as
"best effort from public sources, not verified against the club's official current scorecard."
If anyone in the group can get an actual current scorecard photo from the pro shop for any of
the 4 courses, that should be treated as authoritative over what's currently in `COURSES`.

Current data as of this handoff:
- **Loch Palm Golf Course** — par 71, White 68.2/115 (2019 Jon Morrow redesign)
- **Blue Canyon — Canyon Course** — par 72, White 70.4/131
- **Blue Canyon — Lakes Course** — par 72, White 69.3/124
- **Red Mountain Golf Course** — par 72, White 68.6/121

## Flight rotation logic

`DAILY_FLIGHTS` was hand-derived (not randomly generated) so that across the 4 days:
- Every player shares a flight with every other player **at least once**.
- Total Handicap Index per flight is balanced to within ~4 strokes each day.
- It's mathematically provable that with 8 players / groups of 4 / 4 rounds, at least one pair
  of players must repeat a flight 3 times (can't perfectly balance "everyone meets everyone
  exactly once or twice" — the math doesn't divide evenly). The current schedule accepts that
  trade-off rather than ever leaving a pair at zero shared flights.

If a player list changes (someone drops out, someone new joins), this rotation needs to be
manually rebuilt, not just patched — it's an interlocking schedule, not independent daily
lists.

## Shared state (solved — see `sync.js`)

This was the project's main open problem and is now built. Design doc:
`docs/superpowers/specs/2026-07-31-shared-scoreboard-design.md`.

Storage is no longer `window.storage`/`localStorage`-only. `sync.js` is a local-first sync layer
backed by Supabase:

- **Writes** go to memory and `localStorage` first, then onto a persisted outbox that drains to
  Supabase when there's signal. A tap is never blocked on the network — course mobile data is
  patchy and scores get entered out on the hole.
- **Reads** paint from `localStorage` instantly, then pull from Supabase and subscribe to
  realtime changes.
- **Merging** is last-write-wins per `(day, player, hole)` cell, enforced *in the database*. The
  `on conflict … where excluded.updated_at > scores.updated_at` clause in
  `supabase/schema.sql` rejects stale writes, so a phone replaying its outbox after time in a
  dead zone can't overwrite newer scores. RLS grants `anon` select plus execute on the upsert
  functions only — there is no direct write path.

The scoring code was left untouched, as intended: `computeNets`, `computeSixes`,
`strokesGivenRows`, and every render function still read `SCORES` and `PLAYERS` as plain
in-memory objects.

**The app needs Supabase credentials in `SUPABASE_CONFIG` at the top of `sync.js`.** Without them
it runs local-only and the status pill says so. Setup steps are in `README.md`.

Things worth knowing before changing this area:

- Local timestamps are strictly increasing (`createClock`), not raw `Date.now()`. Two reasons:
  rapid stepper taps land in the same millisecond and would otherwise resolve to the *first* tap,
  and a phone's clock stepping backwards mid-round would otherwise make new edits lose. Don't
  swap it back for `Date.now()`.
- `SCORES` holds gross strokes as **strings** (`''` for blank); the DB holds `smallint`/`null`.
  `toDbStrokes`/`fromDbStrokes` are the boundary.
- Player *names* key the database rows, and are also referenced by `DAILY_FLIGHTS`. They are
  build-time constants and the UI does not expose them for editing. Keep it that way.
- `tests.html` covers the merge, queue, and hydration logic offline. Run it after touching
  `sync.js`.

### Accepted tradeoff: the anon key is public

It ships in page source, so anyone with the site URL can read and write scores. This was raised
and accepted — 8 friends on an unlisted URL, and a passphrase gate was explicitly declined. If
that changes, add a passphrase gate or Supabase anonymous auth.

## Design system (if extending the UI)

- Palette: deep fairway green (`--green-900: #0B3D2E`), cream "scorecard paper" background
  (`--cream: #F7F3E8`), gold accent (`--gold: #C9A227`) used sparingly for active states and
  leaderboard highlighting.
- Fonts: `Fraunces` (serif, headings), `Space Grotesk` (sans, UI text), `JetBrains Mono`
  (monospace, all numeric/score data) — loaded via Google Fonts `@import`.
- Mobile-first input pattern: a "quick entry" hole-by-hole stepper (`quickEntryBlock()`) is the
  primary scoring interface on phones — big tap targets, one hole at a time, prev/next nav. The
  full 18-column grid (`scoreTable()`) still exists as a collapsed `<details>` for overview /
  desktop use, not as the primary input method.

## Things NOT to change without checking with the group first

- The Stableford points table (net double bogey+ = 0 → net albatross = 5) — standard WHS-style
  scoring, shouldn't need adjusting.
- The Sixes bonus values (+5 / +2 / 0 / −2) — explicitly chosen by the group, with 4th place
  being a deliberate penalty (this was a specific, considered request, not a placeholder).
- The `DAILY_FLIGHTS` rotation — see "Flight rotation logic" above, it's a designed schedule,
  not arbitrary.

## Open work

- **Course data is still unverified.** See the section above — this is now the largest remaining
  risk to the app being *correct* rather than merely working, since wrong ratings or stroke
  indexes silently produce wrong handicaps and wrong Stableford points all week.
- The app has never been run against a live Supabase project. The sync logic is covered by
  offline tests, but end-to-end multi-device sync should be verified once credentials exist.
