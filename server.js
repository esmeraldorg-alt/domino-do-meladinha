// Servidor do Dominó do Meladinha: serve a página, guarda contas e ranking, e mantém as salas na memória.
// Cada sala é um documento JSON; quem está inscrito recebe o documento a cada mudança.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const makeStore = require('./store');

const PORT = process.env.PORT || 3000;
const MAX_DOC = 256 * 1024;
const TOKEN_DAYS = 90;
const store = makeStore();
const rooms = new Map(); // código -> { doc, subs:Set<ws>, touched, chat:[], recorded }
let SECRET = null;

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

/* ---------- utilidades ---------- */
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
  if (!r && create) { r = { doc: null, subs: new Set(), touched: Date.now(), chat: [], recorded: null }; rooms.set(code, r); }
  return r;
}

/* ---------- contas ---------- */
const scrypt = (pass, salt) => new Promise((res, rej) => crypto.scrypt(pass, salt, 32, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function verify(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
const fails = new Map(); // ip -> { n, first }
function blocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 10 * 60 * 1000) { fails.delete(ip); return false; }
  return f.n >= 10;
}
function fail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > 10 * 60 * 1000) fails.set(ip, { n: 1, first: Date.now() });
  else f.n++;
}
function publicUser(u) { return { id: u.id, nick: u.nick, wins: u.wins, games: u.games }; }
// A resposta usa "uid" porque "id" já é o número do pedido.
function userOut(u, token) { return { uid: u.id, nick: u.nick, wins: u.wins, games: u.games, token }; }
function newToken(u) { return sign({ id: u.id, exp: Date.now() + TOKEN_DAYS * 86400000 }); }

async function handleAuth(ws, m, reply) {
  const ip = ws.ip;
  if (m.t === 'auth') {
    const p = verify(m.token);
    const u = p && await store.byId(p.id);
    if (!u) return reply({ error: 'auth' });
    ws.user = publicUser(u);
    return reply(userOut(u, m.token));
  }
  if (blocked(ip)) return reply({ error: 'muitas_tentativas' });
  const nick = String(m.nick || '').trim();
  const pass = String(m.pass || '');
  if (m.t === 'register') {
    if (!/^[A-Za-z0-9_-]{3,16}$/.test(nick)) return reply({ error: 'nick_invalido' });
    if (pass.length < 4 || pass.length > 64) return reply({ error: 'senha_curta' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: 'u_' + crypto.randomBytes(9).toString('hex'), nick, nickLower: nick.toLowerCase(),
      salt, hash: await scrypt(pass, salt), wins: 0, games: 0, created: Date.now(),
    };
    try { await store.create(user); } catch (e) {
      if (e.code === 'dup') return reply({ error: 'nick_em_uso' });
      throw e;
    }
    ws.user = publicUser(user);
    return reply(userOut(user, newToken(user)));
  }
  if (m.t === 'login') {
    const u = await store.byNick(nick.toLowerCase());
    const ok = u && crypto.timingSafeEqual(Buffer.from(await scrypt(pass, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
    if (!ok) { fail(ip); return reply({ error: 'login_invalido' }); }
    ws.user = publicUser(u);
    return reply(userOut(u, newToken(u)));
  }
}

/* ---------- ranking ---------- */
// Conta só partida terminada com pelo menos 2 pessoas diferentes, uma vez por jogo.
async function recordIfDone(room, doc) {
  const g = doc.game;
  if (!g || !g.over || !doc.gameId || room.recorded === doc.gameId) return;
  room.recorded = doc.gameId;
  const humans = [];
  for (let s = 0; s < 4; s++) {
    const x = doc.seats && doc.seats[s];
    if (x && x.type === 'human' && x.uid) humans.push({ s, uid: x.uid });
  }
  if (new Set(humans.map((h) => h.uid)).size < 2) return;
  const win = g.scores[0] >= g.scores[1] ? 0 : 1;
  for (const h of humans) await store.addStats(h.uid, { wins: h.s % 2 === win ? 1 : 0, games: 1 });
}

/* ---------- conexões ---------- */
wss.on('connection', (ws, req) => {
  ws.alive = true;
  ws.ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  ws.user = null;
  ws.codes = new Set();
  ws.lastChat = 0;
  ws.chain = Promise.resolve();
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    // Uma mensagem por vez por conexão, para o login terminar antes do resto.
    ws.chain = ws.chain.then(() => handle(ws, m)).catch((e) => {
      console.error(e);
      if (m && m.id) send(ws, { id: m.id, t: 'ack', error: 'erro' });
    });
  });
  ws.on('close', () => { ws.codes.forEach((c) => { const r = rooms.get(c); if (r) r.subs.delete(ws); }); });
});

async function handle(ws, m) {
  const reply = (o) => send(ws, { t: 'ack', id: m.id, ...o });
  if (m.t === 'auth' || m.t === 'login' || m.t === 'register') return handleAuth(ws, m, reply);
  if (!ws.user) return reply({ error: 'auth' });
  if (m.t === 'ranking') return reply({ list: await store.top(20) });
  if (m.t === 'me') { const u = await store.byId(ws.user.id); return reply(u ? userOut(u) : { error: 'auth' }); }

  const code = String(m.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (code.length !== 4) return;
  const room = getRoom(code, m.t === 'sub' || m.t === 'set');
  switch (m.t) {
    case 'get':
      send(ws, { t: 'got', id: m.id, exists: !!(room && room.doc), doc: room && room.doc ? room.doc : null });
      break;
    case 'sub':
      room.subs.add(ws); ws.codes.add(code);
      send(ws, { t: 'doc', code, exists: !!room.doc, doc: room.doc });
      send(ws, { t: 'chathist', code, list: room.chat });
      break;
    case 'unsub':
      if (room) room.subs.delete(ws);
      ws.codes.delete(code);
      break;
    case 'set': {
      if (!isObj(m.doc) || JSON.stringify(m.doc).length > MAX_DOC) return reply({ error: 'invalid_argument' });
      const cur = room.doc;
      if (!cur) {
        // Sala nova: quem cria é o anfitrião e senta na vaga 0 com a própria conta.
        room.chat = []; room.recorded = null;
        m.doc.host = ws.user.id;
        m.doc.seats = m.doc.seats || {};
        m.doc.seats['0'] = { type: 'human', uid: ws.user.id, name: ws.user.nick };
      } else {
        // Só o anfitrião e quem tem lugar na sala gravam; jogada atrasada é descartada.
        const seated = Object.values(cur.seats || {}).some((x) => x && x.uid === ws.user.id);
        if (!seated) return reply({ error: 'sem_lugar' });
        if (cur.phase === 'play' && m.doc.phase === 'play' && m.doc.rev < cur.rev) return reply({});
        m.doc.host = cur.host;
      }
      room.doc = m.doc; room.touched = Date.now();
      broadcast(code, room); reply({});
      recordIfDone(room, room.doc).catch((e) => console.error('ranking:', e.message));
      break;
    }
    case 'update': {
      if (!room || !room.doc || !isObj(m.data)) return reply({ error: 'invalid_argument' });
      // Quem senta numa vaga usa a identidade da própria conta, não a que o aparelho disser.
      const seats = m.data.seats;
      if (isObj(seats)) {
        for (const k of Object.keys(seats)) {
          if (isObj(seats[k]) && seats[k].type === 'human') { seats[k].uid = ws.user.id; seats[k].name = ws.user.nick; }
          if (isObj(seats[k]) && seats[k].type !== 'human' && room.doc.seats && room.doc.seats[k] && room.doc.seats[k].type === 'human'
              && room.doc.host !== ws.user.id) delete seats[k];
        }
      }
      merge(room.doc, m.data); room.touched = Date.now();
      broadcast(code, room); reply({});
      break;
    }
    case 'delete':
      if (room && room.doc && room.doc.host === ws.user.id) { room.doc = null; broadcast(code, room); }
      reply({});
      break;
    case 'chat': {
      if (!room || !room.subs.has(ws)) return;
      const now = Date.now();
      if (now - ws.lastChat < 700) return;
      ws.lastChat = now;
      const x = String(m.text || '').trim().slice(0, 200);
      if (!x) return;
      const msg = { n: ws.user.nick, x, ts: now };
      room.chat.push(msg); if (room.chat.length > 60) room.chat.shift();
      const out = JSON.stringify({ t: 'chat', code, msg });
      room.subs.forEach((w) => { if (w.readyState === 1) w.send(out); });
      break;
    }
  }
}

// Mantém a conexão viva atrás do proxy do Render e remove salas esquecidas.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false; ws.ping();
  });
  const now = Date.now();
  rooms.forEach((r, c) => { if (!r.subs.size && now - r.touched > 6 * 3600 * 1000) rooms.delete(c); });
}, 25000);

(async () => {
  if (store.ready) await store.ready;
  SECRET = await store.secret();
  console.log('Contas guardadas em: ' + store.kind);
  server.listen(PORT, () => console.log('Dominó do Meladinha na porta ' + PORT));
})().catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });
