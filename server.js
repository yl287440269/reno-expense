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

// 简单 CSV 解析（支持双引号包裹、逗号内逗号）
function parseCSV(text) {
  const rows = [];
  let cur = '', row = [], inQuote = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '"') {
        if (s[i+1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += c;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      row.push(cur); cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i+1] === '\n') i++;
      row.push(cur); cur = '';
      // 跳过空行
      if (row.some(x => String(x).trim() !== '')) rows.push(row);
      row = [];
    } else {
      cur += c;
    }
  }
  row.push(cur);
  if (row.some(x => String(x).trim() !== '')) rows.push(row);
  return rows;
}

// 归一化列头（去掉空格/括号/全角，匹配中文/英文别名）
const NORMALIZE = {
  // 名称
  'name':['名称','项目','项目名称','项目名','事项','name','item'],
  // 类别
  'category':['类别','分类','类型','类型分类','category'],
  // 供应商
  'supplier':['商家','供应商','品牌','商家供应商','supplier','vendor','brand'],
  // 预算
  'budget':['预算','原预算','原先预算','预算金额','计划金额','预算价','budget'],
  // 实际
  'actual':['实际','实际价','实际价格','实际总价','实际花费','实际金额','总价','成交价','金额','actual'],
  // 定金
  'deposit':['定金','订金','已付定金','预付','预付款','deposit'],
  // 其他/进度款
  'other':['进度款','其他','已付进度','已付','已付款','已付金额','other','paid','已支付'],
  // 日期
  'date':['日期','时间','日期时间','date','time'],
  // 备注
  'note':['备注','说明','描述','note','remark','desc','注释']
};
const CAT_ALIAS = {
  '硬装':['硬装','硬装类','基础装修'], '软装':['软装','软装类','软饰'],
  '电器':['电器','家电','电器类','大小家电'], '家具':['家具','家具类','家私'],
  '其他':['其他','其它','杂项','其他类']
};
function normCol(header) {
  const h = String(header || '').toLowerCase().replace(/[（）()\s_\-、\/]/g, '');
  for (const [key, aliases] of Object.entries(NORMALIZE)) {
    if (aliases.includes(h) || (h && aliases.some(a => h.includes(a.toLowerCase().replace(/[（）()\s_\-、\/]/g,''))))) {
      return key;
    }
  }
  return null;
}
function normalizeCategory(cat) {
  const c = String(cat || '').trim();
  for (const [key, aliases] of Object.entries(CAT_ALIAS)) {
    if (aliases.some(a => c.includes(a))) return key;
  }
  return c || '其他';
}

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

// ---------- 批量导入（接收前端解析好的记录数组，列名映射在此完成）----------
app.post('/api/import', requireAuth, (req, res) => {
  const records = (req.body && Array.isArray(req.body.records)) ? req.body.records : null;
  if (!records) return res.status(400).json({ error: '缺少 records 数组' });
  if (records.length === 0) return res.status(400).json({ error: '没有可导入的记录' });

  const insert = db.prepare(`INSERT INTO items(id,user_id,name,category,supplier,budget,actual,deposit,other,date,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  let count = 0, skipped = 0;
  const tx = db.transaction((items) => {
    for (const r of items) {
      const name = String(r.name || '').trim();
      if (!name || name === '合计' || name === '总计' || /^小计$/i.test(name)) { skipped++; continue; }
      const category = normalizeCategory(r.category);
      insert.run(uid(), req.session.userId, name, category,
        String(r.supplier || ''), num(r.budget), num(r.actual), num(r.deposit), num(r.other),
        r.date || null, String(r.note || ''));
      count++;
    }
  });
  tx(records);
  res.json({ ok: true, imported: count, skipped });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('reno-expense 已启动，监听端口 ' + PORT));
