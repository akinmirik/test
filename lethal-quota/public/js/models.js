// Low-poly procedural models for players, monsters and items.
import * as THREE from 'three';
import { SCRAP } from '/shared/config.js';

const matCache = new Map();
export function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.1, flatShading: true, ...opts }));
  return matCache.get(key);
}

function mesh(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  return m;
}

// ---------------------------------------------------------------- players
export function makePlayerModel(color) {
  const g = new THREE.Group();
  const suit = mat(color, { roughness: 0.9 });
  const dark = mat(0x222222);
  const body = mesh(new THREE.CapsuleGeometry(0.3, 0.55, 4, 8), suit, 0, 1.05, 0);
  const pack = mesh(new THREE.BoxGeometry(0.42, 0.5, 0.2), mat(0x555555), 0, 1.15, 0.3);
  const head = new THREE.Group();
  head.position.set(0, 1.6, 0);
  head.add(mesh(new THREE.SphereGeometry(0.24, 10, 8), mat(0xd8d8d0)));
  const visor = mesh(new THREE.SphereGeometry(0.2, 12, 8, Math.PI * 0.1, Math.PI * 0.8, Math.PI * 0.25, Math.PI * 0.4), mat(0x1a1a22, { metalness: 0.8, roughness: 0.2 }));
  visor.rotation.y = Math.PI;
  visor.scale.setScalar(1.25);
  head.add(visor);
  const legGeo = new THREE.BoxGeometry(0.18, 0.6, 0.2);
  legGeo.translate(0, -0.3, 0);
  const legL = mesh(legGeo, suit, -0.13, 0.62, 0);
  const legR = mesh(legGeo, suit, 0.13, 0.62, 0);
  const armGeo = new THREE.BoxGeometry(0.14, 0.55, 0.16);
  armGeo.translate(0, -0.27, 0);
  const armL = mesh(armGeo, suit, -0.4, 1.38, 0);
  const armR = mesh(armGeo, suit, 0.4, 1.38, 0);
  const hand = new THREE.Group();
  hand.position.set(0, -0.5, -0.1);
  armR.add(hand);
  const boots = mat(0x2b2b2b);
  legL.add(mesh(new THREE.BoxGeometry(0.2, 0.1, 0.28), boots, 0, -0.58, -0.04));
  legR.add(mesh(new THREE.BoxGeometry(0.2, 0.1, 0.28), boots, 0, -0.58, -0.04));
  g.add(body, pack, head, legL, legR, armL, armR, mesh(new THREE.BoxGeometry(0.1, 0.1, 0.05), dark, 0.12, 1.3, -0.3));
  g.userData = { head, legL, legR, armL, armR, hand, phase: 0 };
  return g;
}

export function animatePlayer(model, dt, speed, crouch, holding) {
  const u = model.userData;
  u.phase += dt * speed * 2.2;
  const swing = Math.sin(u.phase) * Math.min(1, speed / 3) * 0.7;
  u.legL.rotation.x = swing;
  u.legR.rotation.x = -swing;
  u.armL.rotation.x = -swing * 0.6;
  u.armR.rotation.x = holding ? -1.1 : swing * 0.6;
  model.scale.y = crouch ? 0.72 : 1;
}

// ---------------------------------------------------------------- monsters
export function makeMonster(type) {
  const g = new THREE.Group();
  const parts = {};
  if (type === 'hoarder') {
    const shell = mat(0xc9a236), dark = mat(0x3a2a10);
    const body = mesh(new THREE.SphereGeometry(0.45, 10, 8), shell, 0, 0.6, 0);
    body.scale.set(1, 0.8, 1.2);
    const head = mesh(new THREE.SphereGeometry(0.25, 8, 6), dark, 0, 0.7, -0.5);
    const eyeM = mat(0x111111, { metalness: 0.9, roughness: 0.1 });
    head.add(mesh(new THREE.SphereGeometry(0.08, 6, 4), eyeM, -0.12, 0.08, -0.18), mesh(new THREE.SphereGeometry(0.08, 6, 4), eyeM, 0.12, 0.08, -0.18));
    g.add(body, head);
    parts.legs = [];
    for (let i = 0; i < 6; i++) {
      const side = i < 3 ? -1 : 1;
      const leg = mesh(new THREE.CylinderGeometry(0.03, 0.02, 0.6), dark, side * 0.45, 0.35, -0.3 + (i % 3) * 0.3);
      leg.rotation.z = side * 0.6;
      g.add(leg);
      parts.legs.push(leg);
    }
    const wing = mesh(new THREE.PlaneGeometry(0.5, 0.8), mat(0xe0e0c0, { transparent: true, opacity: 0.5, side: THREE.DoubleSide }), 0, 0.95, 0.1);
    wing.rotation.x = -Math.PI / 2.4;
    g.add(wing);
    parts.wing = wing;
    parts.carry = new THREE.Vector3(0, 1.1, -0.3);
  } else if (type === 'lurker') {
    const skin = mat(0x1d2a1a, { roughness: 1 });
    const torso = mesh(new THREE.CylinderGeometry(0.22, 0.12, 1.1, 6), skin, 0, 1.25, 0);
    const head = mesh(new THREE.IcosahedronGeometry(0.42, 0), mat(0x2b3d24, { roughness: 1 }), 0, 2.0, 0);
    head.scale.set(1.1, 0.8, 1);
    for (let i = 0; i < 7; i++) {
      const leaf = mesh(new THREE.ConeGeometry(0.12, 0.5, 4), mat(0x24361f), 0, 2.0, 0);
      leaf.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      leaf.translateY(0.35);
      g.add(leaf);
    }
    head.add(mesh(new THREE.SphereGeometry(0.04, 5, 4), mat(0xffffcc, { emissive: 0x888844 }), -0.1, 0, -0.38), mesh(new THREE.SphereGeometry(0.04, 5, 4), mat(0xffffcc, { emissive: 0x888844 }), 0.1, 0, -0.38));
    const legGeo = new THREE.CylinderGeometry(0.06, 0.04, 0.8, 5);
    legGeo.translate(0, -0.4, 0);
    const legL = mesh(legGeo, skin, -0.12, 0.8, 0), legR = mesh(legGeo, skin, 0.12, 0.8, 0);
    const armGeo = new THREE.CylinderGeometry(0.05, 0.03, 1.1, 5);
    armGeo.translate(0, -0.55, 0);
    const armL = mesh(armGeo, skin, -0.3, 1.7, 0), armR = mesh(armGeo, skin, 0.3, 1.7, 0);
    armL.rotation.z = -0.15; armR.rotation.z = 0.15;
    g.add(torso, head, legL, legR, armL, armR);
    Object.assign(parts, { legL, legR, armL, armR });
  } else if (type === 'springhead') {
    const skin = mat(0x9b8f80, { roughness: 0.6 }), rust = mat(0x7a4a2a, { roughness: 0.5, metalness: 0.6 });
    g.add(mesh(new THREE.BoxGeometry(0.55, 0.8, 0.3), skin, 0, 1.3, 0));
    g.add(mesh(new THREE.CylinderGeometry(0.08, 0.06, 0.9, 6), skin, -0.15, 0.45, 0), mesh(new THREE.CylinderGeometry(0.08, 0.06, 0.9, 6), skin, 0.15, 0.45, 0));
    g.add(mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.75, 6), skin, -0.36, 1.25, 0), mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.75, 6), skin, 0.36, 1.25, 0));
    // coil neck
    const pts = [];
    for (let i = 0; i <= 120; i++) { const a = i * 0.45; pts.push(new THREE.Vector3(Math.cos(a) * 0.1, i * 0.0055, Math.sin(a) * 0.1)); }
    const coil = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 200, 0.018, 4), rust, 0, 1.7, 0);
    const head = mesh(new THREE.SphereGeometry(0.22, 10, 8), mat(0xc4b8a0, { roughness: 0.4 }), 0, 2.45, 0);
    // painted face
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    c.fillStyle = '#c4b8a0'; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#300'; c.beginPath(); c.arc(22, 26, 6, 0, 7); c.arc(42, 26, 6, 0, 7); c.fill();
    c.strokeStyle = '#a00'; c.lineWidth = 3; c.beginPath(); c.arc(32, 36, 14, 0.2, Math.PI - 0.2); c.stroke();
    const face = mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(cv), transparent: false }), 0, 0, -0.221);
    face.rotation.y = Math.PI;
    head.add(face);
    g.add(coil, head);
    parts.head = head;
    parts.coil = coil;
  } else if (type === 'crawler') {
    const skin = mat(0x8a7c78, { roughness: 1 });
    const body = mesh(new THREE.SphereGeometry(0.6, 10, 8), skin, 0, 0.75, 0);
    body.scale.set(1.1, 0.8, 1.5);
    const jaw = mesh(new THREE.BoxGeometry(0.8, 0.25, 0.5), mat(0x5a2a2a), 0, 0.55, -0.85);
    const teeth = mat(0xeeeecc);
    for (let i = 0; i < 6; i++) jaw.add(mesh(new THREE.ConeGeometry(0.04, 0.15, 4), teeth, -0.3 + i * 0.12, 0.17, -0.2));
    g.add(body, jaw);
    parts.legs = [];
    for (let i = 0; i < 4; i++) {
      const leg = mesh(new THREE.CylinderGeometry(0.1, 0.07, 0.8, 5), skin, i % 2 ? 0.55 : -0.55, 0.4, i < 2 ? -0.5 : 0.5);
      g.add(leg);
      parts.legs.push(leg);
    }
    parts.jaw = jaw;
  } else if (type === 'dog') {
    const skin = mat(0x8a3a30, { roughness: 1 });
    const body = mesh(new THREE.CylinderGeometry(0.45, 0.35, 2.2, 7), skin, 0, 1.1, 0.2);
    body.rotation.x = Math.PI / 2;
    const head = new THREE.Group();
    head.position.set(0, 1.2, -1.1);
    head.add(mesh(new THREE.BoxGeometry(0.6, 0.35, 0.8), skin, 0, 0.12, -0.3));
    const jaw = mesh(new THREE.BoxGeometry(0.55, 0.15, 0.75), mat(0x6a2a24), 0, -0.18, -0.3);
    head.add(jaw);
    const teeth = mat(0xeeeecc);
    for (let i = 0; i < 8; i++) head.add(mesh(new THREE.ConeGeometry(0.035, 0.14, 4), teeth, -0.24 + (i % 4) * 0.16, -0.04, -0.4 - Math.floor(i / 4) * 0.25));
    g.add(body, head);
    parts.legs = [];
    for (let i = 0; i < 4; i++) {
      const geo = new THREE.CylinderGeometry(0.1, 0.07, 1.0, 5);
      geo.translate(0, -0.5, 0);
      const leg = mesh(geo, skin, i % 2 ? 0.3 : -0.3, 1.0, i < 2 ? -0.6 : 0.9);
      g.add(leg);
      parts.legs.push(leg);
    }
    parts.head = head;
    parts.jaw = jaw;
  }
  g.userData = { type, parts, phase: Math.random() * 10 };
  return g;
}

export function animateMonster(model, dt, speed, state, time) {
  const u = model.userData, p = u.parts;
  u.phase += dt * (1 + speed * 2.5);
  const s = Math.sin(u.phase);
  switch (u.type) {
    case 'hoarder':
      p.legs.forEach((l, i) => { l.rotation.x = Math.sin(u.phase * 1.5 + i) * 0.5 * Math.min(1, speed); });
      p.wing.rotation.z = state === 'angry' ? Math.sin(time * 40) * 0.3 : 0;
      model.children[0].position.y = 0.6 + Math.abs(s) * 0.04;
      break;
    case 'lurker':
      p.legL.rotation.x = s * 0.6 * Math.min(1, speed / 2);
      p.legR.rotation.x = -s * 0.6 * Math.min(1, speed / 2);
      p.armL.rotation.x = state === 'angry' ? -1.3 : -s * 0.3;
      p.armR.rotation.x = state === 'angry' ? -1.3 : s * 0.3;
      break;
    case 'springhead':
      if (state === 'move') {
        p.head.position.y = 2.45 + Math.abs(Math.sin(time * 18)) * 0.25;
        p.head.rotation.z = Math.sin(time * 9) * 0.2;
        model.rotation.z = Math.sin(time * 14) * 0.05;
      }
      break;
    case 'crawler':
      p.legs.forEach((l, i) => { l.rotation.x = Math.sin(u.phase * 1.4 + i * 1.6) * 0.7 * Math.min(1, speed / 2); });
      p.jaw.position.y = 0.55 - (state === 'chase' ? Math.abs(Math.sin(time * 10)) * 0.12 : 0);
      break;
    case 'dog':
      p.legs.forEach((l, i) => { l.rotation.x = Math.sin(u.phase + (i % 2 ? Math.PI : 0) + (i < 2 ? 0 : 0.5)) * 0.6 * Math.min(1, speed / 2); });
      p.jaw.rotation.x = state === 'chase' || state === 'hunt' ? 0.3 + Math.sin(time * 12) * 0.2 : 0.05;
      p.head.rotation.y = state === 'wander' ? Math.sin(time * 0.8) * 0.4 : 0;
      break;
  }
}

// ---------------------------------------------------------------- items
export function makeItemMesh(item) {
  const g = new THREE.Group();
  switch (item.type) {
    case 'flashlight':
    case 'proflashlight': {
      const body = mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.26, 8), mat(item.type === 'flashlight' ? 0x2a2a2a : 0xd8b020), 0, 0, 0);
      body.rotation.x = Math.PI / 2;
      const head = mesh(new THREE.CylinderGeometry(0.055, 0.04, 0.07, 8), mat(0x333333), 0, 0, -0.15);
      head.rotation.x = Math.PI / 2;
      const lens = mesh(new THREE.CircleGeometry(0.05, 8), new THREE.MeshBasicMaterial({ color: 0xfff6d0 }), 0, 0, -0.186);
      lens.rotation.y = Math.PI;
      g.add(body, head, lens);
      g.userData.lens = lens;
      break;
    }
    case 'walkie': {
      g.add(mesh(new THREE.BoxGeometry(0.08, 0.18, 0.04), mat(0x303030)));
      g.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.14), mat(0x111111), 0.025, 0.15, 0));
      const led = mesh(new THREE.BoxGeometry(0.02, 0.02, 0.01), new THREE.MeshBasicMaterial({ color: 0x331111 }), -0.02, 0.07, -0.021);
      g.add(led);
      g.userData.led = led;
      break;
    }
    case 'shovel': {
      const shaft = mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6), mat(0x6b4a2a), 0, 0, 0);
      const blade = mesh(new THREE.BoxGeometry(0.22, 0.28, 0.02), mat(0x777777, { metalness: 0.6 }), 0, -0.6, 0);
      g.add(shaft, blade);
      g.rotation.z = 0.2;
      break;
    }
    case 'stungrenade': {
      g.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.12, 8), mat(0x3a5a2a)));
      g.add(mesh(new THREE.TorusGeometry(0.02, 0.005, 4, 8), mat(0xaaaaaa), 0, 0.08, 0));
      break;
    }
    default: {
      const def = SCRAP.find((d) => d.id === item.type);
      const m = mat(def?.color ?? 0x888888, { metalness: 0.3 });
      const sz = def?.size ?? [0.2, 0.2, 0.2];
      let geo;
      switch (def?.shape) {
        case 'cyl': geo = new THREE.CylinderGeometry(sz[0], sz[0], sz[1], 10); break;
        case 'sphere': geo = new THREE.SphereGeometry(sz[0], 10, 8); break;
        case 'bell': geo = new THREE.CylinderGeometry(sz[0] * 0.3, sz[0], sz[0] * 1.2, 10, 1, true); break;
        default: geo = new THREE.BoxGeometry(sz[0], sz[1], sz[2]);
      }
      const main = mesh(geo, m);
      g.add(main);
      if (def?.shape === 'bell') main.material = mat(def.color, { metalness: 0.7, roughness: 0.3, side: THREE.DoubleSide });
      if (item.type === 'duck') g.add(mesh(new THREE.SphereGeometry(0.07, 8, 6), m, 0, 0.1, -0.08), mesh(new THREE.ConeGeometry(0.03, 0.06, 4), mat(0xff8800), 0, 0.1, -0.16));
      if (item.type === 'teapot') g.add(mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.14, 6), m, 0.2, 0.05, 0));
      if (item.type === 'robot') g.add(mesh(new THREE.BoxGeometry(0.2, 0.18, 0.18), m, 0, 0.32, 0));
      if (item.type === 'fancylamp') g.add(mesh(new THREE.ConeGeometry(0.25, 0.25, 8, 1, true), mat(0xf0e0b0, { side: THREE.DoubleSide, emissive: 0x332200 }), 0, 0.45, 0));
      // Lift so the bottom sits on the ground.
      const box = new THREE.Box3().setFromObject(g);
      g.children.forEach((c) => { c.position.y -= box.min.y; });
    }
  }
  return g;
}

// Hold offsets in first-person view (relative to camera).
export function viewModelOffset(type) {
  switch (type) {
    case 'flashlight': case 'proflashlight': return [0.28, -0.26, -0.5];
    case 'walkie': return [0.25, -0.25, -0.45];
    case 'shovel': return [0.35, -0.2, -0.6];
    case 'stungrenade': return [0.25, -0.25, -0.45];
    default: return [0, -0.45, -0.75];
  }
}
