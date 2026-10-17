// Guarda contas e ranking. Com MONGODB_URI usa o MongoDB (dura para sempre).
// Sem ela usa um arquivo local, que no plano grátis do Render se perde quando o servidor reinicia.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fileStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
  let db = { users: {}, secret: null };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* arquivo novo */ }
  db.users = db.users || {};
  let timer = null;
  function save() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); }
      catch (e) { console.error('Não consegui salvar os dados:', e.message); }
    }, 300);
  }
  return {
    kind: 'arquivo local (os dados se perdem quando o servidor reinicia no Render)',
    async secret() {
      if (!db.secret) { db.secret = crypto.randomBytes(32).toString('hex'); save(); }
      return db.secret;
    },
    // Devolve true só na primeira vez que a chave é usada (para ajustes que não podem rodar duas vezes).
    async once(key) {
      db.once = db.once || {};
      if (db.once[key]) return false;
      db.once[key] = Date.now(); save(); return true;
    },
    async byNick(lower) { return Object.values(db.users).find((u) => u.nickLower === lower) || null; },
    async byId(id) { return db.users[id] || null; },
    async create(u) {
      if (await this.byNick(u.nickLower)) throw Object.assign(new Error('dup'), { code: 'dup' });
      db.users[u.id] = u; save(); return u;
    },
    // Cada partida (gameId) conta uma vez por jogador; devolve false se já tinha sido contada.
    async addStats(id, { wins, losses, games }, gameId) {
      const u = db.users[id]; if (!u) return false;
      u.recent = (u.recent || []).slice(-30);
      if (u.recent.includes(gameId)) return false;
      u.recent.push(gameId);
      u.wins = (u.wins || 0) + wins; u.losses = (u.losses || 0) + losses; u.games = (u.games || 0) + games;
      save(); return true;
    },
    async top(n) {
      return Object.values(db.users)
        .filter((u) => (u.games || 0) > 0)
        .sort((a, b) => (b.wins || 0) - (a.wins || 0) || (a.losses || 0) - (b.losses || 0) || a.nick.localeCompare(b.nick))
        .slice(0, n).map((u) => ({ nick: u.nick, wins: u.wins || 0, losses: u.losses || 0 }));
    },
  };
}

function mongoStore(uri) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri);
  let users, meta;
  const ready = (async () => {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'domino');
    users = db.collection('users');
    meta = db.collection('meta');
    await users.createIndex({ nickLower: 1 }, { unique: true });
    await users.createIndex({ id: 1 }, { unique: true });
  })();
  return {
    kind: 'MongoDB',
    ready,
    async secret() {
      await ready;
      let d = await meta.findOne({ _id: 'secret' });
      if (!d) {
        try { await meta.insertOne({ _id: 'secret', v: crypto.randomBytes(32).toString('hex') }); } catch { /* outro processo criou */ }
        d = await meta.findOne({ _id: 'secret' });
      }
      return d.v;
    },
    // Devolve true só na primeira vez que a chave é usada (para ajustes que não podem rodar duas vezes).
    async once(key) {
      await ready;
      try { await meta.insertOne({ _id: 'once:' + key, at: Date.now() }); return true; }
      catch (e) { if (e.code === 11000) return false; throw e; }
    },
    async byNick(lower) { await ready; return users.findOne({ nickLower: lower }); },
    async byId(id) { await ready; return users.findOne({ id }); },
    async create(u) {
      await ready;
      try { await users.insertOne(u); } catch (e) { if (e.code === 11000) throw Object.assign(new Error('dup'), { code: 'dup' }); throw e; }
      return u;
    },
    // Cada partida (gameId) conta uma vez por jogador; devolve false se já tinha sido contada.
    async addStats(id, { wins, losses, games }, gameId) {
      await ready;
      const r = await users.updateOne(
        { id, recent: { $ne: gameId } },
        { $inc: { wins, losses, games }, $push: { recent: { $each: [gameId], $slice: -30 } } },
      );
      return r.modifiedCount > 0;
    },
    async top(n) {
      await ready;
      const list = await users.find({ games: { $gt: 0 } }).sort({ wins: -1, losses: 1, nick: 1 }).limit(n).toArray();
      return list.map((u) => ({ nick: u.nick, wins: u.wins || 0, losses: u.losses || 0 }));
    },
  };
}

module.exports = () => (process.env.MONGODB_URI ? mongoStore(process.env.MONGODB_URI) : fileStore());
