'use strict';
/* ============================================================================
 * DROPZONE ROYALE — authoritative multiplayer game server
 * ----------------------------------------------------------------------------
 * A PUBG-style battle royale prototype backend. Clients send *inputs only*;
 * this server owns the whole simulation and broadcasts snapshots at 20 Hz.
 *
 * Match flow:  lobby -> 5s countdown -> drop phase (~15s, steerable
 * parachute) -> play (loot, hitscan combat, shrinking zone, buggies,
 * airdrop) -> end (last one standing wins).
 *
 * Game rules implemented here (authoritative numbers):
 *  - Island: 600x600 m square, x/z in [-300, 300]. Water outside (hard clamp).
 *  - HP 100. Everyone drops with a standard-issue Pistol; better weapons and
 *    medkits are looted on the ground (auto-pickup within 2.2 m).
 *  - Weapons (dmg, interval, mag, reload, range):
 *      Pistol:  18 dmg, 0.35s, 12 rds, 1.2s, 60 m
 *      SMG:     14 dmg, 0.11s, 30 rds, 1.6s, 50 m, full-auto
 *      Rifle:   24 dmg, 0.14s, 30 rds, 2.0s, 120 m, full-auto
 *      Shotgun: 8 pellets x 9 dmg, 0.90s, 6 rds, 2.2s, 25 m, spread
 *      Sniper:  90 dmg, 1.50s, 5 rds, 2.8s, 300 m
 *    Hitscan with linear falloff (half damage at max range) and small spread
 *    while moving. Semi-auto weapons fire on trigger edge only.
 *  - Medkit: 4 s channel, restores 75 HP (capped at 100), interrupted by any
 *    damage. Carry cap: 4.
 *  - Zone: 7 phases. Each phase = 20 s wait + 25 s shrink to 55% radius, new
 *    center random inside the current circle. Outside-zone damage: 2/s in
 *    phase 1, +2/s every later phase (4, 6, ... 14).
 *  - Buggies: 4 spawn per match. Enter/exit with actions, WASD driving up to
 *    ~20 m/s, running someone over at speed deals 60 dmg. Buggy has 200 HP
 *    and can be destroyed by gunfire (driver ejected unharmed).
 *  - Airdrop at ~90 s into play: crate lands at a random point inside the
 *    zone with a Sniper + 2 medkits; an event is broadcast for map marking.
 *  - Win: last one standing. If everyone dies in the same tick, the highest
 *    HP at death wins. Full placements (1..N) for every combatant.
 *  - Kill feed: "A killed B [Rifle]", "A ran over B [Buggy]",
 *    "A died to the zone".
 *
 * Coordinate convention (documented in PROTOCOL.md, must never change):
 *  - Meters on the X/Z ground plane, island centered at (0,0), y = height.
 *  - Aim yaw: 0 = facing +Z (north), increases clockwise toward +X (east).
 *    Forward vector = (sin(yaw), cos(yaw)). Pitch 0 = level, + = up.
 * ========================================================================== */

const http = require('http');
const WebSocket = require('ws');

// ------------------------------- tuning ------------------------------------
const TICK_HZ = 20;
const DT = 1 / TICK_HZ;                 // fixed 50 ms timestep
const PORT = parseInt(process.env.PORT || '3000', 10);

const ISLAND_HALF = 300;                // island is 600x600 m
const BOUNDS = ISLAND_HALF - 2;         // hard clamp (water outside)
const MAX_PLAYERS = 30;
const MIN_COMBATANTS = 12;              // bots fill up to this many

const FOOT_SPEED = 6;                   // m/s on foot
const DRIFT_SPEED = 8;                  // m/s parachute steering
const DROP_HEIGHT = 130;                // m
const DROP_RATE = DROP_HEIGHT / 12;     // ~12 s descent
const DROP_PHASE_TIME = 15;             // s, drop window
const COUNTDOWN_TIME = 5;               // s

const PLAYER_HIT_RADIUS = 1.1;          // m, hitscan body radius
const BUGGY_HIT_RADIUS = 2.4;           // m
const PICKUP_RADIUS = 2.2;              // m, auto-pickup
const MEDKIT_TIME = 4;                  // s channel
const MEDKIT_HEAL = 75;
const MEDKIT_MAX = 4;

const BUGGY_SPEED = 20;                 // m/s top speed
const BUGGY_REVERSE = -8;               // m/s
const BUGGY_HP = 200;
const RUNOVER_DMG = 60;
const RUNOVER_MIN_SPEED = 6;            // m/s
const ENTER_RADIUS = 3.5;               // m

const ZONE_R0 = 450;                    // m, initial radius (covers island)
const ZONE_PHASES = 7;
const ZONE_WAIT = 20;                   // s before each shrink
const ZONE_SHRINK = 25;                 // s of shrinking
const ZONE_FACTOR = 0.55;               // radius multiplier per phase
const zoneDps = (phase) => 2 + 2 * (Math.min(phase, ZONE_PHASES) - 1);

const AIRDROP_AT = 90;                  // s into play phase
const AIRDROP_FALL = 6;                 // s crate descent
const MATCH_TIMEOUT = 900;              // s, safety cap

const WEAPONS = {
  pistol:  { name: 'Pistol',  dmg: 18, interval: 0.35, mag: 12, reload: 1.2, range: 60,  auto: false, pellets: 1, spread: 0 },
  smg:     { name: 'SMG',     dmg: 14, interval: 0.11, mag: 30, reload: 1.6, range: 50,  auto: true,  pellets: 1, spread: 0 },
  rifle:   { name: 'Rifle',   dmg: 24, interval: 0.14, mag: 30, reload: 2.0, range: 120, auto: true,  pellets: 1, spread: 0 },
  shotgun: { name: 'Shotgun', dmg: 9,  interval: 0.90, mag: 6,  reload: 2.2, range: 25,  auto: false, pellets: 8, spread: 0.07 },
  sniper:  { name: 'Sniper',  dmg: 90, interval: 1.50, mag: 5,  reload: 2.8, range: 300, auto: false, pellets: 1, spread: 0 },
};
const WEAPON_RANK = { pistol: 0, smg: 1, shotgun: 2, rifle: 3, sniper: 4 };

const BOT_NAMES = ['Viper','Ghost','Blaze','Cobra','Diesel','Echo','Fang','Gizmo',
  'Hawk','Ivy','Jinx','Koda','Luna','Maverick','Nova','Onyx','Piper','Quinn',
  'Rogue','Sable','Tango','Umbra','Vex','Wolf','Xeno','Yara','Zeke','Ash',
  'Bolt','Cinder'];

// ------------------------------- utils -------------------------------------
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, k) => a + (b - a) * k;
const r2 = (v) => Math.round(v * 100) / 100;   // snapshot float precision
const d2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

function dirFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
}

function genCode(existing) {
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += L[randi(0, 25)];
  } while (existing.has(code));
  return code;
}

// --------------------------- entities & rooms ------------------------------
let playerSeq = 0;
let clientSeq = 0;
let lootSeq = 0;
let vehicleSeq = 0;

function makePlayer(id, name, isBot) {
  return {
    id, name, isBot: !!isBot, ws: null,
    state: 'lobby',            // lobby | drop | playing | dead
    x: 0, z: 0, y: 0, yaw: 0,
    hp: 100, alive: true,
    weapon: 'pistol', ammo: WEAPONS.pistol.mag,
    medkits: 0, kills: 0,
    reloadT: 0, channelT: 0, nextShotT: 0,
    vehicleId: null, place: null, disconnected: false,
    dropX: null, dropZ: null,  // chosen drop target (null = random)
    input: { f: 0, b: 0, l: 0, r: 0, yaw: 0, pitch: 0, firing: false, act: [] },
    ai: { nextThink: 0, reactT: 0, lastTarget: null, strafeDir: 1, strafeT: 0,
          wanderX: 0, wanderZ: 0, wanderT: 0 },
    _runoverCd: 0,
  };
}

function makeRoom(code) {
  return {
    code,
    state: 'lobby',            // lobby | countdown | drop | play | ended
    creatorId: null,
    players: [],               // humans + bots
    loot: [],                  // {id, k:'w'|'m', w, x, z}
    vehicles: [],              // buggies
    tick: 0, time: 0,
    countdownT: 0, _cdLast: -1,
    dropT: 0, playT: 0, endT: 0,
    zone: null,
    airdrop: { started: false },
    events: [],                // drained into each snap broadcast
    deathsTick: [],            // {id, hpAtDeath, cause} for mass-death rule
    winner: null,
  };
}

const rooms = new Map();       // code -> room

function uniqueName(room, base) {
  const taken = new Set(room.players.map(p => p.name.toLowerCase()));
  let name = (base || 'Player').slice(0, 16) || 'Player';
  if (!taken.has(name.toLowerCase())) return name;
  let i = 2;
  while (taken.has((name + i).toLowerCase())) i++;
  return name + i;
}

function addPlayer(room, client, name, isBot) {
  const p = makePlayer('p' + (++playerSeq), uniqueName(room, name), isBot);
  p.ws = client ? client.ws : null;
  room.players.push(p);
  if (client) { client.player = p; client.room = room; }
  return p;
}

function removePlayer(room, p) {
  room.players = room.players.filter(q => q !== p);
  if (room.creatorId === p.id) {
    const nextHuman = room.players.find(q => !q.isBot && !q.disconnected);
    room.creatorId = nextHuman ? nextHuman.id : null;
  }
}

// ------------------------------ match setup --------------------------------
function spawnBots(room) {
  const humans = room.players.filter(p => !p.isBot);
  const want = clamp(MIN_COMBATANTS - humans.length, 0, MAX_PLAYERS - room.players.length);
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  for (let i = 0; i < want; i++) {
    addPlayer(room, null, names[i % names.length] + (i >= names.length ? ' ' + (i + 1) : ''), true);
  }
}

function spawnLoot(room) {
  room.loot.length = 0;
  const wTypes = ['pistol','smg','rifle','shotgun','sniper'];
  const wW = [0.25, 0.25, 0.25, 0.18, 0.07];
  const pickW = () => {
    let r = Math.random(), acc = 0;
    for (let i = 0; i < wTypes.length; i++) { acc += wW[i]; if (r <= acc) return wTypes[i]; }
    return 'pistol';
  };
  for (let i = 0; i < 110; i++) {
    room.loot.push({ id: 'l' + (++lootSeq), k: 'w', w: pickW(),
      x: r2(rand(-290, 290)), z: r2(rand(-290, 290)) });
  }
  for (let i = 0; i < 60; i++) {
    room.loot.push({ id: 'l' + (++lootSeq), k: 'm',
      x: r2(rand(-290, 290)), z: r2(rand(-290, 290)) });
  }
}

function spawnVehicles(room) {
  room.vehicles.length = 0;
  for (let i = 0; i < 4; i++) {
    room.vehicles.push({
      id: 'v' + (++vehicleSeq),
      x: r2(rand(-260, 260)), z: r2(rand(-260, 260)),
      yaw: rand(0, Math.PI * 2), speed: 0,
      hp: BUGGY_HP, driverId: null, destroyed: false,
    });
  }
}

function initZone(room) {
  room.zone = { cx: 0, cz: 0, r: ZONE_R0, phase: 1, mode: 'wait', t: ZONE_WAIT,
                from: null, to: null };
}

function feed(room, text) {
  room.events.push({ t: 'feed', text });
}

// ------------------------- phase transitions -------------------------------
function startDrop(room) {
  room.state = 'drop';
  room.dropT = DROP_PHASE_TIME;
  room.tick = 0;
  spawnBots(room);
  spawnLoot(room);
  spawnVehicles(room);
  initZone(room);
  room.airdrop = { started: false };
  room.deathsTick = [];
  room.winner = null;
  for (const p of room.players) {
    p.state = 'drop';
    p.alive = true; p.hp = 100;
    p.weapon = 'pistol'; p.ammo = WEAPONS.pistol.mag;
    p.medkits = 0; p.kills = 0; p.place = null;
    p.reloadT = 0; p.channelT = 0; p.nextShotT = 0;
    p.vehicleId = null; p._runoverCd = 0;
    p.y = DROP_HEIGHT;
    p.x = clamp(p.dropX != null ? p.dropX : rand(-280, 280), -BOUNDS, BOUNDS);
    p.z = clamp(p.dropZ != null ? p.dropZ : rand(-280, 280), -BOUNDS, BOUNDS);
    p.yaw = rand(0, Math.PI * 2);
    p.input = { f: 0, b: 0, l: 0, r: 0, yaw: p.yaw, pitch: 0, firing: false, act: [] };
    // bots spread their drop points across the island
    if (p.isBot) {
      p.x = clamp(rand(-280, 280), -BOUNDS, BOUNDS);
      p.z = clamp(rand(-280, 280), -BOUNDS, BOUNDS);
    }
  }
  broadcast(room, { t: 'dropStart', dur: DROP_PHASE_TIME });
  // full loot list once; afterwards only deltas (lootSpawn / lootGone)
  const items = room.loot.map(l => ({ id: l.id, k: l.k, w: l.w, x: l.x, z: l.z }));
  for (const p of room.players) {
    if (!p.isBot && p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({ t: 'lootState', items }));
    }
  }
  feed(room, 'Drop started — steer with WASD, good luck!');
}

function startPlay(room) {
  for (const p of room.players) {
    if (p.state === 'drop') { p.y = 0; p.state = 'playing'; }
  }
  room.state = 'play';
  room.playT = 0;
  broadcast(room, { t: 'playStart' });
  feed(room, 'Match started — last one standing wins!');
}

// ------------------------------- bot AI ------------------------------------
function botGoto(p, tx, tz) {
  const dx = tx - p.x, dz = tz - p.z;
  if (Math.hypot(dx, dz) < 2) {
    p.input.f = 0; p.input.b = 0; p.input.l = 0; p.input.r = 0;
    return;
  }
  p.input.yaw = Math.atan2(dx, dz);
  p.input.f = 1; p.input.b = 0; p.input.l = 0; p.input.r = 0;
}

function botMoveVec(p, dx, dz) {
  const d = Math.hypot(dx, dz);
  if (d < 0.1) { p.input.f = 0; p.input.b = 0; p.input.l = 0; p.input.r = 0; return; }
  const s = Math.sin(p.input.yaw), c = Math.cos(p.input.yaw);
  const lf = (dx * s + dz * c) / d, lr = (dx * c - dz * s) / d;
  p.input.f = lf > 0.25 ? 1 : 0; p.input.b = lf < -0.25 ? 1 : 0;
  p.input.r = lr > 0.25 ? 1 : 0; p.input.l = lr < -0.25 ? 1 : 0;
}

function findBotLoot(room, p) {
  let best = null, bd = 250;
  for (const l of room.loot) {
    if (l.k === 'w' && WEAPON_RANK[l.w] <= WEAPON_RANK[p.weapon]) continue;
    if (l.k === 'm' && p.medkits >= 2) continue;
    const d = d2(p.x, p.z, l.x, l.z);
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}

function thinkBot(room, p) {
  const ai = p.ai;
  ai.reactT -= 0.4; // think interval

  // nearest living enemy
  let ne = null, nd = Infinity;
  for (const q of room.players) {
    if (q === p || !q.alive || q.state !== 'playing') continue;
    const d = d2(p.x, p.z, q.x, q.z);
    if (d < nd) { nd = d; ne = q; }
  }
  if (ne && ne.id !== ai.lastTarget) ai.reactT = rand(0.4, 0.9); // reaction delay
  ai.lastTarget = ne ? ne.id : null;

  p.input.act.length = 0;
  const z = room.zone;
  const zDist = d2(p.x, p.z, z.cx, z.cz);

  // heal when hurt and safe
  if (p.hp < 55 && p.medkits > 0 && p.channelT <= 0 && (!ne || nd > 45)) {
    p.input.act.push('medkit');
    botGoto(p, z.cx + rand(-20, 20), z.cz + rand(-20, 20));
    p.input.firing = false;
    return;
  }

  // engage nearest enemy within ~80 m and inside weapon range
  const w = WEAPONS[p.weapon];
  if (ne && nd < 80 && nd < w.range * 0.95) {
    const moving = p.input.f || p.input.b || p.input.l || p.input.r;
    const err = 0.03 + (nd / 80) * 0.13 + (moving ? 0.02 : 0); // worse with distance
    p.input.yaw = Math.atan2(ne.x - p.x, ne.z - p.z) + rand(-err, err);
    p.input.pitch = 0;
    let mx = 0, mz = 0;
    const ax = (p.x - ne.x) / (nd || 1), az = (p.z - ne.z) / (nd || 1);
    if (nd < 14) { mx = ax; mz = az; }          // back off
    else if (nd > 38) { mx = -ax; mz = -az; }   // close in
    ai.strafeT -= 0.4;
    if (ai.strafeT <= 0) { ai.strafeT = rand(1, 2.5); ai.strafeDir = Math.random() < 0.5 ? -1 : 1; }
    mx += -az * ai.strafeDir * 0.8; mz += ax * ai.strafeDir * 0.8; // strafe
    botMoveVec(p, mx, mz);
    p.input.firing = ai.reactT <= 0;
    return;
  }

  p.input.firing = false;
  // bots stay on foot: never drive

  // seek better loot
  const item = findBotLoot(room, p);
  if (item) { botGoto(p, item.x, item.z); return; }

  // rotate toward zone when outside or near the edge
  if (zDist > z.r * 0.7) { botGoto(p, z.cx + rand(-30, 30), z.cz + rand(-30, 30)); return; }

  // wander inside the zone
  ai.wanderT -= 0.4;
  if (ai.wanderT <= 0) {
    ai.wanderT = rand(5, 9);
    const a = rand(0, Math.PI * 2), dd = rand(0, Math.max(20, z.r * 0.5));
    ai.wanderX = z.cx + Math.cos(a) * dd; ai.wanderZ = z.cz + Math.sin(a) * dd;
  }
  botGoto(p, ai.wanderX, ai.wanderZ);
}

// -------------------------------- combat -----------------------------------
function raycast(room, shooter, eye, dir, range) {
  let best = null, bestAlong = Infinity;
  // players (standing center ~1.0 m above feet)
  for (const q of room.players) {
    if (q === shooter || !q.alive || q.state !== 'playing') continue;
    const vx = q.x - eye.x, vy = (q.y + 1.0) - eye.y, vz = q.z - eye.z;
    const along = vx * dir.x + vy * dir.y + vz * dir.z;
    if (along < 0.5 || along > range || along >= bestAlong) continue;
    const px = vx - dir.x * along, py = vy - dir.y * along, pz = vz - dir.z * along;
    if (Math.hypot(px, py, pz) < PLAYER_HIT_RADIUS) {
      best = { kind: 'player', ref: q, along }; bestAlong = along;
    }
  }
  // buggies (center ~0.6 m above ground)
  for (const v of room.vehicles) {
    if (v.destroyed || v.driverId === shooter.id) continue;
    const vx = v.x - eye.x, vy = 0.6 - eye.y, vz = v.z - eye.z;
    const along = vx * dir.x + vy * dir.y + vz * dir.z;
    if (along < 0.5 || along > range || along >= bestAlong) continue;
    const px = vx - dir.x * along, py = vy - dir.y * along, pz = vz - dir.z * along;
    if (Math.hypot(px, py, pz) < BUGGY_HIT_RADIUS) {
      best = { kind: 'vehicle', ref: v, along }; bestAlong = along;
    }
  }
  return best;
}

function fireWeapon(room, p) {
  const w = WEAPONS[p.weapon];
  const eye = { x: p.x, y: p.y + 1.4, z: p.z }; // eye height
  const moving = p.input.f || p.input.b || p.input.l || p.input.r;
  for (let i = 0; i < w.pellets; i++) {
    // small spread while moving + shotgun pellet spread
    const sp = (moving ? 0.03 : 0.008) + (w.spread ? rand(-w.spread, w.spread) : 0);
    const dir = dirFromYawPitch(p.input.yaw + rand(-sp, sp), clamp(p.input.pitch + rand(-sp, sp), -1.2, 1.2));
    const hit = raycast(room, p, eye, dir, w.range);
    if (!hit) continue;
    const falloff = 1 - 0.5 * (hit.along / w.range); // half damage at max range
    const dmg = w.dmg * falloff;
    if (hit.kind === 'player') damagePlayer(room, hit.ref, dmg, p, w.name, 'shot');
    else damageVehicle(room, hit.ref, dmg, p);
  }
  p.ammo--;
  p.nextShotT = room.time + w.interval;
  if (p.ammo <= 0) startReload(p); // auto-reload on empty
}

function updateFire(room, p) {
  const firing = !!p.input.firing;
  const canFire = p.alive && p.state === 'playing' && !p.vehicleId &&
                  p.reloadT <= 0 && p.channelT <= 0;
  if (!canFire || !firing) return;
  const w = WEAPONS[p.weapon];
  if (room.time < p.nextShotT) return;
  if (p.ammo <= 0) { startReload(p); return; }
  fireWeapon(room, p);
}

function startReload(p) {
  const w = WEAPONS[p.weapon];
  if (p.reloadT > 0 || p.ammo >= w.mag || p.state !== 'playing') return;
  p.reloadT = w.reload;
}

function startMedkit(p) {
  if (p.medkits <= 0 || p.hp >= 100 || p.channelT > 0 || p.state !== 'playing') return;
  p.medkits--;
  p.channelT = MEDKIT_TIME;
}

function damagePlayer(room, target, dmg, killer, weaponName, cause) {
  if (!target.alive || target.state !== 'playing' || room.state !== 'play') return;
  if (dmg <= 0) return;
  target.hp -= dmg;
  if (target.channelT > 0) target.channelT = 0; // medkit interrupted by damage
  if (target.hp <= 0) killPlayer(room, target, killer, weaponName, cause);
}

function damageVehicle(room, v, dmg, shooter) {
  if (v.destroyed) return;
  v.hp -= dmg;
  if (v.hp <= 0) {
    v.hp = 0; v.destroyed = true; v.speed = 0;
    if (v.driverId) {
      const d = room.players.find(p => p.id === v.driverId);
      if (d) {
        d.vehicleId = null;
        d.x = clamp(v.x + Math.cos(v.yaw) * 2.5, -BOUNDS, BOUNDS);
        d.z = clamp(v.z - Math.sin(v.yaw) * 2.5, -BOUNDS, BOUNDS);
      }
      v.driverId = null;
    }
    room.events.push({ t: 'vehicleDown', id: v.id });
    feed(room, `${shooter.name} destroyed a buggy`);
  }
}

function dropLootOnDeath(room, p) {
  const mk = (k, w) => ({ id: 'l' + (++lootSeq), k, w, x: r2(p.x + rand(-1, 1)), z: r2(p.z + rand(-1, 1)) });
  const spawned = [mk('w', p.weapon)];
  for (let i = 0; i < p.medkits; i++) spawned.push(mk('m'));
  room.loot.push(...spawned);
  room.events.push({ t: 'lootSpawn', items: spawned.map(l => ({ id: l.id, k: l.k, w: l.w, x: l.x, z: l.z })) });
}

function killPlayer(room, victim, killer, weaponName, cause) {
  if (!victim.alive) return;
  const hpAtDeath = victim.hp;
  const place = room.players.filter(p => p.alive).length; // N alive incl. victim -> place N
  victim.alive = false;
  victim.state = 'dead';
  victim.place = place;
  victim.input.firing = false;
  victim.channelT = 0;
  if (victim.vehicleId) {
    const v = room.vehicles.find(v => v.id === victim.vehicleId);
    if (v) v.driverId = null;
    victim.vehicleId = null;
  }
  dropLootOnDeath(room, victim);
  if (killer && killer !== victim && killer.alive !== undefined) killer.kills++;

  let text;
  if (cause === 'zone') text = `${victim.name} died to the zone`;
  else if (cause === 'runover') text = `${killer ? killer.name : 'Someone'} ran over ${victim.name} [Buggy]`;
  else if (cause === 'debug') text = `${victim.name} was eliminated`;
  else text = `${killer ? killer.name : 'Someone'} killed ${victim.name} [${weaponName || '?'}]`;
  feed(room, text);
  room.events.push({ t: 'death', victimId: victim.id, victim: victim.name,
    killerId: killer ? killer.id : null, killer: killer ? killer.name : null,
    weapon: weaponName || null, cause, place });
  room.deathsTick.push({ id: victim.id, hpAtDeath, cause });
}

// --------------------------- vehicles & pickups -----------------------------
function vehicleById(room, id) { return room.vehicles.find(v => v.id === id); }

function enterVehicle(room, p) {
  if (p.vehicleId || p.state !== 'playing') return;
  for (const v of room.vehicles) {
    if (v.destroyed || v.driverId) continue;
    if (d2(p.x, p.z, v.x, v.z) < ENTER_RADIUS) {
      v.driverId = p.id; p.vehicleId = v.id;
      p.input.firing = false;
      room.events.push({ t: 'feed', text: `${p.name} hopped into a buggy` });
      return;
    }
  }
}

function exitVehicle(room, p) {
  if (!p.vehicleId) return;
  const v = vehicleById(room, p.vehicleId);
  if (v) {
    v.driverId = null; v.speed = 0;
    p.x = clamp(v.x + Math.cos(v.yaw) * 2.5, -BOUNDS, BOUNDS);
    p.z = clamp(v.z - Math.sin(v.yaw) * 2.5, -BOUNDS, BOUNDS);
  }
  p.vehicleId = null;
}

function checkRunover(room) {
  for (const v of room.vehicles) {
    if (v.destroyed || !v.driverId || Math.abs(v.speed) < RUNOVER_MIN_SPEED) continue;
    const driver = room.players.find(p => p.id === v.driverId);
    for (const p of room.players) {
      if (!p.alive || p.state !== 'playing' || p.vehicleId || p._runoverCd > 0) continue;
      if (d2(p.x, p.z, v.x, v.z) < 2.3) {
        p._runoverCd = 1.0; // one hit per second per victim
        damagePlayer(room, p, RUNOVER_DMG, driver, 'Buggy', 'runover');
      }
    }
  }
}

function checkPickups(room) {
  for (const p of room.players) {
    if (!p.alive || p.state !== 'playing' || p.vehicleId) continue;
    for (let i = room.loot.length - 1; i >= 0; i--) {
      const l = room.loot[i];
      if (d2(p.x, p.z, l.x, l.z) > PICKUP_RADIUS) continue;
      if (l.k === 'w') {
        if (WEAPON_RANK[l.w] <= WEAPON_RANK[p.weapon]) continue; // only upgrades
        // drop current weapon where you stand
        room.loot.push({ id: 'l' + (++lootSeq), k: 'w', w: p.weapon, x: r2(p.x), z: r2(p.z) });
        p.weapon = l.w; p.ammo = WEAPONS[l.w].mag; p.reloadT = 0;
        room.loot.splice(i, 1);
        room.events.push({ t: 'lootGone', ids: [l.id] });
        if (!p.isBot) room.events.push({ t: 'feed', text: `${p.name} picked up a ${WEAPONS[l.w].name}` });
        break;
      } else if (l.k === 'm') {
        if (p.medkits >= MEDKIT_MAX) continue;
        p.medkits++;
        room.loot.splice(i, 1);
        room.events.push({ t: 'lootGone', ids: [l.id] });
        break;
      }
    }
  }
}

// ------------------------------ zone & airdrop ------------------------------
function updateZone(room, dt) {
  const z = room.zone;
  z.t -= dt;
  if (z.mode === 'wait' && z.t <= 0) {
    const rTo = z.r * ZONE_FACTOR;
    const maxOff = Math.max(0, z.r - rTo);
    const a = rand(0, Math.PI * 2), dd = rand(0, maxOff);
    z.from = { cx: z.cx, cz: z.cz, r: z.r };
    z.to = { cx: z.cx + Math.cos(a) * dd, cz: z.cz + Math.sin(a) * dd, r: rTo };
    z.mode = 'shrink'; z.t = ZONE_SHRINK;
    room.events.push({ t: 'zone', phase: z.phase, mode: 'shrink' });
    feed(room, `Zone phase ${z.phase}: shrinking!`);
  } else if (z.mode === 'shrink') {
    const k = clamp(1 - Math.max(0, z.t) / ZONE_SHRINK, 0, 1);
    z.cx = lerp(z.from.cx, z.to.cx, k);
    z.cz = lerp(z.from.cz, z.to.cz, k);
    z.r = lerp(z.from.r, z.to.r, k);
    if (z.t <= 0) {
      z.cx = z.to.cx; z.cz = z.to.cz; z.r = z.to.r;
      z.phase++;
      if (z.phase > ZONE_PHASES) {
        z.mode = 'done';
        room.events.push({ t: 'zone', phase: ZONE_PHASES, mode: 'done' });
        feed(room, 'Final zone — nowhere left to hide!');
      } else {
        z.mode = 'wait'; z.t = ZONE_WAIT;
        room.events.push({ t: 'zone', phase: z.phase, mode: 'wait' });
      }
    }
  }
}

function applyZoneDamage(room, dt) {
  const z = room.zone;
  const dps = zoneDps(z.phase);
  for (const p of room.players) {
    if (!p.alive || p.state !== 'playing') continue;
    if (d2(p.x, p.z, z.cx, z.cz) > z.r) {
      damagePlayer(room, p, dps * dt, null, 'Zone', 'zone');
    }
  }
}

function startAirdrop(room) {
  const z = room.zone;
  const a = rand(0, Math.PI * 2), dd = rand(0, z.r * 0.6);
  room.airdrop = { started: true, mode: 'falling',
    x: r2(z.cx + Math.cos(a) * dd), z: r2(z.cz + Math.sin(a) * dd), fallT: AIRDROP_FALL };
  room.events.push({ t: 'airdrop', mode: 'incoming', x: room.airdrop.x, z: room.airdrop.z });
  feed(room, 'Airdrop incoming — check the map!');
}

function landAirdrop(room) {
  const ad = room.airdrop;
  ad.mode = 'landed';
  const mk = (k, w, dx, dz) => ({ id: 'l' + (++lootSeq), k, w,
    x: r2(ad.x + dx), z: r2(ad.z + dz) });
  const spawned = [mk('w', 'sniper', 0, 0), mk('m', undefined, 1.5, 0), mk('m', undefined, -1.5, 0)];
  room.loot.push(...spawned);
  room.events.push({ t: 'airdrop', mode: 'landed', x: ad.x, z: ad.z });
  room.events.push({ t: 'lootSpawn', items: spawned.map(l => ({ id: l.id, k: l.k, w: l.w, x: l.x, z: l.z })) });
  feed(room, 'Airdrop landed: Sniper + 2 medkits!');
}

// ------------------------------ tick logic ---------------------------------
function doActions(room, p) {
  for (const a of p.input.act) {
    if (a === 'reload') startReload(p);
    else if (a === 'medkit') startMedkit(p);
    else if (a === 'enter') enterVehicle(room, p);
    else if (a === 'exit') exitVehicle(room, p);
  }
  p.input.act.length = 0; // actions are one-shot
}

function applyMovement(room, p) {
  const inp = p.input;
  if (p.state === 'drop') {
    // parachute descent + steerable drift
    p.y -= DROP_RATE * DT;
    const fx = Math.sin(inp.yaw), fz = Math.cos(inp.yaw);
    const rx = Math.cos(inp.yaw), rz = -Math.sin(inp.yaw);
    let vx = fx * (inp.f - inp.b) + rx * (inp.r - inp.l);
    let vz = fz * (inp.f - inp.b) + rz * (inp.r - inp.l);
    const len = Math.hypot(vx, vz);
    if (len > 1) { vx /= len; vz /= len; }
    p.x = clamp(p.x + vx * DRIFT_SPEED * DT, -BOUNDS, BOUNDS);
    p.z = clamp(p.z + vz * DRIFT_SPEED * DT, -BOUNDS, BOUNDS);
    if (p.y <= 0) { p.y = 0; p.state = 'playing'; }
    return;
  }
  if (p.state !== 'playing') return;

  if (p.vehicleId) {
    // arcade buggy driving: f/b = throttle, l/r = steering
    const v = vehicleById(room, p.vehicleId);
    if (!v || v.destroyed) { p.vehicleId = null; return; }
    const target = inp.f ? BUGGY_SPEED : inp.b ? BUGGY_REVERSE : 0;
    v.speed += clamp(target - v.speed, -14 * DT, 14 * DT);
    v.yaw += (inp.r - inp.l) * 1.7 * DT * clamp(v.speed / 8, -1, 1);
    v.x = clamp(v.x + Math.sin(v.yaw) * v.speed * DT, -BOUNDS, BOUNDS);
    v.z = clamp(v.z + Math.cos(v.yaw) * v.speed * DT, -BOUNDS, BOUNDS);
    p.x = v.x; p.z = v.z; p.yaw = v.yaw;
    return;
  }

  const fx = Math.sin(inp.yaw), fz = Math.cos(inp.yaw);
  const rx = Math.cos(inp.yaw), rz = -Math.sin(inp.yaw);
  let vx = fx * (inp.f - inp.b) + rx * (inp.r - inp.l);
  let vz = fz * (inp.f - inp.b) + rz * (inp.r - inp.l);
  const len = Math.hypot(vx, vz);
  if (len > 1) { vx /= len; vz /= len; }
  p.x = clamp(p.x + vx * FOOT_SPEED * DT, -BOUNDS, BOUNDS);
  p.z = clamp(p.z + vz * FOOT_SPEED * DT, -BOUNDS, BOUNDS);
}

function tickPlayer(room, p) {
  if (!p.alive) return;
  doActions(room, p);
  applyMovement(room, p);
  // reload progress
  if (p.reloadT > 0) {
    p.reloadT -= DT;
    if (p.reloadT <= 0) { p.reloadT = 0; p.ammo = WEAPONS[p.weapon].mag; }
  }
  // medkit channel
  if (p.channelT > 0) {
    p.channelT -= DT;
    if (p.channelT <= 0) {
      p.channelT = 0;
      p.hp = Math.min(100, p.hp + MEDKIT_HEAL);
      if (!p.isBot) room.events.push({ t: 'feed', text: `${p.name} used a medkit (+${MEDKIT_HEAL} HP)` });
    }
  }
  if (p._runoverCd > 0) p._runoverCd -= DT;
  updateFire(room, p);
}

function checkWin(room) {
  if (room.winner) return;
  const alive = room.players.filter(p => p.alive);
  if (alive.length === 1) {
    endMatch(room, 'last-standing', alive[0]);
  } else if (alive.length === 0) {
    // everyone died this tick: highest HP at death wins
    const ds = [...room.deathsTick].sort((a, b) => b.hpAtDeath - a.hpAtDeath);
    const w = room.players.find(p => p.id === (ds[0] && ds[0].id));
    ds.forEach((d, i) => {
      const pl = room.players.find(p => p.id === d.id);
      if (pl) pl.place = i + 1;
    });
    endMatch(room, 'mass-death', w);
  } else if (room.playT > MATCH_TIMEOUT) {
    const w = [...alive].sort((a, b) => b.hp - a.hp)[0];
    endMatch(room, 'timeout', w);
  }
}

function endMatch(room, reason, winner) {
  room.state = 'ended';
  room.endT = 0;
  room.winner = winner || null;
  if (winner && winner.place == null) winner.place = 1;
  const placements = room.players
    .map(p => ({ id: p.id, name: p.name, bot: p.isBot, place: p.place == null ? 99 : p.place, kills: p.kills }))
    .sort((a, b) => a.place - b.place);
  const msg = { t: 'matchEnd',
    winner: winner ? { id: winner.id, name: winner.name } : null,
    placements, reason };
  broadcast(room, msg);
  feed(room, winner ? `${winner.name} wins the match!` : 'Match ended with no winner');
}

function tickRoom(room) {
  room.time += DT;
  room.tick++;
  switch (room.state) {
    case 'countdown': {
      room.countdownT -= DT;
      const secs = Math.max(0, Math.ceil(room.countdownT));
      if (secs !== room._cdLast) {
        room._cdLast = secs;
        broadcast(room, { t: 'countdown', secs });
      }
      if (room.countdownT <= 0) startDrop(room);
      break;
    }
    case 'drop': {
      for (const p of room.players) {
        if (!p.alive) continue;
        if (p.isBot && p.state === 'drop') {
          // bots drift toward their drop point
          const dx = p.dropX != null ? p.dropX - p.x : 0;
          const dz = p.dropZ != null ? p.dropZ - p.z : 0;
          if (Math.hypot(dx, dz) > 3) {
            p.input.yaw = Math.atan2(dx, dz);
            p.input.f = 1;
          } else p.input.f = 0;
        }
        applyMovement(room, p);
      }
      room.dropT -= DT;
      if (room.dropT <= 0) startPlay(room);
      else broadcastSnap(room);
      break;
    }
    case 'play': {
      room.playT += DT;
      room.deathsTick = [];
      updateZone(room, DT);
      if (!room.airdrop.started && room.playT >= AIRDROP_AT) startAirdrop(room);
      if (room.airdrop.started && room.airdrop.mode === 'falling') {
        room.airdrop.fallT -= DT;
        if (room.airdrop.fallT <= 0) landAirdrop(room);
      }
      for (const p of room.players) {
        if (p.alive && p.isBot && p.state === 'playing' && room.time >= p.ai.nextThink) {
          p.ai.nextThink = room.time + 0.4;
          thinkBot(room, p);
        }
      }
      for (const p of room.players) tickPlayer(room, p);
      checkRunover(room);
      checkPickups(room);
      applyZoneDamage(room, DT);
      checkWin(room);
      if (room.state === 'play') broadcastSnap(room);
      break;
    }
    case 'ended': {
      room.endT += DT;
      if (room.endT > 120 || room.players.length === 0) rooms.delete(room.code);
      break;
    }
  }
}

// ------------------------------- snapshots ---------------------------------
function buildSnap(room, evs) {
  const z = room.zone || { cx: 0, cz: 0, r: ZONE_R0, phase: 1, mode: 'wait' };
  return {
    t: 'snap', tick: room.tick, pt: r2(room.playT || 0),
    pl: room.players.map(p => ({
      i: p.id, n: p.name, x: r2(p.x), z: r2(p.z), y: r2(p.y),
      hp: Math.max(0, Math.ceil(p.hp)), al: p.alive ? 1 : 0,
      w: p.weapon, am: p.ammo, mk: p.medkits, dv: p.vehicleId ? 1 : 0,
      k: p.kills, bot: p.isBot ? 1 : 0,
    })),
    vh: room.vehicles.map(v => ({
      i: v.id, x: r2(v.x), z: r2(v.z), yw: r2(v.yaw), sp: r2(v.speed),
      hp: Math.max(0, Math.ceil(v.hp)),
      dr: v.driverId ? (room.players.find(p => p.id === v.driverId) || {}).name || null : null,
      dd: v.destroyed ? 1 : 0,
    })),
    zone: { cx: r2(z.cx), cz: r2(z.cz), r: r2(z.r), ph: z.phase, m: z.mode },
    ad: room.airdrop.started ? { m: room.airdrop.mode, x: r2(room.airdrop.x), z: r2(room.airdrop.z) } : null,
    ev: evs,
  };
}

function broadcastSnap(room) {
  const evs = room.events.splice(0); // drain once, share with all clients
  const base = buildSnap(room, evs);
  for (const p of room.players) {
    if (p.isBot || !p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
    const you = {
      am: p.ammo, rl: p.reloadT > 0 ? 1 : 0, rlt: r2(Math.max(0, p.reloadT)),
      ch: r2(Math.max(0, p.channelT)), mk: p.medkits,
      hp: Math.max(0, Math.ceil(p.hp)), k: p.kills, st: p.state,
    };
    p.ws.send(JSON.stringify({ ...base, you }));
  }
}

// ------------------------------ networking ---------------------------------
function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  for (const p of room.players) {
    if (!p.isBot && p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(s);
  }
}

function roomMsg(room) {
  return {
    t: 'room', code: room.code, state: room.state,
    players: room.players.map(p => ({
      id: p.id, name: p.name, bot: p.isBot, creator: p.id === room.creatorId,
    })),
  };
}

function broadcastRoom(room) { broadcast(room, roomMsg(room)); }

function sanitizeInput(m) {
  const b = v => v ? 1 : 0;
  const inp = {
    f: b(m.f), b: b(m.b), l: b(m.l), r: b(m.r),
    yaw: clamp(Number(m.yaw) || 0, -Math.PI * 4, Math.PI * 4),
    pitch: clamp(Number(m.pitch) || 0, -1.2, 1.2),
    firing: !!m.firing,
    act: [],
  };
  if (Array.isArray(m.act)) {
    for (const a of m.act.slice(0, 4)) {
      if (['reload', 'medkit', 'enter', 'exit'].includes(a)) inp.act.push(a);
    }
  }
  return inp;
}

function handleDebug(client, m) {
  // TEST-ONLY hook, enabled only with DZR_DEBUG=1. Never part of the game.
  const room = client.room;
  if (!room || (room.state !== 'play' && room.state !== 'drop')) {
    return sendTo(client.ws, { t: 'error', message: 'debug: no active match' });
  }
  const findTarget = (sel) => room.players.find(p =>
    p.id === sel || p.name.toLowerCase() === String(sel).toLowerCase());
  if (m.cmd === 'kill' && m.target) {
    const p = findTarget(m.target);
    if (!p || !p.alive) return sendTo(client.ws, { t: 'error', message: 'debug: target not found/alive' });
    killPlayer(room, p, null, null, 'debug');
    checkWin(room);
    return sendTo(client.ws, { t: 'debugOk', cmd: 'kill', target: p.name });
  }
  if (m.cmd === 'hurt' && m.target) {
    const p = findTarget(m.target);
    if (!p || !p.alive) return sendTo(client.ws, { t: 'error', message: 'debug: target not found/alive' });
    damagePlayer(room, p, Number(m.amount) || 10, null, 'Debug', 'debug');
    return sendTo(client.ws, { t: 'debugOk', cmd: 'hurt', target: p.name });
  }
  if (m.cmd === 'airdrop') {
    if (room.state !== 'play') return sendTo(client.ws, { t: 'error', message: 'debug: not in play' });
    if (!room.airdrop.started) startAirdrop(room);
    return sendTo(client.ws, { t: 'debugOk', cmd: 'airdrop' });
  }
  return sendTo(client.ws, { t: 'error', message: 'debug: unknown cmd' });
}

function handleMessage(client, m) {
  if (!m || typeof m.t !== 'string') return sendTo(client.ws, { t: 'error', message: 'bad message' });

  switch (m.t) {
    case 'hello': {
      client.name = String(m.name || 'Player').slice(0, 16);
      return sendTo(client.ws, { t: 'welcome', clientId: client.id, tickHz: TICK_HZ });
    }
    case 'create': {
      if (client.room) return sendTo(client.ws, { t: 'error', message: 'already in a room' });
      const room = makeRoom(genCode(rooms));
      rooms.set(room.code, room);
      const name = String(m.name || client.name || 'Player').slice(0, 16);
      const p = addPlayer(room, client, name, false);
      room.creatorId = p.id;
      client.name = p.name;
      broadcastRoom(room);
      return;
    }
    case 'join': {
      if (client.room) return sendTo(client.ws, { t: 'error', message: 'already in a room' });
      const code = String(m.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return sendTo(client.ws, { t: 'error', message: 'room not found' });
      if (room.state !== 'lobby') return sendTo(client.ws, { t: 'error', message: 'match already in progress' });
      if (room.players.length >= MAX_PLAYERS) return sendTo(client.ws, { t: 'error', message: 'room is full' });
      const name = String(m.name || client.name || 'Player').slice(0, 16);
      const p = addPlayer(room, client, name, false);
      client.name = p.name;
      broadcastRoom(room);
      return;
    }
    case 'leave': {
      const room = client.room, p = client.player;
      if (!room || !p) return;
      if (room.state === 'lobby') {
        removePlayer(room, p);
        client.room = null; client.player = null;
        if (room.players.length === 0) rooms.delete(room.code);
        else broadcastRoom(room);
      } else {
        // mid-match disconnect handled by the socket close path
        sendTo(client.ws, { t: 'error', message: 'use disconnect to leave a live match' });
      }
      return;
    }
    case 'start': {
      const room = client.room, p = client.player;
      if (!room || !p) return sendTo(client.ws, { t: 'error', message: 'not in a room' });
      if (room.state !== 'lobby') return sendTo(client.ws, { t: 'error', message: 'match already started' });
      if (room.creatorId !== p.id) return sendTo(client.ws, { t: 'error', message: 'only the creator can start' });
      room.state = 'countdown';
      room.countdownT = COUNTDOWN_TIME;
      room._cdLast = -1;
      return;
    }
    case 'input': {
      const room = client.room, p = client.player;
      if (!room || !p || !p.alive) return;
      if (room.state === 'lobby' || room.state === 'countdown') {
        // allow pre-selecting a drop target before the drop
        if (m.dropX != null) p.dropX = clamp(Number(m.dropX) || 0, -290, 290);
        if (m.dropZ != null) p.dropZ = clamp(Number(m.dropZ) || 0, -290, 290);
        return;
      }
      if (room.state !== 'drop' && room.state !== 'play') return;
      const inp = sanitizeInput(m);
      inp.dropX = p.dropX; inp.dropZ = p.dropZ; // keep drop target server-side
      p.input = inp;
      if (room.state === 'drop') { // live steering during the drop too
        if (m.dropX != null) p.dropX = clamp(Number(m.dropX) || 0, -290, 290);
        if (m.dropZ != null) p.dropZ = clamp(Number(m.dropZ) || 0, -290, 290);
      }
      return;
    }
    case 'ping':
      return sendTo(client.ws, { t: 'pong', t0: m.t0 || null });
    case 'debug':
      if (process.env.DZR_DEBUG === '1') return handleDebug(client, m);
      return sendTo(client.ws, { t: 'error', message: 'debug disabled' });
    default:
      return sendTo(client.ws, { t: 'error', message: 'unknown message type' });
  }
}

function onDisconnect(client) {
  const room = client.room, p = client.player;
  client.room = null; client.player = null;
  if (!room || !p) return;
  if (room.state === 'lobby') {
    removePlayer(room, p);
    if (room.players.length === 0) rooms.delete(room.code);
    else broadcastRoom(room);
  } else if (room.state === 'countdown' || room.state === 'drop' || room.state === 'play') {
    // hand the body to the bot brain so the match stays fair
    p.isBot = true; p.disconnected = true; p.ws = null;
    p.input.firing = false;
    feed(room, `${p.name} disconnected (bot took over)`);
  }
}

// --------------------------------- main ------------------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('dropzone-royale-server ok\n');
});
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const client = { ws, id: 'c' + (++clientSeq), name: null, room: null, player: null };
  ws.on('message', (raw) => {
    try { handleMessage(client, JSON.parse(raw)); }
    catch (e) { sendTo(ws, { t: 'error', message: 'bad message' }); }
  });
  ws.on('close', () => onDisconnect(client));
  ws.on('error', () => {});
});

setInterval(() => {
  for (const room of [...rooms.values()]) {
    try { tickRoom(room); }
    catch (e) { console.error('tick error in room', room.code, e); }
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  const addr = server.address();
  console.log(`dropzone-royale-server listening on port ${addr.port} (${TICK_HZ} Hz sim)`);
});
