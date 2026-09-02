const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');

// ---------- 数据库 ----------
const DATA_DIR = process.env.DATA_DIR || '/data';
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'reno.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS items(
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT DEFAULT '其他',
    supplier TEXT DEFAULT '',
    budget REAL DEFAULT 0,
    actual REAL DEFAULT 0,
    deposit REAL DEFAULT 0,
    other REAL DEFAULT 0,
    date TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);
`);

// ---------- 应用 ----------
const app = express();
app.use(express.json());
app.use(cookieSession({
  name: 'reno_session',
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  maxAge: 30 * 24 * 3600 * 1000,
  httpOnly: true,
  sameSite: 'lax'
}));
app.use(express.static(path.join(__dirname, 'public')));

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const uid = () => 'r' + Date.now() + Math.random().toString(36).slice(2, 8);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  next();
}

// ---------- 认证 ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username))
    return res.status(409).json({ error: '用户名已存在' });
  const hash = bcrypt.hashSync(String(password), 10);
  const info = db.prepare('INSERT INTO users(username,password_hash) VALUES(?,?)').run(username, hash);
  req.session.userId = info.lastInsertRowid;
  res.json({ ok: true, username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(String(password), u.password_hash))
    return res.status(401).json({ error: '用户名或密码错误' });
  req.session.userId = u.id;
  res.json({ ok: true, username: u.username });
});

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const u = db.prepare('SELECT username FROM users WHERE id=?').get(req.session.userId);
  res.json({ user: u ? u.username : null });
});

// ---------- 记录 CRUD（全部按 user_id 隔离）----------
app.get('/api/items', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE user_id=? ORDER BY date DESC, created_at DESC').all(req.session.userId);
  res.json(rows);
});

app.post('/api/items', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: '项目名称必填' });
  const id = uid();
  db.prepare(`INSERT INTO items(id,user_id,name,category,supplier,budget,actual,deposit,other,date,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, req.session.userId, String(b.name).trim(), b.category || '其他', b.supplier || '',
    num(b.budget), num(b.actual), num(b.deposit), num(b.other), b.date || null, b.note || '');
  res.json(db.prepare('SELECT * FROM items WHERE id=?').get(id));
});

app.put('/api/items/:id', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!db.prepare('SELECT id FROM items WHERE id=? AND user_id=?').get(req.params.id, req.session.userId))
    return res.status(404).json({ error: '记录不存在' });
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: '项目名称必填' });
  db.prepare(`UPDATE items SET name=?,category=?,supplier=?,budget=?,actual=?,deposit=?,other=?,date=?,note=?
    WHERE id=? AND user_id=?`).run(
    String(b.name).trim(), b.category || '其他', b.supplier || '',
    num(b.budget), num(b.actual), num(b.deposit), num(b.other), b.date || null, b.note || '',
    req.params.id, req.session.userId);
  res.json(db.prepare('SELECT * FROM items WHERE id=?').get(req.params.id));
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM items WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('reno-expense 已启动，监听端口 ' + PORT));
