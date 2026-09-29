import * as THREE from 'three';
import {
  SHIP, SELL_DESK, MOONS, STORE, SCRAP, MONSTER_TYPES, INVENTORY_SLOTS, PLAYER_RADIUS, EYE_HEIGHT,
  CROUCH_EYE_HEIGHT, MAX_HP, SELL_RATE, formatClock,
} from '/shared/config.js';
import { buildWorld, collide, groundHeight, inShip, lineOfSight } from '/shared/world.js';
import { Net } from './net.js';
import { Voice } from './voice.js';
import { Sfx } from './sfx.js';
import { WorldView } from './scene.js';
import { makePlayerModel, animatePlayer, makeMonster, animateMonster, makeItemMesh, viewModelOffset } from './models.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerpAngle = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const SETTINGS_KEY = 'lethalquota.settings';
const settings = Object.assign(
  { name: '', vol: 0.8, voiceVol: 1, sens: 1, scale: 0.5, fov: 72, ptt: false, mute: false, mic: '' },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })(),
);
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };

class Game {
  constructor() {
    // ---------------------------------------------------------------- rendering
    this.canvas = $('view');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000000, 0.02);
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 400);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.view = new WorldView(this.scene);
    this.viewModel = new THREE.Group();
    this.camera.add(this.viewModel);

    this.flashlight = new THREE.SpotLight(0xfff4dd, 0, 25, 0.45, 0.5, 1.4);
    // Beam starts past the held flashlight model so it doesn't light up the view-model itself.
    this.flashlight.position.set(0.2, -0.15, -0.9);
    this.flashlight.target.position.set(0.05, -0.4, -7);
    this.camera.add(this.flashlight, this.flashlight.target);
    this.spotPool = Array.from({ length: 5 }, () => {
      const s = new THREE.SpotLight(0xfff4dd, 0, 25, 0.45, 0.5, 1.4);
      this.scene.add(s, s.target);
      return s;
    });
    this.resize();
    addEventListener('resize', () => this.resize());

    // ---------------------------------------------------------------- state
    this.net = new Net();
    this.id = null;
    this.state = null;
    this.world = buildWorld(1, 1, false);
    this.view.build(this.world);
    this.worldKey = '';
    this.players = new Map();   // remote + local server data
    this.monsters = new Map();
    this.items = new Map();
    this.corpses = [];
    this.me = { x: 0, y: SHIP.floorY, z: 0, vy: 0, yaw: Math.PI, pitch: 0, region: 'out', grounded: true, crouch: false,
      stamina: 1, exhausted: false, seq: 0, alive: true, hp: MAX_HP, inv: [null, null, null, null], slot: 0, moveSpeed: 0 };
    this.keys = new Set();
    this.locked = false;
    this.ui = { terminal: false, chat: false, pause: false, report: false };
    this.time = 0;
    this.sendTimer = 0;
    this.stepDist = 0;
    this.leverAnim = 0;
    this.swingAnim = 0;
    this.shake = 0;
    this.noise = 0;
    this.walkieTx = false;
    this.useHeld = false;
    this.scanTags = [];
    this.scanCd = 0;
    this.spectate = null;
    this.clockDisplay = 480;
    this.interactTarget = null;
    this.teleporting = false;
    this.nametagLayer = $('scan-layer');

    this.bindMenu();
    this.bindInput();
    this.bindNet();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  resize() {
    const s = settings.scale;
    this.renderer.setPixelRatio(s * Math.min(2, devicePixelRatio || 1));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.fov = settings.fov;
    this.camera.updateProjectionMatrix();
  }

  // ================================================================ MENU / SETTINGS
  bindMenu() {
    $('name').value = settings.name;
    const hashCode = location.hash.replace('#', '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
    if (hashCode) $('code').value = hashCode;
    $('host').onclick = () => this.start('', true);
    $('join').onclick = () => {
      const code = $('code').value.trim().toUpperCase();
      if (code.length !== 5) { $('menu-error').textContent = 'Enter a 5 letter crew code.'; return; }
      this.start(code, !!hashCode && code === hashCode);
    };
    $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });

    const bindRange = (id, key, fn) => {
      const el = $(id);
      el.value = settings[key];
      el.oninput = () => { settings[key] = Number(el.value); saveSettings(); fn?.(); };
    };
    bindRange('opt-vol', 'vol', () => this.master && (this.master.gain.value = settings.vol));
    bindRange('opt-voicevol', 'voiceVol', () => this.voice?.setVolume(settings.voiceVol));
    bindRange('opt-sens', 'sens');
    bindRange('opt-scale', 'scale', () => this.resize());
    bindRange('opt-fov', 'fov', () => this.resize());
    $('opt-ptt').checked = settings.ptt;
    $('opt-ptt').onchange = (e) => { settings.ptt = e.target.checked; saveSettings(); this.voice?.setPTT(settings.ptt); };
    $('opt-mute').checked = settings.mute;
    $('opt-mute').onchange = (e) => { this.setMute(e.target.checked); };
    $('opt-mic').onchange = async (e) => {
      settings.mic = e.target.value; saveSettings();
      await this.voice?.startMic(settings.mic || null);
      this.refreshVoiceStatus();
    };
    $('resume').onclick = () => this.lock();
    $('leave').onclick = () => { location.hash = ''; location.reload(); };
    $('copy-link').onclick = () => {
      const url = `${location.origin}${location.pathname}#${this.roomCode}`;
      navigator.clipboard?.writeText(url).then(() => this.toast('Invite link copied'), () => prompt('Invite link:', url));
    };
    $('report').onclick = () => this.hideReport();
  }

  setMute(v) {
    settings.mute = v; saveSettings();
    $('opt-mute').checked = v;
    this.voice?.setMuted(v);
  }

  async refreshVoiceStatus() {
    $('voice-status').textContent = this.voice ? this.voice.status + ' — use headphones to avoid echo.' : '';
    const mics = await (this.voice?.listMics() || []);
    const sel = $('opt-mic');
    sel.innerHTML = '<option value="">Default microphone</option>' + mics.map((m) => `<option value="${esc(m.deviceId)}">${esc(m.label || 'Microphone')}</option>`).join('');
    sel.value = settings.mic && mics.some((m) => m.deviceId === settings.mic) ? settings.mic : '';
  }

  async start(code, create) {
    const name = $('name').value.trim() || `Employee${Math.floor(Math.random() * 90 + 10)}`;
    settings.name = $('name').value.trim();
    saveSettings();
    $('menu-error').textContent = '';
    $('host').disabled = $('join').disabled = true;
    try {
      if (!this.audio) {
        // Audio must be created inside a user gesture.
        this.audio = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.audio.createGain();
        this.master.gain.value = settings.vol;
        this.master.connect(this.audio.destination);
        this.sfx = new Sfx(this.audio, this.master);
        this.voice = new Voice(this.net, this.audio, this.master);
        this.voice.setVolume(settings.voiceVol);
        this.voice.setPTT(settings.ptt);
        this.voice.setMuted(settings.mute);
        await this.voice.loadConfig();
        await this.voice.startMic(settings.mic || null);
      }
      if (this.net.ws?.readyState !== 1) await this.net.connect();
    } catch (e) {
      $('menu-error').textContent = e.message;
      $('host').disabled = $('join').disabled = false;
      return;
    }
    this.net.send({ t: 'join', name, room: code, create });
    this.refreshVoiceStatus();
  }

  lock() {
    if (this.ui.terminal || this.ui.report) return;
    this.canvas.requestPointerLock?.()?.catch?.(() => {});
    this.audio?.resume();
  }

  // ================================================================ INPUT
  bindInput() {
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      const inGame = this.id != null;
      $('pause').classList.toggle('hidden', this.locked || !inGame || this.ui.terminal || this.ui.chat || this.ui.report);
      $('click-to-play').classList.add('hidden');
      if (!this.locked) { this.keys.clear(); this.onUseUp(); }
    });
    this.canvas.addEventListener('click', () => {
      if (this.id == null) return;
      if (!this.locked) return this.lock();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const s = 0.0022 * settings.sens;
      this.me.yaw -= e.movementX * s;
      this.me.pitch = clamp(this.me.pitch - e.movementY * s, -1.5, 1.5);
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (!this.me.alive) { if (e.button === 0) this.cycleSpectate(); return; }
      if (e.button === 0) this.onUseDown();
      if (e.button === 2) this.scan();
    });
    document.addEventListener('mouseup', (e) => { if (e.button === 0) this.onUseUp(); });
    document.addEventListener('contextmenu', (e) => { if (this.id != null) e.preventDefault(); });
    document.addEventListener('wheel', (e) => {
      if (!this.locked || !this.me.alive) return;
      this.selectSlot((this.me.slot + (e.deltaY > 0 ? 1 : -1) + INVENTORY_SLOTS) % INVENTORY_SLOTS);
    }, { passive: true });

    document.addEventListener('keydown', (e) => {
      if (this.id == null) return;
      if (this.ui.chat) {
        if (e.key === 'Enter') {
          const text = $('chat-input').value.trim();
          if (text) this.net.send({ t: 'chat', text });
          this.closeChat();
        } else if (e.key === 'Escape') this.closeChat();
        return;
      }
      if (this.ui.terminal) {
        if (e.key === 'Escape') { e.preventDefault(); this.closeTerminal(); }
        return;
      }
      if (e.code === 'Tab') { e.preventDefault(); $('crew').classList.remove('hidden'); this.renderCrew(); }
      if (e.code === 'KeyV') this.voice?.setPTTDown(true);
      if (!this.locked) return;
      if (e.repeat) return;
      this.keys.add(e.code);
      switch (e.code) {
        case 'KeyE': this.interact(); break;
        case 'KeyG': this.dropHeld(); break;
        case 'KeyC': case 'ControlLeft': this.me.crouch = !this.me.crouch; break;
        case 'KeyM': this.setMute(!settings.mute); this.toast(settings.mute ? 'Microphone muted' : 'Microphone on'); break;
        case 'KeyT': case 'Enter': e.preventDefault(); this.openChat(); break;
        case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': this.selectSlot(Number(e.code.slice(5)) - 1); break;
        case 'Space': this.jump(); break;
      }
    });
    document.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyV') this.voice?.setPTTDown(false);
      if (e.code === 'Tab') $('crew').classList.add('hidden');
    });
    addEventListener('blur', () => { this.keys.clear(); this.voice?.setPTTDown(false); });

    const termIn = $('term-in');
    termIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const cmd = termIn.value.trim();
        termIn.value = '';
        this.termPrint(`\n> ${cmd.toUpperCase()}\n`);
        this.net.send({ t: 'terminal', cmd });
      } else this.sfx?.play('type');
    });
  }

  openChat() {
    this.ui.chat = true;
    this.keys.clear();
    $('chat').classList.add('open');
    const inp = $('chat-input');
    inp.classList.remove('hidden');
    inp.placeholder = this.me.alive ? 'Say something... (Enter to send)' : 'Dead chat (only the dead can see)...';
    setTimeout(() => inp.focus(), 0);
  }

  closeChat() {
    this.ui.chat = false;
    const inp = $('chat-input');
    inp.value = '';
    inp.blur();
    inp.classList.add('hidden');
    $('chat').classList.remove('open');
    if (!this.locked) this.lock();
  }

  openTerminal() {
    this.ui.terminal = true;
    this.keys.clear();
    document.exitPointerLock?.();
    $('terminal').classList.remove('hidden');
    $('term-out').textContent = '';
    this.termPrint('COMPANY OS v4.2\n\nWelcome, employee. Type HELP for a list of commands.\n');
    this.net.send({ t: 'terminal', cmd: 'quota' });
    setTimeout(() => $('term-in').focus(), 0);
  }

  closeTerminal() {
    this.ui.terminal = false;
    $('terminal').classList.add('hidden');
    $('term-in').blur();
    this.lock();
  }

  termPrint(text) {
    const out = $('term-out');
    out.textContent += text;
    out.scrollTop = out.scrollHeight;
  }

  // ================================================================ NETWORK
  bindNet() {
    const n = this.net;
    n.on('error', (m) => {
      $('menu-error').textContent = m.text;
      $('host').disabled = $('join').disabled = false;
    });
    n.on('close', () => {
      if (this.id == null) return;
      this.toast('Disconnected from server', true);
      setTimeout(() => location.reload(), 3000);
    });
    n.on('welcome', (m) => {
      this.id = m.id;
      this.roomCode = m.room;
      location.hash = m.room;
      $('pause-code').textContent = m.room;
      $('menu').classList.add('hidden');
      $('hud').classList.remove('hidden');
      $('click-to-play').classList.remove('hidden');
      for (const r of m.roster) this.addPlayer(r);
      this.applyState(m.state);
      this.resetItems(m.items);
      this.teleport(m.spawn.x, m.spawn.z, m.spawn.yaw, 'out');
      this.me.seq = m.spawn.seq;
      for (const r of m.roster) if (r.id !== this.id) this.voice.connectTo(r.id).catch((e) => console.warn(e));
      this.chat(null, `Joined crew ${m.room}. Share the code or invite link (Esc menu) with friends.`);
      this.lock();
    });
    n.on('peerJoin', (m) => { this.addPlayer(m); this.sfx.play('click'); });
    n.on('peerLeave', (m) => this.removePlayer(m.id));
    n.on('state', (m) => this.applyState(m.state));
    n.on('itemsReset', (m) => this.resetItems(m.items));
    n.on('snap', (m) => this.onSnap(m));
    n.on('ev', (m) => this.onEvent(m));
    n.on('chat', (m) => this.chat(m.from, m.text, m.color, m.dead));
    n.on('term', (m) => { if (this.ui.terminal) this.termPrint(m.text + '\n'); });
    n.on('toast', (m) => this.toast(m.text));
    n.on('slot', (m) => { this.me.slot = m.i; });
    n.on('respawn', (m) => {
      this.me.seq = m.seq;
      this.me.alive = true;
      this.me.hp = MAX_HP;
      this.teleport(m.x, m.z, m.yaw, 'out');
      $('dead-overlay').classList.add('hidden');
      this.spectate = null;
    });
  }

  addPlayer(r) {
    if (this.players.has(r.id)) return;
    const p = { id: r.id, name: r.name, color: r.color, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, region: 'out', alive: true,
      hp: MAX_HP, inv: [null, null, null, null], slot: 0, walkieTx: false, moving: false, target: null, stepDist: 0 };
    if (r.id !== this.id) {
      p.model = makePlayerModel(r.color);
      this.scene.add(p.model);
      p.tag = document.createElement('div');
      p.tag.className = 'nametag';
      this.nametagLayer.appendChild(p.tag);
    }
    this.players.set(r.id, p);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.model) this.scene.remove(p.model);
    p.tag?.remove();
    this.players.delete(id);
    this.voice.removePeer(id);
    if (this.spectate === id) this.spectate = null;
  }

  applyState(s) {
    this.state = s;
    const key = `${s.landed}|${s.moon}|${s.seed}`;
    if (key !== this.worldKey) {
      this.worldKey = key;
      this.world = buildWorld(s.moon, s.seed, s.landed);
      this.view.build(this.world);
      if (!s.landed && this.me.region === 'in') this.me.region = 'out';
    }
    this.monitorDirty = true;
  }

  resetItems(list) {
    for (const it of this.items.values()) it.mesh.removeFromParent();
    this.items.clear();
    for (const d of list) this.upsertItem(d);
    this.monitorDirty = true;
  }

  upsertItem(d) {
    let it = this.items.get(d.id);
    if (!it) {
      it = { mesh: makeItemMesh(d) };
      this.scene.add(it.mesh);
      this.items.set(d.id, it);
    }
    const wasOn = it.data?.on;
    it.data = d;
    if (it.mesh.userData.lens) it.mesh.userData.lens.material.color.setHex(d.on ? 0xfff6d0 : 0x333333);
    if (it.mesh.userData.led) it.mesh.userData.led.material.color.setHex(d.on ? 0x22ff44 : 0x331111);
    if (wasOn !== undefined && wasOn && !d.on && d.charge === 0 && d.heldBy === this.id) this.toast(`${d.name} battery dead`);
  }

  onSnap(m) {
    this.clockDisplay = m.clock;
    if (this.state) { this.state.clock = m.clock; this.state.phase = m.ph; }
    if (m.items) { for (const d of m.items) this.upsertItem(d); this.monitorDirty = true; }
    if (m.gone) {
      for (const id of m.gone) { const it = this.items.get(id); if (it) { it.mesh.removeFromParent(); this.items.delete(id); } }
      this.monitorDirty = true;
    }
    for (const s of m.p) {
      const p = this.players.get(s.id);
      if (!p) continue;
      p.alive = !!s.a; p.hp = s.hp; p.inv = s.inv; p.walkieTx = !!s.wt;
      if (s.id === this.id) {
        const me = this.me;
        if (me.alive && !s.a) this.onLocalDeath();
        me.alive = !!s.a;
        me.hp = s.hp;
        me.inv = s.inv;
        continue;
      }
      p.slot = s.sl; p.crouch = !!s.cr; p.moving = !!s.mv; p.sprint = !!s.sp;
      if (p.region !== s.r) { p.x = s.x; p.y = s.y; p.z = s.z; } // teleported: snap
      p.region = s.r;
      p.target = { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch };
      if (p.x === 0 && p.z === 0) Object.assign(p, p.target);
    }
    const seen = new Set();
    for (const s of m.m) {
      seen.add(s.id);
      let mo = this.monsters.get(s.id);
      if (!mo) {
        mo = { id: s.id, type: s.t, model: makeMonster(s.t), x: s.x, z: s.z, yaw: s.yaw, sndT: 0 };
        this.scene.add(mo.model);
        this.monsters.set(s.id, mo);
      }
      mo.target = s;
      mo.state = s.s; mo.region = s.r; mo.speed = s.v; mo.stunned = !!s.st;
    }
    for (const [id, mo] of this.monsters) if (!seen.has(id)) { this.scene.remove(mo.model); this.monsters.delete(id); }
  }

  posOf(id) {
    if (id === this.id) return { x: this.me.x, y: this.me.y + 1, z: this.me.z };
    const p = this.players.get(id);
    return p ? { x: p.x, y: p.y + 1, z: p.z } : null;
  }

  monsterPos(id) {
    const mo = this.monsters.get(id);
    if (!mo) return null;
    return { x: mo.x, y: groundHeight(this.world, mo.region, mo.x, mo.z) + 1, z: mo.z };
  }

  listenerRegion() {
    if (this.me.alive) return this.me.region;
    const t = this.players.get(this.spectate);
    return t ? t.region : this.me.region;
  }

  onEvent(m) {
    const sfx = this.sfx;
    const mine = m.id === this.id;
    const region = this.listenerRegion();
    const mpos = (id) => { const mo = this.monsters.get(id); return mo && mo.region === region ? this.monsterPos(id) : null; };
    switch (m.k) {
      case 'hurt':
        if (mine) {
          sfx.play('hurt');
          $('hurt-flash').style.transition = 'none';
          $('hurt-flash').style.opacity = String(clamp(m.amt / 60, 0.4, 1));
          requestAnimationFrame(() => { $('hurt-flash').style.transition = 'opacity 0.8s'; $('hurt-flash').style.opacity = '0'; });
          this.shake = 0.4;
        } else sfx.play('hurt', this.posOf(m.id), 0.6);
        break;
      case 'die': {
        const p = this.players.get(m.id);
        sfx.play('death', mine ? null : { x: m.x, y: m.y + 1, z: m.z });
        this.addCorpse(m, p?.color ?? 0xff7a1a);
        if (mine) $('dead-cause').textContent = `You ${m.cause.replace(/^was /, 'were ').replace(/\btheir\b/g, 'your')}.`;
        else if (p) this.chat(null, `${p.name} ${m.cause}.`);
        break;
      }
      case 'lever': this.leverAnim = 1; sfx.play('lever', SHIP.lever); break;
      case 'landing': sfx.play('horn'); this.shake = 4; this.toast(`Landing on ${MOONS[m.moon].name}...`); break;
      case 'landed': this.shake = 0.6; sfx.play('land'); break;
      case 'leaving': {
        const msg = { lever: 'The ship is taking off!', midnight: 'It is midnight. The autopilot is leaving!', alldead: 'All crew members are dead. The autopilot is returning the ship.' }[m.reason];
        this.toast(msg, true);
        sfx.play('alarm');
        this.leavingShake = true;
        break;
      }
      case 'shipdoor': sfx.play('door', { x: 0, y: 1.2, z: SHIP.maxZ }); break;
      case 'sell': sfx.play('sell'); this.toast(`+$${m.amount} — ${this.players.get(m.id)?.name ?? '?'} sold ${m.name}`); break;
      case 'buy': sfx.play('buy'); this.chat(null, `${m.by} ordered ${m.qty}x ${m.name}.`); break;
      case 'route': this.chat(null, `${m.by} routed the ship to ${MOONS[m.moon].name}.`); break;
      case 'signal': {
        const el = $('signal');
        el.textContent = '';
        el.classList.remove('hidden');
        [...m.text].forEach((ch, i) => setTimeout(() => { el.textContent += ch; sfx.play('pin'); }, i * 120));
        clearTimeout(this.signalT);
        this.signalT = setTimeout(() => el.classList.add('hidden'), 5000 + m.text.length * 120);
        break;
      }
      case 'warnLate': this.toast("It's getting late. Head back to the ship!", true); break;
      case 'dayReport': this.showReport(m); break;
      case 'swing':
        if (mine) this.swingAnim = 1;
        sfx.play('swing', mine ? null : this.posOf(m.id));
        break;
      case 'pickup': sfx.play('pickup', mine ? null : this.posOf(m.id), 0.7); break;
      case 'drop': sfx.play('drop', mine ? null : this.posOf(m.id), 0.7); break;
      case 'mhit': sfx.play('hit', mpos(m.id)); break;
      case 'mdie': sfx.play('death', mpos(m.id), 0.7); break;
      case 'mattack': { const p = mpos(m.id); if (p) sfx.play(this.monsters.get(m.id)?.type === 'crawler' ? 'thud' : 'hit', p); break; }
      case 'mboing': { const p = mpos(m.id); if (p) sfx.play('boing', p); break; }
      case 'mchirp': { const p = mpos(m.id); if (p) sfx.play('yippee', p); break; }
      case 'mroar': {
        const p = mpos(m.id);
        if (p) sfx.play(this.monsters.get(m.id)?.type === 'dog' ? 'roar' : 'growl', p);
        break;
      }
      case 'mspotted': { const p = mpos(m.id); if (p) sfx.play('rustle', p, 1.5); break; }
      case 'grenade': this.spawnGrenade(m); break;
      case 'flash': {
        const p = { x: m.x, y: groundHeight(this.world, m.region, m.x, m.z) + 0.3, z: m.z };
        if (m.region === region) sfx.play('bang', p);
        const me = this.me;
        const d = Math.hypot(me.x - m.x, me.z - m.z);
        if (me.alive && me.region === m.region && d < 9 && lineOfSight(this.world, m.region, me.x, me.z, m.x, m.z)) {
          const fb = $('flashbang');
          fb.style.transition = 'none';
          fb.style.opacity = String(clamp(1.2 - d / 9, 0.3, 1));
          requestAnimationFrame(() => { fb.style.transition = 'opacity 4s'; fb.style.opacity = '0'; });
          sfx.play('tinnitus');
        }
        break;
      }
    }
  }

  addCorpse(m, color) {
    const body = makePlayerModel(color);
    body.traverse((o) => { if (o.material) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.6); } });
    body.rotation.set(-Math.PI / 2, m.yaw || 0, 0, 'YXZ');
    const y = groundHeight(this.world, m.region, m.x, m.z) + 0.3;
    body.position.set(m.x, y, m.z);
    this.scene.add(body);
    this.corpses.push(body);
  }

  onLocalDeath() {
    this.me.alive = false;
    this.walkieTx = false;
    this.useHeld = false;
    $('dead-overlay').classList.remove('hidden');
    if (this.ui.terminal) this.closeTerminal();
    this.spectate = null;
    this.cycleSpectate();
  }

  cycleSpectate() {
    const alive = [...this.players.values()].filter((p) => p.id !== this.id && p.alive);
    if (!alive.length) { this.spectate = null; $('spectating').textContent = 'No living crew to spectate.'; return; }
    const i = alive.findIndex((p) => p.id === this.spectate);
    const next = alive[(i + 1) % alive.length];
    this.spectate = next.id;
    $('spectating').textContent = `Spectating: ${next.name}`;
  }

  spawnGrenade(m) {
    const from = this.posOf(m.from) || { x: m.x, y: 1, z: m.z };
    const mesh = makeItemMesh({ type: 'stungrenade' });
    this.scene.add(mesh);
    const to = { x: m.x, y: groundHeight(this.world, m.region, m.x, m.z) + 0.05, z: m.z };
    const start = this.time, dur = 0.7;
    from.y += 0.6;
    this.grenades = this.grenades || [];
    this.grenades.push({ mesh, from, to, start, dur, until: start + 1.4 });
  }

  // ================================================================ REPORT / HUD HELPERS
  showReport(r) {
    for (const c of this.corpses) this.scene.remove(c);
    this.corpses = [];
    this.leavingShake = false;
    const lines = [];
    lines.push(`<h2>DAY REPORT &mdash; ${esc(r.moon)}</h2>`);
    if (r.deaths.length) {
      lines.push('<div class="line"><b>Casualties</b><span></span></div>');
      for (const d of r.deaths) lines.push(`<div class="line bad"><span>${esc(d.name)}</span><span>${esc(d.cause)}</span></div>`);
    } else lines.push('<div class="line good"><span>All crew survived</span><span></span></div>');
    if (r.allDead) lines.push('<div class="big bad">ALL EMPLOYEES DEAD<br><small>The autopilot recovered the ship. All scrap was lost.</small></div>');
    lines.push(`<div class="line"><span>Scrap on ship</span><span>$${r.shipValue}</span></div>`);
    const ev = r.evaluation;
    if (ev?.fired) {
      lines.push(`<div class="big bad">YOU'RE FIRED</div><p>The crew sold $${ev.fulfilled} of a $${ev.quota} quota. The Company has terminated your contracts. Starting over from quota #1.</p>`);
      this.sfx.play('fired');
    } else if (ev?.met) {
      lines.push(`<div class="big good">QUOTA MET</div><div class="line"><span>Overtime bonus</span><span>+$${ev.overtime}</span></div><div class="line"><span>New quota</span><span>$${ev.newQuota}</span></div>`);
      this.sfx.play('quotaMet');
    } else {
      lines.push(`<div class="line"><span>Profit quota</span><span>$${r.fulfilled} / $${r.quota}</span></div>`);
      lines.push(`<div class="line"><span>Days until deadline</span><span>${r.daysLeft}</span></div>`);
      if (r.daysLeft === 0) lines.push('<p class="bad">DEADLINE REACHED. The autopilot is routed to the Company. Land and sell your scrap!</p>');
    }
    lines.push('<p class="muted">Click to continue</p>');
    $('report-body').innerHTML = lines.join('');
    $('report').classList.remove('hidden');
    this.ui.report = true;
    document.exitPointerLock?.();
    clearTimeout(this.reportT);
    this.reportT = setTimeout(() => this.hideReport(), 12000);
  }

  hideReport() {
    if (!this.ui.report) return;
    this.ui.report = false;
    $('report').classList.add('hidden');
    this.lock();
  }

  toast(text, big = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (big ? ' big' : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  chat(from, text, color, dead) {
    const el = document.createElement('div');
    if (from == null) { el.className = 'sys'; el.textContent = text; }
    else {
      if (dead) el.className = 'dead';
      el.innerHTML = `<b style="color:${hex(color ?? 0xff7a1a)}">${esc(from)}${dead ? ' (dead)' : ''}:</b> ${esc(text)}`;
    }
    const log = $('chat-log');
    log.appendChild(el);
    while (log.children.length > 40) log.firstChild.remove();
  }

  renderCrew() {
    const rows = [...this.players.values()].map((p) => {
      const talking = p.id === this.id ? this.voice.micLevel() > 0.06 : this.voice.speaking(p.id);
      const peer = this.voice.peers.get(p.id);
      const conn = p.id === this.id ? (this.voice.localTrack ? (settings.mute ? 'muted' : settings.ptt ? 'push-to-talk' : 'open mic') : 'no mic')
        : peer?.state === 'connected' ? 'voice ok' : `voice ${peer?.state || 'connecting'}`;
      return `<div class="member ${talking ? 'talking' : ''}"><span class="name"><span class="swatch" style="background:${hex(p.color)}"></span>${esc(p.name)}${p.id === this.id ? ' (you)' : ''}</span>
        <span class="${p.alive ? '' : 'dead'}">${p.alive ? 'ALIVE' : 'DECEASED'}</span><span class="muted">${conn}</span></div>`;
    });
    $('crew').innerHTML = `<h2>CREW ${esc(this.roomCode || '')}</h2>${rows.join('')}<p class="muted">Ping ${Math.round(this.net.rtt)} ms</p>`;
  }

  // ================================================================ ITEMS & ACTIONS
  heldItem() {
    const id = this.me.inv[this.me.slot];
    return id != null ? this.items.get(id)?.data : null;
  }

  carriedWeight() {
    let w = 0;
    for (const id of this.me.inv) if (id != null) w += this.items.get(id)?.data.weight || 0;
    return w;
  }

  holdingTwoHanded() {
    return this.me.inv.some((id) => id != null && this.items.get(id)?.data.twoHanded);
  }

  selectSlot(i) {
    if (i === this.me.slot) return;
    if (this.holdingTwoHanded()) { this.toast('Hands full — drop the heavy item first [G]'); return; }
    this.onUseUp();
    this.me.slot = i;
    this.net.send({ t: 'slot', i });
    this.sfx.play('click');
  }

  dropHeld() {
    const it = this.heldItem();
    if (!it || !this.me.alive) return;
    this.onUseUp();
    const me = this.me;
    const p = { x: me.x - Math.sin(me.yaw) * 0.6, z: me.z - Math.cos(me.yaw) * 0.6 };
    collide(this.world, me.region, p, 0.2, this.state?.doorClosed);
    this.net.send({ t: 'drop', x: p.x, z: p.z });
  }

  onUseDown() {
    const it = this.heldItem();
    if (!it) return;
    this.useHeld = true;
    if (it.type === 'flashlight' || it.type === 'proflashlight') {
      if (it.charge <= 0) { this.toast('Battery dead'); return; }
      it.on = !it.on;
      this.upsertItem(it);
      this.sfx.play('flashOn');
      this.net.send({ t: 'use', on: it.on });
    } else if (it.type === 'walkie') {
      if (!it.on) {
        if (it.charge <= 0) { this.toast('Battery dead'); return; }
        it.on = true;
        this.upsertItem(it);
        this.net.send({ t: 'use', on: true });
        this.sfx.play('radioOn');
        this.toast('Walkie-talkie on. Hold LMB to transmit, double-click to turn off.');
        return;
      }
      this.walkieTx = true;
      this.sfx.play('radioOn');
      // double click turns it off
      if (this.time - (this.lastWalkieClick || 0) < 0.3) {
        it.on = false;
        this.walkieTx = false;
        this.upsertItem(it);
        this.net.send({ t: 'use', on: false });
        this.sfx.play('radioOff');
      }
      this.lastWalkieClick = this.time;
    } else if (it.type === 'shovel') {
      if (this.time - (this.lastSwing || 0) < 0.75) return;
      this.lastSwing = this.time;
      this.net.send({ t: 'swing' });
    } else if (it.type === 'stungrenade') {
      const me = this.me;
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const dist = clamp(8 + dir.y * 6, 2, 12);
      let x = me.x, z = me.z;
      const h = Math.hypot(dir.x, dir.z) || 1;
      for (let d = 0; d < dist; d += 0.25) {
        const nx = me.x + (dir.x / h) * d, nz = me.z + (dir.z / h) * d;
        const p = collide(this.world, me.region, { x: nx, z: nz }, 0.15, this.state?.doorClosed);
        if (Math.hypot(p.x - nx, p.z - nz) > 0.01) break;
        x = nx; z = nz;
      }
      this.net.send({ t: 'throw', x, z });
    }
  }

  onUseUp() {
    this.useHeld = false;
    if (this.walkieTx) { this.walkieTx = false; this.sfx?.play('radioOff'); }
  }

  scan() {
    if (this.scanCd > 0) return;
    this.scanCd = 1.5;
    this.sfx.play('scan');
    const me = this.me;
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const add = (pos, text, cls) => {
      const v = pos.clone().project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return;
      const el = document.createElement('div');
      el.className = 'scan-tag ' + cls;
      el.innerHTML = text;
      $('scan-layer').appendChild(el);
      this.scanTags.push({ el, pos, until: this.time + 4 });
    };
    let total = 0;
    for (const it of this.items.values()) {
      const d = it.data;
      if (d.heldBy != null || d.region !== me.region) continue;
      const pos = new THREE.Vector3(d.x, groundHeight(this.world, d.region, d.x, d.z) + 0.3, d.z);
      if (pos.distanceTo(eye) > 28 || !lineOfSight(this.world, me.region, me.x, me.z, d.x, d.z)) continue;
      if (d.scrap) { add(pos, `${esc(d.name)}<br>Value: $${d.value}`, ''); total += d.value; }
      else add(pos, esc(d.name), 'tool');
    }
    for (const mo of this.monsters.values()) {
      if (mo.region !== me.region) continue;
      const pos = new THREE.Vector3(mo.x, groundHeight(this.world, mo.region, mo.x, mo.z) + 1.5, mo.z);
      if (pos.distanceTo(eye) > 25 || !lineOfSight(this.world, me.region, me.x, me.z, mo.x, mo.z)) continue;
      add(pos, esc(MONSTER_TYPES[mo.type].name), 'enemy');
    }
    if (total > 0) this.toast(`Total: $${total}`);
  }

  // Interactable fixtures in the current world.
  fixtures() {
    const list = [];
    const s = this.state;
    if (!s) return list;
    const me = this.me;
    const O = this.world.out;
    list.push({ region: 'out', x: SHIP.terminal.x, y: SHIP.terminal.y, z: SHIP.terminal.z, range: 2.2, label: 'Use terminal', act: () => this.openTerminal() });
    if (s.phase === 'orbit') {
      const target = s.daysLeft === 0 ? MOONS[0] : MOONS[s.route];
      list.push({ region: 'out', ...SHIP.lever, range: 2.2, label: `Land ship on ${target.name}`, act: () => this.net.send({ t: 'interact', what: 'lever' }) });
    } else if (s.phase === 'landed') {
      list.push({ region: 'out', ...SHIP.lever, range: 2.2, label: 'Start ship (leave moon)', act: () => this.net.send({ t: 'interact', what: 'lever' }) });
      list.push({ region: 'out', ...SHIP.doorButton, range: 2.2, label: s.doorClosed ? 'Open door' : 'Close door', act: () => this.net.send({ t: 'interact', what: 'shipdoor' }) });
    }
    if (!this.world.landed) return list;
    if (O.facility) {
      const f = O.facility;
      list.push({ region: 'out', x: f.mainDoor.x, y: groundHeight(this.world, 'out', f.mainDoor.x, f.mainDoor.z) + 1.2, z: f.mainDoor.z, range: 2.8, label: 'Enter facility', act: () => this.useDoor(this.world.interior.mainDoor.spawn, 'in') });
      if (this.world.interior?.fireDoor) {
        list.push({ region: 'out', x: f.fireDoor.x, y: groundHeight(this.world, 'out', f.fireDoor.x, f.fireDoor.z) + 1.2, z: f.fireDoor.z, range: 2.5, label: 'Enter fire exit', act: () => this.useDoor(this.world.interior.fireDoor.spawn, 'in') });
      }
    }
    const I = this.world.interior;
    if (I) {
      list.push({ region: 'in', x: I.mainDoor.x, y: 1.2, z: I.mainDoor.z, range: 2.8, label: 'Exit facility', act: () => this.useDoor(O.facility.mainDoor.spawn, 'out') });
      if (I.fireDoor) list.push({ region: 'in', x: I.fireDoor.x, y: 1.2, z: I.fireDoor.z, range: 2.5, label: 'Use fire exit', act: () => this.useDoor(O.facility.fireDoor.spawn, 'out') });
    }
    if (this.world.moon.company && s.phase === 'landed') {
      const it = this.heldItem();
      const rate = SELL_RATE[Math.min(s.daysLeft, 3)];
      const label = it?.scrap ? `Sell ${it.name} for $${Math.floor(it.value * rate)} (${Math.round(rate * 100)}%)` : 'Sell desk — hold scrap to sell';
      list.push({ region: 'out', x: SELL_DESK.x, y: 1.1, z: SELL_DESK.z - SELL_DESK.halfD, range: 3, wide: true, label, act: () => this.net.send({ t: 'interact', what: 'sell' }) });
    }
    return list;
  }

  findInteractTarget() {
    const me = this.me;
    if (!me.alive) return null;
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    let best = null, bestScore = -1;
    const consider = (pos, range, minDot, target) => {
      const v = pos.clone().sub(eye);
      const d = v.length();
      if (d > range) return;
      const dot = v.normalize().dot(dir);
      if (dot < minDot) return;
      const score = dot - d * 0.02;
      if (score > bestScore) { bestScore = score; best = target; }
    };
    for (const f of this.fixtures()) {
      if (f.region !== me.region) continue;
      consider(new THREE.Vector3(f.x, f.y, f.z), f.range, f.wide ? 0.6 : 0.8, f);
    }
    for (const it of this.items.values()) {
      const d = it.data;
      if (d.heldBy != null || d.region !== me.region) continue;
      const pos = new THREE.Vector3(d.x, groundHeight(this.world, d.region, d.x, d.z) + 0.15, d.z);
      consider(pos, 2.4, 0.9, { item: d, label: `Pick up ${d.name}${d.scrap ? '' : ''}` });
    }
    return best;
  }

  interact() {
    const t = this.interactTarget;
    if (!t || !this.me.alive || this.teleporting) return;
    if (t.item) { this.net.send({ t: 'pickup', id: t.item.id }); return; }
    t.act();
  }

  useDoor(spawn, region) {
    if (this.teleporting) return;
    this.teleporting = true;
    this.sfx.play('facilityDoor');
    $('fade').style.opacity = '1';
    setTimeout(() => {
      this.teleport(spawn.x, spawn.z, spawn.yaw, region);
      $('fade').style.opacity = '0';
      this.teleporting = false;
    }, 280);
  }

  teleport(x, z, yaw, region) {
    const me = this.me;
    me.x = x; me.z = z; me.yaw = yaw; me.pitch = 0; me.region = region; me.vy = 0;
    me.y = groundHeight(this.world, region, x, z);
  }

  jump() {
    const me = this.me;
    if (!me.alive || !me.grounded || this.ui.chat || this.ui.terminal || me.stamina < 0.08) return;
    me.vy = 6.2;
    me.grounded = false;
    me.stamina -= 0.08;
    this.sfx.play('jump');
  }

  // ================================================================ MAIN LOOP
  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    if (this.id != null) this.update(dt);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame((t) => this.frame(t));
  }

  update(dt) {
    const me = this.me;
    const s = this.state;
    this.scanCd = Math.max(0, this.scanCd - dt);
    this.leverAnim = Math.max(0, this.leverAnim - dt * 1.5);
    this.swingAnim = Math.max(0, this.swingAnim - dt * 2.5);
    this.shake = Math.max(0, this.shake - dt);

    if (me.alive) this.updateMovement(dt);
    this.updateCamera(dt);
    this.updateRemotes(dt);
    this.updateMonsters(dt);
    this.updateItems(dt);
    this.updateLights();
    this.updateGrenades();

    // voice/noise
    const lvl = this.voice.micLevel();
    this.noise = Math.max(lvl, this.noise - dt * 1.5);
    const camPos = this.camera.getWorldPosition(new THREE.Vector3());
    const camDir = this.camera.getWorldDirection(new THREE.Vector3());
    const L = this.audio.listener;
    if (L.positionX) {
      const t = this.audio.currentTime;
      L.positionX.setTargetAtTime(camPos.x, t, 0.02); L.positionY.setTargetAtTime(camPos.y, t, 0.02); L.positionZ.setTargetAtTime(camPos.z, t, 0.02);
      L.forwardX.setTargetAtTime(camDir.x, t, 0.02); L.forwardY.setTargetAtTime(camDir.y, t, 0.02); L.forwardZ.setTargetAtTime(camDir.z, t, 0.02);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      L.setPosition(camPos.x, camPos.y, camPos.z);
      L.setOrientation(camDir.x, camDir.y, camDir.z, 0, 1, 0);
    }
    const hasRadio = me.inv.some((id) => { const d = id != null && this.items.get(id)?.data; return d && d.type === 'walkie' && d.on; });
    this.voice.update({ x: camPos.x, y: camPos.y - 1.5, z: camPos.z, region: this.listenerRegion(), alive: me.alive, hasRadio }, this.players);

    const region = this.listenerRegion();
    this.sfx.ambience(region === 'in' && s?.landed, region === 'out' && s?.landed && !inShip(camPos.x, camPos.z), (s?.clock ?? 0) > 18 * 60, !s?.landed);

    this.view.update(dt, this.time, {
      region, clock: s?.clock ?? 480, phase: s?.phase, doorClosed: s?.doorClosed ?? true,
      camPos, landed: this.world.landed, leverAnim: this.leverAnim,
    });

    // network send @20Hz
    this.sendTimer -= dt;
    if (this.sendTimer <= 0) {
      this.sendTimer = 0.05;
      if (me.alive) {
        this.net.send({
          t: 'state', seq: me.seq, x: +me.x.toFixed(2), y: +me.y.toFixed(2), z: +me.z.toFixed(2), yaw: +me.yaw.toFixed(3), pitch: +me.pitch.toFixed(3),
          region: me.region, crouch: me.crouch, sprint: me.sprinting, moving: me.moveSpeed > 0.5, noise: +this.noise.toFixed(2), walkieTx: this.walkieTx,
        });
      }
    }

    this.interactTarget = this.locked ? this.findInteractTarget() : null;
    this.updateHUD();
    if (this.monitorDirty && s) {
      this.monitorDirty = false;
      let shipScrap = 0;
      for (const it of this.items.values()) {
        const d = it.data;
        if (d.scrap && d.heldBy == null && d.region === 'out' && inShip(d.x, d.z)) shipScrap += d.value;
      }
      this.shipScrap = shipScrap;
      this.view.updateMonitor(s, shipScrap);
    }
  }

  updateMovement(dt) {
    const me = this.me;
    const k = this.keys;
    const canMove = this.locked && !this.ui.chat && !this.ui.terminal;
    let fx = 0, fz = 0;
    if (canMove) {
      if (k.has('KeyW') || k.has('ArrowUp')) fz -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) fz += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
    }
    const len = Math.hypot(fx, fz);
    const weight = this.carriedWeight();
    const weightMul = clamp(1 - weight / 260, 0.45, 1);
    const wantSprint = canMove && (k.has('ShiftLeft') || k.has('ShiftRight')) && len > 0 && fz < 0;
    if (me.stamina <= 0) me.exhausted = true;
    if (me.exhausted && me.stamina > 0.3) me.exhausted = false;
    me.sprinting = wantSprint && !me.exhausted && !me.crouch;
    let speed = me.crouch ? 2.2 : me.sprinting ? 7.2 : 4.3;
    speed *= weightMul;
    if (me.sprinting) me.stamina -= dt * 0.2 * (1 + weight / 150);
    else me.stamina += dt * (len > 0 ? 0.12 : 0.22);
    me.stamina = clamp(me.stamina, 0, 1);

    let vx = 0, vz = 0;
    if (len > 0) {
      const sin = Math.sin(me.yaw), cos = Math.cos(me.yaw);
      const lx = fx / len, lz = fz / len;
      vx = (lx * cos + lz * sin) * speed;
      vz = (-lx * sin + lz * cos) * speed;
    }
    const acc = me.grounded ? 12 : 3;
    me.vx = (me.vx || 0) + (vx - (me.vx || 0)) * Math.min(1, dt * acc);
    me.vz = (me.vz || 0) + (vz - (me.vz || 0)) * Math.min(1, dt * acc);
    const ox = me.x, oz = me.z;
    const p = { x: me.x + me.vx * dt, z: me.z + me.vz * dt };
    collide(this.world, me.region, p, PLAYER_RADIUS, this.state?.doorClosed ?? true);
    // Never let the player leave the ship while in orbit.
    if (!this.world.landed && !inShip(p.x, p.z)) { p.x = clamp(p.x, SHIP.minX + 0.4, SHIP.maxX - 0.4); p.z = clamp(p.z, SHIP.minZ + 0.4, SHIP.maxZ - 0.4); }
    me.x = p.x; me.z = p.z;
    const moved = Math.hypot(me.x - ox, me.z - oz);
    me.moveSpeed = moved / dt;

    // vertical
    const ground = groundHeight(this.world, me.region, me.x, me.z);
    me.vy -= 20 * dt;
    me.y += me.vy * dt;
    if (me.y <= ground || (me.grounded && me.y - ground < 0.35 && me.vy <= 0)) {
      if (!me.grounded && me.vy < -6) this.sfx.play('land');
      me.y = ground;
      me.vy = 0;
      me.grounded = true;
    } else me.grounded = false;

    // footsteps
    if (me.grounded && moved > 0) {
      this.stepDist += moved;
      const stride = me.sprinting ? 2.4 : me.crouch ? 1.1 : 1.8;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        const metal = inShip(me.x, me.z) || me.region === 'in';
        this.sfx.play(metal ? 'stepMetal' : 'step', null, me.crouch ? 0.3 : 0.6);
      }
    }
  }

  updateCamera(dt) {
    const me = this.me;
    const cam = this.camera;
    if (me.alive) {
      me.eye = (me.eye ?? EYE_HEIGHT) + ((me.crouch ? CROUCH_EYE_HEIGHT : EYE_HEIGHT) - (me.eye ?? EYE_HEIGHT)) * Math.min(1, dt * 10);
      const bob = me.grounded ? Math.sin(this.time * (me.sprinting ? 14 : 9)) * Math.min(1, me.moveSpeed / 4) * 0.04 : 0;
      cam.position.set(me.x, me.y + me.eye + bob, me.z);
      cam.rotation.set(me.pitch, me.yaw, 0);
    } else {
      // Spectate: orbit behind the target.
      const t = this.players.get(this.spectate);
      if (t && !t.alive) this.cycleSpectate();
      const tgt = this.players.get(this.spectate);
      if (tgt) {
        const yaw = me.yaw;
        const head = new THREE.Vector3(tgt.x, tgt.y + 1.6, tgt.z);
        const back = new THREE.Vector3(Math.sin(yaw) * Math.cos(me.pitch), -Math.sin(me.pitch) + 0.3, Math.cos(yaw) * Math.cos(me.pitch)).normalize();
        let dist = 3.2;
        // pull in against walls
        for (let d = 0.5; d <= 3.2; d += 0.2) {
          const px = head.x + back.x * d, pz = head.z + back.z * d;
          const c = collide(this.world, tgt.region, { x: px, z: pz }, 0.2, false);
          if (Math.hypot(c.x - px, c.z - pz) > 0.01) { dist = d - 0.2; break; }
        }
        cam.position.copy(head).addScaledVector(back, dist);
        cam.lookAt(head);
      }
    }
    if (this.shake > 0 || (this.state && (this.state.phase === 'landing' || this.state.phase === 'leaving') && inShip(me.x, me.z))) {
      const amt = this.shake > 0 ? Math.min(0.05, this.shake * 0.04) : 0.012;
      cam.position.x += (Math.random() - 0.5) * amt;
      cam.position.y += (Math.random() - 0.5) * amt;
    }
    cam.updateMatrixWorld();
  }

  updateRemotes(dt) {
    const t = Math.min(1, dt * 12);
    const region = this.listenerRegion();
    const camPos = this.camera.position;
    for (const p of this.players.values()) {
      if (p.id === this.id || !p.target) continue;
      const ox = p.x, oz = p.z;
      p.x += (p.target.x - p.x) * t;
      p.y += (p.target.y - p.y) * t;
      p.z += (p.target.z - p.z) * t;
      p.yaw = lerpAngle(p.yaw, p.target.yaw, t);
      p.pitch += (p.target.pitch - p.pitch) * t;
      const spd = Math.hypot(p.x - ox, p.z - oz) / Math.max(dt, 1e-3);
      const m = p.model;
      m.visible = p.alive;
      m.position.set(p.x, p.y, p.z);
      m.rotation.y = p.yaw;
      m.userData.head.rotation.x = p.pitch * 0.6;
      const heldId = p.inv[p.slot];
      animatePlayer(m, dt, spd, p.crouch, heldId != null);
      // footsteps
      if (p.alive && p.region === region && spd > 0.5) {
        p.stepDist += spd * dt;
        if (p.stepDist > (p.sprint ? 2.4 : 1.8)) {
          p.stepDist = 0;
          const metal = inShip(p.x, p.z) || p.region === 'in';
          this.sfx.play(metal ? 'stepMetal' : 'step', { x: p.x, y: p.y, z: p.z }, p.crouch ? 0.2 : 0.5);
        }
      }
      // nametag
      const d = Math.hypot(p.x - camPos.x, p.z - camPos.z);
      const show = p.alive && p.region === region && d < 14;
      const v = new THREE.Vector3(p.x, p.y + 2.05, p.z).project(this.camera);
      if (show && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1) {
        p.tag.style.display = '';
        p.tag.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
        p.tag.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
        const talking = this.voice.speaking(p.id);
        p.tag.classList.toggle('talking', talking);
        const radio = talking && this.voice.peerRadio(p.id);
        const html = `${esc(p.name)}${radio ? ' <span class="radio">[radio]</span>' : ''}`;
        if (p.tag._html !== html) { p.tag.innerHTML = html; p.tag._html = html; }
      } else p.tag.style.display = 'none';
    }
  }

  updateMonsters(dt) {
    const t = Math.min(1, dt * 10);
    const region = this.listenerRegion();
    for (const mo of this.monsters.values()) {
      const tg = mo.target;
      if (Math.hypot(tg.x - mo.x, tg.z - mo.z) > 6) { mo.x = tg.x; mo.z = tg.z; }
      mo.x += (tg.x - mo.x) * t;
      mo.z += (tg.z - mo.z) * t;
      mo.yaw = lerpAngle(mo.yaw, tg.yaw, t);
      const y = groundHeight(this.world, mo.region, mo.x, mo.z);
      mo.model.position.set(mo.x, y, mo.z);
      mo.model.rotation.y = mo.yaw;
      if (!mo.stunned) animateMonster(mo.model, dt, mo.speed, mo.state, this.time);
      // ambient monster sounds
      if (mo.region !== region) continue;
      mo.sndT -= dt;
      const pos = { x: mo.x, y: y + 1, z: mo.z };
      if (mo.sndT <= 0) {
        switch (mo.type) {
          case 'springhead': if (mo.state === 'move' && mo.speed > 1) { this.sfx.play('springStep', pos); mo.sndT = 0.22; } else mo.sndT = 0.2; break;
          case 'hoarder': if (Math.random() < 0.3) this.sfx.play('chirp', pos, 0.8); mo.sndT = 2 + Math.random() * 3; break;
          case 'crawler': if (mo.speed > 1) this.sfx.play('thud', pos, 0.5); mo.sndT = mo.speed > 5 ? 0.25 : 0.5; break;
          case 'dog': if (mo.speed > 0.5) this.sfx.play('step', pos, 1.2); if (Math.random() < 0.08) this.sfx.play('growl', pos); mo.sndT = mo.speed > 5 ? 0.25 : 0.6; break;
          case 'lurker': if (mo.speed > 3 && Math.random() < 0.5) this.sfx.play('rustle', pos, 0.6); mo.sndT = 0.8; break;
        }
      }
    }
  }

  updateItems(dt) {
    const me = this.me;
    const vmItem = me.alive ? me.inv[me.slot] : null;
    for (const [id, it] of this.items) {
      const d = it.data, mesh = it.mesh;
      mesh.visible = true;
      if (d.heldBy === this.id && me.alive) {
        if (id !== vmItem) { mesh.visible = false; continue; }
        if (mesh.parent !== this.viewModel) this.viewModel.add(mesh);
        const off = viewModelOffset(d.type);
        const bob = Math.sin(this.time * 9) * Math.min(1, me.moveSpeed / 4) * 0.015;
        mesh.position.set(off[0], off[1] + bob, off[2]);
        mesh.rotation.set(0, d.scrap ? 0.4 : 0, 0);
        if (d.type === 'shovel') {
          const a = this.swingAnim;
          mesh.rotation.set(-0.3 - Math.sin(a * Math.PI) * 1.6, 0, 0.3);
          mesh.position.y += 0.2;
        }
        if (d.type === 'walkie' && this.walkieTx) mesh.position.set(0.12, -0.12, -0.3);
      } else if (typeof d.heldBy === 'number') {
        const p = this.players.get(d.heldBy);
        if (!p || !p.model || !p.alive || p.inv[p.slot] !== id) { mesh.visible = false; continue; }
        const hand = p.model.userData.hand;
        if (mesh.parent !== hand) hand.add(mesh);
        mesh.position.set(0, 0, 0);
        mesh.rotation.set(d.type === 'shovel' ? 0 : Math.PI / 2, 0, 0);
      } else if (typeof d.heldBy === 'string') {
        const mo = this.monsters.get(Number(d.heldBy.slice(1)));
        if (!mo) { mesh.visible = false; continue; }
        if (mesh.parent !== this.scene) this.scene.add(mesh);
        mesh.position.set(mo.x, mo.model.position.y + 1.0, mo.z);
      } else {
        if (mesh.parent !== this.scene) this.scene.add(mesh);
        mesh.position.set(d.x, groundHeight(this.world, d.region, d.x, d.z), d.z);
        mesh.rotation.set(0, d.rot || 0, 0);
        if (d.type === 'flashlight' || d.type === 'proflashlight') { mesh.rotation.set(0, d.rot || 0, 0); mesh.position.y += 0.05; }
      }
    }
  }

  updateLights() {
    const me = this.me;
    const held = me.alive ? this.heldItem() : null;
    const def = held && STORE[held.type]?.beam;
    if (def && held.on) {
      this.flashlight.intensity = def.intensity;
      this.flashlight.distance = def.distance;
      this.flashlight.angle = def.angle;
      const low = held.charge < 15 && Math.sin(this.time * 30) > 0.6;
      if (low) this.flashlight.intensity *= 0.2;
    } else this.flashlight.intensity = 0;

    // Remote flashlights + flashlights lying on the floor.
    const region = this.listenerRegion();
    const cam = this.camera.position;
    const sources = [];
    for (const [, it] of this.items) {
      const d = it.data;
      const beam = STORE[d.type]?.beam;
      if (!beam || !d.on) continue;
      if (d.heldBy === this.id && me.alive) continue;
      if (typeof d.heldBy === 'number') {
        const p = this.players.get(d.heldBy);
        if (!p || !p.alive || p.region !== region || p.inv[p.slot] !== d.id) continue;
        const pos = new THREE.Vector3(p.x, p.y + 1.4, p.z);
        const dir = new THREE.Vector3(-Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), -Math.cos(p.yaw) * Math.cos(p.pitch));
        sources.push({ pos, dir, beam, d2: pos.distanceToSquared(cam) });
      } else if (d.heldBy == null && d.region === region) {
        const pos = new THREE.Vector3(d.x, groundHeight(this.world, d.region, d.x, d.z) + 0.1, d.z);
        const dir = new THREE.Vector3(-Math.sin(d.rot || 0), 0, -Math.cos(d.rot || 0));
        sources.push({ pos, dir, beam, d2: pos.distanceToSquared(cam) });
      }
    }
    sources.sort((a, b) => a.d2 - b.d2);
    this.spotPool.forEach((s, i) => {
      const src = sources[i];
      if (!src || src.d2 > 60 * 60) { s.intensity = 0; return; }
      s.position.copy(src.pos);
      s.target.position.copy(src.pos).addScaledVector(src.dir, 6);
      s.target.updateMatrixWorld();
      s.intensity = src.beam.intensity;
      s.distance = src.beam.distance;
      s.angle = src.beam.angle;
    });
  }

  updateGrenades() {
    if (!this.grenades?.length) return;
    this.grenades = this.grenades.filter((g) => {
      const k = clamp((this.time - g.start) / g.dur, 0, 1);
      g.mesh.position.set(g.from.x + (g.to.x - g.from.x) * k, g.from.y + (g.to.y - g.from.y) * k + Math.sin(k * Math.PI) * 1.5, g.from.z + (g.to.z - g.from.z) * k);
      if (this.time > g.until) { this.scene.remove(g.mesh); return false; }
      return true;
    });
  }

  updateHUD() {
    const me = this.me, s = this.state;
    if (!s) return;
    $('hp-fill').style.width = `${me.hp}%`;
    $('hp-text').textContent = me.hp;
    $('stam-fill').style.width = `${me.stamina * 100}%`;
    $('stam-fill').style.background = me.exhausted ? 'var(--bad)' : '';
    const w = this.carriedWeight();
    $('weight').textContent = `${w} lb`;

    const showClock = s.landed && me.region === 'out' && !this.world.moon.company && me.alive;
    $('clock').classList.toggle('hidden', !showClock);
    if (showClock) $('clock').textContent = formatClock(s.clock);

    const onShip = me.region === 'out' && inShip(me.x, me.z);
    $('shipinfo').classList.toggle('hidden', !onShip);
    if (onShip) {
      const phaseText = { orbit: `In orbit — routed to ${MOONS[s.daysLeft === 0 ? 0 : s.route].name}`, landing: 'Landing...', landed: `Landed on ${MOONS[s.moon].name}`, leaving: 'Taking off...' }[s.phase];
      const html = `QUOTA $${s.fulfilled} / $${s.quota}<br>DEADLINE ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'}<br>CREDITS $${s.credits}<br>SHIP SCRAP $${this.shipScrap || 0}<br><span class="muted">${phaseText}</span>`;
      if ($('shipinfo')._h !== html) { $('shipinfo').innerHTML = html; $('shipinfo')._h = html; }
    }

    // inventory
    let invHtml = '';
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const d = me.inv[i] != null ? this.items.get(me.inv[i])?.data : null;
      const bat = d && d.charge != null ? `<div class="bat"><div style="width:${(d.charge / STORE[d.type].battery) * 100}%"></div></div>` : '';
      invHtml += `<div class="slot ${i === me.slot ? 'active' : ''}">${d ? esc(d.name) : ''}${bat}</div>`;
    }
    if ($('inventory')._h !== invHtml) { $('inventory').innerHTML = invHtml; $('inventory')._h = invHtml; }
    const held = this.heldItem();
    let heldText = '';
    if (held) {
      if (held.type === 'flashlight' || held.type === 'proflashlight') heldText = `${held.name} — [LMB] ${held.on ? 'off' : 'on'}`;
      else if (held.type === 'walkie') heldText = held.on ? (this.walkieTx ? 'TRANSMITTING...' : 'Walkie on — hold [LMB] to talk, double-click to turn off') : 'Walkie — [LMB] turn on';
      else if (held.type === 'shovel') heldText = 'Shovel — [LMB] swing';
      else if (held.type === 'stungrenade') heldText = 'Stun grenade — [LMB] throw';
      else heldText = `${held.name}${held.twoHanded ? ' (two-handed)' : ''} — [G] drop`;
    }
    $('helditem').textContent = heldText;

    const t = this.interactTarget;
    $('prompt').textContent = t ? `${t.label} [E]` : '';

    // mic
    const mi = $('mic-indicator');
    const lvl = this.voice.micLevel();
    mi.classList.toggle('muted', settings.mute || !this.voice.localTrack);
    mi.classList.toggle('talking', lvl > 0.06);
    $('mic-label').textContent = !this.voice.localTrack ? 'NO MIC' : settings.mute ? 'MUTED' : settings.ptt ? (this.voice.pttDown ? 'PTT ON' : 'PTT [V]') : this.walkieTx ? 'RADIO' : 'MIC';
    mi.style.setProperty('--lvl', `${Math.round(lvl * 100)}%`);

    if (!$('crew').classList.contains('hidden') && Math.floor(this.time * 4) !== this._crewT) { this._crewT = Math.floor(this.time * 4); this.renderCrew(); }

    // scan tags follow the world
    this.scanTags = this.scanTags.filter((tag) => {
      if (this.time > tag.until) { tag.el.remove(); return false; }
      const v = tag.pos.clone().project(this.camera);
      tag.el.style.display = v.z > 1 ? 'none' : '';
      tag.el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
      tag.el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
      return true;
    });
  }
}

window.game = new Game();
