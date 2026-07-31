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

Play order (days 3 and 4 were swapped from the original plan — the group plays Red Mountain on
day 3 and Blue Canyon Lakes on day 4). Only `COURSES` moved; `DAILY_FLIGHTS` is tied to the day,
not the venue, so groupings stayed put.

- **Day 1 — Loch Palm Golf Course** — par 71, White 68.2/115 (2019 Jon Morrow redesign)
- **Day 2 — Blue Canyon — Canyon Course** — par 72, White 70.4/131
- **Day 3 — Red Mountain Golf Course** — par 72, White 68.6/121
- **Day 4 — Blue Canyon — Lakes Course** — par 72, White 69.3/124

## Flight rotation logic

Days 1–2 are **history** — they were played and their scores are in the database. Never edit
them. Days 3–4 were re-optimised by exhaustive search over all 35 × 35 possible splits.

**"Everyone shares a flight with everyone twice" is impossible.** A player has 3 flight-mates a
day, so at most 12 encounters over 4 days, while meeting all 7 others twice needs 14. With Kai
out on day 3 there are 45 pair-slots total against the 56 required. Don't accept this as a
requirement — it cannot be met.

The exhaustive search also confirmed the original note: with 8 players in two flights of 4 over
4 rounds, **no schedule avoids some pair meeting 3 times** (all 52,360 checked). The original
hand-built schedule was nonetheless suboptimal — 4 pairs at 3× and 12 pairs at 1×, where the
theoretical best was 20 pairs at 2× and 8 at 1×.

Current schedule, chosen deliberately: **21 of 28 pairs share a flight exactly twice and no pair
exceeds twice.** The accepted cost is 4 pairs who never share a flight — Bob+Weng, Daryl+Junyi,
Rainey+Song, Kai+Wilson. The alternative (everyone meets at least once) was rejected because it
drops to only 9 pairs at twice and forces 4 pairs to 3×.

The binding constraint is Kai: he plays only days 1, 2 and 4, and his unmet pairs were Weng and
Wilson. Covering both would force Weng+Wilson — already at 2 from days 1–2 — up to 3.

Handicap balance per flight stays within ~1 stroke of average on both re-optimised days.

If a player list changes (someone drops out, someone new joins), this rotation needs to be
manually rebuilt, not just patched — it's an interlocking schedule, not independent daily
lists.

### Order within a flight is meaningful

`computeSixes` derives the entire partner rotation from the array order: the first two names are
the opening pair, and the other two segments are generated from there. So reordering a flight
changes who partners whom in each 6-hole segment, while leaving flight membership and the
handicap balance alone.

Day 2 Flight 2 is ordered `Weng, Rainey, Junyi, Wilson` because the group actually played
Weng+Rainey over holes 1–6, not Weng+Junyi. Everyone still partners each flight-mate exactly
once. If another day's opening pair turns out to be misrecorded, the fix is a reorder of that
flight — not a change to `computeSixes`.

## Side bets

`SIDE_BETS` holds agreed adjustments applied on top of the scorecard. Currently one: Bob and
Rainey exchange holes 1–15 on Day 1.

The exchange is done on **net scores**, not on Stableford points. Both players play the same hole
with the same par, so swapping nets swaps the Stableford points identically — and because Sixes
is played on nets, the match play follows from the same swap. Adjusting points alone would leave
the leaderboard disagreeing with the Sixes result over the same holes. Note this does change who
won those Sixes segments, which is intended: Bob and Rainey share a flight on Day 1.

`applySideBets` is called inside `computeNets` on purpose. The Sixes block, the day totals, and
the leaderboard all read from `computeNets`, so one insertion point keeps every view consistent
instead of each recomputing the adjustment. `holes` is an inclusive 0-indexed range — `[0,14]`
is holes 1–15. Each active bet renders a gold note at the top of its day panel; don't make an
adjustment silent.

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

## Gross strokes summary

`grossFor(dayIdx)` totals raw strokes before handicap. Rendered twice: `grossBlock` on each day
panel, and `renderGrossSummary` on the leaderboard.

Two properties worth preserving:

- **Score to par is measured against the holes actually played**, not the full course. Otherwise
  40 strokes through 9 holes reads as −31 instead of +4, which is worse than showing nothing.
- **Gross is deliberately unaffected by `SIDE_BETS`.** Those exchange net scores; gross is what a
  player physically hit, and "how everyone's shooting" should stay a record of ball-striking.

It lives in its own table because it ranks low-to-high while the championship ranks high-to-low.
Don't merge them — opposite-direction numbers in one grid invite misreading the leaderboard.
`byGross` sorts players with no scores to the bottom, so nobody leads on zero strokes.

## Handicaps are admin-managed

Players cannot change handicap indexes. Three layers, only the last of which is real:

1. The HI inputs render `disabled`.
2. There is no `hi-input` branch in the `input` handler and no `recordPlayer` in `sync.js`.
3. **`execute` on `upsert_player` is revoked from `anon`** — this is the actual enforcement.

Layers 1 and 2 are cosmetic on their own: the source and the API key are public, so a disabled
input stops accidents, not intent. Only the revoke prevents a handicap write, and it's verified
to return `42501 permission denied`.

The **read** path stays open. The organiser changes a handicap either by editing `PLAYERS` in the
source and pushing, or by editing the `players` table in the Supabase dashboard — a dashboard
edit propagates live to every phone via `applyRemotePlayer`.

`flush()` drops non-score outbox entries rather than retrying them. A phone still holding a
handicap edit queued by the pre-lock version would otherwise fail forever and stall every score
behind it.

## Open work

- **Course data is still unverified.** See the section above — this is now the largest remaining
  risk to the app being *correct* rather than merely working, since wrong ratings or stroke
  indexes silently produce wrong handicaps and wrong Stableford points all week.
- Live sync is verified end-to-end (realtime delivery, stale-write rejection, RLS enforcement).
  Days 1 and 2 are fully scored in the database.

## Absences and short flights

`ABSENT` lists players not playing on a given day (`{2: ['Kai']}` — Kai misses day 3). An absent
player is left out of `DAILY_FLIGHTS` for that day entirely, scores 0, and renders as "not
playing" in the day totals and "—" in the gross table.

Day 3 therefore has 7 players split 4 + 3. A 3-player flight cannot play partners format, so
`computeThreeWay` runs **3-way individual match play**: each hole goes to the outright lowest net
(a tie for lowest halves the hole), most holes wins the 6-hole game, and the bonus slots are
`[5, 2, −2]` rather than `[5, 2, 0, −2]`. `computeSixes` dispatches on flight length.

`awardBonus` is shared by both formats and takes an `anyPlayable` count. This fixes a real bug:
with no scores entered, every player tied on zero and the tie-averaging handed each of them
`(5+2+0−2)/4 = 1.25` for a day that had not been played, inflating every trip total by 2.5.
Unplayed days now award nothing. Don't remove that guard.
