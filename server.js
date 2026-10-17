// Servidor do Dominó do Meladinha: serve a página e guarda as salas na memória.
// Cada sala é um documento JSON; quem está inscrito recebe o documento a cada mudança.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_DOC = 256 * 1024;
const rooms = new Map(); // código -> { doc, subs:Set<ws>, touched }

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_DOC + 1024 });

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(a, b) {
  for (const k of Object.keys(b)) {
    if (isObj(b[k]) && isObj(a[k])) merge(a[k], b[k]);
    else a[k] = b[k];
  }
  return a;
}
function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function broadcast(code, room) {
  const msg = JSON.stringify({ t: 'doc', code, exists: !!room.doc, doc: room.doc });
  room.subs.forEach((w) => { if (w.readyState === 1) w.send(msg); });
}
function getRoom(code, create) {
  let r = rooms.get(code);
  if (!r && create) { r = { doc: null, subs: new Set(), touched: Date.now() }; rooms.set(code, r); }
  return r;
}

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.codes = new Set();
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const code = String(m.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (code.length !== 4) return;
    const room = getRoom(code, m.t === 'sub' || m.t === 'set');
    const ack = (error) => send(ws, { t: 'ack', id: m.id, error });
    switch (m.t) {
      case 'get':
        send(ws, { t: 'got', id: m.id, exists: !!(room && room.doc), doc: room && room.doc ? room.doc : null });
        break;
      case 'sub':
        room.subs.add(ws); ws.codes.add(code);
        send(ws, { t: 'doc', code, exists: !!room.doc, doc: room.doc });
        break;
      case 'unsub':
        if (room) room.subs.delete(ws);
        ws.codes.delete(code);
        break;
      case 'set': {
        if (!isObj(m.doc) || JSON.stringify(m.doc).length > MAX_DOC) return ack('invalid_argument');
        const cur = room.doc;
        // Um estado mais antigo que o já guardado é descartado (jogada atrasada).
        if (cur && cur.phase === 'play' && m.doc.phase === 'play' && m.doc.rev < cur.rev) return ack();
        room.doc = m.doc; room.touched = Date.now();
        broadcast(code, room); ack();
        break;
      }
      case 'update':
        if (!room || !room.doc || !isObj(m.data)) return ack('invalid_argument');
        merge(room.doc, m.data); room.touched = Date.now();
        broadcast(code, room); ack();
        break;
      case 'delete':
        if (room) { room.doc = null; broadcast(code, room); }
        ack();
        break;
    }
  });
  ws.on('close', () => { ws.codes.forEach((c) => { const r = rooms.get(c); if (r) r.subs.delete(ws); }); });
});

// Mantém a conexão viva atrás do proxy do Render e remove salas esquecidas.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false; ws.ping();
  });
  const now = Date.now();
  rooms.forEach((r, c) => { if (!r.subs.size && now - r.touched > 6 * 3600 * 1000) rooms.delete(c); });
}, 25000);

server.listen(PORT, () => console.log('Dominó do Meladinha na porta ' + PORT));
