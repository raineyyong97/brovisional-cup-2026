# Brovisional Championship — Scorer

A shared live scoreboard for a 4-day, 8-player golf trip in Phuket. Any player can enter scores
from their own phone; everyone else's view updates within about a second.

**Live:** https://raineyyong97.github.io/brovisional-cup-2026/

⚠️ **Not yet shared.** The site is deployed and working, but `SUPABASE_CONFIG` in `sync.js` is
still empty, so every phone currently keeps its own independent copy — the status pill says
`Local only — not synced`. Do step 1 below to turn it into a real shared scoreboard.

## Files

| File | What it is |
|---|---|
| `phuket-golf-scorer.html` | The app: scoring logic, rendering, UI. |
| `sync.js` | Local-first sync layer — outbox, merge rule, realtime. |
| `supabase/schema.sql` | Tables, merge functions, RLS. Run once. |
| `tests.html` | Offline tests for the sync logic. Open in a browser. |
| `netlify.toml` | Static hosting config. |
| `CLAUDE.md` | Context for a fresh Claude Code session. |
| `docs/superpowers/specs/` | Design docs. |

## Setup

Hosting is done (GitHub Pages, from `main`). One step remains, and it needs an account signup.

**1. Create the Supabase project and run the schema.**

Sign in at [supabase.com](https://supabase.com) and create a free project. Open the SQL editor,
paste the whole of `supabase/schema.sql`, and run it. Then go to Project Settings → API and copy
the **Project URL** and the **anon public** key.

**2. Run one command with those two values.**

```bash
./configure-sync.sh <project-url> <anon-key>
```

It checks the credentials work and the schema actually ran, writes them into `sync.js`, commits,
pushes, waits for Pages to rebuild, and confirms the live site picked them up. If you forgot to
run the SQL, it tells you that instead of shipping a broken site.

Then send the 8 players the URL and confirm the pill reads `Live`.

`netlify.toml` is kept in case the group would rather host there later; it isn't used by Pages.

## How syncing works

Scores are written to memory and `localStorage` first, then queued in an outbox that drains to
Supabase whenever there's signal. A tap is never blocked on the network, which matters because
course mobile data is patchy and entry happens out on the hole.

Every write goes through a Postgres function whose `on conflict` clause rejects any update older
than what's already stored. This is what stops a phone that spent 40 minutes in a dead zone from
replaying its queue and overwriting newer scores. RLS grants `anon` select plus execute on those
functions only — there is no direct insert or update path, so the merge rule is enforced by the
database rather than trusted to the client.

The status pill in the bottom-right shows `Live`, `Syncing… n`, or `Offline — n pending`.

## Testing

Open `tests.html` through a local web server (ES modules don't load over `file://`):

```bash
python3 -m http.server 4173
```

Then visit `http://localhost:4173/tests.html`. 23 tests, no framework, no install.

## Known constraints

- **The anon key is public.** Anyone with the site URL can read and write scores. This was a
  deliberate tradeoff for 8 friends on an unlisted URL. If that changes, the fix is a passphrase
  gate or Supabase anonymous auth.
- **Last write wins across devices**, resolved by timestamp with a device-id tiebreak. Local
  timestamps are strictly increasing, so a phone's clock jumping backwards can't make new edits
  lose — but two phones with badly wrong clocks could still disagree about ordering.
- **Player names are build-time constants.** They key the database rows and are referenced by
  `DAILY_FLIGHTS`. Changing the roster means rebuilding the flight rotation — see `CLAUDE.md`.
