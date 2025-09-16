PLAYER ACTIONS
==============

Purpose
-------
This file explains how to use `player.sh` and the `/move` endpoint to play the simulation.

Requirements
------------
- bash (or a POSIX-compatible shell)
- curl
- jq (command-line JSON processor)

Environment
-----------
- BASE: The base URL of the server, e.g. `https://min.liminalgates.net` (EASY) or `https://max.liminalgates.net` (HARD)
- TOKEN: Automatically cached by `player.sh` after the first `/status` call. You can also set it manually.

Quick Start
-----------
1) Claim a seat and cache a token:
```bash
$ ./player.sh status
```

1) Advance a random turn (no actions):
```bash
$ ./player.sh move
```

1) Automate multiple turns with recipe and delay:
```bash
$ ./player.sh loop FILE.json         # uses SLEEP_SECS (default 2s)
$ ./player.sh loop 2 FILE.json       # explicit 2s delay
# or set an env for this shell:
# SLEEP_SECS=6 ./player.sh loop FILE.json
```

Built-in Commands
-----------------
```bash
./player.sh help
./player.sh status
./player.sh move [--boost k=v,..] [--trade k=v,..] [--covert k=v,..] [--act '<raw-json>']
./player.sh loop [DELAY] FILE.json
```

Action Flags
------------
Add small, bounded actions to a `/move` using flags. Multiple flags can be combined in one turn.

```
--boost 'ps=...,ta=...,ea=...,investI=...,policy=...,focus=...'
  - ps       : Public Stability bump (0.00–0.03 typical per turn)
  - ta       : Technology Advancement bump (0.00–0.03 typical)
  - ea       : External Alliances/Openness bump (0.00–0.03 typical)
  - investI  : Infrastructure investment (0.00–0.12 typical)
  - policy   : (optional) counterintel | price_stability | food_security
               • counterintel  → faster HEAT decay; higher detect chance vs enemies
               • price_stability → steadier prices; TA gains slightly reduced this turn
               • food_security → small extra Food stock bump
  - focus    : (optional) industry | services | agri (nudges inventories/externals a bit)

--trade 'to=...,cat=...,vol=...'
  - to   : Target regime (emoji name like '🏔🌋', internal id, or 0-based index)
          (Indices can shift as regimes fall/spawn; emoji name copied from status is safest.)
  - cat  : Market category (e.g. F for Food, M for Metals, G for Goods, I for Infrastructure)
  - vol  : Trade volume (0.01–0.60 typical; server clamps and applies quotas)
  
--covert 'to=...,kind=...,x=...,stealth=...'
  - to      : Target regime (emoji name, id, or 0-based index)
  - kind    : 'destabilize' | 'steal_tech'
  - x       : Small effect size (0.001–0.02 typical; clamped server-side)
  - stealth : true|false (optional). Stealth lowers detection risk but costs more PC and may reduce payoff if caught.
  Detection:
    • Higher PS/RA and attacker HEAT increase detect chance.
    • If detected: target gets a brief PS guard; attacker HEAT spikes; TA steal payoff is reduced.

--act '<raw-json>'
  - Supply a raw action object to be appended to the `acts` array (advanced).
```

Notes
-----
- Values are parsed as strings by the shell and coerced server-side. The server enforces bounds and a per-turn
  action budget; if you over-specify, it will apply what fits and ignore the rest.
- Mode difficulty and budgets differ (MIN easier, MAX harder).

Examples (single turn)
----------------------
```bash
# Slight domestic boost with policy & focus:
$ ./player.sh move --boost 'ps=0.01,ta=0.01,ea=0.006,investI=0.05,policy=counterintel,focus=industry'

# Trade finished goods to a named target (emoji):
$ ./player.sh move --trade 'to=🏔🌋,cat=G,vol=0.08'

# Stealth tech theft against index 2:
$ ./player.sh move --covert 'to=2,kind=steal_tech,x=0.006,stealth=true'
```

Strategy Files
--------------
Attach a strategy file for repeated or sequenced actions during `loop`. See `recipe.json.sample` for shape.

```
A) Static every-turn strategy (same actions each turn)
   File: strategy.simple.json
   [
     { "type":"boost","ps":0.02,"ta":0.01,"ea":0.01,"investI":0.10,"policy":"price_stability" },
     { "type":"trade","to":"🏔🌋","cat":"F","vol":0.20 },
     { "type":"covert","to":"🧩🌳","kind":"destabilize","x":0.01,"stealth":true }
   ]

   Run:
   # 3 second interval
   $ ./player.sh loop 3 strategy.simple.json
   # or single turn:
   $ ./player.sh move --act "$(cat strategy.simple.json)"

B) Sequenced per-turn strategy (rotate through a list)
   File: strategy.sequence.json
   {
     "perTurn": [
       [ { "type":"boost","ps":0.01,"ta":0.01,"investI":0.06,"policy":"counterintel","focus":"industry" } ],
       [ { "type":"trade","to":"🏔🌋","cat":"G","vol":0.08 } ],
       [ { "type":"covert","to":"🌋💎","kind":"steal_tech","x":0.006,"stealth":true } ],
       [ { "type":"boost","ea":0.012,"investI":0.03,"policy":"food_security","focus":"agri" } ]
     ]
   }

   Run:
   $ ./player.sh loop 2 strategy.sequence.json
```

HTTP Schema
-----------

```
Endpoint:
  POST /move
Body:
  {
    "token": "...",
    "acts": [
      { "type":"boost","ps":0.02,"ta":0.01,"ea":0.01,"investI":0.10,"policy":"counterintel","focus":"industry" },
      { "type":"trade","to":"🏔🌋","cat":"F","vol":0.20 },
      { "type":"covert","to":"🌋💎","kind":"destabilize","x":0.01,"stealth":true }
    ]
  }

Return:
  - Snapshot of the world after the turn.
  - May include: `token` (refreshed), `step`, `policy`, `meters` (PC/HC/HEAT),
    `score` (rolling), `best` (your epoch best), `rank`, narrative lines,
    and sometimes `board` (mini leaderboard).
  - If your regime ends, the server replies 410; `player.sh loop` stops on 410.
```