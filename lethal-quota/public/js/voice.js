// Proximity voice chat: a WebRTC audio mesh between all crew members, signalled through the
// game server. Every remote voice runs through a Web Audio PannerNode (HRTF) positioned on that
// player's head, so voices come from where the player is and fade out with distance.
//
// Routing rules (like the original):
//  - Living players hear living players nearby, in the same area (outside / inside the facility).
//  - Anyone holding a powered walkie-talkie hears crewmates who transmit on theirs (radio filter).
//  - Dead players hear the living around whoever they spectate, and talk freely with the dead.
//  - Living players never hear the dead.

const HEAR_FULL = 20; // metres at which voices start fading out
const HEAR_MAX = 32;  // metres beyond which voices are silent

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class Voice {
  constructor(net, ctx, output) {
    this.net = net;
    this.ctx = ctx;
    this.peers = new Map();
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.localStream = null;
    this.localTrack = null;
    this.micAnalyser = null;
    this.micBuf = new Float32Array(512);
    this.muted = false;
    this.ptt = false;
    this.pttDown = false;
    this.status = 'Microphone not started';
    this.deviceId = null;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.bus = ctx.createGain();
    this.bus.connect(comp).connect(output);

    // Shared radio "distortion" curve for walkie-talkie audio.
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 3.5) * 0.8;
    }
    this.radioCurve = curve;

    net.on('rtc', (m) => this.onSignal(m.from, m.data).catch((e) => console.warn('rtc', e)));
  }

  async loadConfig() {
    try {
      const cfg = await (await fetch('/config.json')).json();
      if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) this.iceServers = cfg.iceServers;
    } catch { /* keep defaults */ }
  }

  // ------------------------------------------------------------------ microphone
  async startMic(deviceId = this.deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.status = 'Voice needs HTTPS (or localhost). You can still hear others.';
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        },
        video: false,
      });
      this.localStream?.getTracks().forEach((t) => t.stop());
      this.localStream = stream;
      this.localTrack = stream.getAudioTracks()[0];
      this.deviceId = deviceId;
      this.micSrc?.disconnect();
      this.micSrc = this.ctx.createMediaStreamSource(stream);
      this.micAnalyser = this.ctx.createAnalyser();
      this.micAnalyser.fftSize = 512;
      this.micSrc.connect(this.micAnalyser);
      for (const peer of this.peers.values()) {
        if (peer.sender) await peer.sender.replaceTrack(this.localTrack).catch(() => {});
      }
      this.applyTrackState();
      this.status = `Microphone: ${this.localTrack.label || 'active'}`;
      return true;
    } catch (e) {
      this.status = `Microphone unavailable (${e.name}). You can still hear others.`;
      return false;
    }
  }

  async listMics() {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    } catch { return []; }
  }

  get transmitting() {
    return !!this.localTrack && !this.muted && (!this.ptt || this.pttDown);
  }

  applyTrackState() {
    if (this.localTrack) this.localTrack.enabled = this.transmitting;
  }

  setMuted(v) { this.muted = v; this.applyTrackState(); }
  setPTT(v) { this.ptt = v; this.applyTrackState(); }
  setPTTDown(v) { this.pttDown = v; this.applyTrackState(); }
  setVolume(v) { this.bus.gain.value = v; }

  // RMS level of our own microphone 0..1 (0 while muted). Also feeds blind-dog hearing.
  micLevel() {
    if (!this.micAnalyser || !this.transmitting) return 0;
    this.micAnalyser.getFloatTimeDomainData(this.micBuf);
    let sum = 0;
    for (let i = 0; i < this.micBuf.length; i++) sum += this.micBuf[i] * this.micBuf[i];
    return Math.min(1, Math.sqrt(sum / this.micBuf.length) * 5);
  }

  // ------------------------------------------------------------------ peers & signalling
  sendSignal(to, data) {
    this.net.send({ t: 'rtc', to, data });
  }

  async connectTo(id) {
    // The newer player always initiates, so there is never an offer collision.
    const peer = this.createPeer(id, true);
    const tr = peer.pc.addTransceiver(this.localTrack || 'audio', {
      direction: 'sendrecv', streams: this.localStream ? [this.localStream] : [],
    });
    peer.sender = tr.sender;
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.sendSignal(id, { sdp: peer.pc.localDescription });
  }

  createPeer(id, initiator) {
    this.removePeer(id);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = { id, pc, initiator, pendingIce: [], level: 0, audible: 0, nodes: null, buf: new Float32Array(512) };
    pc.onicecandidate = (e) => { if (e.candidate) this.sendSignal(id, { ice: e.candidate }); };
    pc.ontrack = (e) => this.attachStream(peer, e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState;
      if (pc.connectionState === 'failed' && initiator && this.peers.get(id) === peer) {
        setTimeout(() => { if (this.peers.get(id) === peer) this.connectTo(id).catch(() => {}); }, 1500);
      }
    };
    this.peers.set(id, peer);
    return peer;
  }

  async onSignal(from, data) {
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        const peer = this.createPeer(from, false);
        await peer.pc.setRemoteDescription(data.sdp);
        const tr = peer.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio') || peer.pc.getTransceivers()[0];
        if (tr) {
          tr.direction = 'sendrecv';
          if (this.localTrack) {
            await tr.sender.replaceTrack(this.localTrack);
            if (this.localStream) tr.sender.setStreams?.(this.localStream);
          }
          peer.sender = tr.sender;
        }
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.sendSignal(from, { sdp: peer.pc.localDescription });
        await this.flushIce(peer);
      } else if (data.sdp.type === 'answer') {
        const peer = this.peers.get(from);
        if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription(data.sdp);
        await this.flushIce(peer);
      }
    } else if (data.ice) {
      const peer = this.peers.get(from);
      if (!peer) return;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.ice).catch(() => {});
      else peer.pendingIce.push(data.ice);
    }
  }

  async flushIce(peer) {
    for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  attachStream(peer, stream) {
    if (peer.nodes) return;
    const ctx = this.ctx;
    // Chrome only pulls remote WebRTC audio into Web Audio if the stream is also attached to a
    // media element, so attach it to a muted one.
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    el.play().catch(() => {});

    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);

    // 1) Spatial path.
    const spatial = ctx.createGain();
    spatial.gain.value = 0;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.5;
    panner.rolloffFactor = 1.1;
    panner.maxDistance = 200;
    src.connect(spatial).connect(panner).connect(this.bus);

    // 2) Walkie-talkie path: band-limited and crunchy.
    const radio = ctx.createGain();
    radio.gain.value = 0;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 500;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.radioCurve;
    const radioOut = ctx.createGain();
    radioOut.gain.value = 0.8;
    src.connect(radio).connect(hp).connect(lp).connect(shaper).connect(radioOut).connect(this.bus);

    // 3) Direct path for dead-to-dead chat.
    const direct = ctx.createGain();
    direct.gain.value = 0;
    src.connect(direct).connect(this.bus);

    peer.nodes = { el, src, analyser, spatial, panner, radio, direct };
  }

  removePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    try { peer.pc.close(); } catch { /* ignore */ }
    if (peer.nodes) {
      peer.nodes.src.disconnect();
      peer.nodes.el.srcObject = null;
    }
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.localTrack = null;
  }

  // ------------------------------------------------------------------ per-frame routing
  // listener: { x, y, z, region, alive, hasRadio }  players: Map id -> { x, y, z, region, alive, walkieTx }
  update(listener, players) {
    const t = this.ctx.currentTime;
    for (const peer of this.peers.values()) {
      const n = peer.nodes;
      if (!n) continue;
      const p = players.get(peer.id);
      let spatial = 0, radio = 0, direct = 0;
      if (p) {
        if (p.alive) {
          if (p.region === listener.region) {
            const d = Math.hypot(p.x - listener.x, p.y - listener.y, p.z - listener.z);
            spatial = 1 - smoothstep(HEAR_FULL, HEAR_MAX, d);
          }
          if (listener.alive && listener.hasRadio && p.walkieTx) radio = 1;
          const hx = p.x, hy = p.y + 1.5, hz = p.z;
          if (n.panner.positionX) {
            n.panner.positionX.setTargetAtTime(hx, t, 0.03);
            n.panner.positionY.setTargetAtTime(hy, t, 0.03);
            n.panner.positionZ.setTargetAtTime(hz, t, 0.03);
          } else n.panner.setPosition(hx, hy, hz);
        } else if (!listener.alive) {
          direct = 1;
        }
      }
      n.spatial.gain.setTargetAtTime(spatial, t, 0.08);
      n.radio.gain.setTargetAtTime(radio, t, 0.05);
      n.direct.gain.setTargetAtTime(direct, t, 0.08);

      n.analyser.getFloatTimeDomainData(peer.buf);
      let sum = 0;
      for (let i = 0; i < peer.buf.length; i++) sum += peer.buf[i] * peer.buf[i];
      const lvl = Math.min(1, Math.sqrt(sum / peer.buf.length) * 5);
      peer.level = Math.max(lvl, peer.level * 0.85);
      peer.audible = Math.max(spatial, radio, direct);
      peer.viaRadio = radio > 0;
    }
  }

  // Is this peer currently speaking and audible to us?
  speaking(id) {
    const peer = this.peers.get(id);
    return !!peer && peer.level > 0.06 && peer.audible > 0.05;
  }

  peerRadio(id) {
    return !!this.peers.get(id)?.viaRadio;
  }
}
