// Shared game constants. Imported by both the Node server and the browser client.

export const TICK_RATE = 20; // server simulation ticks per second
export const SNAPSHOT_RATE = 20; // snapshots per second
export const MAX_PLAYERS = 8;

// In-game clock: minutes since midnight. A day runs 08:00 -> 24:00.
export const DAY_START = 8 * 60;
export const DAY_END = 24 * 60;
// Real seconds per in-game minute (16h * 60 * 0.75 = 12 real minutes per day).
export const SECONDS_PER_GAME_MINUTE = Number(globalThis.process?.env?.LQ_MINUTE_SECONDS) || 0.75;

export const START_CREDITS = 60;
export const START_QUOTA = 130;
export const DAYS_PER_QUOTA = 3;

// Interior (the facility) lives far away from the outdoor map, so the two never see each other.
export const INTERIOR_ORIGIN = { x: 1000, z: 0 };
export const CELL = 4; // size of one interior grid cell (m)
export const WALL_HEIGHT = 4;

export const PLAYER_RADIUS = 0.35;
export const EYE_HEIGHT = 1.6;
export const CROUCH_EYE_HEIGHT = 0.95;
export const MAX_HP = 100;
export const INVENTORY_SLOTS = 4;

// The ship sits at the origin of every moon. Door faces +Z.
export const SHIP = {
  minX: -4, maxX: 4, minZ: -6, maxZ: 6,
  wall: 0.3,
  doorHalf: 1.1,
  floorY: 0.15,
  height: 3.2,
  lever: { x: 0, y: 1.1, z: -5.3 },
  terminal: { x: -3.2, y: 1.2, z: -4.2 },
  doorButton: { x: 1.6, y: 1.3, z: 5.7 },
  delivery: { x: 2.8, z: -4.5 },
  spawn: { x: 0, z: -2 },
};

// Selling desk on the Company moon.
export const SELL_DESK = { x: 0, z: 16, halfW: 3, halfD: 0.6 };

export const MOONS = [
  {
    id: 'company', name: '00-Company', cost: 0, company: true,
    desc: 'The Company building. Sell your scrap here.',
    ground: 0x3b3a36, sky: 0x6d6a5f, fog: 0x6d6a5f, fogDensity: 0.012,
    terrainAmp: 0, trees: 0, rocks: 12, radius: 45,
  },
  {
    id: 'proving', name: '12-Proving', cost: 0, risk: 'C',
    desc: 'A dusty industrial rock. Low value, low danger. Good for new hires.',
    ground: 0x7a5a3a, sky: 0xc9a27a, fog: 0xb08a66, fogDensity: 0.012,
    terrainAmp: 3, trees: 0, rocks: 70, radius: 140,
    rooms: [8, 11], scrap: [9, 13], scrapMult: 0.85, power: 4, initialMonsters: 0, dogs: 1, dogHour: 19,
  },
  {
    id: 'bastion', name: '33-Bastion', cost: 0, risk: 'B',
    desc: 'Rocky canyons around an abandoned plant. Moderate scrap.',
    ground: 0x5d5a52, sky: 0x9aa4a6, fog: 0x8d9899, fogDensity: 0.015,
    terrainAmp: 5, trees: 10, rocks: 90, radius: 140,
    rooms: [10, 13], scrap: [12, 16], scrapMult: 1, power: 6, initialMonsters: 1, dogs: 2, dogHour: 18,
  },
  {
    id: 'mire', name: '58-Mire', cost: 0, risk: 'B',
    desc: 'A foggy swamp forest. Visibility is poor.',
    ground: 0x33452b, sky: 0x6f7d6a, fog: 0x5f6d5a, fogDensity: 0.03,
    terrainAmp: 2.5, trees: 140, rocks: 20, radius: 140,
    rooms: [10, 14], scrap: [13, 17], scrapMult: 1.05, power: 7, initialMonsters: 1, dogs: 2, dogHour: 17,
  },
  {
    id: 'ashfall', name: '74-Ashfall', cost: 0, risk: 'A',
    desc: 'Volcanic wastes. Rich facility, hostile fauna.',
    ground: 0x2c2624, sky: 0x5a3a30, fog: 0x4a2c24, fogDensity: 0.02,
    terrainAmp: 6, trees: 0, rocks: 110, radius: 140,
    rooms: [12, 16], scrap: [15, 20], scrapMult: 1.25, power: 10, initialMonsters: 2, dogs: 3, dogHour: 16,
  },
  {
    id: 'blizzard', name: '92-Blizzard', cost: 450, risk: 'S',
    desc: 'Frozen mountain complex. Extremely valuable. Extremely deadly.',
    ground: 0xd8dde3, sky: 0xa9b3bd, fog: 0xc3ccd6, fogDensity: 0.035,
    terrainAmp: 7, trees: 60, rocks: 60, radius: 140,
    rooms: [13, 17], scrap: [18, 24], scrapMult: 1.6, power: 13, initialMonsters: 3, dogs: 4, dogHour: 14,
  },
];

// Purchasable equipment.
export const STORE = {
  flashlight: { name: 'Flashlight', price: 15, weight: 5, battery: 140, beam: { intensity: 25, distance: 22, angle: 0.45 } },
  proflashlight: { name: 'Pro-flashlight', price: 25, weight: 5, battery: 300, beam: { intensity: 60, distance: 40, angle: 0.38 } },
  walkie: { name: 'Walkie-talkie', price: 12, weight: 0, battery: 400 },
  shovel: { name: 'Shovel', price: 30, weight: 16, damage: 1 },
  stungrenade: { name: 'Stun grenade', price: 30, weight: 5 },
};

// Scrap found inside facilities. value = [min, max] credits, weight in lb.
export const SCRAP = [
  { id: 'axle', name: 'Large axle', value: [36, 56], weight: 16, shape: 'cyl', color: 0x777777, size: [0.12, 0.9] },
  { id: 'register', name: 'Cash register', value: [80, 160], weight: 80, shape: 'box', color: 0x445566, size: [0.6, 0.45, 0.5], twoHanded: true },
  { id: 'bell', name: 'Brass bell', value: [48, 80], weight: 24, shape: 'bell', color: 0xc9a13b, size: [0.25] },
  { id: 'robot', name: 'Toy robot', value: [56, 88], weight: 21, shape: 'box', color: 0x9aa3ad, size: [0.3, 0.45, 0.2] },
  { id: 'glass', name: 'Magnifier', value: [44, 60], weight: 11, shape: 'cyl', color: 0x88ccdd, size: [0.15, 0.05] },
  { id: 'bottles', name: 'Bottle bin', value: [44, 56], weight: 19, shape: 'box', color: 0x5a7a3a, size: [0.4, 0.35, 0.4] },
  { id: 'duck', name: 'Rubber duck', value: [4, 26], weight: 1, shape: 'sphere', color: 0xf2d22e, size: [0.13] },
  { id: 'mug', name: 'Coffee mug', value: [24, 68], weight: 5, shape: 'cyl', color: 0xe0e0d0, size: [0.08, 0.14] },
  { id: 'teapot', name: 'Teapot', value: [32, 70], weight: 5, shape: 'sphere', color: 0xb0b8c0, size: [0.18] },
  { id: 'goldbar', name: 'Gold bar', value: [102, 210], weight: 77, shape: 'box', color: 0xf0c030, size: [0.35, 0.12, 0.18] },
  { id: 'cube', name: 'Toy cube', value: [24, 44], weight: 3, shape: 'box', color: 0xd04a4a, size: [0.2, 0.2, 0.2] },
  { id: 'phone', name: 'Old phone', value: [48, 64], weight: 6, shape: 'box', color: 0x2a2a2a, size: [0.22, 0.12, 0.18] },
  { id: 'airhorn', name: 'Airhorn', value: [52, 72], weight: 1, shape: 'cyl', color: 0xd83030, size: [0.07, 0.35] },
  { id: 'engine', name: 'V-type engine', value: [20, 56], weight: 16, shape: 'box', color: 0x4d4d52, size: [0.6, 0.4, 0.4], twoHanded: true },
  { id: 'sheet', name: 'Metal sheet', value: [10, 24], weight: 23, shape: 'box', color: 0x8a8f94, size: [0.7, 0.03, 0.5] },
  { id: 'flask', name: 'Chemical jug', value: [32, 84], weight: 32, shape: 'cyl', color: 0x3a8a5a, size: [0.18, 0.45] },
  { id: 'candy', name: 'Candy', value: [6, 36], weight: 1, shape: 'box', color: 0xff66cc, size: [0.14, 0.05, 0.08] },
  { id: 'fancylamp', name: 'Fancy lamp', value: [60, 128], weight: 21, shape: 'cyl', color: 0xd6b56a, size: [0.1, 0.8] },
];

export const MONSTER_TYPES = {
  hoarder: { name: 'Hoarder bug', hp: 3, power: 1, speed: 3.2, angrySpeed: 5.6, damage: 30 },
  lurker: { name: 'Lurker', hp: 3, power: 3, speed: 3.0, angrySpeed: 8.5, damage: 999 },
  springhead: { name: 'Springhead', hp: Infinity, power: 1, speed: 11, damage: 90 },
  crawler: { name: 'Crawler', hp: 4, power: 3, speed: 3.0, angrySpeed: 8.5, damage: 40 },
  dog: { name: 'Blind dog', hp: 6, power: 2, speed: 2.5, angrySpeed: 9, damage: 999 },
};

// Credit multiplier for selling, indexed by days left before the deadline.
export const SELL_RATE = [1.0, 0.75, 0.5, 0.3];

export function formatClock(minutes) {
  const m = Math.floor(minutes) % (24 * 60);
  let h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mm} ${ampm}`;
}
