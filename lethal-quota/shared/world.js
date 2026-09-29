// Deterministic world generation + collision, shared by server and client.
// Given the same (moonIndex, seed) both sides build an identical world.

import { MOONS, SHIP, CELL, INTERIOR_ORIGIN, SELL_DESK } from './config.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randRange = (rng, a, b) => a + rng() * (b - a);
export const randInt = (rng, a, b) => Math.floor(a + rng() * (b - a + 1));

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- noise
function makeNoise(seed) {
  const rng = mulberry32(seed);
  const perm = new Float32Array(256 * 256);
  for (let i = 0; i < perm.length; i++) perm[i] = rng();
  const at = (x, z) => perm[(x & 255) + ((z & 255) << 8)];
  const noise = (x, z) => {
    const xi = Math.floor(x), zi = Math.floor(z);
    const xf = x - xi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    const a = at(xi, zi), b = at(xi + 1, zi), c = at(xi, zi + 1), d = at(xi + 1, zi + 1);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  };
  return (x, z) => {
    let amp = 1, freq = 1 / 40, sum = 0, norm = 0;
    for (let o = 0; o < 4; o++) {
      sum += (noise(x * freq, z * freq) * 2 - 1) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}

// ---------------------------------------------------------------- geometry helpers
function rect(minX, minZ, maxX, maxZ, tag) {
  return { minX, minZ, maxX, maxZ, tag };
}

function distToRect(x, z, r) {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}

function distToSegment(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz || 1)));
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

export function shipRects() {
  const { minX, maxX, minZ, maxZ, wall, doorHalf } = SHIP;
  return [
    rect(minX - wall, minZ - wall, minX, maxZ + wall, 'ship'),
    rect(maxX, minZ - wall, maxX + wall, maxZ + wall, 'ship'),
    rect(minX - wall, minZ - wall, maxX + wall, minZ, 'ship'),
    rect(minX - wall, maxZ, -doorHalf, maxZ + wall, 'ship'),
    rect(doorHalf, maxZ, maxX + wall, maxZ + wall, 'ship'),
    // terminal desk + lever console
    rect(-4, -4.9, -2.4, -3.5, 'ship'),
    rect(-0.6, -6, 0.6, -5.0, 'ship'),
  ];
}

export const SHIP_DOOR_RECT = rect(-SHIP.doorHalf, SHIP.maxZ, SHIP.doorHalf, SHIP.maxZ + SHIP.wall, 'door');

export function inShip(x, z) {
  return x > SHIP.minX && x < SHIP.maxX && z > SHIP.minZ && z < SHIP.maxZ;
}

// ---------------------------------------------------------------- interior generation
function generateInterior(moon, seed) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const W = 22 + Math.floor(moon.rooms[1] / 2), H = W;
  const grid = new Uint8Array(W * H); // 0 = solid, 1 = floor
  const roomId = new Int16Array(W * H).fill(-1);
  const rooms = [];
  const carve = (x, z, rid = -1) => {
    if (x < 0 || z < 0 || x >= W || z >= H) return;
    grid[z * W + x] = 1;
    if (rid >= 0) roomId[z * W + x] = rid;
  };

  // Entrance hall on the north edge (z = 0).
  const ex = Math.floor(W / 2);
  rooms.push({ x: ex - 1, z: 0, w: 3, h: 3, entrance: true });
  const targetRooms = randInt(rng, moon.rooms[0], moon.rooms[1]);
  for (let attempt = 0; attempt < 400 && rooms.length < targetRooms; attempt++) {
    const w = randInt(rng, 2, 5), h = randInt(rng, 2, 5);
    const x = randInt(rng, 1, W - w - 1), z = randInt(rng, 3, H - h - 1);
    const overlaps = rooms.some((r) => x - 1 < r.x + r.w && x + w + 1 > r.x && z - 1 < r.z + r.h && z + h + 1 > r.z);
    if (!overlaps) rooms.push({ x, z, w, h });
  }
  rooms.forEach((r, i) => {
    r.cx = r.x + Math.floor(r.w / 2);
    r.cz = r.z + Math.floor(r.h / 2);
    for (let zz = r.z; zz < r.z + r.h; zz++) for (let xx = r.x; xx < r.x + r.w; xx++) carve(xx, zz, i);
  });

  const corridor = (a, b) => {
    let x = a.cx, z = a.cz;
    const horizFirst = rng() < 0.5;
    const stepX = () => { while (x !== b.cx) { x += Math.sign(b.cx - x); carve(x, z); } };
    const stepZ = () => { while (z !== b.cz) { z += Math.sign(b.cz - z); carve(x, z); } };
    if (horizFirst) { stepX(); stepZ(); } else { stepZ(); stepX(); }
  };
  // Connect each room to its nearest earlier room (spanning tree), then add a few loops.
  for (let i = 1; i < rooms.length; i++) {
    let best = 0, bd = Infinity;
    for (let j = 0; j < i; j++) {
      const d = Math.abs(rooms[i].cx - rooms[j].cx) + Math.abs(rooms[i].cz - rooms[j].cz);
      if (d < bd) { bd = d; best = j; }
    }
    corridor(rooms[i], rooms[best]);
  }
  const loops = Math.max(1, Math.floor(rooms.length / 4));
  for (let i = 0; i < loops; i++) {
    const a = rooms[randInt(rng, 0, rooms.length - 1)], b = rooms[randInt(rng, 0, rooms.length - 1)];
    if (a !== b) corridor(a, b);
  }

  const ox = INTERIOR_ORIGIN.x - (W * CELL) / 2, oz = INTERIOR_ORIGIN.z;
  const cellCenter = (i, j) => ({ x: ox + (i + 0.5) * CELL, z: oz + (j + 0.5) * CELL });
  const isFloor = (i, j) => i >= 0 && j >= 0 && i < W && j < H && grid[j * W + i] === 1;

  // BFS distances from entrance for fire exit placement and spawns.
  const dist = new Int32Array(W * H).fill(-1);
  const q = [[ex, 0]];
  dist[ex] = 0;
  while (q.length) {
    const [i, j] = q.shift();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (isFloor(ni, nj) && dist[nj * W + ni] < 0) {
        dist[nj * W + ni] = dist[j * W + i] + 1;
        q.push([ni, nj]);
      }
    }
  }

  // Fire exit: farthest floor cell that has a solid neighbour.
  let fe = null, feDist = -1;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const d = dist[j * W + i];
    if (d <= feDist || roomId[j * W + i] < 1) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!isFloor(i + di, j + dj)) { fe = { i, j, di, dj }; feDist = d; break; }
    }
  }

  const mainC = cellCenter(ex, 0);
  const mainDoor = { x: mainC.x, z: oz + 0.05, yaw: Math.PI, spawn: { x: mainC.x, z: oz + 1.2, yaw: Math.PI } };
  let fireDoor = null;
  if (fe) {
    const c = cellCenter(fe.i, fe.j);
    fireDoor = {
      x: c.x + fe.di * (CELL / 2 - 0.05), z: c.z + fe.dj * (CELL / 2 - 0.05),
      di: fe.di, dj: fe.dj,
      spawn: { x: c.x - fe.di * 0.2, z: c.z - fe.dj * 0.2, yaw: Math.atan2(fe.di, fe.dj) },
    };
  }

  // Ceiling lamps in rooms.
  const lamps = [];
  rooms.forEach((r, i) => {
    if (i === 0 || rng() < 0.75) {
      const c = cellCenter(r.cx, r.cz);
      lamps.push({ x: c.x, z: c.z, flicker: rng() < 0.25 });
    }
  });

  // Scrap spawn points inside rooms (not the entrance hall).
  const roomCells = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (roomId[j * W + i] > 0) roomCells.push([i, j]);
  const scrapSpots = [];
  const nScrap = randInt(rng, moon.scrap[0], moon.scrap[1]);
  for (let k = 0; k < nScrap && roomCells.length; k++) {
    const [i, j] = roomCells[randInt(rng, 0, roomCells.length - 1)];
    const c = cellCenter(i, j);
    scrapSpots.push({ x: c.x + randRange(rng, -1.3, 1.3), z: c.z + randRange(rng, -1.3, 1.3) });
  }
  // Vents where monsters crawl out: room cells far from the entrance.
  const farCells = roomCells.filter(([i, j]) => dist[j * W + i] > 6);
  const vents = [];
  for (let k = 0; k < 5 && farCells.length; k++) {
    const [i, j] = farCells[randInt(rng, 0, farCells.length - 1)];
    vents.push(cellCenter(i, j));
  }
  if (!vents.length) vents.push(cellCenter(rooms[rooms.length - 1].cx, rooms[rooms.length - 1].cz));

  // Decorative props (visual only): crates & pipes along walls.
  const props = [];
  for (const [i, j] of roomCells) {
    if (rng() < 0.18) {
      const c = cellCenter(i, j);
      props.push({ kind: rng() < 0.6 ? 'crate' : 'barrel', x: c.x + randRange(rng, -1.4, 1.4), z: c.z + randRange(rng, -1.4, 1.4), r: rng() * Math.PI });
    }
  }

  return { W, H, grid, roomId, rooms, ox, oz, dist, mainDoor, fireDoor, lamps, scrapSpots, vents, props, cellCenter, isFloor };
}

// ---------------------------------------------------------------- outdoor generation
function generateOutdoor(moon, seed) {
  const rng = mulberry32(seed ^ 0x51ed270b);
  const noise = makeNoise(seed);
  const rects = [...shipRects()];
  const circles = [];
  let facility = null;

  if (moon.company) {
    rects.push(rect(SELL_DESK.x - SELL_DESK.halfW, SELL_DESK.z - SELL_DESK.halfD, SELL_DESK.x + SELL_DESK.halfW, SELL_DESK.z + SELL_DESK.halfD, 'desk'));
    // Company building behind the desk.
    rects.push(rect(-14, SELL_DESK.z + 1.5, 14, SELL_DESK.z + 16, 'building'));
  } else {
    const fx = randRange(rng, -30, 30), fz = randRange(rng, 60, 85);
    facility = {
      x: fx, z: fz, halfW: 15, depth: 22,
      mainDoor: { x: fx, z: fz - 0.05, spawn: { x: fx, z: fz - 2, yaw: 0 } },
      fireDoor: { x: fx + 15.05, z: fz + 11, spawn: { x: fx + 17, z: fz + 11, yaw: -Math.PI / 2 } },
    };
    rects.push(rect(fx - 15, fz, fx + 15, fz + 22, 'building'));
  }

  const flatZones = [{ r: rect(SHIP.minX - 2, SHIP.minZ - 2, SHIP.maxX + 2, SHIP.maxZ + 6), inner: 8, outer: 22 }];
  if (facility) flatZones.push({ r: rect(facility.x - 15, facility.z, facility.x + 15, facility.z + 22), inner: 6, outer: 18 });
  if (moon.company) flatZones.push({ r: rect(-16, 0, 16, SELL_DESK.z + 16), inner: 10, outer: 20 });

  const height = (x, z) => {
    if (!moon.terrainAmp) return 0;
    let f = 1;
    for (const zone of flatZones) f *= smoothstep(zone.inner, zone.outer, distToRect(x, z, zone.r));
    const r = Math.hypot(x, z);
    const rim = smoothstep(moon.radius - 25, moon.radius, r) * 10; // rise towards the map edge
    return (noise(x, z) * moon.terrainAmp + moon.terrainAmp * 0.4) * f + rim;
  };

  const clearOf = (x, z, pad) => {
    if (Math.hypot(x, z) < 20) return false;
    for (const r of rects) if (distToRect(x, z, r) < pad) return false;
    if (facility) {
      if (distToSegment(x, z, 0, SHIP.maxZ, facility.x, facility.z) < 7) return false;
      if (distToSegment(x, z, facility.x + 15, facility.z + 11, 0, 0) < 5) return false;
    }
    return true;
  };
  const scatter = (count, kind, rMin, rMax) => {
    for (let k = 0, tries = 0; k < count && tries < count * 10; tries++) {
      const a = rng() * Math.PI * 2;
      const d = Math.sqrt(rng()) * (moon.radius - 12);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const r = randRange(rng, rMin, rMax);
      if (!clearOf(x, z, r + 3)) continue;
      circles.push({ x, z, r, kind, s: rng() });
      k++;
    }
  };
  scatter(moon.trees, 'tree', 0.35, 0.6);
  scatter(moon.rocks, 'rock', 0.6, 2.2);

  return { rects, circles, facility, height, radius: moon.radius };
}

// ---------------------------------------------------------------- public API
export function buildWorld(moonIndex, seed, landed = true) {
  const moon = MOONS[moonIndex];
  const world = { moonIndex, moon, seed, landed };
  if (!landed) {
    world.out = { rects: shipRects(), circles: [], facility: null, height: () => 0, radius: 30 };
    world.interior = null;
    return world;
  }
  world.out = generateOutdoor(moon, seed);
  world.interior = moon.company ? null : generateInterior(moon, seed);
  return world;
}

export function groundHeight(world, region, x, z) {
  if (region === 'in') return 0;
  if (inShip(x, z)) return SHIP.floorY;
  return world.out.height(x, z);
}

function pushOutOfRect(p, r, radius) {
  const cx = Math.max(r.minX, Math.min(p.x, r.maxX));
  const cz = Math.max(r.minZ, Math.min(p.z, r.maxZ));
  let dx = p.x - cx, dz = p.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= radius * radius) return false;
  if (d2 < 1e-8) {
    // Centre is inside the rect: push out along the shallowest axis.
    const l = p.x - r.minX, rr = r.maxX - p.x, t = p.z - r.minZ, b = r.maxZ - p.z;
    const m = Math.min(l, rr, t, b);
    if (m === l) p.x = r.minX - radius; else if (m === rr) p.x = r.maxX + radius;
    else if (m === t) p.z = r.minZ - radius; else p.z = r.maxZ + radius;
    return true;
  }
  const d = Math.sqrt(d2);
  p.x = cx + (dx / d) * radius;
  p.z = cz + (dz / d) * radius;
  return true;
}

// Resolves a circle against static geometry. Mutates and returns p = {x, z}.
export function collide(world, region, p, radius, doorClosed = false) {
  for (let iter = 0; iter < 3; iter++) {
    let hit = false;
    if (region === 'in') {
      const I = world.interior;
      if (!I) return p;
      const ci = Math.floor((p.x - I.ox) / CELL), cj = Math.floor((p.z - I.oz) / CELL);
      for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
        if (I.isFloor(i, j)) continue;
        const r = { minX: I.ox + i * CELL, minZ: I.oz + j * CELL, maxX: I.ox + (i + 1) * CELL, maxZ: I.oz + (j + 1) * CELL };
        if (pushOutOfRect(p, r, radius)) hit = true;
      }
    } else {
      const O = world.out;
      for (const r of O.rects) {
        if (p.x < r.minX - 3 || p.x > r.maxX + 3 || p.z < r.minZ - 3 || p.z > r.maxZ + 3) continue;
        if (pushOutOfRect(p, r, radius)) hit = true;
      }
      if (doorClosed && pushOutOfRect(p, SHIP_DOOR_RECT, radius)) hit = true;
      for (const c of O.circles) {
        const dx = p.x - c.x, dz = p.z - c.z;
        const min = c.r + radius;
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min) {
          const d = Math.sqrt(d2) || 1e-4;
          p.x = c.x + (dx / d) * min;
          p.z = c.z + (dz / d) * min;
          hit = true;
        }
      }
      const rr = Math.hypot(p.x, p.z), lim = O.radius - 2;
      if (rr > lim) { p.x *= lim / rr; p.z *= lim / rr; hit = true; }
    }
    if (!hit) break;
  }
  return p;
}

// Line of sight inside the facility (grid march). Outdoors we only block on big rects.
export function lineOfSight(world, region, ax, az, bx, bz) {
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.ceil(len / 0.5);
  if (region === 'in') {
    const I = world.interior;
    if (!I) return true;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      if (!I.isFloor(Math.floor((x - I.ox) / CELL), Math.floor((z - I.oz) / CELL))) return false;
    }
    return true;
  }
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    for (const r of world.out.rects) if (r.tag === 'building' && x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ) return false;
  }
  return true;
}

export function cellOf(world, x, z) {
  const I = world.interior;
  return [Math.floor((x - I.ox) / CELL), Math.floor((z - I.oz) / CELL)];
}

// A* on the interior grid. Returns a list of world-space waypoints (excluding start).
export function findPath(world, ax, az, bx, bz, maxNodes = 900) {
  const I = world.interior;
  if (!I) return null;
  const [si, sj] = cellOf(world, ax, az);
  const [ti, tj] = cellOf(world, bx, bz);
  if (!I.isFloor(si, sj) || !I.isFloor(ti, tj)) return null;
  if (si === ti && sj === tj) return [{ x: bx, z: bz }];
  const W = I.W;
  const key = (i, j) => j * W + i;
  const g = new Map(), came = new Map();
  const open = [[Math.abs(ti - si) + Math.abs(tj - sj), si, sj]];
  g.set(key(si, sj), 0);
  let n = 0;
  while (open.length && n++ < maxNodes) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
    const [, i, j] = open.splice(bi, 1)[0];
    if (i === ti && j === tj) {
      const path = [];
      let k = key(i, j);
      while (k !== key(si, sj)) {
        const ci = k % W, cj = Math.floor(k / W);
        path.push(I.cellCenter(ci, cj));
        k = came.get(k);
      }
      path.reverse();
      path[path.length - 1] = { x: bx, z: bz };
      return path;
    }
    const gc = g.get(key(i, j));
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (!I.isFloor(ni, nj)) continue;
      const nk = key(ni, nj);
      if (g.has(nk) && g.get(nk) <= gc + 1) continue;
      g.set(nk, gc + 1);
      came.set(nk, key(i, j));
      open.push([gc + 1 + Math.abs(ti - ni) + Math.abs(tj - nj), ni, nj]);
    }
  }
  return null;
}

export function randomFloorPoint(world, rng) {
  const I = world.interior;
  for (let k = 0; k < 200; k++) {
    const i = Math.floor(rng() * I.W), j = Math.floor(rng() * I.H);
    if (I.isFloor(i, j)) return I.cellCenter(i, j);
  }
  return I.cellCenter(Math.floor(I.W / 2), 0);
}
