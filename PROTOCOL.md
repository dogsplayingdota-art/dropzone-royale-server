# Dropzone Royale — Server Protocol

JSON messages over WebSocket. The server is **authoritative**: clients send
inputs only; the server simulates everything at a fixed **20 Hz** tick and
broadcasts snapshots. Never trust client-side positions, health, or hits.

Endpoint: `ws://<host>:<port>/` (same port as HTTP; `GET /` returns `200 ok`
for Render health checks). Port = `process.env.PORT || 3000`.

## Coordinate & angle conventions (frozen — clients depend on these)

- Meters on the **X/Z ground plane**, island centered at **(0, 0)**.
  Playable island: x, z ∈ [-300, 300] (water outside; server hard-clamps).
- **y** = height in meters. Ground = 0, parachute spawns at y = 130.
- **Aim yaw** (radians): `0` = facing **+Z** (north), increases clockwise
  toward **+X** (east). Forward vector = `(sin(yaw), cos(yaw))`.
  To aim from `(ax, az)` at `(bx, bz)`: `yaw = atan2(bx - ax, bz - az)`.
- **Pitch**: `0` = level, positive = up, clamped to ±1.2.
- All snapshot floats are rounded to 2 decimals.

## Tick / snapshot model

- Fixed timestep: 50 ms (20 Hz). `tick` increments every simulation step.
- During `drop` and `play` phases every connected human receives a `snap`
  message **every tick** (~20/s). Lobby/countdown/ended phases: no snaps.
- `snap.ev` carries **all events since the previous snap** (kill feed, deaths,
  zone changes, loot deltas, …). Clients must drain it every tick.
- Inputs are stateful: the server keeps each player's last `input` and
  re-applies it every tick until a new one arrives. Send at ~10–20 Hz or on
  change; sending once and holding is fine.
- Typical bandwidth ≈ 1.5 KB/snap × 20 Hz ≈ **30 KB/s per client** (12
  combatants). Loot is *not* in the snapshot (see below).

## Client → server messages

| `t` | fields | meaning |
|---|---|---|
| `hello` | `name` (string, ≤16) | Identify yourself. → `welcome`. |
| `create` | `name?` | Create a room, become creator. → `room` broadcast. |
| `join` | `code`, `name?` | Join a lobby by 4-letter code (case-insensitive). Errors: `room not found`, `match already in progress`, `room is full`. |
| `leave` | — | Leave a **lobby** room. (Mid-match: just disconnect; a bot takes over your body.) |
| `start` | — | Creator only, lobby only. Begins the 5 s countdown. |
| `input` | see below | Movement/aim/fire/actions. In `lobby`/`countdown` only `dropX`/`dropZ` are read. |
| `ping` | `t0?` | → `pong`. |
| `debug` | `cmd`, … | **TEST ONLY**, requires `DZR_DEBUG=1` on the server (see bottom). |

### `input` fields

```json
{ "t": "input",
  "f": 0|1, "b": 0|1, "l": 0|1, "r": 0|1,   // forward/back/left/right (WASD)
  "yaw": 1.57, "pitch": 0.0,                 // aim (see conventions)
  "firing": true,                            // hold to fire
  "act": ["reload", "medkit", "enter"],       // one-shot actions, consumed on receipt
  "dropX": 282, "dropZ": 282 }                // parachute target, lobby/countdown/drop only
```

- On foot: `f/b` = forward/back along aim yaw, `l/r` = strafe. Speed 6 m/s.
- Driving a buggy: `f/b` = throttle/brake, `l/r` = steering. Aim/fire disabled.
- `act` values: `reload`, `medkit` (4 s channel), `enter` (buggy ≤3.5 m),
  `exit`. Unknown values are ignored.
- `dropX`/`dropZ` are clamped to ±290 and stored server-side.

## Server → client messages

| `t` | fields | meaning |
|---|---|---|
| `welcome` | `clientId`, `tickHz: 20` | After `hello`. |
| `room` | `code`, `state`, `players[]` | Lobby roster, broadcast on every change. `players[]`: `{id, name, bot, creator}`. `state`: `lobby` (only state that emits this). |
| `error` | `message` | Rejected request (bad code, in-progress join, non-creator start, …). |
| `countdown` | `secs` | Each second of the 5 s countdown (`5…1`, then `0` = go). |
| `dropStart` | `dur` | Drop phase began (`dur` ≈ 15 s). Steer with WASD; ~12 s descent from y=130. |
| `lootState` | `items[]` | **Full** loot list, sent once at drop start. `items[]`: `{id, k: "w"\|"m", w: "rifle"\|…, x, z}` (`w` absent for medkits). |
| `playStart` | — | Drop phase over, everyone grounded, combat live. |
| `snap` | see below | 20 Hz game state (drop + play phases). |
| `matchEnd` | `winner`, `placements[]`, `reason` | `winner`: `{id, name}` (null only if truly nobody). `placements`: `{id, name, bot, place, kills}[]` sorted by place. `reason`: `last-standing` \| `mass-death` \| `timeout`. |
| `pong` | `t0` | Ping reply. |
| `debugOk` | `cmd`, … | Debug command accepted (test only). |

### `snap` fields

```json
{ "t": "snap", "tick": 1234, "pt": 12.35,
  "pl": [ { "i":"p7", "n":"Viper", "x":12.3, "z":-45.1, "y":0,
            "hp": 100, "al": 1, "w":"rifle", "am": 30, "mk": 1,
            "dv": 0, "k": 2, "bot": 1 } ],
  "vh": [ { "i":"v1", "x":10, "z":-40, "yw": 1.2, "sp": 14.5,
            "hp": 200, "dr": "Viper", "dd": 0 } ],
  "zone": { "cx":0, "cz":0, "r":450, "ph":1, "m":"wait" },
  "ad": null,                       // or { "m":"incoming"|"landed", "x":…, "z":… }
  "you": { "am":30, "rl":0, "rlt":0, "ch":0, "mk":1, "hp":100, "k":2, "st":"playing" },
  "ev": [ … ] }
```

- `pl`: every combatant (humans + bots). `y` > 0 means still parachuting.
  `w` = current weapon key, `am` = mag ammo, `mk` = medkits, `dv` = in vehicle,
  `k` = kills.
- `vh`: the 4 buggies. `dr` = driver name (null if empty), `dd` = destroyed.
- `zone.m`: `wait` (20 s) → `shrink` (25 s) → … → `done`.
- `you`: your private state — mag ammo, reloading (`rl`/`rlt` seconds left),
  medkit channel progress (`ch` seconds left), medkits, hp, kills, phase state.
- `ev`: events since last snap (see below). **Drain every tick.**

### Event objects (`snap.ev[]`)

| `t` | fields | meaning |
|---|---|---|
| `feed` | `text` | Kill-feed line, e.g. `A killed B [Rifle]`, `A ran over B [Buggy]`, `A died to the zone`, `📦 Airdrop landed: Sniper + 2 medkits!`. Render verbatim. |
| `death` | `victimId`, `victim`, `killerId`, `killer`, `weapon`, `cause`, `place` | `cause`: `shot` \| `runover` \| `zone` \| `debug`. `killer*` null for zone deaths. `place` = victim's final placement. |
| `zone` | `phase`, `mode` | Zone phase/mode changed (`shrink`, `wait`, `done`). |
| `airdrop` | `mode`, `x`, `z` | `incoming` (crate falling, mark the map) → `landed` (loot spawned: Sniper + 2 medkits). |
| `lootSpawn` | `items[]` | New loot (airdrop contents, death drops). Same item shape as `lootState`. Add to local loot map. |
| `lootGone` | `ids[]` | Loot picked up/removed. Delete from local loot map. |
| `vehicleDown` | `id` | A buggy was destroyed (wreck, cannot be entered). |

**Loot model:** clients keep a local loot map seeded by `lootState`, then apply
`lootSpawn` / `lootGone` deltas. Loot is *not* repeated in snapshots (bandwidth).

## Match flow (client's-eye view)

1. `hello` → `welcome`.
2. `create` **or** `join {code}` → `room` (re-broadcast on roster changes).
3. Creator sends `start` → `countdown` (5…0). Send `input {dropX, dropZ}` now
   (or during the drop) to pick a landing spot; default = random.
4. `dropStart` + `lootState` → steer the chute with WASD (`snap.pl[].y` > 0).
5. `playStart` → fight. Send `input` continuously; read `snap` at 20 Hz.
6. `matchEnd` → show placements. Room closes ~2 min later.

Rejects: joining a non-lobby room or a full (30/30) room returns `error`
and leaves you unattached — surface `error.message` to the user.

## Game rules (authoritative numbers)

- **Start loadout:** everyone drops with a **Pistol** (12/∞). Better weapons
  and medkits spawn as ground loot (110 weapons + 60 medkits per match,
  auto-pickup ≤ 2.2 m, weapons only if strictly better than current).
- **Weapons** (damage, interval, mag, reload, range). All are hold-to-fire at
  the listed interval. Hitscan; linear falloff to **half damage at max range**;
  small random spread, larger while moving; shotgun fires 8 pellets with extra
  spread:
  - Pistol: 18, 0.35 s, 12, 1.2 s, 60 m
  - SMG: 14, 0.11 s, 30, 1.6 s, 50 m
  - Rifle: 24, 0.14 s, 30, 2.0 s, 120 m
  - Shotgun: 8×9, 0.90 s, 6, 2.2 s, 25 m
  - Sniper: 90, 1.50 s, 5, 2.8 s, 300 m
- **Medkit:** 4 s channel, +75 HP (cap 100), **any damage interrupts**,
  carry max 4.
- **Zone:** 7 phases; each = 20 s wait + 25 s shrink to 55% radius; new center
  uniform-random inside the current circle. Outside damage: **2/s phase 1,
  +2/s per later phase** (2, 4, 6, 8, 10, 12, 14).
- **Buggies (4):** enter ≤ 3.5 m (`act:["enter"]`), exit (`act:["exit"]`).
  ~20 m/s top speed, −8 m/s reverse. Running over a player at > 6 m/s deals
  **60 dmg** (1 s per-victim cooldown). Buggy HP 200, destructible by gunfire;
  driver is ejected unharmed on destruction. No firing while driving.
- **Airdrop:** at ~90 s of play, crate falls for 6 s at a random point inside
  the zone → Sniper + 2 medkits. `airdrop` events carry the coordinates.
- **Deaths:** victims drop their weapon + medkits as loot. Disconnecting
  mid-match hands your body to the bot AI (fairness, no free kills).
- **Win:** last one standing. If everyone dies in the same tick, **highest HP
  at death wins** (`reason: "mass-death"`). 15-minute safety timeout awards
  the alive player with most HP. Placements 1..N for all combatants.

## Bots

On match start the server fills to **12 combatants** (humans + bots, max 30).
Bots parachute to spread-out points, then every 0.4 s decide: heal (< 55 HP,
medkit available, no enemy within 45 m) → engage nearest enemy within 80 m
(keep 14–38 m, strafe, **0.4–0.9 s reaction delay**, aim error growing with
distance) → seek better-weapon/medkit loot → rotate into the zone → wander.
They die, feed the kill feed, and count toward the win like anyone else. They
never drive (documented limitation).

## Test-only debug hook (disabled by default)

With `DZR_DEBUG=1` in the server environment, clients may send:

- `{t:"debug", cmd:"kill", target:"<id|name>"}` — kill a combatant
- `{t:"debug", cmd:"hurt", target:"<id|name>", amount: 25}` — damage one
- `{t:"debug", cmd:"airdrop"}` — trigger the airdrop immediately

→ `debugOk` or `error`. **Not part of the game protocol** — used by
`test/sim.js` for the elimination phase and to force the airdrop. Never enable
in production.
