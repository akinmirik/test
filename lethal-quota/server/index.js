// HTTP static server + WebSocket game/voice-signalling server.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './game.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

// URL prefix -> directory on disk.
const MOUNTS = [
  ['/shared/', path.join(ROOT, 'shared')],
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/build')],
  ['/', path.join(ROOT, 'public')],
];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Optional TURN/STUN override so voice works across strict NATs, e.g.
// ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
let ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.ICE_SERVERS) {
  try { ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS); } catch { console.warn('Invalid ICE_SERVERS JSON, using defaults'); }
}

// Browsers only allow microphone access on HTTPS (or localhost). Set SSL_KEY and SSL_CERT to serve HTTPS directly.
const tls = process.env.SSL_KEY && process.env.SSL_CERT
  ? { key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) }
  : null;

const handler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: ICE_SERVERS }));
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`ok rooms=${rooms.size}`);
  }
  for (const [prefix, dir] of MOUNTS) {
    if (!url.pathname.startsWith(prefix)) continue;
    let rel = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep)) break;
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }
  res.writeHead(404);
  res.end('Not found');
};
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  let code;
  do code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  while (rooms.has(code));
  return code;
}

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  let room = null, id = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    if (!room) {
      if (msg.t !== 'join') return;
      const name = String(msg.name || 'Employee').replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 16).trim() || 'Employee';
      let code = String(msg.room || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
      if (code && !rooms.has(code)) {
        if (!msg.create) return ws.send(JSON.stringify({ t: 'error', text: `Crew ${code} not found.` }));
      }
      if (!code) code = newCode();
      if (!rooms.has(code)) rooms.set(code, new Room(code, (c) => rooms.delete(c)));
      room = rooms.get(code);
      id = room.addClient(ws, name);
      if (id == null) {
        room = null;
        return ws.send(JSON.stringify({ t: 'error', text: 'That crew is full.' }));
      }
      return;
    }
    room.handle(id, msg);
  });
  ws.on('close', () => { if (room) room.removeClient(id); });
});

// Drop dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.listen(PORT, () => {
  console.log(`Lethal Quota server running on ${tls ? 'https' : 'http'}://localhost:${PORT}`);
});
