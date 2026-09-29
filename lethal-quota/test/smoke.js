// Headless test of the server game loop: join, buy, land, collect scrap, leave, sell, quota evaluation.
// Run with: npm test
import assert from 'node:assert/strict';
import { Room } from '../server/game.js';
import { SHIP, MOONS, SELL_DESK, DAY_END } from '../shared/config.js';
import { buildWorld, collide, findPath, inShip } from '../shared/world.js';

class FakeWs {
  constructor() { this.readyState = 1; this.inbox = []; }
  send(data) { this.inbox.push(JSON.parse(data)); }
  last(t, k) { return [...this.inbox].reverse().find((m) => m.t === t && (!k || m.k === k)); }
  all(t, k) { return this.inbox.filter((m) => m.t === t && (!k || m.k === k)); }
}

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// ---------------------------------------------------------------- world generation
test('worlds are deterministic and connected', () => {
  for (let moon = 1; moon < MOONS.length; moon++) {
    for (const seed of [1, 42, 99999]) {
      const a = buildWorld(moon, seed), b = buildWorld(moon, seed);
      assert.deepEqual([...a.interior.grid], [...b.interior.grid]);
      const I = a.interior;
      for (const v of I.vents) assert.ok(findPath(a, I.mainDoor.spawn.x, I.mainDoor.spawn.z, v.x, v.z), 'vent reachable');
      for (const s of I.scrapSpots) {
        const [i, j] = [Math.floor((s.x - I.ox) / 4), Math.floor((s.z - I.oz) / 4)];
        assert.ok(I.isFloor(i, j), 'scrap on floor');
      }
      assert.ok(I.fireDoor, 'has fire exit');
    }
  }
});

test('collision keeps players out of walls', () => {
  const w = buildWorld(2, 7);
  const p = collide(w, 'out', { x: SHIP.maxX + SHIP.wall + 0.1, z: 0 }, 0.35);
  assert.ok(p.x >= SHIP.maxX + SHIP.wall + 0.34, 'pushed out of ship wall');
  const closed = collide(w, 'out', { x: 0, z: SHIP.maxZ + 0.1 }, 0.35, true);
  assert.ok(closed.z > SHIP.maxZ + SHIP.wall || closed.z < SHIP.maxZ, 'closed door blocks');
});

// ---------------------------------------------------------------- full game loop
test('full day loop', () => {
  const room = new Room('TEST', () => {});
  clearInterval(room.interval);
  const tick = (sec) => { for (let i = 0; i < sec * 20; i++) room.tick(); };
  const wa = new FakeWs(), wb = new FakeWs();
  const a = room.addClient(wa, 'Alice');
  const b = room.addClient(wb, 'Bob');
  assert.equal(wa.inbox[0].t, 'welcome');
  assert.ok(wa.last('peerJoin'), 'alice told about bob');
  const pa = room.clients.get(a).player, pb = room.clients.get(b).player;
  const state = (p, extra = {}) => room.handle(p.id, { t: 'state', seq: p.seq, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: 0, region: p.region, ...extra });

  // rtc relay
  room.handle(b, { t: 'rtc', to: a, data: { sdp: { type: 'offer', sdp: 'x' } } });
  assert.deepEqual(wa.last('rtc'), { t: 'rtc', from: b, data: { sdp: { type: 'offer', sdp: 'x' } } });

  // terminal
  room.handle(a, { t: 'terminal', cmd: 'buy flashlight 2' });
  assert.equal(room.s.credits, 30);
  assert.equal([...room.items.values()].filter((i) => i.type === 'flashlight').length, 2);
  room.handle(a, { t: 'terminal', cmd: 'route bastion' });
  assert.equal(room.s.route, 2);
  room.handle(a, { t: 'terminal', cmd: 'route blizzard' });
  assert.match(wa.last('term').text, /Not enough credits/);

  // pull lever -> land
  pa.x = 0; pa.z = -4.5; state(pa);
  room.handle(a, { t: 'interact', what: 'lever' });
  assert.equal(room.s.phase, 'landing');
  tick(5);
  assert.equal(room.s.phase, 'landed');
  assert.equal(room.s.doorClosed, false);
  const scrap = [...room.items.values()].filter((i) => i.scrap);
  assert.ok(scrap.length >= 12, 'scrap spawned');

  // Alice walks into the facility and grabs scrap.
  const it = scrap[0];
  pa.x = it.x; pa.z = it.z; pa.region = 'in'; state(pa);
  room.handle(a, { t: 'pickup', id: it.id });
  assert.equal(it.heldBy, a);
  assert.equal(pa.inv[pa.slot], it.id);
  // back to the ship and drop it
  pa.x = 1; pa.z = 0; pa.region = 'out'; state(pa);
  room.handle(a, { t: 'drop', x: 1, z: 0.5 });
  tick(0.1);
  assert.equal(it.heldBy, null);
  assert.ok(inShip(it.x, it.z));

  // Bob stays outside the ship -> left behind when the ship leaves
  pb.x = 20; pb.z = 20; state(pb);
  room.handle(a, { t: 'interact', what: 'lever' });
  assert.equal(room.s.phase, 'leaving');
  tick(6);
  assert.equal(room.s.phase, 'orbit');
  assert.equal(room.s.daysLeft, 2);
  const report = wa.last('ev', 'dayReport');
  assert.ok(report.deaths.some((d) => d.name === 'Bob'), 'bob left behind');
  assert.equal(report.shipValue, it.value);
  assert.ok(room.items.has(it.id), 'scrap on ship kept');
  assert.equal(pb.alive, true, 'bob revived');
  assert.ok(wb.last('respawn'), 'bob respawned');
  const others = [...room.items.values()].filter((i) => i.scrap && i.id !== it.id);
  assert.equal(others.length, 0, 'scrap left on the moon is gone');

  // Two more days, then deadline forces the company route.
  for (let d = 0; d < 2; d++) {
    pa.x = 0; pa.z = -4.5; pa.seq = pa.seq; state(pa);
    pb.x = 0; pb.z = -3; state(pb);
    room.handle(a, { t: 'interact', what: 'lever' });
    tick(5);
    assert.equal(room.s.phase, 'landed');
    // Let the clock run out: autopilot leaves at midnight.
    room.s.clock = DAY_END - 0.01;
    tick(9);
    assert.equal(room.s.phase, 'orbit');
  }
  assert.equal(room.s.daysLeft, 0);
  assert.equal(room.s.route, 0);
  room.handle(a, { t: 'terminal', cmd: 'route proving' });
  assert.match(wa.last('term').text, /DEADLINE/);

  // Land at the company and sell.
  state(pa);
  room.handle(a, { t: 'interact', what: 'lever' });
  tick(5);
  assert.ok(MOONS[room.s.moon].company);
  pa.x = 0; pa.z = 1; state(pa);
  room.handle(a, { t: 'pickup', id: it.id });
  pa.x = SELL_DESK.x; pa.z = SELL_DESK.z - 1.5; state(pa);
  room.handle(a, { t: 'interact', what: 'sell' });
  assert.equal(room.s.fulfilled, it.value, 'sold at 100% on deadline day');
  assert.ok(!room.items.has(it.id));

  // Give them enough to pass, then leave -> quota evaluation.
  room.s.fulfilled = room.s.quota + 50;
  pa.x = 0; pa.z = -2; state(pa);
  pb.x = 0; pb.z = -3; state(pb);
  const oldQuota = room.s.quota;
  room.handle(a, { t: 'interact', what: 'lever' });
  tick(6);
  const r2 = wa.last('ev', 'dayReport');
  assert.ok(r2.evaluation?.met, 'quota met');
  assert.ok(room.s.quota > oldQuota);
  assert.equal(room.s.daysLeft, 3);
  assert.equal(room.s.fulfilled, 0);

  // Fail the next quota: fired and reset.
  room.s.daysLeft = 0; room.s.route = 0;
  room.handle(a, { t: 'interact', what: 'lever' });
  tick(5);
  room.handle(a, { t: 'interact', what: 'lever' });
  tick(6);
  assert.ok(wa.last('ev', 'dayReport').evaluation?.fired, 'fired');
  assert.equal(room.s.quota, 130);
  room.removeClient(a);
  room.removeClient(b);
});

test('monsters hunt and kill players', () => {
  const room = new Room('MONS', () => {});
  clearInterval(room.interval);
  const tick = (sec) => { for (let i = 0; i < sec * 20; i++) room.tick(); };
  const ws = new FakeWs();
  const id = room.addClient(ws, 'Victim');
  const p = room.clients.get(id).player;
  room.handle(id, { t: 'interact', what: 'lever' });
  tick(5);
  room.monsters.clear();
  const I = room.world.interior;
  // Springhead: player looks away, it closes in.
  const spawn = I.mainDoor.spawn;
  p.x = spawn.x; p.z = spawn.z; p.region = 'in';
  p.yaw = 0; // facing -z (the wall behind the entrance), room is behind the player
  const start = I.cellCenter(Math.floor(I.W / 2), 2);
  const sh = room.spawnMonster('springhead', start.x, start.z, 'in');
  const d0 = Math.hypot(sh.x - p.x, sh.z - p.z);
  tick(0.3);
  assert.equal(sh.state, 'move');
  assert.ok(Math.hypot(sh.x - p.x, sh.z - p.z) < d0, 'springhead approaches');
  // Now look at it: it freezes.
  p.yaw = Math.atan2(-(sh.x - p.x), -(sh.z - p.z));
  tick(0.2);
  assert.equal(sh.state, 'frozen');
  const frozenAt = { x: sh.x, z: sh.z };
  tick(1);
  assert.deepEqual({ x: sh.x, z: sh.z }, frozenAt);
  // Look away: dead.
  p.yaw += Math.PI;
  tick(3);
  assert.equal(p.alive, false, 'killed');
  assert.ok(ws.last('ev', 'die'));
  // Everyone dead -> ship leaves automatically.
  assert.equal(room.s.phase, 'leaving');
  tick(9);
  assert.equal(room.s.phase, 'orbit');
  assert.ok(ws.last('ev', 'dayReport').allDead);
  room.removeClient(id);
});

test('blind dogs hear voices', () => {
  const room = new Room('DOGS', () => {});
  clearInterval(room.interval);
  const tick = (sec) => { for (let i = 0; i < sec * 20; i++) room.tick(); };
  const ws = new FakeWs();
  const id = room.addClient(ws, 'Talker');
  const p = room.clients.get(id).player;
  room.handle(id, { t: 'interact', what: 'lever' });
  tick(5);
  room.monsters.clear();
  p.x = 30; p.z = -30; p.region = 'out';
  const dog = room.spawnMonster('dog', 45, -30, 'out');
  room.handle(id, { t: 'state', seq: p.seq, x: p.x, y: 0, z: p.z, yaw: 0, pitch: 0, region: 'out', noise: 0 });
  tick(1);
  assert.equal(dog.state, 'wander', 'silent player not heard');
  room.handle(id, { t: 'state', seq: p.seq, x: p.x, y: 0, z: p.z, yaw: 0, pitch: 0, region: 'out', noise: 0.8 });
  tick(0.1);
  assert.notEqual(dog.state, 'wander', 'talking player heard');
  room.removeClient(id);
});

console.log(`\n${passed} tests passed`);
