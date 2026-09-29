// Thin WebSocket wrapper with a message-type dispatcher.

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.rtt = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${proto}//${location.host}`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('Could not connect to server.'));
      this.ws.onclose = () => this.emit('close', {});
      this.ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.t === 'pong') this.rtt = performance.now() - msg.ts;
        this.emit(msg.t, msg);
      };
      setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 3000);
    });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  emit(type, msg) {
    for (const fn of this.handlers.get(type) || []) fn(msg);
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
}
