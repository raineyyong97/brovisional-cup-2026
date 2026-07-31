-- Brovisional Championship — shared scoreboard schema
-- Design: docs/superpowers/specs/2026-07-31-shared-scoreboard-design.md
--
-- Paste this whole file into the Supabase SQL editor and run it once.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
-- Cell granularity, not JSON blobs: two people entering different holes touch
-- different rows and can never clobber each other.

create table if not exists scores (
  day        smallint    not null check (day between 0 and 3),
  player     text        not null,
  hole       smallint    not null check (hole between 0 and 17),
  strokes    smallint             check (strokes between 1 and 15),  -- null = no score entered
  updated_at timestamptz not null,
  device     text        not null,
  primary key (day, player, hole)
);

create table if not exists players (
  name       text        primary key,
  hi         numeric     not null,
  updated_at timestamptz not null,
  device     text        not null
);

-- ---------------------------------------------------------------------------
-- Merge rule
-- ---------------------------------------------------------------------------
-- The `where` clause is the load-bearing line. Without it a phone reconnecting
-- after time in a dead zone replays its outbox and overwrites newer scores with
-- stale ones. The device tiebreak makes identical timestamps resolve the same
-- way everywhere, so all devices converge on one value.

create or replace function upsert_score(
  p_day smallint, p_player text, p_hole smallint,
  p_strokes smallint, p_updated_at timestamptz, p_device text
) returns void
language sql
security definer
set search_path = public
as $$
  insert into scores (day, player, hole, strokes, updated_at, device)
  values (p_day, p_player, p_hole, p_strokes, p_updated_at, p_device)
  on conflict (day, player, hole) do update
    set strokes    = excluded.strokes,
        updated_at = excluded.updated_at,
        device     = excluded.device
    where excluded.updated_at > scores.updated_at
       or (excluded.updated_at = scores.updated_at and excluded.device > scores.device);
$$;

create or replace function upsert_player(
  p_name text, p_hi numeric, p_updated_at timestamptz, p_device text
) returns void
language sql
security definer
set search_path = public
as $$
  insert into players (name, hi, updated_at, device)
  values (p_name, p_hi, p_updated_at, p_device)
  on conflict (name) do update
    set hi         = excluded.hi,
        updated_at = excluded.updated_at,
        device     = excluded.device
    where excluded.updated_at > players.updated_at
       or (excluded.updated_at = players.updated_at and excluded.device > players.device);
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- RLS on, with select policies but deliberately NO insert/update/delete policies.
-- The security-definer functions are therefore the only write path in existence,
-- which means the merge rule is enforced by the database rather than trusted to
-- the client. A tampered client still cannot write a stale value over a fresh one.
--
-- Note: the anon key ships in page source, so anyone with the site URL can read
-- and write scores. Accepted tradeoff for an unlisted URL shared among 8 friends.

alter table scores  enable row level security;
alter table players enable row level security;

drop policy if exists scores_read  on scores;
drop policy if exists players_read on players;

create policy scores_read  on scores  for select to anon, authenticated using (true);
create policy players_read on players for select to anon, authenticated using (true);

revoke all on function upsert_score(smallint, text, smallint, smallint, timestamptz, text) from public;
revoke all on function upsert_player(text, numeric, timestamptz, text) from public;

grant execute on function upsert_score(smallint, text, smallint, smallint, timestamptz, text) to anon, authenticated;

-- Handicaps are admin-managed and deliberately NOT grantable to anon. The app's
-- HI inputs are disabled, but that is only cosmetic — the source and API key are
-- public, so a disabled input stops accidents, not intent. Withholding execute
-- here is what actually enforces it: no client can write a handicap at all.
--
-- The organiser changes handicaps by editing PLAYERS in the source and pushing,
-- or by editing the players table in the Supabase dashboard. The read path stays
-- open, so a dashboard edit propagates live to every phone.
revoke execute on function upsert_player(text, numeric, timestamptz, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- Lets every open phone pick up changes in about a second without polling.

alter publication supabase_realtime add table scores;
alter publication supabase_realtime add table players;
