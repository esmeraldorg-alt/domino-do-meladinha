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
const EMOJIS = ['😀', '😂', '😎', '😡', '😭', '👏', '👍', '🔥', '🤔', '🙏'];
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
function publicUser(u) { return { id: u.id, nick: u.nick, wins: u.wins || 0, losses: u.losses || 0 }; }
// A resposta usa "uid" porque "id" já é o número do pedido.
function userOut(u, token) { return { uid: u.id, nick: u.nick, wins: u.wins || 0, losses: u.losses || 0, abandons: u.abandons || 0, token }; }
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
      salt, hash: await scrypt(pass, salt), wins: 0, losses: 0, games: 0, recent: [], created: Date.now(),
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
// Partida online terminada: cada pessoa com conta ganha vitória ou derrota, uma vez por jogo (robôs não pontuam).
async function recordIfDone(room, doc) {
  const g = doc.game;
  if (!g || !g.over || !doc.gameId || room.recorded === doc.gameId) return;
  room.recorded = doc.gameId;
  const humans = [];
  for (let s = 0; s < 4; s++) {
    const x = doc.seats && doc.seats[s];
    if (x && x.type === 'human' && x.uid) humans.push({ s, uid: x.uid });
  }
  const win = g.scores[0] >= g.scores[1] ? 0 : 1;
  // Em duplas as cadeiras 0 e 2 formam a dupla A; no 1 contra 1 a cadeira 0 é o time 0 e a 2 o time 1.
  const teamOf = (s) => (doc.mode === '2' ? s >> 1 : s % 2);
  for (const h of humans) {
    const won = teamOf(h.s) === win;
    await store.addStats(h.uid, { wins: won ? 1 : 0, losses: won ? 0 : 1, games: 1 }, doc.gameId);
  }
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
  ws.on('close', () => {
    const uid = ws.user && ws.user.id;
    ws.codes.forEach((c) => {
      const r = rooms.get(c); if (!r) return;
      r.subs.delete(ws);
      // Sumiu sem avisar: espera um tempo para a pessoa voltar; se não voltar, um robô assume.
      if (uid) {
        setTimeout(() => {
          const rr = rooms.get(c);
          if (!rr || !rr.doc) return;
          if ([...rr.subs].some((w) => w.user && w.user.id === uid)) return;
          convertSeat(rr, c, uid);
        }, GRACE_MS);
      }
    });
  });
});

async function handle(ws, m) {
  const reply = (o) => send(ws, { t: 'ack', id: m.id, ...o });
  if (m.t === 'auth' || m.t === 'login' || m.t === 'register') return handleAuth(ws, m, reply);
  if (m.t === 'ranking') return reply({ list: await store.top(20) }); // público: aparece já na tela inicial
  if (!ws.user) return reply({ error: 'auth' });
  if (m.t === 'me') { const u = await store.byId(ws.user.id); return reply(u ? userOut(u) : { error: 'auth' }); }
  if (m.t === 'rooms') {
    // Mesas com alguém conectado: no lobby (com ou sem vaga) e em jogo. Qualquer pessoa com conta pode assistir.
    const list = [];
    rooms.forEach((r, code) => {
      const d = r.doc;
      if (!d || !r.subs.size || !d.seats) return;
      const seats = d.mode === '2' ? [0, 2] : [0, 1, 2, 3];
      const open = d.phase === 'lobby' ? seats.filter((s) => d.seats[s] && d.seats[s].type === 'open').length : 0;
      const players = seats.filter((s) => d.seats[s] && d.seats[s].type === 'human').map((s) => d.seats[s].name);
      const item = { code, mode: d.mode === '2' ? '2' : '4', playing: d.phase === 'play', players, open, touched: r.touched };
      if (item.playing && d.game && Array.isArray(d.game.scores)) item.scores = d.game.scores;
      list.push(item);
    });
    list.sort((a, b) => b.touched - a.touched);
    return reply({ list: list.slice(0, 20).map(({ touched, ...rest }) => rest) });
  }
  if (m.t === 'abandon') {
    // Saiu de uma partida local (contra robôs ou no mesmo celular) antes de terminar.
    const gameId = String(m.gameId || '').slice(0, 40);
    if (!gameId) return reply({ error: 'invalid_argument' });
    await store.addAbandon(ws.user.id, 'AL' + gameId);
    const u = await store.byId(ws.user.id);
    return reply(u ? userOut(u) : { error: 'auth' });
  }
  if (m.t === 'result') {
    // Partida local (contra robôs ou no mesmo celular) que chegou ao fim: vale para quem está com a conta.
    const gameId = String(m.gameId || '').slice(0, 40);
    if (!gameId || typeof m.win !== 'boolean') return reply({ error: 'invalid_argument' });
    await store.addStats(ws.user.id, { wins: m.win ? 1 : 0, losses: m.win ? 0 : 1, games: 1 }, 'L' + gameId);
    const u = await store.byId(ws.user.id);
    return reply(u ? userOut(u) : { error: 'auth' });
  }

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
        // Cadeiras já entregues a um robô porque a pessoa saiu não voltam a ser humanas por um estado atrasado.
        for (const s of Object.keys(cur.seats || {})) {
          if (cur.seats[s] && (cur.seats[s].left || cur.seats[s].took) && m.doc.seats) m.doc.seats[s] = cur.seats[s];
        }
      }
      room.doc = m.doc; room.touched = Date.now();
      broadcast(code, room); reply({});
      recordIfDone(room, room.doc).catch((e) => console.error('ranking:', e.message));
      break;
    }
    case 'update': {
      if (!room || !room.doc || !isObj(m.data)) return reply({ error: 'invalid_argument' });
      // Só o lobby aceita mudanças (sentar, trocar vaga, trocar modo); quem assiste não mexe na partida.
      if (room.doc.phase !== 'lobby') return reply({ error: 'jogo_ja_comecou' });
      if (m.data.mode !== undefined && room.doc.host !== ws.user.id) delete m.data.mode;
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
    case 'take': {
      // Quem assiste senta no lugar de um robô: na hora, se a cadeira foi deixada por alguém que saiu; senão, só entre as rodadas.
      if (!room || !room.doc || !room.subs.has(ws)) return reply({ error: 'invalid_argument' });
      const d = room.doc;
      if (d.phase !== 'play' || !d.game || d.game.over) return reply({ error: 'indisponivel' });
      if (Object.values(d.seats || {}).some((x) => x && x.uid === ws.user.id)) return reply({ error: 'ja_sentado' });
      const s = String(m.seat);
      const ativos = d.mode === '2' ? ['0', '2'] : ['0', '1', '2', '3'];
      const x = d.seats[s];
      if (!x || !ativos.includes(s) || x.type !== 'bot') return reply({ error: 'indisponivel' });
      if (!(x.left || d.game.handOver)) return reply({ error: 'espere_rodada' });
      const antigo = x.name;
      d.seats[s] = { type: 'human', uid: ws.user.id, name: ws.user.nick, took: true };
      d.rev = (d.rev || 0) + 1;
      d.game.msg = ws.user.nick + ' sentou no lugar de ' + antigo + '.';
      room.touched = Date.now();
      broadcast(code, room);
      reply({});
      break;
    }
    case 'emoji': {
      // Reação rápida: só emojis da lista, no máximo uma a cada 1,2 segundo.
      if (!room || !room.subs.has(ws) || !EMOJIS.includes(m.e)) return;
      const agora = Date.now();
      if (agora - (ws.lastEmoji || 0) < 1200) return;
      ws.lastEmoji = agora;
      const out = JSON.stringify({ t: 'emoji', code, n: ws.user.nick, e: m.e });
      room.subs.forEach((w) => { if (w.readyState === 1) w.send(out); });
      break;
    }
    case 'leave':
      if (room) { convertSeat(room, code, ws.user.id); room.subs.delete(ws); }
      ws.codes.delete(code);
      break;
    case 'chat': {
      if (!room || !room.subs.has(ws)) return;
      const now = Date.now();
      if (now - ws.lastChat < 700) return;
      ws.lastChat = now;
      const x = String(m.text || '').trim().slice(0, 200);
      if (!x) return;
      const seated = room.doc && Object.values(room.doc.seats || {}).some((s) => s && s.uid === ws.user.id);
      const msg = { n: ws.user.nick, x, ts: now };
      if (!seated) msg.w = true; // quem assiste aparece como "assistindo"
      room.chat.push(msg); if (room.chat.length > 60) room.chat.shift();
      const out = JSON.stringify({ t: 'chat', code, msg });
      room.subs.forEach((w) => { if (w.readyState === 1) w.send(out); });
      break;
    }
  }
}

/* ---------- saída de jogador ---------- */
// Quem sai de uma partida em andamento vira um robô na mesma cadeira e ganha um abandono.
// No lobby a vaga volta a ficar livre. Se o anfitrião sai, a mesa passa para outra pessoa; sem ninguém, a sala fecha.
const GRACE_MS = Number(process.env.GRACE_MS) || 30000;
function convertSeat(room, code, uid) {
  const d = room.doc;
  if (!d || !d.seats) return false;
  const k = Object.keys(d.seats).find((s) => d.seats[s] && d.seats[s].type === 'human' && d.seats[s].uid === uid);
  if (k === undefined) return false;
  const nick = d.seats[k].name;
  if (d.phase === 'lobby') {
    if (d.host === uid) { room.doc = null; broadcast(code, room); return true; }
    d.seats[k] = { type: 'open', uid: null, name: '' };
  } else {
    const aindaJogando = !(d.game && d.game.over);
    d.seats[k] = { type: 'bot', uid: null, name: nick + ' (robô)', left: true };
    if (aindaJogando && d.gameId) store.addAbandon(uid, 'A' + d.gameId).catch((e) => console.error('abandono:', e.message));
    if (d.host === uid) {
      const next = Object.values(d.seats).find((x) => x && x.type === 'human' && x.uid);
      if (!next) { room.doc = null; broadcast(code, room); return true; }
      d.host = next.uid;
    }
    d.rev = (d.rev || 0) + 1;
    if (d.game) d.game.msg = nick + ' saiu e um robô assumiu o lugar.';
  }
  room.touched = Date.now();
  broadcast(code, room);
  return true;
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

// ajustes.json: correções de pontos feitas à mão, cada uma aplicada uma única vez (pela chave "id").
// Formato: [{ "id": "ajuste-1", "nick": "fulano", "wins": 5, "losses": 0 }]
async function aplicarAjustes() {
  let lista = [];
  try { lista = JSON.parse(fs.readFileSync(path.join(__dirname, 'ajustes.json'), 'utf8')); } catch { return; }
  for (const a of lista) {
    if (!a || !a.id || !a.nick) continue;
    const u = await store.byNick(String(a.nick).toLowerCase());
    if (!u) { console.log('Ajuste ' + a.id + ': usuário ' + a.nick + ' não existe, fica para depois.'); continue; }
    if (!(await store.once('ajuste:' + a.id))) continue;
    const wins = Math.max(0, +a.wins || 0), losses = Math.max(0, +a.losses || 0);
    await store.addStats(u.id, { wins, losses, games: wins + losses }, 'ajuste:' + a.id);
    console.log('Ajuste ' + a.id + ' aplicado em ' + u.nick + ': +' + wins + ' vitórias, +' + losses + ' derrotas.');
  }
}

(async () => {
  if (store.ready) await store.ready;
  SECRET = await store.secret();
  await aplicarAjustes();
  console.log('Contas guardadas em: ' + store.kind);
  server.listen(PORT, () => console.log('Dominó do Meladinha na porta ' + PORT));
})().catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });
