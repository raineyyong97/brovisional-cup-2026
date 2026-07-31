// Shared scoreboard sync layer for the Brovisional Championship scorer.
//
// Design: docs/superpowers/specs/2026-07-31-shared-scoreboard-design.md
//
// Local-first. Every edit lands in memory and localStorage immediately, then queues
// in a persisted outbox that drains to Supabase whenever there is signal. Remote
// changes arrive over a realtime subscription and merge back with last-write-wins.
//
// The pure functions at the top are the whole correctness story and are covered by
// tests.html. The Supabase client is imported dynamically so those tests can run
// with no network.

export const SUPABASE_CONFIG = {
  url: 'https://awkvztyhalfakwlhitft.supabase.co',
  anonKey: 'sb_publishable_rIBtcMUO_yvbuzClgMWWVg_OXqh-vTt'
};

const CLIENT_URL = 'https://esm.sh/@supabase/supabase-js@2';

const LS_SNAPSHOT = 'phuket-golf-snapshot';
const LS_OUTBOX   = 'phuket-golf-outbox';
const LS_DEVICE   = 'phuket-golf-device';

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

// Mirrors the SQL `where` clause in upsert_score/upsert_player. Timestamps are
// epoch ms. The device tiebreak makes identical timestamps resolve the same way
// on every device rather than by arrival order.
export function isNewer(a, b){
  if(!b) return true;
  if(a.updated_at !== b.updated_at) return a.updated_at > b.updated_at;
  return String(a.device || '') > String(b.device || '');
}

export function scoreKey(day, player, hole){ return `s|${day}|${player}|${hole}`; }
export function playerKey(name){ return `p|${name}`; }

// Collapse repeated edits to the same cell, keeping the winner. Hammering the
// +/- stepper eight times on one hole should cost one write, not eight.
export function coalesceOutbox(entries){
  const byKey = new Map();
  for(const e of entries){
    const prev = byKey.get(e.key);
    if(!prev || isNewer(e, prev)) byKey.set(e.key, e);
  }
  return [...byKey.values()].sort((a, b) => a.updated_at - b.updated_at);
}

// SCORES holds gross strokes as strings ('' for blank); the DB holds smallint/null.
export function toDbStrokes(v){
  if(v === '' || v === null || v === undefined) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}
export function fromDbStrokes(n){
  return (n === null || n === undefined) ? '' : String(n);
}

function toMs(t){
  return typeof t === 'number' ? t : Date.parse(t);
}

// Strictly increasing timestamps, per device.
//
// Two reasons this is not just Date.now(). Rapid taps on the +/- stepper land in
// the same millisecond, and on an exact tie the device tiebreak would keep the
// *first* tap rather than the last — so a player tapping 4→5→6→7 would sync a 4.
// And if a phone's clock steps backwards mid-round (NTP correction), plain wall
// time would make new edits lose to old ones both here and in SQL.
export function createClock(now = () => Date.now()){
  let last = 0;
  return () => (last = Math.max(now(), last + 1));
}

// Merge one remote score row into memory. `state` is {SCORES, versions}.
// Returns true if memory changed. A row loses if this device holds a newer
// value — including a still-unflushed local edit, which is what stops a remote
// update from discarding something the user just typed.
export function applyRemoteScore(state, row){
  const day = Number(row.day), hole = Number(row.hole);
  const key = scoreKey(day, row.player, hole);
  const incoming = { updated_at: toMs(row.updated_at), device: row.device };
  if(!isNewer(incoming, state.versions[key])) return false;
  if(!state.SCORES[day] || !state.SCORES[day][row.player]) return false;
  state.SCORES[day][row.player][hole] = fromDbStrokes(row.strokes);
  state.versions[key] = incoming;
  return true;
}

export function applyRemotePlayer(state, row){
  const key = playerKey(row.name);
  const incoming = { updated_at: toMs(row.updated_at), device: row.device };
  if(!isNewer(incoming, state.versions[key])) return false;
  const p = state.PLAYERS.find(x => x.name === row.name);
  if(!p) return false;                       // unknown player: names are build-time constants
  p.hi = Number(row.hi);
  state.versions[key] = incoming;
  return true;
}

export function statusText(state){
  if(state.pending > 0) return state.online ? `Syncing… ${state.pending}` : `Offline — ${state.pending} pending`;
  if(!state.online) return 'Offline';
  return state.live ? 'Live' : 'Saved';
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

function deviceId(){
  let id = null;
  try { id = localStorage.getItem(LS_DEVICE); } catch(e){}
  if(!id){
    id = Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(LS_DEVICE, id); } catch(e){}
  }
  return id;
}

function readJSON(key, fallback){
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch(e){ return fallback; }
}

function writeJSON(key, value){
  try { localStorage.setItem(key, JSON.stringify(value)); } catch(e){}
}

export function createSync({ SCORES, PLAYERS, onRemoteChange, onStatus, config = SUPABASE_CONFIG }){
  const device = deviceId();
  const nextTs = createClock();
  const state = { SCORES, PLAYERS, versions: {}, online: navigator.onLine, live: false, pending: 0 };

  let outbox = readJSON(LS_OUTBOX, []);
  let client = null;
  let flushing = false;
  let backoff = 1000;
  let flushTimer = null;

  const configured = Boolean(config.url && config.anonKey);

  function emitStatus(){
    state.pending = outbox.length;
    if(!onStatus) return;
    // Without credentials nothing is ever going to sync, so don't claim it is.
    onStatus(configured ? statusText(state) : 'Local only — not synced', state);
  }

  function persistSnapshot(){
    writeJSON(LS_SNAPSHOT, { SCORES, PLAYERS, versions: state.versions });
  }

  function persistOutbox(){
    writeJSON(LS_OUTBOX, outbox);
  }

  // -- local edits ----------------------------------------------------------

  function enqueue(entry){
    outbox.push(entry);
    outbox = coalesceOutbox(outbox);
    state.versions[entry.key] = { updated_at: entry.updated_at, device: entry.device };
    persistSnapshot();
    persistOutbox();
    emitStatus();
    scheduleFlush(0);
  }

  function recordScore(day, player, hole, value){
    enqueue({
      kind: 'score',
      key: scoreKey(Number(day), player, Number(hole)),
      day: Number(day), player, hole: Number(hole),
      strokes: toDbStrokes(value),
      updated_at: nextTs(),
      device
    });
  }

  function recordPlayer(name, hi){
    enqueue({
      kind: 'player',
      key: playerKey(name),
      name, hi: Number(hi),
      updated_at: nextTs(),
      device
    });
  }

  // -- flushing -------------------------------------------------------------

  function scheduleFlush(delay){
    if(flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, delay);
  }

  async function flush(){
    if(flushing || !outbox.length || !configured) return;
    if(!navigator.onLine){ state.online = false; emitStatus(); return; }
    flushing = true;
    emitStatus();
    try {
      const sb = await connect();
      // Snapshot the batch: edits made mid-flush stay queued for the next pass.
      const batch = coalesceOutbox(outbox);
      for(const e of batch){
        if(e.kind === 'score'){
          const { error } = await sb.rpc('upsert_score', {
            p_day: e.day, p_player: e.player, p_hole: e.hole,
            p_strokes: e.strokes, p_updated_at: new Date(e.updated_at).toISOString(), p_device: e.device
          });
          if(error) throw error;
        } else {
          const { error } = await sb.rpc('upsert_player', {
            p_name: e.name, p_hi: e.hi,
            p_updated_at: new Date(e.updated_at).toISOString(), p_device: e.device
          });
          if(error) throw error;
        }
        // Drop only this entry, and only if it wasn't superseded while in flight.
        outbox = outbox.filter(x => !(x.key === e.key && x.updated_at <= e.updated_at));
        persistOutbox();
        emitStatus();
      }
      state.online = true;
      backoff = 1000;
    } catch(err){
      state.online = navigator.onLine;
      backoff = Math.min(backoff * 2, 30000);
      scheduleFlush(backoff);
    } finally {
      flushing = false;
      emitStatus();
    }
  }

  // -- remote ---------------------------------------------------------------

  async function connect(){
    if(client) return client;
    const { createClient } = await import(CLIENT_URL);
    client = createClient(config.url, config.anonKey);
    return client;
  }

  async function pullAll(){
    const sb = await connect();
    const [scores, players] = await Promise.all([
      sb.from('scores').select('*'),
      sb.from('players').select('*')
    ]);
    let changed = false;
    if(scores.data) for(const row of scores.data) changed = applyRemoteScore(state, row) || changed;
    if(players.data) for(const row of players.data) changed = applyRemotePlayer(state, row) || changed;
    if(changed){ persistSnapshot(); if(onRemoteChange) onRemoteChange(); }
    return changed;
  }

  async function subscribe(){
    const sb = await connect();
    sb.channel('scoreboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scores' }, ({ new: row }) => {
        if(row && applyRemoteScore(state, row)){ persistSnapshot(); if(onRemoteChange) onRemoteChange(); }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, ({ new: row }) => {
        if(row && applyRemotePlayer(state, row)){ persistSnapshot(); if(onRemoteChange) onRemoteChange(); }
      })
      .subscribe((s) => {
        state.live = (s === 'SUBSCRIBED');
        if(state.live){ pullAll().catch(()=>{}); scheduleFlush(0); }
        emitStatus();
      });
  }

  // -- lifecycle ------------------------------------------------------------

  // Hydrate from localStorage into the caller's existing SCORES/PLAYERS objects,
  // mutating in place so the render functions keep their references. Synchronous
  // and offline, so the caller can paint before any network work begins.
  let hydrated = false;
  function hydrate(){
    if(hydrated) return;
    hydrated = true;
    const snap = readJSON(LS_SNAPSHOT, null);
    if(!snap) return migrateLegacy();
    if(snap.versions) state.versions = snap.versions;
    if(snap.SCORES) mergeSnapshotScores(snap.SCORES);
    if(snap.PLAYERS) mergeSnapshotPlayers(snap.PLAYERS);
  }

  // One-time pickup of scores saved by the pre-sync version of the app.
  function migrateLegacy(){
    const s = readJSON('phuket-golf-scores', null);
    const p = readJSON('phuket-golf-players', null);
    if(s) mergeSnapshotScores(s);
    if(p) mergeSnapshotPlayers(p);
    if(s || p) persistSnapshot();
  }

  function mergeSnapshotScores(src){
    for(const day of Object.keys(src)){
      if(!SCORES[day]) continue;
      for(const player of Object.keys(src[day])){
        if(!SCORES[day][player]) continue;
        SCORES[day][player] = src[day][player].slice();
      }
    }
  }

  function mergeSnapshotPlayers(src){
    for(const sp of src){
      const p = PLAYERS.find(x => x.name === sp.name);
      if(p && typeof sp.hi === 'number') p.hi = sp.hi;
    }
  }

  async function start(){
    hydrate();
    emitStatus();
    if(!configured) return;
    window.addEventListener('online',  () => { state.online = true;  emitStatus(); scheduleFlush(0); });
    window.addEventListener('offline', () => { state.online = false; emitStatus(); });
    // Periodic safety net in case the realtime socket dies quietly mid-round.
    setInterval(() => { if(outbox.length) scheduleFlush(0); }, 20000);
    try {
      await pullAll();
      await subscribe();
    } catch(err){
      state.online = false;
      emitStatus();
    }
    scheduleFlush(0);
  }

  return { hydrate, start, recordScore, recordPlayer, state, _outbox: () => outbox };
}
