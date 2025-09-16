#!/usr/bin/env bash

BASE="${BASE:-http://localhost:3000}"
STATE="${STATE_FILE:-.sim_state}"
SLEEP_SECS="${SLEEP_SECS:-2}"

jqval()  { jq -r "$1" <<<"$2"; }
jqsafe() { jq -r "$1 // \"\"" <<<"$2"; }
exists() { command -v "$1" >/dev/null 2>&1; }

die() { echo "error: $*" >&2; exit 1; }

need_tools() {
  exists curl || die "curl is required"
  exists jq   || die "jq is required"
}

TOKEN=""
LAST_HTTP=""
save_state() { printf '{"token":%s}\n' "$(jq -Rn --arg t "$TOKEN" '$t')" > "$STATE"; }
load_state() { if [ -f "$STATE" ]; then TOKEN="$(jq -r '.token // empty' < "$STATE")"; fi; }

ensure_token() {
  if [ -z "${TOKEN:-}" ]; then
    local resp; resp=$(curl -sS "$BASE/status")
    if jq -e '.ok==true' >/dev/null 2>&1 <<<"$resp"; then
      TOKEN="$(jq -r '.token // empty' <<<"$resp")"
      [ -n "$TOKEN" ] && save_state
      print_header_and_body "$resp"
    else
      echo "Failed to auto-join shard:"
      echo "$resp" | jq .
      exit 1
    fi
  fi
}

_http() {
  local method="$1"; local path="$2"; shift 2
  local tmp; tmp="$(mktemp)"
  local code
  if [ "$method" = "GET" ]; then
    code=$(curl -sS -o "$tmp" -w "%{http_code}" \
      -H "Authorization: Bearer ${TOKEN}" \
      "$BASE$path")
  else
    code=$(curl -sS -o "$tmp" -w "%{http_code}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$*" "$BASE$path")
  fi
  LAST_HTTP="$code"
  cat "$tmp"
  rm -f "$tmp"
}
api_get()  { _http "GET"  "$1"; }
api_post() { local path="$1"; shift; _http "POST" "$path" "$@"; }

_rolling_score_value() {
  local resp="$1"

  local rolling
  rolling="$(jq -r 'try .score // empty' <<<"$resp")"
  if [[ -n "$rolling" && "$rolling" != "null" ]]; then
    printf "%s" "$rolling"
    return
  fi

  local snap; snap="$(jq -r 'try .snapshot // empty' <<<"$resp")"
  [[ -z "$snap" ]] && return

  local sw S W
  sw="$(awk '
    BEGIN{inF=0; si=0; wi=0}
    /^FUNDAMENTALS/ {inF=1; next}
    inF && /^-+/ {next}
    inF && si==0 && $1=="Regime" {
      for(i=1;i<=NF;i++){
        if($i=="Stability") si=i;
        if($i=="Wealth")   wi=i;
      } next
    }
    inF && $1=="*" && si>0 && wi>0 { printf "%s %s\n", $(si), $(wi); exit }
  ' <<<"$snap")" || true

  S="$(awk '{print $1}' <<<"$sw")"
  W="$(awk '{print $2}' <<<"$sw")"
  [[ -z "$S" || -z "$W" ]] && return

  awk -v S="$S" -v W="$W" 'BEGIN{ printf "%.0f", 1000 + 2*W + 1*S }'
}

print_header_and_body() {
  local resp="$1"

  local tok; tok=$(jq -r '.token // empty' <<<"$resp")
  if [ -n "$tok" ]; then TOKEN="$tok"; save_state; fi

  if jq -e '.ok==true' >/dev/null 2>&1 <<<"$resp"; then
    local policy step seat tro scr
    printf "\n"

    if jq -e '.meters' >/dev/null 2>&1 <<<"$resp"; then
      local pc hc ht
      pc=$(jq -r '.meters.PC // empty' <<<"$resp")
      hc=$(jq -r '.meters.HC // empty' <<<"$resp")
      ht=$(jq -r '.meters.HEAT // empty' <<<"$resp")
      if [ -n "$pc" ] || [ -n "$hc" ] || [ -n "$ht" ]; then
        printf "Meters — PC:%s  HC:%s  Heat:%s\n" \
          "${pc:-—}" "${hc:-—}" "${ht:-—}"
      fi
    fi
    
    jq -r '.snapshot // empty' <<<"$resp"

    if [ -n "$(jq -r '.snapshot // empty' <<<"$resp")" ] \
       && [ "$(jq -r '((.narrative // []) | length)' <<<"$resp")" != "0" ]; then
      echo
    fi

    jq -r '(.narrative // [])[]' <<<"$resp"

    printf "\n"
    policy=$(jq -r '.policy // .mode // "?"' <<<"$resp")
    step=$(jq -r '.step // "?"' <<<"$resp")
    seat=$(jq -r '.you.idx // empty' <<<"$resp")
    tro=$(jq -r '.trophy // empty' <<<"$resp")
    scr="$(_rolling_score_value "$resp")"

    printf "Policy: %s | Step: %s" "$policy" "$step"
    [ -n "$seat" ] && printf " | Seat: R%s" "$seat"
    [ -n "$tro" ]  && printf " | Trophy: %s" "$tro"
    [ -n "$scr" ]  && printf " | Score: %s"  "$scr"
    printf "\n"
    
  else
    echo "Request failed:"
    echo "$resp" | jq .
  fi

  if [ "$(jq -r '.trophy // empty' <<<"$resp")" = "last_survivor" ]; then
    echo
    echo "==================== 🏆 LAST PLAYER STANDING 🏆 ===================="
    local s; s=$(jq -r '.score // empty' <<<"$resp")
    [ -n "$s" ] && echo "Score: $s"
    echo "Congratulations! Your legend is on the board."
    echo "=================================================================="
  fi
}

cmd_help() {
  cat <<EOF
player.sh — CLI for ${BASE} (single persistent shard)

Commands:
  ./player.sh join                      Join game
  ./player.sh status                    Show current snapshot (joins if needed)
  ./player.sh move [--boost ...]        Advance one turn; accepts flags below
  ./player.sh loop recipe.json          Run a scripted loop of /move payloads
  ./player.sh board [EPOCH] [MODE]      Show top scores (MODE=MIN|MAX). EPOCH optional.
  ./player.sh reset                     Reset player token

Move flags:
  --boost 'ps=0.01,ta=0.01,ea=0.005,investI=0.05'
  --trade 'to=<name|id>,cat=F|M|G|I|...,vol=0.10'
  --covert 'to=<name|id>,kind=destabilize|steal_tech,x=0.005'

Requires: curl, jq
EOF
}

cmd_reset() { TOKEN=""; rm -f "$STATE"; echo "State cleared."; }

cmd_status() { local resp; resp=$(api_get "/status"); print_header_and_body "$resp"; }
cmd_join()   { cmd_status; }

kv_to_json_obj() {
  local s="${1:-}"
  if [ -z "$s" ]; then
    echo "{}"
    return
  fi
  jq -Rn --arg s "$s" '
    def parse:
      if test("^-?[0-9]+(\\.[0-9]+)?$") then tonumber
      elif . == "true"  then true
      elif . == "false" then false
      else .
      end;
    $s
    | split(",")
    | map(select(length>0))
    | map(split("=") | {k: (.[0] // ""), v: (.[1] // "")})
    | map({ ( .k ): (.v | parse) })
    | add
  '
}

build_acts_payload() {
  local boost_str="${BOOST:-}"
  local trade_str="${TRADE:-}"
  local covert_str="${COVERT:-}"

  local acts; acts="[]"

  if [ -n "$boost_str" ]; then
    local obj; obj=$(kv_to_json_obj "$boost_str")
    acts=$(jq -c --argjson o "$obj" '. + [{"type":"boost"} + $o]' <<<"$acts")
  fi
  if [ -n "$trade_str" ]; then
    local obj; obj=$(kv_to_json_obj "$trade_str")
    acts=$(jq -c --argjson o "$obj" '. + [{"type":"trade"} + $o]' <<<"$acts")
  fi
  if [ -n "$covert_str" ]; then
    local obj; obj=$(kv_to_json_obj "$covert_str")
    acts=$(jq -c --argjson o "$obj" '. + [{"type":"covert"} + $o]' <<<"$acts")
  fi

  echo "$acts"
}

cmd_move() {
  local BOOST=""; local TRADE=""; local COVERT=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --boost)  shift; BOOST="${1:-}";;
      --trade)  shift; TRADE="${1:-}";;
      --covert) shift; COVERT="${1:-}";;
      *) echo "unknown flag: $1"; return 1;;
    esac
    shift || true
  done

  ensure_token

  local acts; acts=$(build_acts_payload)
  if ! jq -e 'type=="array"' >/dev/null 2>&1 <<<"$acts"; then
    echo "Invalid acts payload built; got:" >&2
    echo "$acts" >&2
    exit 1
  fi

  local payload; payload=$(jq -nc --arg t "$TOKEN" --argjson a "$acts" '{token:$t, acts:$a}')
  local resp; resp=$(api_post "/move" "$payload")
  print_header_and_body "$resp"
  if [ "$LAST_HTTP" = "410" ]; then
    echo
    echo "⛔  Server says your regime is gone (410). Stopping."
    exit 0
  fi
}

cmd_loop() {
  local a1="${1:-}" a2="${2:-}"
  local delay file

  if [[ "$a1" =~ ^[0-9]+$ ]] && [ -n "$a2" ]; then
    delay="$a1"; file="$a2"
  else
    file="$a1"
  fi

  [ -n "$file" ] || die "usage: ./player.sh loop [DELAY_SECONDS] recipe.json"
  [ -f "$file" ] || die "file not found: $file"

  ensure_token

  local arr; arr=$(jq -c 'if type=="array" then . else [.] end' "$file")
  local i len; len=$(jq -r 'length' <<<"$arr")
  for ((i=0; i<len; i++)); do
    local turn; turn=$(jq -c ".[$i]" <<<"$arr")
    local acts; acts=$(jq -c '.acts // []' <<<"$turn")
    local payload; payload=$(jq -nc --arg t "$TOKEN" --argjson a "$acts" '{token:$t, acts:$a}')
    local resp; resp=$(api_post "/move" "$payload")
    print_header_and_body "$resp"

    if [ "$LAST_HTTP" = "410" ]; then
      echo; echo "⛔  Regime ended (410). Ending loop."
      break
    fi

    sleep "${delay:-$SLEEP_SECS}"
  done
}

api_board() {
  local url="${BASE}/scoreboard"
  local epoch="${1:-}"; local mode="${2:-}"
  if [ -n "$epoch" ]; then url="${url}?epoch=${epoch}"; fi
  if [ -n "$mode" ]; then
    if [[ "$url" == *"?"* ]]; then url="${url}&mode=${mode}"; else url="${url}?mode=${mode}"; fi
  fi
  curl -sS "$url"
}
cmd_board() {
  local epoch="${1:-}"; shift || true
  local mode="${1:-}";  shift || true
  api_board "$epoch" "$mode" | jq .
}

need_tools
load_state

case "${1:-}" in
  join)   shift; cmd_join "$@";;
  status) shift; cmd_status "$@";;
  move)   shift; cmd_move "$@";;
  loop)   shift; cmd_loop "$@";;
  board)  shift; cmd_board "$@";;
  reset)  shift; cmd_reset "$@";;
  ""|help|-h|--help) cmd_help;;
  *) echo "unknown command: $1"; cmd_help; exit 1;;
esac
