// Builds Three.js meshes for the ship, moon surface, facility interior and space backdrop.
import * as THREE from 'three';
import { SHIP, CELL, WALL_HEIGHT, SELL_DESK, MOONS, formatClock } from '/shared/config.js';
import { mat } from './models.js';

// ---------------------------------------------------------------- procedural textures
function canvasTex(size, draw, repeat = 1) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d'), size);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}
function speckle(c, s, base, spread, n) {
  c.fillStyle = base; c.fillRect(0, 0, s, s);
  for (let i = 0; i < n; i++) {
    const v = Math.floor(Math.random() * spread);
    c.fillStyle = `rgba(${v},${v},${v},${Math.random() * 0.25})`;
    c.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
}
const TEX = {};
function textures() {
  if (TEX.ready) return TEX;
  TEX.concrete = canvasTex(128, (c, s) => {
    speckle(c, s, '#6e6c66', 255, 900);
    c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 2; c.strokeRect(0, 0, s, s);
  });
  TEX.wall = canvasTex(128, (c, s) => {
    speckle(c, s, '#7c7a70', 200, 600);
    c.fillStyle = 'rgba(40,30,20,0.55)'; c.fillRect(0, s * 0.72, s, s * 0.28);
    c.fillStyle = 'rgba(200,160,40,0.5)'; c.fillRect(0, s * 0.7, s, 4);
    c.strokeStyle = 'rgba(0,0,0,0.4)'; c.beginPath(); c.moveTo(s / 2, 0); c.lineTo(s / 2, s * 0.7); c.stroke();
  });
  TEX.metal = canvasTex(128, (c, s) => {
    speckle(c, s, '#5b6168', 255, 400);
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { c.beginPath(); c.moveTo(0, (i * s) / 4); c.lineTo(s, (i * s) / 4); c.stroke(); }
    c.fillStyle = 'rgba(0,0,0,0.5)';
    for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) c.fillRect(4 + j * 16, 4 + (i * s) / 4, 2, 2);
  });
  TEX.grate = canvasTex(64, (c, s) => {
    c.fillStyle = '#2a2d30'; c.fillRect(0, 0, s, s);
    c.fillStyle = '#4c5156';
    for (let i = 0; i < s; i += 8) { c.fillRect(i, 0, 3, s); c.fillRect(0, i, s, 3); }
  }, 8);
  TEX.ready = true;
  return TEX;
}

function box(w, h, d, material, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
}

function textSprite(text, color = '#ff7a1a', w = 256, h = 64, font = 'bold 34px monospace') {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  c.fillStyle = color; c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(w / 128, h / 128), new THREE.MeshBasicMaterial({ map: t }));
}

// ---------------------------------------------------------------- scene manager
export class WorldView {
  constructor(scene) {
    this.scene = scene;
    textures();
    this.dynamic = new THREE.Group(); // per-moon content
    scene.add(this.dynamic);

    // Persistent lights. Never add/remove lights at runtime (avoids shader recompiles).
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x333333, 0.6);
    this.sun = new THREE.DirectionalLight(0xfff0dd, 1.2);
    this.sun.position.set(50, 80, 30);
    this.shipLight = new THREE.PointLight(0xffeecc, 12, 14, 1.6);
    this.shipLight.position.set(0, SHIP.height - 0.3, -1);
    this.doorLight = new THREE.PointLight(0xffd9a0, 0, 16, 1.5);
    this.lampPool = Array.from({ length: 4 }, () => new THREE.PointLight(0xfff2cc, 0, 14, 1.5));
    scene.add(this.hemi, this.sun, this.sun.target, this.shipLight, this.doorLight, ...this.lampPool);

    this.buildShip();
    this.buildSpace();
    this.world = null;
  }

  // ------------------------------------------------------------------ ship
  buildShip() {
    const T = textures();
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ map: T.metal, roughness: 0.7, metalness: 0.4, color: 0xb0b4b8 });
    const floorMat = new THREE.MeshStandardMaterial({ map: T.grate.clone(), roughness: 0.9, metalness: 0.5 });
    floorMat.map.repeat.set(4, 6);
    floorMat.map.needsUpdate = true;
    const { minX, maxX, minZ, maxZ, wall, height, doorHalf, floorY } = SHIP;
    const W = maxX - minX, D = maxZ - minZ;
    g.add(box(W + wall * 2, floorY, D + wall * 2, floorMat, 0, floorY / 2, 0));
    g.add(box(W + wall * 2, 0.3, D + wall * 2, hull, 0, height + 0.15, 0));
    g.add(box(wall, height, D + wall * 2, hull, minX - wall / 2, height / 2, 0));
    g.add(box(wall, height, D + wall * 2, hull, maxX + wall / 2, height / 2, 0));
    g.add(box(W + wall * 2, height, wall, hull, 0, height / 2, minZ - wall / 2));
    const sideW = maxX - doorHalf + wall;
    g.add(box(sideW, height, wall, hull, -(doorHalf + sideW / 2), height / 2, maxZ + wall / 2));
    g.add(box(sideW, height, wall, hull, doorHalf + sideW / 2, height / 2, maxZ + wall / 2));
    g.add(box(doorHalf * 2, height - 2.4, wall, hull, 0, 2.4 + (height - 2.4) / 2, maxZ + wall / 2));
    // exterior hull detail
    g.add(box(W + 1.2, 0.8, D + 1, mat(0x3a3d40), 0, height + 0.6, -0.3));
    g.add(box(2.5, 1.2, 3, mat(0x55585c), 0, height + 1.4, -3));

    // sliding door panels
    const doorMat = mat(0x707880, { metalness: 0.6, roughness: 0.4 });
    this.doorL = box(doorHalf, 2.4, 0.12, doorMat, -doorHalf / 2, 1.2 + floorY / 2, maxZ + wall / 2);
    this.doorR = box(doorHalf, 2.4, 0.12, doorMat, doorHalf / 2, 1.2 + floorY / 2, maxZ + wall / 2);
    g.add(this.doorL, this.doorR);
    this.doorOpen = 0;
    // door button panel
    const btn = box(0.25, 0.35, 0.08, mat(0x222222), SHIP.doorButton.x, SHIP.doorButton.y, maxZ - 0.05);
    btn.add(box(0.1, 0.1, 0.05, new THREE.MeshBasicMaterial({ color: 0x33ff55 }), 0, 0.07, -0.04));
    btn.add(box(0.1, 0.1, 0.05, new THREE.MeshBasicMaterial({ color: 0xff3322 }), 0, -0.08, -0.04));
    g.add(btn);

    // ceiling light panel
    g.add(box(1.4, 0.05, 2.5, new THREE.MeshBasicMaterial({ color: 0xfff5dd }), 0, height - 0.03, -1));

    // terminal
    const desk = box(1.6, 1.0, 1.4, mat(0x3d4247), -3.2, 0.5 + floorY, -4.2);
    const screen = box(0.9, 0.6, 0.08, mat(0x111111), 0, 0.75, -0.2);
    screen.rotation.x = -0.2;
    this.termScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), new THREE.MeshBasicMaterial({ color: 0x1dff5a }));
    this.termScreen.position.set(0, 0, 0.045);
    screen.add(this.termScreen);
    screen.rotation.y = Math.PI / 5;
    desk.add(screen);
    g.add(desk);

    // lever console
    const consoleM = box(1.2, 1.0, 1.0, mat(0x2e3236), 0, 0.5 + floorY, -5.5);
    const leverBase = box(0.2, 0.1, 0.3, mat(0x111111), 0, 0.55, 0.1);
    this.leverArm = new THREE.Group();
    this.leverArm.position.set(0, 0.55, 0.1);
    this.leverArm.add(box(0.05, 0.5, 0.05, mat(0x999999, { metalness: 0.8 }), 0, 0.25, 0));
    this.leverArm.add(box(0.14, 0.08, 0.08, mat(0xcc2222), 0, 0.52, 0));
    this.leverArm.rotation.x = 0.6;
    consoleM.add(leverBase, this.leverArm);
    const warn = textSprite('LAND / LAUNCH', '#ffcc00', 256, 48, 'bold 26px monospace');
    warn.position.set(0, 0.2, 0.51);
    warn.scale.setScalar(0.5);
    consoleM.add(warn);
    g.add(consoleM);

    // quota monitor
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 256;
    this.monitorCtx = cv.getContext('2d');
    this.monitorTex = new THREE.CanvasTexture(cv);
    this.monitorTex.colorSpace = THREE.SRGBColorSpace;
    const mon = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2), new THREE.MeshBasicMaterial({ map: this.monitorTex }));
    mon.position.set(1.4, 2.2, minZ + 0.02);
    g.add(mon);

    // cupboard + delivery shelf
    const cup = box(1.4, 2.2, 0.8, mat(0x6b4a2a), 3.3, 1.1 + floorY, -5.5);
    g.add(cup);
    // beds / seats along the wall
    g.add(box(0.9, 0.5, 2.2, mat(0x445566), 3.5, 0.25 + floorY, 1));
    g.add(box(0.9, 0.5, 2.2, mat(0x445566), -3.5, 0.25 + floorY, 1));

    this.ship = g;
    this.scene.add(g);
  }

  updateMonitor(state, shipScrap) {
    const c = this.monitorCtx;
    c.fillStyle = '#0a0503'; c.fillRect(0, 0, 512, 256);
    c.fillStyle = '#ff7a1a'; c.font = 'bold 40px monospace';
    c.fillText(`PROFIT QUOTA`, 24, 56);
    c.font = 'bold 48px monospace';
    c.fillText(`$${state.fulfilled} / $${state.quota}`, 24, 116);
    c.font = '30px monospace';
    c.fillText(`DEADLINE: ${state.daysLeft} DAY${state.daysLeft === 1 ? '' : 'S'}`, 24, 170);
    c.fillStyle = '#7dff6a';
    c.fillText(`SCRAP ON SHIP: $${shipScrap}`, 24, 220);
    this.monitorTex.needsUpdate = true;
  }

  // ------------------------------------------------------------------ space backdrop
  buildSpace() {
    const g = new THREE.Group();
    const n = 1500, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(450);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.5, sizeAttenuation: false, fog: false })));
    this.planet = new THREE.Mesh(new THREE.SphereGeometry(220, 32, 24), new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 1, fog: false }));
    this.planet.position.set(0, -300, -120);
    g.add(this.planet);
    this.space = g;
    this.scene.add(g);
  }

  // ------------------------------------------------------------------ per-moon build
  clearDynamic() {
    this.dynamic.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.scene.remove(this.dynamic);
    this.dynamic = new THREE.Group();
    this.scene.add(this.dynamic);
    this.lamps = [];
  }

  build(world) {
    this.clearDynamic();
    this.world = world;
    this.lamps = [];
    this.planet.material.color.setHex(MOONS[world.moonIndex].ground);
    if (!world.landed) return;
    this.buildOutdoor(world);
    if (world.interior) this.buildInterior(world);
  }

  buildOutdoor(world) {
    const T = textures();
    const moon = world.moon, O = world.out, R = O.radius + 10;
    const seg = 120;
    const geo = new THREE.PlaneGeometry(R * 2, R * 2, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const base = new THREE.Color(moon.ground), tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = O.height(x, z);
      pos.setY(i, h);
      const v = 0.85 + Math.random() * 0.25 + h * 0.01;
      tmp.copy(base).multiplyScalar(v);
      colors.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
    this.dynamic.add(ground);

    // map edge cliffs
    const cliff = new THREE.Mesh(new THREE.CylinderGeometry(O.radius + 4, O.radius + 12, 60, 48, 3, true),
      new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.6), side: THREE.BackSide, flatShading: true, roughness: 1 }));
    cliff.position.y = 20;
    const cp = cliff.geometry.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const s = 1 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.06;
      cp.setX(i, cp.getX(i) * s); cp.setZ(i, cp.getZ(i) * s);
    }
    cliff.geometry.computeVertexNormals();
    this.dynamic.add(cliff);

    // trees & rocks (instanced)
    const trees = O.circles.filter((c) => c.kind === 'tree');
    const rocks = O.circles.filter((c) => c.kind === 'rock');
    const dummy = new THREE.Object3D();
    if (trees.length) {
      const snowy = moon.id === 'blizzard';
      const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.3, 3, 5), mat(0x3a2a1a), trees.length);
      const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1.8, 6, 6), mat(snowy ? 0x9fb0a8 : 0x1f3a22), trees.length);
      trees.forEach((t, i) => {
        const h = O.height(t.x, t.z), s = 0.8 + t.s * 0.8;
        dummy.position.set(t.x, h + 1.5 * s, t.z); dummy.scale.setScalar(s); dummy.rotation.set(0, t.s * 6, 0); dummy.updateMatrix();
        trunk.setMatrixAt(i, dummy.matrix);
        dummy.position.y = h + 5.5 * s; dummy.updateMatrix();
        crown.setMatrixAt(i, dummy.matrix);
      });
      this.dynamic.add(trunk, crown);
    }
    if (rocks.length) {
      const rockM = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), mat(new THREE.Color(moon.ground).multiplyScalar(0.7).getHex()), rocks.length);
      rocks.forEach((r, i) => {
        dummy.position.set(r.x, O.height(r.x, r.z) + r.r * 0.3, r.z);
        dummy.scale.set(r.r, r.r * (0.6 + r.s * 0.6), r.r);
        dummy.rotation.set(r.s * 3, r.s * 7, r.s * 2);
        dummy.updateMatrix();
        rockM.setMatrixAt(i, dummy.matrix);
      });
      this.dynamic.add(rockM);
    }

    const concrete = new THREE.MeshStandardMaterial({ map: T.concrete.clone(), color: 0x9a968c, roughness: 1 });
    concrete.map.repeat.set(6, 3);
    concrete.map.needsUpdate = true;
    if (O.facility) {
      const f = O.facility;
      const bld = box(30, 14, 22, concrete, f.x, 7, f.z + 11);
      this.dynamic.add(bld);
      this.dynamic.add(box(34, 1, 26, mat(0x55524c), f.x, 14.2, f.z + 11));
      this.dynamic.add(box(3, 6, 2, mat(0x4a4a4a), f.x + 9, 17, f.z + 14));
      // main entrance
      const frame = box(3.4, 3.6, 0.3, mat(0x2a2a2a), f.x, 1.8, f.z - 0.1);
      frame.add(box(2.6, 3.0, 0.1, mat(0x5b3a22, { roughness: 0.6 }), 0, -0.2, -0.16));
      this.dynamic.add(frame);
      const sign = textSprite('MAIN ENTRANCE', '#ffaa33', 256, 40, 'bold 24px monospace');
      sign.position.set(f.x, 4.2, f.z - 0.26);
      sign.rotation.y = Math.PI;
      this.dynamic.add(sign);
      this.doorLight.position.set(f.x, 4.5, f.z - 1.5);
      this.dynamic.add(box(0.6, 0.15, 0.4, new THREE.MeshBasicMaterial({ color: 0xffe0a0 }), f.x, 4.7, f.z - 0.3));
      // fire exit
      const fe = box(0.3, 2.6, 1.6, mat(0x2a2a2a), f.fireDoor.x + 0.05, 1.3, f.fireDoor.z);
      fe.add(box(0.1, 2.2, 1.2, mat(0x6a2020), 0.16, -0.1, 0));
      this.dynamic.add(fe);
      const exitSign = textSprite('EXIT', '#33ff55', 128, 40, 'bold 28px monospace');
      exitSign.position.set(f.fireDoor.x + 0.26, 2.95, f.fireDoor.z);
      exitSign.rotation.y = Math.PI / 2;
      this.dynamic.add(exitSign);
      // walkway lights
      for (let i = 1; i < 6; i++) {
        const t = i / 6, x = f.x * t, z = SHIP.maxZ + (f.z - SHIP.maxZ) * t;
        this.dynamic.add(box(0.15, 0.8, 0.15, mat(0x333333), x + 3, O.height(x + 3, z) + 0.4, z));
        this.dynamic.add(box(0.2, 0.1, 0.2, new THREE.MeshBasicMaterial({ color: 0xffaa55 }), x + 3, O.height(x + 3, z) + 0.85, z));
      }
    }
    if (moon.company) {
      const bld = box(28, 16, 14.5, concrete, 0, 8, SELL_DESK.z + 8.75);
      this.dynamic.add(bld);
      const counter = box(SELL_DESK.halfW * 2, 1.1, SELL_DESK.halfD * 2, mat(0x5a4632), SELL_DESK.x, 0.55, SELL_DESK.z);
      this.dynamic.add(counter);
      this.dynamic.add(box(SELL_DESK.halfW * 2, 3, 0.2, mat(0x111111), SELL_DESK.x, 3.2, SELL_DESK.z + 1.4));
      const sign = textSprite('THE COMPANY - SELL SCRAP HERE', '#ff7a1a', 512, 48, 'bold 26px monospace');
      sign.position.set(0, 5.5, SELL_DESK.z + 1.2);
      sign.rotation.y = Math.PI;
      sign.scale.setScalar(1.5);
      this.dynamic.add(sign);
      this.doorLight.position.set(0, 4, SELL_DESK.z - 1);
    }
  }

  buildInterior(world) {
    const T = textures();
    const I = world.interior;
    const floors = [];
    const walls = [];
    for (let j = 0; j < I.H; j++) for (let i = 0; i < I.W; i++) {
      if (!I.isFloor(i, j)) continue;
      const c = I.cellCenter(i, j);
      floors.push(c);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!I.isFloor(i + di, j + dj)) walls.push({ x: c.x + di * CELL / 2, z: c.z + dj * CELL / 2, rot: di !== 0 ? Math.PI / 2 : 0 });
      }
    }
    const dummy = new THREE.Object3D();
    const floorMat = new THREE.MeshStandardMaterial({ map: T.concrete, color: 0x9a9890, roughness: 0.95 });
    const floorGeo = new THREE.PlaneGeometry(CELL, CELL);
    floorGeo.rotateX(-Math.PI / 2);
    const floorM = new THREE.InstancedMesh(floorGeo, floorMat, floors.length);
    const ceilGeo = floorGeo.clone();
    ceilGeo.rotateX(Math.PI);
    const ceilM = new THREE.InstancedMesh(ceilGeo, mat(0x3a3936), floors.length);
    floors.forEach((c, k) => {
      dummy.position.set(c.x, 0, c.z); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
      floorM.setMatrixAt(k, dummy.matrix);
      dummy.position.y = WALL_HEIGHT; dummy.updateMatrix();
      ceilM.setMatrixAt(k, dummy.matrix);
    });
    const wallMat = new THREE.MeshStandardMaterial({ map: T.wall, roughness: 0.9 });
    const wallM = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL, WALL_HEIGHT, 0.2), wallMat, walls.length);
    walls.forEach((w, k) => {
      dummy.position.set(w.x, WALL_HEIGHT / 2, w.z); dummy.rotation.set(0, w.rot, 0); dummy.updateMatrix();
      wallM.setMatrixAt(k, dummy.matrix);
    });
    this.dynamic.add(floorM, ceilM, wallM);

    // pipes along some corridors
    const pipeMat = mat(0x5a4a3a, { metalness: 0.6 });
    walls.forEach((w, k) => {
      if (k % 5) return;
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, CELL, 6), pipeMat);
      p.rotation.z = Math.PI / 2;
      p.rotation.y = w.rot;
      p.position.set(w.x, WALL_HEIGHT - 0.4, w.z);
      this.dynamic.add(p);
    });

    // props
    const crates = I.props.filter((p) => p.kind === 'crate'), barrels = I.props.filter((p) => p.kind === 'barrel');
    const crateM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), mat(0x6b5236), crates.length || 1);
    crates.forEach((p, k) => { dummy.position.set(p.x, 0.45, p.z); dummy.rotation.set(0, p.r, 0); dummy.updateMatrix(); crateM.setMatrixAt(k, dummy.matrix); });
    crateM.count = crates.length;
    const barrelM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.35, 1, 8), mat(0x2f4a5a, { metalness: 0.4 }), barrels.length || 1);
    barrels.forEach((p, k) => { dummy.position.set(p.x, 0.5, p.z); dummy.rotation.set(0, p.r, 0); dummy.updateMatrix(); barrelM.setMatrixAt(k, dummy.matrix); });
    barrelM.count = barrels.length;
    this.dynamic.add(crateM, barrelM);

    // lamps
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff2cc });
    for (const l of I.lamps) {
      const fixture = box(0.9, 0.08, 0.3, lampMat.clone(), l.x, WALL_HEIGHT - 0.05, l.z);
      this.dynamic.add(fixture);
      this.lamps.push({ ...l, y: WALL_HEIGHT - 0.4, mesh: fixture, phase: Math.random() * 100 });
    }

    // doors inside
    const md = I.mainDoor;
    const frame = box(2.8, 3.2, 0.3, mat(0x2a2a2a), md.x, 1.6, md.z + 0.1);
    frame.add(box(2.2, 2.8, 0.1, mat(0x5b3a22, { roughness: 0.6 }), 0, -0.2, 0.16));
    this.dynamic.add(frame);
    const s1 = textSprite('MAIN ENTRANCE', '#ffaa33', 256, 40, 'bold 24px monospace');
    s1.position.set(md.x, 3.5, md.z + 0.27);
    this.dynamic.add(s1);
    if (I.fireDoor) {
      const fd = I.fireDoor;
      const f = box(fd.di ? 0.3 : 1.6, 2.6, fd.di ? 1.6 : 0.3, mat(0x2a2a2a), fd.x, 1.3, fd.z);
      f.add(box(fd.di ? 0.1 : 1.2, 2.2, fd.di ? 1.2 : 0.1, mat(0x6a2020), -fd.di * 0.16, -0.1, -fd.dj * 0.16));
      this.dynamic.add(f);
      const s2 = textSprite('EXIT', '#33ff55', 128, 40, 'bold 28px monospace');
      s2.position.set(fd.x - fd.di * 0.2, 2.95, fd.z - fd.dj * 0.2);
      s2.rotation.y = Math.atan2(-fd.di, -fd.dj);
      this.dynamic.add(s2);
    }
  }

  // ------------------------------------------------------------------ per frame
  update(dt, time, { region, clock, phase, doorClosed, camPos, landed, leverAnim }) {
    const world = this.world;
    const moon = world ? MOONS[world.moonIndex] : MOONS[1];

    // ship door animation
    const target = doorClosed ? 0 : 1;
    this.doorOpen += (target - this.doorOpen) * Math.min(1, dt * 3);
    const off = this.doorOpen * SHIP.doorHalf;
    this.doorL.position.x = -SHIP.doorHalf / 2 - off;
    this.doorR.position.x = SHIP.doorHalf / 2 + off;
    this.leverArm.rotation.x = 0.6 - leverAnim * 1.2;
    this.termScreen.material.color.setHSL(0.37, 1, 0.35 + Math.sin(time * 3) * 0.03);

    const scene = this.scene;
    const inShipArea = Math.abs(camPos.x) < 6 && Math.abs(camPos.z) < 8;
    this.shipLight.intensity = region === 'out' && inShipArea ? 12 : region === 'out' ? 4 : 0;

    if (!landed) {
      // Orbit
      this.space.visible = true;
      scene.background = new THREE.Color(0x000000);
      scene.fog.color.setHex(0x000000);
      scene.fog.density = 0.0;
      this.hemi.intensity = 0.25;
      this.sun.intensity = 0.8;
      this.sun.position.set(-100, 50, -200);
      this.doorLight.intensity = 0;
      this.lampPool.forEach((l) => { l.intensity = 0; });
      this.space.rotation.y += dt * 0.004;
      this.planet.rotation.y += dt * 0.01;
      this.planet.position.y = phase === 'landing' ? -300 + 0 : -300;
      return;
    }
    this.space.visible = phase === 'landing' || phase === 'leaving';

    if (region === 'in') {
      scene.background = new THREE.Color(0x000000);
      scene.fog.color.setHex(0x000000);
      scene.fog.density = 0.075;
      this.hemi.intensity = 0.04;
      this.sun.intensity = 0;
      this.doorLight.intensity = 0;
      // Assign the pooled point lights to the lamps nearest the camera.
      const sorted = this.lamps
        .map((l) => ({ l, d: (l.x - camPos.x) ** 2 + (l.z - camPos.z) ** 2 }))
        .sort((a, b) => a.d - b.d);
      this.lampPool.forEach((light, k) => {
        const e = sorted[k];
        if (!e || e.d > 40 * 40) { light.intensity = 0; return; }
        let inten = 9;
        if (e.l.flicker) {
          const f = Math.sin(time * 13 + e.l.phase) + Math.sin(time * 7.3 + e.l.phase * 2);
          inten = f > 1.2 ? 1 : 9;
          e.l.mesh.material.color.setScalar(inten > 2 ? 1 : 0.2);
        }
        light.position.set(e.l.x, e.l.y, e.l.z);
        light.intensity = inten;
      });
      return;
    }

    // Outdoors: day/night cycle.
    this.lampPool.forEach((l) => { l.intensity = 0; });
    const hours = clock / 60;
    const day = moon.company ? 0.7 : 1 - Math.min(1, Math.max(0, (hours - 15) / 5));
    const sky = new THREE.Color(moon.sky).lerp(new THREE.Color(0x05070d), 1 - day);
    const fogC = new THREE.Color(moon.fog).lerp(new THREE.Color(0x020306), 1 - day);
    scene.background = sky;
    scene.fog.color.copy(fogC);
    scene.fog.density = moon.fogDensity * (1 + (1 - day) * 0.6);
    this.hemi.color.setHex(0xffffff);
    this.hemi.groundColor.setHex(moon.ground);
    this.hemi.intensity = 0.3 + day * 0.75;
    if (day < 0.5) this.hemi.color.lerp(new THREE.Color(0x6f86c9), 1 - day * 2); // moonlight
    const sunAng = ((hours - 6) / 14) * Math.PI;
    this.sun.position.set(Math.cos(sunAng) * 100, Math.max(10, Math.sin(sunAng) * 120), 40);
    this.sun.color.setHSL(0.08, 0.6, 0.5 + day * 0.4);
    this.sun.intensity = day * 1.6;
    this.doorLight.intensity = 6 + (1 - day) * 10;
  }
}

export { formatClock };
