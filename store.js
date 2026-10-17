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
    async byNick(lower) { return Object.values(db.users).find((u) => u.nickLower === lower) || null; },
    async byId(id) { return db.users[id] || null; },
    async create(u) {
      if (await this.byNick(u.nickLower)) throw Object.assign(new Error('dup'), { code: 'dup' });
      db.users[u.id] = u; save(); return u;
    },
    async addStats(id, { wins, games }) {
      const u = db.users[id]; if (!u) return;
      u.wins += wins; u.games += games; save();
    },
    async top(n) {
      return Object.values(db.users)
        .sort((a, b) => b.wins - a.wins || a.games - b.games || a.nick.localeCompare(b.nick))
        .slice(0, n).map((u) => ({ nick: u.nick, wins: u.wins, games: u.games }));
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
    async byNick(lower) { await ready; return users.findOne({ nickLower: lower }); },
    async byId(id) { await ready; return users.findOne({ id }); },
    async create(u) {
      await ready;
      try { await users.insertOne(u); } catch (e) { if (e.code === 11000) throw Object.assign(new Error('dup'), { code: 'dup' }); throw e; }
      return u;
    },
    async addStats(id, { wins, games }) { await ready; await users.updateOne({ id }, { $inc: { wins, games } }); },
    async top(n) {
      await ready;
      const list = await users.find({}).sort({ wins: -1, games: 1, nick: 1 }).limit(n).toArray();
      return list.map((u) => ({ nick: u.nick, wins: u.wins, games: u.games }));
    },
  };
}

module.exports = () => (process.env.MONGODB_URI ? mongoStore(process.env.MONGODB_URI) : fileStore());
