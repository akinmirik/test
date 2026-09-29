// Authoritative game room: ship/day/quota loop, items, monsters and relay of voice signalling.

import {
  TICK_RATE, MAX_HP, INVENTORY_SLOTS, DAY_START, DAY_END, SECONDS_PER_GAME_MINUTE,
  START_CREDITS, START_QUOTA, DAYS_PER_QUOTA, MOONS, STORE, SCRAP, MONSTER_TYPES, SHIP, SELL_DESK, SELL_RATE,
  MAX_PLAYERS, formatClock,
} from '../shared/config.js';
import {
  buildWorld, collide, lineOfSight, findPath, randomFloorPoint, inShip, mulberry32, randInt, randRange,
} from '../shared/world.js';

const DT = 1 / TICK_RATE;
const PLAYER_COLORS = [0xff7a1a, 0x3aa0ff, 0x5bd15b, 0xe8d43a, 0xd65bd6, 0x44e0d0, 0xff4a4a, 0xffffff];

const round = (v, n = 100) => Math.round(v * n) / n;
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const lerpYaw = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export class Room {
  constructor(code, onEmpty) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.clients = new Map(); // id -> { ws, player }
    this.nextPlayerId = 1;
    this.nextItemId = 1;
    this.nextMonsterId = 1;
    this.rng = mulberry32((Date.now() ^ (Math.random() * 1e9)) >>> 0);
    this.dirtyItems = new Set();
    this.removedItems = [];
    this.pending = []; // delayed actions [{at, fn}]
    this.time = 0;
    this.resetGame();
    this.interval = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  // ------------------------------------------------------------------ lifecycle
  resetGame() {
    this.s = {
      credits: START_CREDITS, quota: START_QUOTA, fulfilled: 0, daysLeft: DAYS_PER_QUOTA,
      quotaNum: 1, day: 1, route: 1, phase: 'orbit', clock: DAY_START, doorClosed: true,
      seed: 1, moon: 1, landed: false, phaseTimer: 0,
    };
    this.items = new Map();
    this.monsters = new Map();
    this.world = buildWorld(this.s.moon, this.s.seed, false);
    this.powerUsed = 0;
    this.dogsSpawned = 0;
    this.lastHour = Math.floor(DAY_START / 60);
    this.dayStats = { deaths: [] };
  }

  get players() {
    return [...this.clients.values()].map((c) => c.player);
  }

  publicState() {
    const s = this.s;
    return {
      credits: s.credits, quota: s.quota, fulfilled: s.fulfilled, daysLeft: s.daysLeft, quotaNum: s.quotaNum,
      day: s.day, route: s.route, phase: s.phase, clock: s.clock, doorClosed: s.doorClosed,
      moon: s.moon, seed: s.seed, landed: s.landed,
    };
  }

  addClient(ws, name) {
    if (this.clients.size >= MAX_PLAYERS) return null;
    const id = this.nextPlayerId++;
    const used = new Set(this.players.map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
    const player = {
      id, name, color, x: 0, y: SHIP.floorY, z: 0, yaw: 0, pitch: 0, region: 'out',
      alive: true, hp: MAX_HP, inv: new Array(INVENTORY_SLOTS).fill(null), slot: 0,
      crouch: false, sprint: false, moving: false, noise: 0, walkieTx: false, seq: 0,
    };
    this.placeAtSpawn(player, this.clients.size);
    this.clients.set(id, { ws, player });

    this.send(id, {
      t: 'welcome', id, room: this.code, state: this.publicState(),
      roster: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
      items: [...this.items.values()],
      spawn: { x: player.x, z: player.z, yaw: player.yaw, seq: player.seq },
    });
    this.broadcast({ t: 'peerJoin', id, name, color }, id);
    this.sysChat(`${name} joined the crew.`);
    return id;
  }

  removeClient(id) {
    const c = this.clients.get(id);
    if (!c) return;
    const p = c.player;
    for (let i = 0; i < INVENTORY_SLOTS; i++) if (p.inv[i] != null) this.dropItem(p, i, p.x, p.z, true);
    this.clients.delete(id);
    this.broadcast({ t: 'peerLeave', id });
    this.sysChat(`${p.name} left.`);
    if (this.clients.size === 0) {
      clearInterval(this.interval);
      this.onEmpty(this.code);
    } else {
      this.checkAllDead();
    }
  }

  placeAtSpawn(p, index = 0) {
    const off = [[0, 0], [-1.2, 0], [1.2, 0], [0, 1.2], [-1.2, 1.2], [1.2, 1.2], [0, -1.2], [-1.2, 2.4]][index % 8];
    p.x = SHIP.spawn.x + off[0];
    p.z = SHIP.spawn.z + off[1];
    p.y = SHIP.floorY;
    p.yaw = Math.PI; // face the door
    p.region = 'out';
    p.seq++;
  }

  // ------------------------------------------------------------------ messaging
  send(id, msg) {
    const c = this.clients.get(id);
    if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  broadcast(msg, exceptId = null, filter = null) {
    const data = JSON.stringify(msg);
    for (const [id, c] of this.clients) {
      if (id === exceptId || c.ws.readyState !== 1) continue;
      if (filter && !filter(c.player)) continue;
      c.ws.send(data);
    }
  }

  event(kind, data = {}) {
    this.broadcast({ t: 'ev', k: kind, ...data });
  }

  sysChat(text) {
    this.broadcast({ t: 'chat', from: null, text });
  }

  broadcastState() {
    this.broadcast({ t: 'state', state: this.publicState() });
  }

  handle(id, msg) {
    const c = this.clients.get(id);
    if (!c) return;
    const p = c.player;
    switch (msg.t) {
      case 'state': return this.onPlayerState(p, msg);
      case 'slot':
        if (Number.isInteger(msg.i) && msg.i >= 0 && msg.i < INVENTORY_SLOTS) p.slot = msg.i;
        return;
      case 'pickup': return this.onPickup(p, msg.id);
      case 'drop':
        if (p.inv[p.slot] != null && Number.isFinite(msg.x) && Number.isFinite(msg.z) && Math.hypot(msg.x - p.x, msg.z - p.z) < 4) {
          this.dropItem(p, p.slot, msg.x, msg.z);
        }
        return;
      case 'use': return this.onUse(p, msg);
      case 'swing': return this.onSwing(p);
      case 'throw': return this.onThrow(p, msg);
      case 'interact': return this.onInteract(p, msg.what);
      case 'terminal': return this.onTerminal(p, String(msg.cmd || '').slice(0, 80));
      case 'chat': {
        const text = String(msg.text || '').slice(0, 200).trim();
        if (!text) return;
        const out = { t: 'chat', from: p.name, color: p.color, text, dead: !p.alive };
        // The dead can only talk amongst themselves.
        if (p.alive) this.broadcast(out); else this.broadcast(out, null, (q) => !q.alive);
        return;
      }
      case 'rtc':
        if (this.clients.has(msg.to)) this.send(msg.to, { t: 'rtc', from: id, data: msg.data });
        return;
      case 'ping':
        return this.send(id, { t: 'pong', ts: msg.ts });
    }
  }

  // ------------------------------------------------------------------ player actions
  onPlayerState(p, m) {
    if (m.seq !== p.seq) return; // stale packet from before a teleport/respawn
    if (!p.alive) return;
    if ([m.x, m.y, m.z, m.yaw, m.pitch].some((v) => !Number.isFinite(v))) return;
    p.x = m.x; p.y = m.y; p.z = m.z; p.yaw = m.yaw; p.pitch = m.pitch;
    p.region = m.region === 'in' && this.world.interior ? 'in' : 'out';
    p.crouch = !!m.crouch; p.sprint = !!m.sprint; p.moving = !!m.moving;
    p.noise = Math.max(0, Math.min(1, Number(m.noise) || 0));
    const held = this.items.get(p.inv[p.slot]);
    p.walkieTx = !!m.walkieTx && held?.type === 'walkie' && held.on;
  }

  freeSlot(p) {
    if (p.inv[p.slot] == null) return p.slot;
    return p.inv.findIndex((v) => v == null);
  }

  onPickup(p, itemId) {
    if (!p.alive) return;
    const it = this.items.get(itemId);
    if (!it || it.heldBy != null || it.region !== p.region) return;
    if (Math.hypot(it.x - p.x, it.z - p.z) > 3.5) return;
    const holdingTwoHanded = p.inv.some((iid) => this.items.get(iid)?.twoHanded);
    if (holdingTwoHanded) return this.send(p.id, { t: 'toast', text: 'Hands full' });
    const slot = this.freeSlot(p);
    if (slot < 0) return this.send(p.id, { t: 'toast', text: 'Inventory full' });
    p.inv[slot] = it.id;
    p.slot = slot;
    it.heldBy = p.id;
    if (it.nest) {
      const bug = this.monsters.get(it.nest);
      if (bug && dist2d(bug, p) < 14) this.angerMonster(bug, p, 12);
      it.nest = null;
    }
    this.dirtyItems.add(it.id);
    this.send(p.id, { t: 'slot', i: slot });
    this.event('pickup', { id: p.id, item: it.id });
  }

  dropItem(p, slot, x, z, silent = false) {
    const it = this.items.get(p.inv[slot]);
    p.inv[slot] = null;
    if (!it) return;
    it.heldBy = null;
    it.x = x; it.z = z; it.region = p.region;
    if (it.type === 'walkie' || it.type === 'flashlight' || it.type === 'proflashlight') {
      // keep power state; lights keep shining on the floor
    }
    this.dirtyItems.add(it.id);
    if (!silent) this.event('drop', { id: p.id, item: it.id });
  }

  onUse(p, msg) {
    if (!p.alive) return;
    const it = this.items.get(p.inv[p.slot]);
    if (!it || !['flashlight', 'proflashlight', 'walkie'].includes(it.type)) return;
    it.on = !!msg.on && it.charge > 0;
    this.dirtyItems.add(it.id);
  }

  onSwing(p) {
    if (!p.alive) return;
    const it = this.items.get(p.inv[p.slot]);
    if (!it || it.type !== 'shovel') return;
    if (this.time - (p.lastSwing || 0) < 0.7) return;
    p.lastSwing = this.time;
    this.event('swing', { id: p.id });
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const inCone = (t, range) => {
      const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz);
      return d < range && (d < 0.4 || (dx * fx + dz * fz) / d > 0.55);
    };
    // Delay the hit slightly to match the swing animation.
    this.later(0.35, () => {
      if (!p.alive) return;
      for (const m of this.monsters.values()) {
        if (m.region !== p.region || !inCone(m, 2.6)) continue;
        this.damageMonster(m, STORE.shovel.damage, p);
        return;
      }
      for (const q of this.players) {
        if (q === p || !q.alive || q.region !== p.region || !inCone(q, 2.2)) continue;
        this.hurtPlayer(q, 20, `was bonked by ${p.name}`);
        return;
      }
    });
  }

  onThrow(p, msg) {
    if (!p.alive) return;
    const it = this.items.get(p.inv[p.slot]);
    if (!it || it.type !== 'stungrenade') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.z)) return;
    p.inv[p.slot] = null;
    this.items.delete(it.id);
    this.removedItems.push(it.id);
    const region = p.region, x = msg.x, z = msg.z;
    this.event('grenade', { x, z, region, from: p.id });
    this.later(1.3, () => {
      this.event('flash', { x, z, region });
      for (const m of this.monsters.values()) {
        if (m.region === region && Math.hypot(m.x - x, m.z - z) < 8) m.stunUntil = this.time + 5;
      }
    });
  }

  onInteract(p, what) {
    if (!p.alive) return;
    const s = this.s;
    if (what === 'lever') {
      if (!inShip(p.x, p.z)) return;
      if (s.phase === 'orbit') this.land();
      else if (s.phase === 'landed') this.startLeaving('lever');
    } else if (what === 'shipdoor') {
      if (s.phase !== 'landed') return;
      if (Math.hypot(p.x, p.z - SHIP.maxZ) > 5) return;
      s.doorClosed = !s.doorClosed;
      this.event('shipdoor', { closed: s.doorClosed });
      this.broadcastState();
    } else if (what === 'sell') {
      if (s.phase !== 'landed' || !MOONS[s.moon].company) return;
      if (Math.hypot(p.x - SELL_DESK.x, p.z - SELL_DESK.z) > 5) return;
      const it = this.items.get(p.inv[p.slot]);
      if (!it) return;
      if (!it.scrap) return this.send(p.id, { t: 'toast', text: 'The Company only buys scrap.' });
      const amount = Math.floor(it.value * SELL_RATE[Math.min(s.daysLeft, SELL_RATE.length - 1)]);
      p.inv[p.slot] = null;
      this.items.delete(it.id);
      this.removedItems.push(it.id);
      s.credits += amount;
      s.fulfilled += amount;
      this.event('sell', { id: p.id, name: it.name, amount });
      this.broadcastState();
    }
  }

  // ------------------------------------------------------------------ terminal
  onTerminal(p, raw) {
    const reply = (text) => this.send(p.id, { t: 'term', text });
    const s = this.s;
    const [cmd, ...args] = raw.trim().toLowerCase().split(/\s+/);
    const arg = args.join(' ');
    const moonMatch = (q) => MOONS.findIndex((m) => m.id.startsWith(q) || m.name.toLowerCase().includes(q));
    switch (cmd) {
      case '':
        return reply('');
      case 'help':
        return reply([
          '>MOONS      List moons the autopilot can route to.',
          '>ROUTE [moon]   Set course. Ship must be in orbit.',
          '>STORE      See the Company store.',
          '>BUY [item] [amount]',
          '>SCAN       Count scrap left on the current moon.',
          '>QUOTA      Profit quota status.',
          '>TRANSMIT [msg]  Broadcast a short signal to the crew.',
          '>CREW       List crew members and vitals.',
        ].join('\n'));
      case 'moons':
        return reply(['MOON CATALOGUE', '', ...MOONS.map((m, i) =>
          `${i === s.route ? '* ' : '  '}${m.name.padEnd(14)}${m.company ? ' (sell scrap)' : ` [risk ${m.risk}]`}${m.cost ? `  $${m.cost}` : ''}\n    ${m.desc}`),
        '', 'Use ROUTE [moon].'].join('\n'));
      case 'route': {
        if (s.phase !== 'orbit') return reply('The ship must be in orbit to change course.');
        const i = moonMatch(arg);
        if (!arg || i < 0) return reply('Unknown moon. Type MOONS for a list.');
        if (s.daysLeft === 0 && !MOONS[i].company) return reply('DEADLINE REACHED.\nThe autopilot is locked to the Company building. Sell your scrap!');
        if (i === s.route) return reply(`Already routed to ${MOONS[i].name}.`);
        if (s.credits < MOONS[i].cost) return reply(`Not enough credits. Route costs $${MOONS[i].cost}.`);
        s.credits -= MOONS[i].cost;
        s.route = i;
        this.broadcastState();
        this.event('route', { moon: i, by: p.name });
        return reply(`Routing autopilot to ${MOONS[i].name}.\nYour new balance is $${s.credits}.\nPull the lever to land.`);
      }
      case 'store':
        return reply(['COMPANY STORE', '', ...Object.entries(STORE).map(([k, v]) => `  ${v.name.padEnd(16)} $${v.price}`),
          '', `Balance: $${s.credits}`, 'Use BUY [item] [amount]. Items are delivered to the ship.'].join('\n'));
      case 'buy': {
        const parts = arg.split(' ');
        let qty = parseInt(parts[parts.length - 1], 10);
        if (Number.isFinite(qty)) parts.pop(); else qty = 1;
        qty = Math.max(1, Math.min(10, qty));
        const q = parts.join(' ').replace(/[\s-]/g, '');
        const entry = Object.entries(STORE).find(([k, v]) => k.startsWith(q) || v.name.toLowerCase().replace(/[\s-]/g, '').startsWith(q));
        if (!q || !entry) return reply('Unknown item. Type STORE for a list.');
        const [type, def] = entry;
        const cost = def.price * qty;
        if (s.credits < cost) return reply(`You cannot afford that. ($${cost}, balance $${s.credits})`);
        s.credits -= cost;
        for (let k = 0; k < qty; k++) {
          this.spawnItem(type, SHIP.delivery.x + randRange(this.rng, -0.6, 0.6), SHIP.delivery.z + randRange(this.rng, -0.6, 0.9), 'out');
        }
        this.broadcastState();
        this.event('buy', { by: p.name, name: def.name, qty });
        return reply(`Ordered ${qty} ${def.name}${qty > 1 ? 's' : ''}. Your new balance is $${s.credits}.\nDelivered to the ship cupboard.`);
      }
      case 'scan': {
        if (!s.landed) return reply('No moon to scan. Land first.');
        let n = 0, v = 0;
        for (const it of this.items.values()) {
          if (!it.scrap || it.heldBy != null) continue;
          if (it.region === 'out' && inShip(it.x, it.z)) continue;
          n++; v += it.value;
        }
        return reply(`There are ${n} objects outside the ship, totalling an approximate value of $${Math.round(v / 10) * 10}.`);
      }
      case 'quota':
        return reply(`PROFIT QUOTA: $${s.fulfilled} / $${s.quota}\nDeadline in ${s.daysLeft} day(s).\nCompany buying rate: ${Math.round(SELL_RATE[Math.min(s.daysLeft, 3)] * 100)}%`);
      case 'transmit': {
        const text = raw.trim().slice(8).trim().slice(0, 24).toUpperCase();
        if (!text) return reply('Usage: TRANSMIT [message]');
        this.event('signal', { text });
        return reply('Transmitting...');
      }
      case 'crew':
        return reply(this.players.map((q) => `${q.name.padEnd(16)} ${q.alive ? `HP ${q.hp}` : 'DECEASED'}`).join('\n'));
      case 'spawn': // debug only: LQ_DEBUG=1
        if (process.env.LQ_DEBUG !== '1' || !MONSTER_TYPES[args[0]] || !s.landed) break;
        this.spawnMonster(args[0], p.x - Math.sin(p.yaw) * 5, p.z - Math.cos(p.yaw) * 5, p.region);
        return reply(`Spawned ${args[0]}.`);
      case 'time':
        if (process.env.LQ_DEBUG !== '1') break;
        s.clock = Number(args[0]) * 60 || s.clock;
        return reply(`Clock set to ${formatClock(s.clock)}.`);
    }
    switch (cmd) {
      default:
        return reply('[There was no action supplied with the word.]\nType HELP for a list of commands.');
    }
  }

  // ------------------------------------------------------------------ items
  spawnItem(type, x, z, region, extra = {}) {
    const id = this.nextItemId++;
    let it;
    if (STORE[type]) {
      const def = STORE[type];
      it = { id, type, name: def.name, value: 0, weight: def.weight, scrap: false, charge: def.battery ?? null, on: false };
    } else {
      const def = SCRAP.find((d) => d.id === type);
      const mult = MOONS[this.s.moon].scrapMult || 1;
      const value = Math.round(randInt(this.rng, def.value[0], def.value[1]) * mult);
      it = { id, type, name: def.name, value, weight: def.weight, scrap: true, twoHanded: !!def.twoHanded };
    }
    Object.assign(it, { x, z, region, heldBy: null, rot: this.rng() * Math.PI * 2 }, extra);
    this.items.set(id, it);
    this.dirtyItems.add(id);
    return it;
  }

  holderPos(it) {
    if (typeof it.heldBy === 'number') return this.clients.get(it.heldBy)?.player;
    if (typeof it.heldBy === 'string') return this.monsters.get(Number(it.heldBy.slice(1)));
    return null;
  }

  // ------------------------------------------------------------------ day cycle
  land() {
    const s = this.s;
    if (s.daysLeft === 0 && !MOONS[s.route].company) s.route = 0;
    s.moon = s.route;
    s.seed = (this.rng() * 2 ** 31) >>> 0;
    s.phase = 'landing';
    s.phaseTimer = 4;
    s.landed = true;
    s.clock = DAY_START;
    s.doorClosed = true;
    this.world = buildWorld(s.moon, s.seed, true);
    this.monsters.clear();
    this.powerUsed = 0;
    this.dogsSpawned = 0;
    this.lastHour = Math.floor(DAY_START / 60);
    this.dayStats = { deaths: [] };

    const moon = MOONS[s.moon];
    if (this.world.interior) {
      const types = SCRAP.map((d) => d.id);
      for (const spot of this.world.interior.scrapSpots) {
        this.spawnItem(types[Math.floor(this.rng() * types.length)], spot.x, spot.z, 'in');
      }
      for (let i = 0; i < moon.initialMonsters; i++) this.spawnInteriorMonster();
    }
    this.event('lever', {});
    this.event('landing', { moon: s.moon });
    this.broadcastState();
    this.sendAllItems();
  }

  startLeaving(reason) {
    const s = this.s;
    if (s.phase !== 'landed') return;
    s.phase = 'leaving';
    s.phaseTimer = reason === 'lever' ? 5 : 8;
    this.event('leaving', { reason });
    if (reason === 'lever') this.event('lever', {});
    this.broadcastState();
  }

  finishDay() {
    const s = this.s;
    const moon = MOONS[s.moon];
    // Anyone not aboard is left behind.
    for (const p of this.players) {
      if (p.alive && (p.region !== 'out' || !inShip(p.x, p.z))) this.killPlayer(p, 'was left behind', true);
    }
    const allDead = this.players.every((p) => !p.alive);
    // Items not on the ship are lost.
    for (const it of [...this.items.values()]) {
      let keep;
      if (typeof it.heldBy === 'number') keep = !!this.clients.get(it.heldBy)?.player.alive;
      else if (it.heldBy != null) keep = false;
      else keep = it.region === 'out' && inShip(it.x, it.z);
      if (allDead && it.scrap) keep = false;
      if (!keep) {
        if (typeof it.heldBy === 'number') {
          const holder = this.clients.get(it.heldBy)?.player;
          if (holder) holder.inv = holder.inv.map((v) => (v === it.id ? null : v));
        }
        this.items.delete(it.id);
      } else {
        it.on = false;
      }
    }
    this.monsters.clear();

    let shipValue = 0;
    for (const it of this.items.values()) if (it.scrap) shipValue += it.value;

    const report = {
      moon: moon.name, deaths: this.dayStats.deaths, allDead, shipValue,
      quota: s.quota, fulfilled: s.fulfilled, daysLeftBefore: s.daysLeft,
    };

    s.landed = false;
    s.phase = 'orbit';
    s.doorClosed = true;
    s.clock = DAY_START;

    if (!moon.company) {
      s.day++;
      s.daysLeft = Math.max(0, s.daysLeft - 1);
      if (s.daysLeft === 0) s.route = 0;
    }
    report.daysLeft = s.daysLeft;

    let evaluation = null;
    if (moon.company && s.daysLeft === 0) evaluation = this.evaluateQuota();
    report.evaluation = evaluation;

    this.world = buildWorld(s.moon, s.seed, false);
    // Revive everyone on the ship.
    const fired = !!evaluation?.fired;
    this.players.forEach((p, i) => {
      const wasDead = !p.alive;
      p.alive = true;
      p.hp = MAX_HP;
      if (fired) p.inv = new Array(INVENTORY_SLOTS).fill(null);
      if (wasDead || fired) {
        this.placeAtSpawn(p, i);
        this.send(p.id, { t: 'respawn', x: p.x, z: p.z, yaw: p.yaw, seq: p.seq });
      }
    });
    this.event('dayReport', report);
    this.broadcastState();
    this.sendAllItems();
  }

  evaluateQuota() {
    const s = this.s;
    if (s.fulfilled >= s.quota) {
      const overtime = Math.max(0, Math.floor((s.fulfilled - s.quota) / 5) + 15);
      s.credits += overtime;
      const prev = s.quota;
      s.quotaNum++;
      s.quota = Math.round(s.quota + 100 * (1 + (s.quotaNum * s.quotaNum) / 16) * (0.6 + this.rng() * 0.5));
      s.fulfilled = 0;
      s.daysLeft = DAYS_PER_QUOTA;
      s.route = 1;
      return { met: true, overtime, prevQuota: prev, newQuota: s.quota };
    }
    const result = { fired: true, fulfilled: s.fulfilled, quota: s.quota, quotaNum: s.quotaNum };
    this.resetGame();
    return result;
  }

  sendAllItems() {
    this.dirtyItems.clear();
    this.removedItems = [];
    this.broadcast({ t: 'itemsReset', items: [...this.items.values()] });
  }

  // ------------------------------------------------------------------ damage
  hurtPlayer(p, amount, cause) {
    if (!p.alive) return;
    p.hp = Math.max(0, p.hp - amount);
    this.event('hurt', { id: p.id, amt: amount });
    if (p.hp <= 0) this.killPlayer(p, cause);
  }

  killPlayer(p, cause, silentItems = false) {
    if (!p.alive) return;
    p.alive = false;
    p.hp = 0;
    p.walkieTx = false;
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      if (p.inv[i] != null) this.dropItem(p, i, p.x + randRange(this.rng, -0.6, 0.6), p.z + randRange(this.rng, -0.6, 0.6), true);
    }
    this.dayStats.deaths.push({ name: p.name, cause });
    this.event('die', { id: p.id, cause, x: p.x, y: p.y, z: p.z, region: p.region, yaw: p.yaw });
    if (!silentItems) this.checkAllDead();
  }

  checkAllDead() {
    if (this.s.phase === 'landed' && this.clients.size > 0 && this.players.every((p) => !p.alive)) {
      this.startLeaving('alldead');
    }
  }

  damageMonster(m, amount, attacker) {
    const def = MONSTER_TYPES[m.type];
    this.event('mhit', { id: m.id });
    if (!Number.isFinite(def.hp)) return;
    m.hp -= amount;
    if (m.hp <= 0) {
      if (m.carrying) this.monsterDrop(m);
      this.monsters.delete(m.id);
      this.event('mdie', { id: m.id, type: m.type });
      return;
    }
    this.angerMonster(m, attacker, 15);
  }

  angerMonster(m, p, seconds) {
    if (m.type === 'hoarder' || m.type === 'crawler') {
      m.state = 'angry';
      m.target = p.id;
      m.timer = seconds;
      if (m.carrying) this.monsterDrop(m);
    } else if (m.type === 'lurker') {
      m.state = 'angry';
      m.target = p.id;
      m.timer = 10;
    } else if (m.type === 'dog') {
      m.state = 'chase';
      m.heard = { x: p.x, z: p.z };
      m.timer = 6;
    }
  }

  // ------------------------------------------------------------------ monsters
  spawnInteriorMonster() {
    const moon = MOONS[this.s.moon];
    const counts = {};
    for (const m of this.monsters.values()) counts[m.type] = (counts[m.type] || 0) + 1;
    const options = [
      ['hoarder', 3, 4], ['crawler', 2, 2], ['lurker', 1.4, 1], ['springhead', 1.2, 2],
    ].filter(([t, , max]) => (counts[t] || 0) < max && this.powerUsed + MONSTER_TYPES[t].power <= moon.power);
    if (!options.length) return;
    let r = this.rng() * options.reduce((a, o) => a + o[1], 0);
    let type = options[0][0];
    for (const [t, w] of options) { if ((r -= w) <= 0) { type = t; break; } }
    const vent = this.world.interior.vents[Math.floor(this.rng() * this.world.interior.vents.length)];
    this.spawnMonster(type, vent.x, vent.z, 'in');
    this.powerUsed += MONSTER_TYPES[type].power;
  }

  spawnMonster(type, x, z, region) {
    const def = MONSTER_TYPES[type];
    const m = {
      id: this.nextMonsterId++, type, x, z, region, yaw: 0, hp: def.hp, state: 'wander',
      path: null, pathTarget: null, repath: 0, timer: 0, anger: 0, attackCd: 0, stunUntil: 0,
      target: null, carrying: null, speed: 0,
    };
    if (type === 'hoarder') m.nest = randomFloorPoint(this.world, this.rng);
    this.monsters.set(m.id, m);
    this.event('mspawn', { id: m.id, type });
    return m;
  }

  alivePlayersIn(region) {
    return this.players.filter((p) => p.alive && p.region === region);
  }

  nearestPlayer(m, maxDist = Infinity) {
    let best = null, bd = maxDist;
    for (const p of this.alivePlayersIn(m.region)) {
      const d = dist2d(p, m);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  playerSees(p, m, halfAngle, maxDist) {
    if (!p.alive || p.region !== m.region) return false;
    const dx = m.x - p.x, dz = m.z - p.z, d = Math.hypot(dx, dz);
    if (d > maxDist) return false;
    if (d < 0.05) return false;
    {
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      if ((dx * fx + dz * fz) / d < Math.cos(halfAngle)) return false;
      // Looking steeply at the floor or ceiling doesn't count unless very close.
      const elev = Math.atan2(1.2 - 1.6, d);
      if (d > 1.5 && Math.abs(p.pitch - elev) > 0.75) return false;
    }
    return lineOfSight(this.world, m.region, p.x, p.z, m.x, m.z);
  }

  moveToward(m, tx, tz, speed, stopDist = 0) {
    if (stopDist && Math.hypot(tx - m.x, tz - m.z) < stopDist) {
      m.yaw = lerpYaw(m.yaw, Math.atan2(m.x - tx, m.z - tz), 0.3);
      return true;
    }
    if (m.region === 'in') {
      m.repath -= DT;
      if (!m.path || m.repath <= 0 || !m.pathTarget || Math.hypot(m.pathTarget.x - tx, m.pathTarget.z - tz) > 1.5) {
        m.path = findPath(this.world, m.x, m.z, tx, tz);
        m.pathTarget = { x: tx, z: tz };
        m.repath = 0.6;
      }
      if (!m.path || !m.path.length) return true;
      let wp = m.path[0];
      if (Math.hypot(wp.x - m.x, wp.z - m.z) < 0.4) {
        m.path.shift();
        if (!m.path.length) return true;
        wp = m.path[0];
      }
      this.stepTo(m, wp.x, wp.z, speed);
      return false;
    }
    if (Math.hypot(tx - m.x, tz - m.z) < 0.6) return true;
    this.stepTo(m, tx, tz, speed);
    return false;
  }

  stepTo(m, tx, tz, speed) {
    const dx = tx - m.x, dz = tz - m.z, d = Math.hypot(dx, dz);
    if (d < 1e-4) return;
    const step = Math.min(d, speed * DT);
    const p = { x: m.x + (dx / d) * step, z: m.z + (dz / d) * step };
    collide(this.world, m.region, p, 0.4, m.region === 'out' && this.s.doorClosed);
    const moved = Math.hypot(p.x - m.x, p.z - m.z);
    m.stuck = moved < step * 0.2 ? (m.stuck || 0) + DT : 0;
    m.x = p.x; m.z = p.z;
    m.speed = moved / DT;
    const targetYaw = Math.atan2(-dx, -dz);
    let dy = targetYaw - m.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    m.yaw += dy * Math.min(1, DT * 10);
  }

  wander(m, speed, radius = 30) {
    if (!m.wanderTo || m.timer <= 0 || (m.stuck || 0) > 1.5) {
      if (m.region === 'in') m.wanderTo = randomFloorPoint(this.world, this.rng);
      else {
        const a = this.rng() * Math.PI * 2, d = randRange(this.rng, 8, radius);
        const lim = this.world.out.radius - 8;
        let x = m.x + Math.cos(a) * d, z = m.z + Math.sin(a) * d;
        const r = Math.hypot(x, z);
        if (r > lim) { x *= lim / r; z *= lim / r; }
        m.wanderTo = { x, z };
      }
      m.timer = randRange(this.rng, 6, 14);
      m.stuck = 0;
    }
    if (this.moveToward(m, m.wanderTo.x, m.wanderTo.z, speed)) m.timer = Math.min(m.timer, randRange(this.rng, 0.5, 2));
  }

  tryAttack(m, p, range, damage, cooldown, cause) {
    if (!p || m.attackCd > 0 || dist2d(m, p) > range || p.region !== m.region) return false;
    m.attackCd = cooldown;
    this.event('mattack', { id: m.id, target: p.id });
    this.hurtPlayer(p, damage, cause);
    return true;
  }

  monsterDrop(m) {
    const it = this.items.get(m.carrying);
    m.carrying = null;
    if (!it) return;
    it.heldBy = null;
    it.x = m.x; it.z = m.z; it.region = m.region;
    this.dirtyItems.add(it.id);
  }

  updateMonster(m) {
    const def = MONSTER_TYPES[m.type];
    m.attackCd = Math.max(0, m.attackCd - DT);
    m.timer -= DT;
    m.speed = 0;
    if (this.time < m.stunUntil) { m.stunned = true; return; }
    m.stunned = false;
    const targetP = () => this.clients.get(m.target)?.player;

    switch (m.type) {
      case 'hoarder': {
        if (m.state === 'angry') {
          const p = targetP();
          if (!p || !p.alive || p.region !== m.region || m.timer <= 0) { m.state = 'wander'; break; }
          this.moveToward(m, p.x, p.z, def.angrySpeed, 0.9);
          this.tryAttack(m, p, 1.3, def.damage, 1.0, 'was mauled by a hoarder bug');
          break;
        }
        if (m.carrying) {
          m.state = 'return';
          if (this.moveToward(m, m.nest.x, m.nest.z, def.speed)) {
            const it = this.items.get(m.carrying);
            this.monsterDrop(m);
            if (it) {
              it.x = m.nest.x + randRange(this.rng, -0.8, 0.8);
              it.z = m.nest.z + randRange(this.rng, -0.8, 0.8);
              it.nest = m.id;
            }
            m.state = 'wander';
          }
          break;
        }
        // Guard the nest: players loitering there with an item get chased.
        for (const p of this.alivePlayersIn(m.region)) {
          if (dist2d(p, m.nest) < 3 && dist2d(p, m) < 7 && p.inv.some((v) => v != null) && this.rng() < DT * 0.6) {
            this.angerMonster(m, p, 10);
            return;
          }
        }
        if (m.state !== 'fetch' || !this.items.has(m.fetchId)) {
          m.state = 'wander';
          if (this.rng() < DT * 0.5) {
            for (const it of this.items.values()) {
              if (it.heldBy == null && it.region === 'in' && it.nest !== m.id && dist2d(it, m) < 12 &&
                  lineOfSight(this.world, 'in', m.x, m.z, it.x, it.z)) { m.state = 'fetch'; m.fetchId = it.id; break; }
            }
          }
        }
        if (m.state === 'fetch') {
          const it = this.items.get(m.fetchId);
          if (it.heldBy != null) { m.state = 'wander'; break; }
          if (this.moveToward(m, it.x, it.z, def.speed) || dist2d(it, m) < 0.8) {
            it.heldBy = 'm' + m.id;
            it.nest = null;
            m.carrying = it.id;
            this.dirtyItems.add(it.id);
            this.event('mchirp', { id: m.id });
          }
        } else this.wander(m, def.speed * 0.7);
        break;
      }

      case 'lurker': {
        m.anger = Math.max(0, m.anger - DT * 0.08);
        let p = targetP();
        if (!p || !p.alive || p.region !== m.region || (m.state !== 'angry' && this.rng() < DT * 0.1)) {
          const np = this.nearestPlayer(m, 60);
          m.target = np?.id ?? null;
          p = np;
        }
        if (!p) { m.state = 'wander'; this.wander(m, def.speed); break; }
        if (m.state === 'angry') {
          this.moveToward(m, p.x, p.z, def.angrySpeed, 0.7);
          if (dist2d(p, m) < 1.1) { this.hurtPlayer(p, def.damage, 'had their neck snapped'); m.state = 'evade'; m.timer = 4; m.anger = 0; }
          if (m.timer <= 0) { m.state = 'stalk'; m.anger = 0; }
          break;
        }
        const seen = this.playerSees(p, m, 0.7, 22);
        if (m.state === 'evade') {
          if (!m.fleeTo || m.stuck > 1) {
            let best = null, bd = -1;
            for (let k = 0; k < 6; k++) {
              const pt = randomFloorPoint(this.world, this.rng);
              const d = dist2d(pt, p);
              if (d > bd) { bd = d; best = pt; }
            }
            m.fleeTo = best;
          }
          this.moveToward(m, m.fleeTo.x, m.fleeTo.z, def.angrySpeed * 0.8);
          if (m.timer <= 0) { m.state = 'stalk'; m.fleeTo = null; }
          break;
        }
        m.state = 'stalk';
        if (seen) {
          m.anger += 1;
          this.event('mspotted', { id: m.id });
          if (m.anger >= 3) { m.state = 'angry'; m.timer = 10; this.event('mroar', { id: m.id }); }
          else { m.state = 'evade'; m.timer = 3; m.fleeTo = null; }
          break;
        }
        const d = dist2d(p, m);
        this.moveToward(m, p.x, p.z, d > 10 ? def.speed * 1.6 : def.speed, 0.7);
        if (d < 1.0) { this.hurtPlayer(p, def.damage, 'had their neck snapped'); m.state = 'evade'; m.timer = 5; m.anger = 0; }
        break;
      }

      case 'springhead': {
        const watchers = this.alivePlayersIn(m.region).filter((p) => this.playerSees(p, m, 1.0, 45));
        if (watchers.length) {
          if (m.state === 'move') this.event('mboing', { id: m.id });
          m.state = 'frozen';
          break;
        }
        const p = this.nearestPlayer(m, 50);
        if (!p) { m.state = 'idle'; this.wander(m, 2); break; }
        m.state = 'move';
        this.moveToward(m, p.x, p.z, def.speed, 0.9);
        this.tryAttack(m, p, 1.2, def.damage, 0.5, 'was mauled by a springhead');
        break;
      }

      case 'crawler': {
        let p = targetP();
        if (m.state === 'chase' || m.state === 'angry') {
          if (!p || !p.alive || p.region !== m.region) { m.state = 'wander'; break; }
          const los = lineOfSight(this.world, m.region, m.x, m.z, p.x, p.z);
          if (los) m.lastSeen = this.time;
          if (this.time - (m.lastSeen || 0) > 5 && m.state === 'chase') { m.state = 'wander'; break; }
          m.charge = Math.min(1, (m.charge || 0) + DT * 0.25);
          this.moveToward(m, p.x, p.z, def.speed + (def.angrySpeed - def.speed) * m.charge, 1.0);
          if (this.tryAttack(m, p, 1.4, def.damage, 1.1, 'was chewed by a crawler')) m.charge = 0.3;
          if (m.state === 'angry' && m.timer <= 0) m.state = 'chase';
          break;
        }
        m.charge = 0;
        for (const q of this.alivePlayersIn(m.region)) {
          if (dist2d(q, m) < 18 && lineOfSight(this.world, m.region, m.x, m.z, q.x, q.z)) {
            m.state = 'chase'; m.target = q.id; m.lastSeen = this.time;
            this.event('mroar', { id: m.id });
            break;
          }
        }
        if (m.state === 'wander') this.wander(m, def.speed);
        break;
      }

      case 'dog': {
        // Blind: hunts by sound. Voice volume from the proximity chat counts!
        for (const p of this.alivePlayersIn('out')) {
          if (this.s.doorClosed && inShip(p.x, p.z)) continue;
          const d = dist2d(p, m);
          let range = 1.6;
          if (p.moving) range = p.sprint ? 18 : p.crouch ? 2.5 : 7;
          if (p.noise > 0.08) range = Math.max(range, 6 + p.noise * 34);
          if (p.walkieTx) range = Math.max(range, 12);
          if (d < range) {
            m.heard = { x: p.x, z: p.z };
            m.state = m.state === 'wander' ? 'hunt' : 'chase';
            m.timer = 6;
            if (m.state === 'chase' && this.rng() < DT) this.event('mroar', { id: m.id });
          }
          if (d < 1.4 && m.state !== 'wander') {
            this.tryAttack(m, p, 1.4, MONSTER_TYPES.dog.damage, 1, 'was eaten by a blind dog');
          }
        }
        if (m.state === 'hunt' || m.state === 'chase') {
          const arrived = this.moveToward(m, m.heard.x, m.heard.z, m.state === 'chase' ? def.angrySpeed : 5);
          if (arrived || m.timer <= 0) { m.state = 'wander'; m.wanderTo = null; }
        } else this.wander(m, def.speed, 25);
        break;
      }
    }
  }

  spawnTick() {
    const s = this.s;
    const hour = Math.floor(s.clock / 60);
    if (hour === this.lastHour) return;
    this.lastHour = hour;
    const moon = MOONS[s.moon];
    if (moon.company) return;
    if (hour === 22) this.event('warnLate', {});
    if (this.world.interior && this.rng() < 0.55) this.spawnInteriorMonster();
    if (hour >= moon.dogHour && this.dogsSpawned < moon.dogs && this.rng() < 0.7) {
      const a = this.rng() * Math.PI * 2, r = this.world.out.radius - 15;
      this.spawnMonster('dog', Math.cos(a) * r, Math.sin(a) * r, 'out');
      this.dogsSpawned++;
    }
  }

  // ------------------------------------------------------------------ main loop
  later(delay, fn) {
    this.pending.push({ at: this.time + delay, fn });
  }

  tick() {
    this.time += DT;
    const s = this.s;
    if (this.pending.length) {
      const due = this.pending.filter((p) => p.at <= this.time);
      this.pending = this.pending.filter((p) => p.at > this.time);
      for (const d of due) d.fn();
    }

    if (s.phase === 'landing') {
      s.phaseTimer -= DT;
      if (s.phaseTimer <= 0) {
        s.phase = 'landed';
        s.doorClosed = false;
        this.event('landed', {});
        this.event('shipdoor', { closed: false });
        this.broadcastState();
      }
    } else if (s.phase === 'leaving') {
      s.phaseTimer -= DT;
      if (s.phaseTimer <= 3 && !s.doorClosed) {
        s.doorClosed = true;
        this.event('shipdoor', { closed: true });
        this.broadcastState();
      }
      if (s.phaseTimer <= 0) this.finishDay();
    }

    if (s.phase === 'landed' || s.phase === 'leaving') {
      if (!MOONS[s.moon].company) s.clock = Math.min(DAY_END, s.clock + DT / SECONDS_PER_GAME_MINUTE);
      if (s.phase === 'landed') {
        this.spawnTick();
        if (s.clock >= DAY_END) this.startLeaving('midnight');
      }
      for (const m of [...this.monsters.values()]) this.updateMonster(m);
    }

    // Held items follow their holder; batteries drain.
    const batterySync = Math.round(this.time * TICK_RATE) % TICK_RATE === 0;
    for (const it of this.items.values()) {
      const h = this.holderPos(it);
      if (h) { it.x = h.x; it.z = h.z; it.region = h.region; }
      if (it.on && it.charge != null) {
        it.charge = Math.max(0, it.charge - DT);
        if (it.charge <= 0) { it.on = false; this.dirtyItems.add(it.id); }
        else if (batterySync) this.dirtyItems.add(it.id);
      }
    }

    // Snapshot.
    const snap = {
      t: 'snap', clock: round(s.clock, 10), ph: s.phase,
      p: this.players.map((p) => ({
        id: p.id, x: round(p.x), y: round(p.y), z: round(p.z), yaw: round(p.yaw), pitch: round(p.pitch),
        r: p.region, a: p.alive ? 1 : 0, hp: p.hp, sl: p.slot, inv: p.inv, cr: p.crouch ? 1 : 0,
        mv: p.moving ? 1 : 0, sp: p.sprint ? 1 : 0, wt: p.walkieTx ? 1 : 0,
      })),
      m: [...this.monsters.values()].map((m) => ({
        id: m.id, t: m.type, x: round(m.x), z: round(m.z), yaw: round(m.yaw), r: m.region, s: m.state,
        v: round(m.speed, 10), st: m.stunned ? 1 : 0, c: m.carrying,
      })),
    };
    if (this.dirtyItems.size) {
      snap.items = [...this.dirtyItems].map((id) => this.items.get(id)).filter(Boolean);
      this.dirtyItems.clear();
    }
    if (this.removedItems.length) {
      snap.gone = this.removedItems;
      this.removedItems = [];
    }
    this.broadcast(snap);
  }
}

export { formatClock };
