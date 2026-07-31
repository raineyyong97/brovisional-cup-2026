# Shared Live Scoreboard — Design

**Date:** 2026-07-31
**Status:** Approved, pending implementation plan

## Problem

`phuket-golf-scorer.html` saves scores to `window.storage` (Claude artifact viewer) with a
`localStorage` fallback. Both are per-browser, per-device. If 8 players open the same Netlify
URL on 8 phones, each gets an independent, disconnected copy of the app. There is no shared
scoreboard.

Goal: one Netlify-hosted site where any of the 8 players can enter scores from their own phone
and everyone else's view updates.

## Decisions

These were settled during brainstorming and are inputs to the design, not open questions.

| Decision | Choice | Reasoning |
|---|---|---|
| Backend | Supabase | Websocket realtime (no polling over a 4-hour round) and Postgres, which lets the merge rule live server-side as SQL. |
| Offline behaviour | Local-first with a persisted sync queue | Phuket course mobile data is patchy and the quick-entry stepper is used out on the hole. Entries must never be lost or blocked on the network. |
| Write model | Anyone can edit anyone | Matches how the group already uses the app. No login. |
| Access control | None — unlisted URL | Accepted risk, see Security below. |
| File layout | Split `sync.js` out of the HTML | Keeps the scorer file focused; sync logic becomes testable in isolation. Still no build step. |
| Testing | Offline self-test page + live two-browser check | The stale-replay edge cases are impractical to trigger by hand. |

## Non-goals

- Authentication or per-player identity.
- Changing any scoring logic. `computeNets`, `computeSixes`, `strokesGivenRows`, the Stableford
  table, the Sixes bonus values, and `DAILY_FLIGHTS` are all untouched.
- Editing player *names* — the UI only exposes handicap index, and `DAILY_FLIGHTS` references
  names, so names remain build-time constants.

## Architecture

```
┌─────────────────────────────────────────┐
│ phuket-golf-scorer.html                 │
│   COURSES / PLAYERS / DAILY_FLIGHTS     │  ← unchanged
│   SCORES (in-memory truth for render)   │  ← unchanged shape
│   computeNets / computeSixes / render*  │  ← unchanged
└───────────────┬─────────────────────────┘
                │ imports
┌───────────────▼─────────────────────────┐
│ sync.js                                 │
│   outbox (localStorage-persisted queue) │
│   flusher (backoff, coalescing)         │
│   realtime subscription                 │
│   mergeCell / mergeRemote (pure, LWW)   │
└───────────────┬─────────────────────────┘
                │ RPC + realtime
┌───────────────▼─────────────────────────┐
│ Supabase: scores, players + upsert RPCs │
└─────────────────────────────────────────┘
```

`SCORES` and `PLAYERS` remain plain in-memory objects. Every render function keeps reading them
exactly as it does today. The only edits to the HTML file are: replacing `saveState`/`loadState`,
importing `sync.js`, and repurposing the `.save-status` element.

## Data model

Cell granularity, not JSON blobs. One row per score cell means two people entering different
holes touch different rows and can never clobber each other; only the identical hole is a real
conflict.

```sql
create table scores (
  day        smallint    not null check (day between 0 and 3),
  player     text        not null,
  hole       smallint    not null check (hole between 0 and 17),
  strokes    smallint,                      -- null = no score entered
  updated_at timestamptz not null,
  device     text        not null,
  primary key (day, player, hole)
);

create table players (
  name       text        primary key,
  hi         numeric     not null,
  updated_at timestamptz not null,
  device     text        not null
);
```

`day` and `hole` are 0-indexed to match the existing in-memory representation, avoiding an
off-by-one translation layer.

## Merge rule

All writes go through one function per table. RLS grants `anon` **select plus execute on those
functions only** — no direct insert or update policy. The merge rule is therefore not a
convention the client is trusted to follow; it is the only write path that exists.

```sql
create function upsert_score(
  p_day smallint, p_player text, p_hole smallint,
  p_strokes smallint, p_updated_at timestamptz, p_device text
) returns void language sql security definer as $$
  insert into scores (day, player, hole, strokes, updated_at, device)
  values (p_day, p_player, p_hole, p_strokes, p_updated_at, p_device)
  on conflict (day, player, hole) do update
    set strokes    = excluded.strokes,
        updated_at = excluded.updated_at,
        device     = excluded.device
    where excluded.updated_at > scores.updated_at
       or (excluded.updated_at = scores.updated_at and excluded.device > scores.device);
$$;
```

The `where` clause is the load-bearing line. Without it, a phone reconnecting after 40 minutes in
a dead zone replays its outbox and overwrites newer scores with stale ones. With it, stale writes
are dropped server-side.

The `device` tiebreak makes identical-timestamp collisions resolve deterministically rather than
by arrival order, so every device converges on the same value.

**Known limitation:** this trusts 8 phone clocks to roughly agree. They are NTP-synced in
practice, so skew is on the order of seconds and the realistic conflict window is far smaller
than that. Accepted.

The same rule is implemented once more as a pure client-side function, used when merging fetched
rows and realtime events into memory. Server and client must agree; the self-tests cover the
client copy.

## Sync layer

**On edit:** update memory → re-render → snapshot to `localStorage` → append to outbox → kick the
flusher. The tap is never blocked on the network.

**Outbox:** a `localStorage`-persisted array of `{table, key, value, updated_at, device}`. It
survives app close, reload, and phone death. The flusher drains it via RPC, retains failed
entries, and retries on exponential backoff plus the `online` event and realtime reconnect.

**Coalescing:** before sending, entries are collapsed by key keeping the latest. Eight rapid taps
on the +/- stepper for one hole send one write, not eight.

**Load:** paint from `localStorage` immediately (the app opens fully offline) → fetch all rows →
merge client-side with the LWW rule → re-render. Then subscribe to `postgres_changes` on both
tables and apply incoming events the same way.

**Two subtleties that are where this class of bug lives:**

1. A remote update must never overwrite the user's own still-pending edits. After any remote
   merge, unflushed outbox entries are re-applied on top.
2. Re-rendering must not steal focus mid-entry. The file already has
   `refreshCurrentDayKeepFocus` for this; realtime-triggered renders route through it.

## UI

The existing `.save-status` pill stops being a 900ms "Saved" flash and becomes a persistent
state indicator: `Live` / `Syncing…` / `Offline — 3 pending`. Same element, same design tokens
(`--green-900`, `--cream`, `--gold`), no new visual language.

## Configuration

Supabase project URL and anon key are needed before implementation can be verified. They live in
a `SUPABASE_CONFIG` const at the top of `sync.js`. The `@supabase/supabase-js` client loads as an
ES module from a CDN, preserving the no-build-step property.

## Security

The anon key ships in page source, so anyone with the Netlify URL can read and write the tables.
This was raised and accepted: the group is 8 friends on an unlisted URL, and a passphrase gate was
explicitly declined. Recorded here so the tradeoff is visible rather than implicit.

RLS is still enabled with the RPC-only write path, which means the exposure is "can edit scores",
not "can drop the table" or "can write arbitrary rows bypassing the merge rule".

## Testing

`tests.html` — no framework, no install, open in a browser for pass/fail. Covers the pure logic
that is impractical to exercise by hand:

- A stale write loses to a newer one.
- Identical timestamps resolve deterministically via the device tiebreak.
- Queue coalescing collapses repeated edits to the same key, keeps distinct keys separate.
- Offline replay ordering: a queue drained after reconnect does not regress newer remote values.
- A remote update does not discard a pending local edit.
- `localStorage` hydration produces the same in-memory shape the render functions expect.

Plus live verification across two browsers: enter in one, confirm the other updates; simulate
offline via devtools, confirm entries queue and flush on reconnect.

## Risks

| Risk | Mitigation |
|---|---|
| Phone clock skew misorders writes | NTP sync makes skew ≪ realistic conflict window; device tiebreak ensures convergence. |
| Realtime subscription drops silently on a long round | Flusher also runs on a periodic timer and on `online`; a full refetch runs on reconnect. |
| Anon key is public | Accepted; RLS restricts writes to the merge-enforcing RPC. |
| Course data still unverified (per CLAUDE.md) | Out of scope for this change, unchanged by it. |
