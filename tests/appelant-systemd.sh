#!/usr/bin/env bash
# Test : un appel portant metadata.user_id = systemd:<unite> sort dans
# proxy-usage.jsonl sous la source `systemd`, avec le nom de l'unite.
# Un user_id quelconque ne change rien (source habituelle, appelant nul).
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=/tmp/proxytest-appelant; rm -rf "${T:?}"; mkdir -p "$T"
HOME="$T" PORT=8979 CLAUDE_BIN="$ICI/faux-claude-usage" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "${T:?}"' EXIT
sleep 2
for uid in systemd:kana-veille quelconque-42; do
  curl -s -m 10 http://127.0.0.1:8979/v1/messages -H 'content-type: application/json' \
    -d "{\"model\":\"claude-haiku-4-5\",\"max_tokens\":50,\"metadata\":{\"user_id\":\"$uid\"},\"messages\":[{\"role\":\"user\",\"content\":\"go\"}]}" >/dev/null
  sleep 1
done
L="$T/.hermes/proxy-usage.jsonl"
python3 - "$L" <<'PY'
import json, sys
l = [json.loads(x) for x in open(sys.argv[1])]
ok = len(l) == 2 and (l[0]['source'], l[0]['appelant']) == ('systemd', 'kana-veille') \
    and l[1]['source'] == 'auxiliaire' and l[1]['appelant'] is None
print('OK : appelant systemd note, user_id quelconque ignore' if ok else f"ECHEC {[(x['source'], x.get('appelant')) for x in l]}")
sys.exit(0 if ok else 1)
PY
