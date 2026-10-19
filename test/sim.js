'use strict';
/* Dropzone Royale server simulation test.
 * Spins up the real server on an ephemeral port, drives 3 simulated clients
 * through a full match (lobby -> countdown -> drop -> play -> combat ->
 * airdrop -> elimination -> win), asserting protocol behavior at each step.
 * Exits 0 on success, 1 on any failure.
 *
 * Uses the DZR_DEBUG=1 test hook (debug kill/hurt/airdrop) only for the
 * elimination phase and for de-risking the aimed-kill assertion; all game
 * rules exercised are the production ones.
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const DIR = path.join(__dirname, '..');
let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.error('  FAIL:', msg); throw new Error(msg); }
  console.log('  ok:', msg);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class T {
  constructor(name) { this.name = name; this.inbox = []; this.snapCount = 0; }
  async connect(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((res, rej) => {
      this.ws.once('open', res); this.ws.once('error', rej);
      setTimeout(() => rej(new Error('connect timeout')), 5000);
    });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      this.inbox.push(m);
      if (m.t === 'snap') this.snapCount++;
    });
    this.send({ t: 'hello', name: this.name });
    const w = await this.wait(m => m.t === 'welcome', 5000, 'welcome');
    ok(w.tickHz === 20, `welcome tickHz=20 (got ${w.tickHz})`);
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async wait(pred, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (let i = 0; i < this.inbox.length; i++) {
        if (pred(this.inbox[i])) return this.inbox.splice(i, 1)[0];
      }
      await sleep(25);
    }
    throw new Error('timeout waiting for ' + (label || 'message'));
  }
  lastSnap() {
    for (let i = this.inbox.length - 1; i >= 0; i--)
      if (this.inbox[i].t === 'snap') return this.inbox[i];
    return null;
  }
  events() { // all events seen so far (from snaps)
    const evs = [];
    for (const m of this.inbox) if (m.t === 'snap' && m.ev) evs.push(...m.ev);
    return evs;
  }
  clear() { this.inbox.length = 0; }
  close() { try { this.ws.close(); } catch (e) {} }
}

function playerByName(snap, name) { return snap.pl.find(p => p.n === name); }

async function main() {
  console.log('== starting server on ephemeral port ==');
  const srv = spawn('node', ['server.js'], {
    cwd: DIR, env: { ...process.env, PORT: '0', DZR_DEBUG: '1' },
  });
  let srvOut = '';
  const port = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start')), 10000);
    srv.stdout.on('data', (d) => {
      srvOut += d;
      const m = srvOut.match(/listening on port (\d+)/);
      if (m) { clearTimeout(to); res(parseInt(m[1], 10)); }
    });
    srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
    srv.on('exit', (c) => rej(new Error('server exited ' + c)));
  });
  console.log('  ok: server listening on port', port);
  const killSrv = () => { try { srv.kill(); } catch (e) {} };

  try {
    // ---- lobby ----
    console.log('== lobby ==');
    const A = new T('A'), B = new T('B'), C = new T('C');
    await A.connect(port); await B.connect(port); await C.connect(port);
    A.send({ t: 'create' });
    const roomMsg = await A.wait(m => m.t === 'room', 5000, 'room msg');
    const code = roomMsg.code;
    ok(/^[A-Z]{4}$/.test(code), `4-letter room code (${code})`);
    ok(roomMsg.players.length === 1 && roomMsg.players[0].creator, 'creator listed in lobby');
    B.send({ t: 'join', code }); C.send({ t: 'join', code: code.toLowerCase() });
    await B.wait(m => m.t === 'room' && m.players.length === 3, 5000, 'join broadcast');
    console.log('  ok: 3 clients in lobby');

    // bad-code join rejected
    const X = new T('X');
    await X.connect(port);
    X.send({ t: 'join', code: 'ZZZZ' });
    const errBad = await X.wait(m => m.t === 'error', 5000, 'bad code error');
    ok(/not found/i.test(errBad.message), `bad code rejected ("${errBad.message}")`);
    X.close();

    // drop targets: corner of the island, A and B 5 m apart
    A.send({ t: 'input', dropX: 282, dropZ: 282 });
    B.send({ t: 'input', dropX: 287, dropZ: 282 });
    C.send({ t: 'input', dropX: 282, dropZ: 287 });

    // ---- countdown -> drop ----
    console.log('== countdown & drop ==');
    A.send({ t: 'start' });
    const cd = await A.wait(m => m.t === 'countdown', 8000, 'countdown');
    ok(cd.secs <= 5 && cd.secs >= 1, `countdown ticking (secs=${cd.secs})`);
    await A.wait(m => m.t === 'dropStart', 10000, 'dropStart');
    const loot = await A.wait(m => m.t === 'lootState', 5000, 'lootState');
    ok(loot.items.length >= 150, `lootState with ${loot.items.length} items`);
    const snap0 = await A.wait(m => m.t === 'snap', 5000, 'first snap');
    ok(snap0.pl.length === 12, `12 combatants (3 humans + 9 bots), got ${snap0.pl.length}`);
    ok(snap0.pl.filter(p => p.bot === 1).length === 9, 'bots filled to MIN_COMBATANTS=12');
    ok(snap0.vh.length === 4, '4 buggies spawned');
    ok(snap0.zone && snap0.zone.r === 450 && snap0.zone.ph === 1, 'zone initialized (r=450, phase 1)');

    // join during drop must be rejected
    const D = new T('D');
    await D.connect(port);
    D.send({ t: 'join', code });
    const errProg = await D.wait(m => m.t === 'error', 5000, 'in-progress error');
    ok(/progress/i.test(errProg.message), `in-progress join rejected ("${errProg.message}")`);
    D.close();

    // ---- play begins ----
    console.log('== play phase ==');
    await A.wait(m => m.t === 'playStart', 30000, 'playStart');
    // wait until our three clients have landed (y == 0)
    let landed = null;
    for (let i = 0; i < 200; i++) {
      const s = A.lastSnap();
      if (s && ['A', 'B', 'C'].every(n => { const p = playerByName(s, n); return p && p.y === 0 && p.al === 1; })) { landed = s; break; }
      await sleep(100);
    }
    ok(!!landed, 'A, B, C landed (y=0, alive)');
    const pa = playerByName(landed, 'A'), pb = playerByName(landed, 'B');
    ok(Math.abs(pa.x - 282) < 3 && Math.abs(pb.x - 287) < 3, 'drop targets honored');

    // ---- movement ----
    console.log('== movement ==');
    const x0 = pa.x, z0 = pa.z;
    A.send({ t: 'input', f: 1, yaw: Math.PI }); // walk -z, away from C
    await sleep(1000);
    A.send({ t: 'input', f: 0, yaw: Math.PI });
    const sMove = A.lastSnap();
    const pa2 = playerByName(sMove, 'A');
    const moved = Math.hypot(pa2.x - x0, pa2.z - z0);
    ok(moved > 2 && moved < 10, `A moved ${moved.toFixed(1)} m in 1 s on foot`);

    // ---- snapshot rate sanity (while match is live) ----
    console.log('== snapshot rate ==');
    A.snapCount = 0; await sleep(2000);
    ok(A.snapCount >= 30 && A.snapCount <= 55, `${A.snapCount} snaps in 2 s (~20 Hz)`);

    // de-risk: eliminate bots near the duel so the aimed kill is deterministic
    const sPre = A.lastSnap();
    const near = sPre.pl.filter(p => p.bot === 1 && p.al === 1 &&
      Math.hypot(p.x - 282, p.z - 282) < 150).map(p => p.n);
    for (const n of near) { A.send({ t: 'debug', cmd: 'kill', target: n }); await sleep(30); }
    if (near.length) console.log(`  (removed ${near.length} bots near the duel via debug)`);

    // ---- aimed kill: A shoots B with the starting pistol ----
    console.log('== combat: A fires at B until B dies ==');
    let sNow = A.lastSnap();
    let a = playerByName(sNow, 'A'), b = playerByName(sNow, 'B');
    ok(Math.hypot(a.x - b.x, a.z - b.z) < 60, 'B inside pistol range');
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    A.send({ t: 'input', yaw, pitch: 0, firing: true });
    let deathEv = null, feedText = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 40000 && !deathEv) {
      await sleep(200);
      for (const e of A.events()) {
        if (e.t === 'death' && e.victim === 'B') deathEv = e;
        if (e.t === 'feed' && /killed B/.test(e.text)) feedText = e.text;
      }
    }
    A.send({ t: 'input', firing: false });
    ok(!!deathEv, 'death event for B received');
    ok(deathEv.killer === 'A', `killer is A (got ${deathEv.killer})`);
    ok(deathEv.weapon === 'Pistol', `weapon is Pistol (got ${deathEv.weapon})`);
    ok(feedText === 'A killed B [Pistol]', `kill feed text ("${feedText}")`);
    const sAfter = A.lastSnap();
    ok(playerByName(sAfter, 'A').k === 1, 'A has 1 kill');

    // ---- airdrop (via debug trigger; rules are production) ----
    console.log('== airdrop ==');
    A.send({ t: 'debug', cmd: 'airdrop' });
    await A.wait(m => m.t === 'debugOk', 5000, 'debugOk');
    let adIn = null, adLand = null, sniperLoot = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 15000 && !adLand) {
      await sleep(200);
      for (const e of A.events()) {
        if (e.t === 'airdrop' && e.mode === 'incoming') adIn = e;
        if (e.t === 'airdrop' && e.mode === 'landed') adLand = e;
        if (e.t === 'lootSpawn' && e.items.some(i => i.w === 'sniper')) sniperLoot = e;
      }
    }
    ok(!!adIn && typeof adIn.x === 'number', 'airdrop incoming event with coordinates');
    ok(!!adLand, 'airdrop landed event');
    ok(!!sniperLoot, 'airdrop spawned sniper loot');
    const sAd = A.lastSnap();
    ok(sAd.ad && sAd.ad.m === 'landed', 'snap carries airdrop state');

    // ---- elimination: everyone but A dies -> A wins ----
    console.log('== elimination & win ==');
    const sEl = A.lastSnap();
    const aId = playerByName(sEl, 'A').i;
    const victims = sEl.pl.filter(p => p.al === 1 && p.i !== aId).map(p => p.n);
    ok(victims.length >= 2, `${victims.length} other combatants to eliminate`);
    for (const n of victims) { A.send({ t: 'debug', cmd: 'kill', target: n }); await sleep(25); }
    const end = await A.wait(m => m.t === 'matchEnd', 10000, 'matchEnd');
    ok(end.winner && end.winner.name === 'A', `winner is A (got ${end.winner && end.winner.name})`);
    ok(end.reason === 'last-standing', `reason last-standing (got ${end.reason})`);
    const places = end.placements.map(p => p.place).sort((x, y) => x - y);
    const expect = Array.from({ length: end.placements.length }, (_, i) => i + 1);
    ok(JSON.stringify(places) === JSON.stringify(expect),
      `placements are 1..${end.placements.length} permutation`);
    ok(end.placements.find(p => p.name === 'A').place === 1, 'A placed 1st');
    for (const n of ['A', 'B', 'C']) ok(end.placements.some(p => p.name === n), `${n} in placements`);
    const botsPlaced = end.placements.filter(p => p.bot).length;
    ok(botsPlaced === 9, `${botsPlaced} bots in placements`);

    A.close(); B.close(); C.close();
    console.log('\nALL CHECKS PASSED');
  } catch (e) {
    console.error('\nTEST FAILED:', e.message);
    killSrv();
    process.exit(1);
  }
  killSrv();
  await sleep(300);
  process.exit(failures ? 1 : 0);
}

main();
