#!/usr/bin/env bash
#
# Wires the Supabase project into the app and ships it.
#
#   ./configure-sync.sh <project-url> <anon-key>
#
# Checks the credentials actually work (and that the schema was run) BEFORE
# committing anything, then pushes and waits for GitHub Pages to rebuild.

set -euo pipefail

URL="${1:-}"
KEY="${2:-}"
REPO="raineyyong97/brovisional-cup-2026"
SITE="https://raineyyong97.github.io/brovisional-cup-2026"

cd "$(dirname "$0")"

if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "usage: ./configure-sync.sh <project-url> <anon-key>"
  echo "  project-url  e.g. https://abcdefgh.supabase.co   (Settings -> API -> Project URL)"
  echo "  anon-key     the long eyJ... string              (Settings -> API -> anon public)"
  exit 1
fi

URL="${URL%/}"   # tolerate a trailing slash

case "$URL" in
  https://*.supabase.co) ;;
  *) echo "✗ That doesn't look like a Supabase project URL: $URL"; exit 1 ;;
esac

# --- 1. does the project answer, and did the schema run? ---------------------

echo "→ Checking the project responds and the schema exists…"
body=$(curl -s -w '\n%{http_code}' "$URL/rest/v1/scores?select=day&limit=1" \
        -H "apikey: $KEY" -H "Authorization: Bearer $KEY")
code=$(printf '%s' "$body" | tail -1)
payload=$(printf '%s' "$body" | sed '$d')

if [ "$code" = "401" ] || [ "$code" = "403" ]; then
  echo "✗ Supabase rejected that anon key (HTTP $code)."
  echo "  Copy the 'anon public' key from Settings -> API — not the service_role key."
  exit 1
fi

if printf '%s' "$payload" | grep -q "does not exist\|PGRST205"; then
  echo "✗ Credentials work, but the 'scores' table is missing."
  echo "  Open the Supabase SQL editor, paste all of supabase/schema.sql, and run it."
  exit 1
fi

if [ "$code" != "200" ]; then
  echo "✗ Unexpected response (HTTP $code): $payload"
  exit 1
fi
echo "✓ Project reachable and schema present."

# --- 2. confirm the write path exists ----------------------------------------

echo "→ Checking the upsert function is callable…"
# Probes with a real player, no strokes, and a 1970 timestamp. The merge rule
# rejects it if that cell already has a score, and otherwise it writes a blank
# row that renders as an empty box — so probing never leaves visible junk.
rpc=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/rest/v1/rpc/upsert_score" \
       -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
       -d '{"p_day":0,"p_player":"Bob","p_hole":0,"p_strokes":null,"p_updated_at":"1970-01-01T00:00:00Z","p_device":"probe"}')
if [ "$rpc" != "200" ] && [ "$rpc" != "204" ]; then
  echo "✗ upsert_score is not callable (HTTP $rpc)."
  echo "  Re-run supabase/schema.sql — the grants at the bottom are what expose it."
  exit 1
fi
echo "✓ Write path live."

# --- 3. wire it in -----------------------------------------------------------

echo "→ Writing credentials into sync.js…"
python3 - "$URL" "$KEY" <<'PY'
import re, sys
url, key = sys.argv[1], sys.argv[2]
p = 'sync.js'
s = open(p).read()
new = ("export const SUPABASE_CONFIG = {\n"
       f"  url: '{url}',\n"
       f"  anonKey: '{key}'\n"
       "};")
s2, n = re.subn(r"export const SUPABASE_CONFIG = \{.*?\};", new, s, count=1, flags=re.S)
if n != 1:
    sys.exit("could not find SUPABASE_CONFIG in sync.js")
open(p, 'w').write(s2)
PY
echo "✓ sync.js updated."

# --- 4. ship -----------------------------------------------------------------

echo "→ Committing and pushing…"
git add sync.js
git commit -q -m "Add Supabase credentials — scoreboard now shared" || { echo "nothing to commit"; }
git push -q origin main
echo "✓ Pushed."

echo "→ Waiting for GitHub Pages to rebuild…"
for i in $(seq 1 30); do
  st=$(gh api "repos/$REPO/pages" --jq '.status' 2>/dev/null || echo "?")
  [ "$st" = "built" ] && break
  sleep 10
done

echo "→ Verifying the deployed site picked it up…"
for i in $(seq 1 12); do
  if curl -s "$SITE/sync.js" | grep -q "$URL"; then
    echo "✓ Live: $SITE"
    echo
    echo "Open it on two phones and enter a score on one — the other should update"
    echo "within a second or so, and the pill bottom-right should read 'Live'."
    exit 0
  fi
  sleep 10
done

echo "⚠ Pushed and built, but the CDN is still serving the old sync.js."
echo "  Give it a minute and hard-refresh $SITE"
