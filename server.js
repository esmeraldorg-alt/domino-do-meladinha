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

const ARQUIVOS = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  // Arquivos para instalar o jogo na tela inicial do celular (ícone e manifesto).
  const estatico = ARQUIVOS[url];
  if (estatico) {
    try {
      res.writeHead(200, { 'content-type': estatico[1], 'cache-control': 'public, max-age=86400' });
      res.end(fs.readFileSync(path.join(__dirname, 'public', estatico[0])));
    } catch { res.writeHead(404); res.end('not found'); }
    return;
  }
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
  persistir(code, room);
}
// Guarda a mesa no banco (no máximo uma vez por segundo) para ela sobreviver a um reinício do servidor.
const adiados = new Map();
function persistir(code, room) {
  if (adiados.has(code)) return;
  adiados.set(code, setTimeout(() => {
    adiados.delete(code);
    const op = room.doc ? store.saveRoom(code, room.doc) : store.deleteRoom(code);
    Promise.resolve(op).catch((e) => console.error('mesa:', e.message));
  }, 1000));
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
const guests = new Map(); // apelido em minúsculas -> { gid, ws } (convidados conectados)
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
  if (m.t === 'guest') {
    // Convidado: joga e aparece nas mesas só com um apelido, sem senha. Não fica no banco e não entra no ranking.
    if (!/^[A-Za-z0-9_-]{3,16}$/.test(nick)) return reply({ error: 'nick_invalido' });
    if (await store.byNick(nick.toLowerCase())) return reply({ error: 'nick_registrado' });
    const gid = /^g_[a-z0-9]{8,24}$/.test(String(m.gid || '')) ? m.gid : 'g_' + crypto.randomBytes(8).toString('hex');
    const key = nick.toLowerCase(), outro = guests.get(key);
    if (outro && outro.gid !== gid && outro.ws.readyState === 1) return reply({ error: 'nick_em_uso' });
    guests.set(key, { gid, ws });
    ws.user = { id: gid, nick: nick + ' (convidado)', guest: true };
    return reply({ uid: gid, nick: ws.user.nick, wins: 0, losses: 0, abandons: 0, guest: true });
  }
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
  if (m.t === 'auth' || m.t === 'login' || m.t === 'register' || m.t === 'guest') return handleAuth(ws, m, reply);
  if (m.t === 'ranking') return reply({ list: await store.top(20) }); // público: aparece já na tela inicial
  if (m.t === 'presence') { ws.presence = m.mode === 'local' ? 'local' : 'menu'; return; }   // vale também para quem não entrou com conta
  if (!ws.user) return reply({ error: 'auth' });
  const semConta = { uid: ws.user.id, nick: ws.user.nick, wins: 0, losses: 0, abandons: 0, guest: true };
  if (m.t === 'me') { if (ws.user.guest) return reply(semConta); const u = await store.byId(ws.user.id); return reply(u ? userOut(u) : { error: 'auth' }); }
  if (m.t === 'online') {
    // Quem está conectado agora e o que está fazendo: numa mesa, assistindo, jogando contra robôs no próprio aparelho, ou no menu.
    const gente = new Map();
    let anonimos = 0;
    wss.clients.forEach((w) => {
      if (w.readyState === 1 && !w.user && w.presence === 'local') anonimos++;   // joga contra robôs sem ter entrado com conta nem como convidado
      if (w.readyState !== 1 || !w.user) return;
      let onde = w.presence === 'local' ? 'jogando contra robôs' : 'no menu', ordem = w.presence === 'local' ? 2 : 3;
      for (const c of w.codes) {
        const r = rooms.get(c);
        if (!r || !r.doc) continue;
        const sentado = Object.values(r.doc.seats || {}).some((x) => x && x.uid === w.user.id);
        onde = (sentado ? 'na mesa ' : 'assistindo a mesa ') + c; ordem = sentado ? 1 : 2;
        if (sentado) break;
      }
      const ant = gente.get(w.user.id);
      if (!ant || ordem < ant.ordem) gente.set(w.user.id, { nick: w.user.nick, onde, ordem });
    });
    const list = [...gente.values()].sort((a, b) => a.ordem - b.ordem || a.nick.localeCompare(b.nick)).slice(0, 40).map(({ nick, onde }) => ({ nick, onde }));
    if (anonimos) list.push({ nick: anonimos === 1 ? '1 jogador sem cadastro' : anonimos + ' jogadores sem cadastro', onde: 'jogando contra robôs' });
    return reply({ list });
  }
  if (m.t === 'rooms') {
    // Mesas com alguém conectado: no lobby (com ou sem vaga) e em jogo. Qualquer pessoa com conta pode assistir.
    const list = [];
    rooms.forEach((r, code) => {
      const d = r.doc;
      if (!d || !r.subs.size || !d.seats) return;
      const seats = d.mode === '2' ? [0, 2] : [0, 1, 2, 3];
      const open = d.phase === 'lobby' ? seats.filter((s) => d.seats[s] && d.seats[s].type === 'open').length : 0;
      const players = seats.filter((s) => d.seats[s] && d.seats[s].type === 'human').map((s) => d.seats[s].name);
      const robos = seats.filter((s) => d.seats[s] && d.seats[s].type === 'bot').length;
      const item = { code, mode: d.mode === '2' ? '2' : '4', playing: d.phase === 'play', players, open, robos, touched: r.touched };
      if (item.playing && d.game && Array.isArray(d.game.scores)) item.scores = d.game.scores;
      list.push(item);
    });
    list.sort((a, b) => b.touched - a.touched);
    return reply({ list: list.slice(0, 20).map(({ touched, ...rest }) => rest) });
  }
  if ((m.t === 'abandon' || m.t === 'result') && ws.user.guest) return reply(semConta);   // convidado não pontua
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
        m.doc.reservas = cur.reservas || [];   // a fila de quem reservou lugar é do servidor, o estado do jogo não a conhece
        // Cadeiras já entregues a um robô porque a pessoa saiu não voltam a ser humanas por um estado atrasado.
        for (const s of Object.keys(cur.seats || {})) {
          if (cur.seats[s] && (cur.seats[s].left || cur.seats[s].took) && m.doc.seats) m.doc.seats[s] = cur.seats[s];
        }
      }
      room.doc = m.doc; room.touched = Date.now();
      // O ranking olha quem estava sentado ANTES de entrarem os que reservaram lugar.
      recordIfDone(room, room.doc).catch((e) => console.error('ranking:', e.message));
      aplicarReservas(room);
      broadcast(code, room); reply({});
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
      if (d.phase !== 'play' || !d.game) return reply({ error: 'indisponivel' });
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
    case 'reserve': {
      if (!room || !room.doc || !room.subs.has(ws)) return reply({ error: 'invalid_argument' });
      const d = room.doc;
      if (d.phase !== 'play' || !d.game) return reply({ error: 'indisponivel' });
      if (Object.values(d.seats || {}).some((x) => x && x.uid === ws.user.id)) return reply({ error: 'ja_sentado' });
      d.reservas = Array.isArray(d.reservas) ? d.reservas : [];
      if (!d.reservas.some((r) => r.uid === ws.user.id)) {
        if (d.reservas.length >= 6) return reply({ error: 'fila_cheia' });
        d.reservas.push({ uid: ws.user.id, nick: ws.user.nick });
      }
      aplicarReservas(room);                       // se já tem cadeira livre, senta na hora
      d.rev = (d.rev || 0) + 1;
      room.touched = Date.now();
      broadcast(code, room);
      reply({ sentou: Object.values(d.seats || {}).some((x) => x && x.uid === ws.user.id) });
      break;
    }
    case 'unreserve': {
      if (!room || !room.doc || !Array.isArray(room.doc.reservas)) return reply({});
      const antes = room.doc.reservas.length;
      room.doc.reservas = room.doc.reservas.filter((r) => r.uid !== ws.user.id);
      if (room.doc.reservas.length !== antes) { room.doc.rev = (room.doc.rev || 0) + 1; broadcast(code, room); }
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

/* ---------- reserva de lugar ---------- */
// Quem assiste pode reservar: assim que uma cadeira de robô fica livre (a rodada acabou, ou alguém saiu), o primeiro da fila senta sozinho.
function aplicarReservas(room) {
  const d = room.doc;
  if (!d || d.phase !== 'play' || !d.game || !Array.isArray(d.reservas) || !d.reservas.length) return false;
  const ativos = d.mode === '2' ? ['0', '2'] : ['0', '1', '2', '3'];
  let mudou = false;
  for (let i = 0; i < d.reservas.length;) {
    const r = d.reservas[i];
    const jaSentado = Object.values(d.seats || {}).some((x) => x && x.uid === r.uid);
    const presente = [...room.subs].some((w) => w.user && w.user.id === r.uid);
    if (jaSentado || !presente) { d.reservas.splice(i, 1); mudou = true; continue; }   // já sentou ou foi embora
    const livres = ativos.filter((s) => d.seats[s] && d.seats[s].type === 'bot' && (d.seats[s].left || d.game.handOver));
    if (!livres.length) { i++; continue; }
    const s = livres.find((k) => d.seats[k].left) || livres[0];   // prefere a cadeira que alguém deixou
    const antigo = d.seats[s].name;
    d.seats[s] = { type: 'human', uid: r.uid, name: r.nick, took: true };
    d.reservas.splice(i, 1);
    d.game.msg = r.nick + ' sentou no lugar de ' + antigo + '.';
    mudou = true;
  }
  if (mudou) d.rev = (d.rev || 0) + 1;
  return mudou;
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
    aplicarReservas(room);   // a cadeira que ficou vaga vai para o primeiro da fila, se houver
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
  rooms.forEach((r, c) => {
    if (!r.subs.size && now - r.touched > 6 * 3600 * 1000) { rooms.delete(c); Promise.resolve(store.deleteRoom(c)).catch(() => {}); }
  });
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
  // Reabre as mesas que estavam ativas antes do reinício; os jogadores reconectam sozinhos e continuam.
  try {
    for (const [code, doc] of await store.loadRooms()) {
      if (doc && doc.seats) rooms.set(code, { doc, subs: new Set(), touched: Date.now(), chat: [], recorded: doc.game && doc.game.over ? doc.gameId : null });
    }
    console.log('Mesas recuperadas: ' + rooms.size);
  } catch (e) { console.error('Não consegui recuperar as mesas:', e.message); }
  console.log('Contas guardadas em: ' + store.kind);
  server.listen(PORT, () => console.log('Dominó do Meladinha na porta ' + PORT));
})().catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });
