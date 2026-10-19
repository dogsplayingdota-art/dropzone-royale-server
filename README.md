# Dropzone Royale — Multiplayer Game Server

Authoritative battle-royale game server for the **DROPZONE ROYALE** browser-game
prototype. Clients send **inputs only**; the server simulates everything
(players, hitscan combat, loot, shrinking zone, buggies, bots, airdrop, win
condition) at a fixed **20 Hz** tick and broadcasts snapshots over WebSocket.

- **Stack:** Node.js ≥ 18 + `ws` only. No other runtime dependencies.
- **Protocol:** fully documented in [`PROTOCOL.md`](PROTOCOL.md) (message
  catalog, tick/snapshot model, coordinates, weapon/zone numbers, bot AI).
- **Test:** `npm test` runs `test/sim.js` — spins up the real server on an
  ephemeral port and plays a full scripted match (lobby → countdown → drop →
  combat → airdrop → elimination → win), asserting ~40 checks. Must exit 0.

## Run locally

```bash
npm install
npm start            # listens on $PORT or 3000
npm test             # simulation test (needs the ws package installed)
```

`GET /` returns `200 ok` (health checks). Optional env: `DZR_DEBUG=1` enables
the **test-only** debug hook used by `test/sim.js` (kill/hurt/airdrop) —
never enable in production.

## Deploy to Render (free tier)

1. Push this directory to a GitHub repo (no credentials or secrets in it —
   there are none; config is env vars only).
2. Render dashboard → **New → Web Service** → connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Plan:** Free
   - (Optional) add `render.yaml` from this repo as a Blueprint instead —
     it encodes the same settings.)
4. Deploy. The game client then connects to `wss://<your-service>.onrender.com/`.

Notes:

- Render's free tier **sleeps after ~15 min idle** — the first connection after
  sleep takes ~50 s while the service wakes. Later connections are instant.
- The server keeps no database; rooms live in memory and are cleaned up when
  empty / ~2 min after a match ends.
- Never commit `node_modules/` (see `.gitignore`).

## Repo layout

```
server.js        # the whole server: rooms, 20 Hz sim, bots, combat, protocol
test/sim.js      # scripted full-match simulation test (plain node + ws)
PROTOCOL.md      # protocol + rules documentation for the game-client builder
render.yaml      # Render blueprint (free web service)
package.json     # name dropzone-royale-server, start script, engines
```

## Rules summary (authoritative numbers live in server.js + PROTOCOL.md)

600×600 m island · 100 HP · everyone drops with a Pistol · 5 lootable weapons
(Pistol/SMG/Rifle/Shotgun/Sniper) + medkits (4 s channel, +75 HP, interrupted
by damage) · hitscan with distance falloff · 7-phase shrinking zone (20 s wait
+ 25 s shrink to 55%, 2/s → 14/s outside damage) · 4 drivable buggies (20 m/s,
60 dmg run-over, 200 HP destructible) · airdrop at ~90 s (Sniper + 2 medkits) ·
bots fill to 12 combatants · last-one-standing wins, full placements.
