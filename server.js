const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');

// ---------- 数据库 ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'reno.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON'); // 启用外键约束，使 ON DELETE CASCADE 生效

db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    status TEXT DEFAULT 'active',
    last_login_ip TEXT DEFAULT '',
    last_login_at TEXT,
    total_budget REAL DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS categories(
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    color TEXT DEFAULT '',
    sort INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, name),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);
`);

// 默认分类(色板自动取色)
const DEFAULT_CATS = ['硬装','软装','电器','家具','其他'];
const CAT_COLOR_PALETTE = ['#2f6fed','#a855f7','#f59e0b','#10b981','#94a3b8','#ef4444','#06b6d4','#84cc16','#ec4899','#f97316','#8b5cf6','#14b8a6'];
const catColor = idx => CAT_COLOR_PALETTE[idx % CAT_COLOR_PALETTE.length];

// 为某用户初始化默认分类(幂等)
function seedDefaultCats(userId){
  const cx = db.prepare('INSERT OR IGNORE INTO categories(id,user_id,name,color,sort) VALUES(?,?,?,?,?)');
  const tx = db.transaction(() => {
    DEFAULT_CATS.forEach((name, i) => cx.run(uid(), userId, name, catColor(i), i));
  });
  tx();
}

// 存量库迁移：若 users 表缺少新列则补上（旧库兼容）
(function migrate(){
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c=>c.name);
  const add = (name, ddl) => { if(!cols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`); };
  add('role', "role TEXT DEFAULT 'user'");
  add('status', "status TEXT DEFAULT 'active'");
  add('last_login_ip', "last_login_ip TEXT DEFAULT ''");
  add('last_login_at', "last_login_at TEXT");
  add('total_budget', "total_budget REAL DEFAULT 0");
  // 为已有的每个用户初始化默认分类(幂等)
  const uids = db.prepare('SELECT id FROM users').all().map(r=>r.id);
  uids.forEach(id => seedDefaultCats(id));
})();

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
function uid(){ return 'r' + Date.now() + Math.random().toString(36).slice(2, 8); }

// ---------- 图形验证码（零依赖，手写 SVG）----------
const captchaStore = new Map(); // id -> {code, expires}
const CAP_EXPIRE = 5 * 60 * 1000; // 5 分钟
function makeCaptcha() {
  // 去除易混淆字符 0O1lI
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  const id = 'c' + Date.now() + Math.random().toString(36).slice(2, 8);
  captchaStore.set(id, { code, expires: Date.now() + CAP_EXPIRE });
  // 清理过期
  for (const [k, v] of captchaStore) if (v.expires < Date.now()) captchaStore.delete(k);
  return { id, code };
}
function verifyCaptcha(id, input) {
  if (!id || !input) return false;
  const rec = captchaStore.get(id);
  if (!rec) return false;
  captchaStore.delete(id); // 一次性使用
  return rec.expires >= Date.now() && rec.code.toLowerCase() === String(input).trim().toLowerCase();
}
function svgCaptcha(code) {
  const w = 120, h = 40;
  const colors = ['#2f6fed','#a855f7','#f59e0b','#10b981','#ef4444'];
  let chars = '';
  for (let i = 0; i < code.length; i++) {
    const x = 14 + i * 26;
    const y = 26 + Math.floor(Math.random() * 7);
    const rot = Math.floor(Math.random() * 30) - 15;
    const color = colors[Math.floor(Math.random() * colors.length)];
    chars += `<text x="${x}" y="${y}" font-size="30" font-weight="700" font-family="Arial" fill="${color}" transform="rotate(${rot} ${x} ${y})">${code[i]}</text>`;
  }
  // 干扰线
  let lines = '';
  for (let i = 0; i < 4; i++) {
    const x1 = Math.random()*w, y1 = Math.random()*h, x2 = Math.random()*w, y2 = Math.random()*h;
    lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#cbd5e1" stroke-width="1"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="#f1f4f8"/>
    ${lines}${chars}
  </svg>`;
}
// 获取客户端 IP（兼容 X-Forwarded-For）
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

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
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: '无管理员权限' });
  next();
}

// ---------- 认证 ----------
app.get('/api/captcha', (req, res) => {
  const { id, code } = makeCaptcha();
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Captcha-Id', id);
  res.send(svgCaptcha(code));
});

app.post('/api/register', (req, res) => {
  const { username, password, captchaId, captcha } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (!verifyCaptcha(captchaId, captcha)) return res.status(400).json({ error: '验证码错误或已失效' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username))
    return res.status(409).json({ error: '用户名已存在' });
  const hash = bcrypt.hashSync(String(password), 10);
  const info = db.prepare('INSERT INTO users(username,password_hash) VALUES(?,?)').run(username, hash);
  seedDefaultCats(info.lastInsertRowid);
  req.session.userId = info.lastInsertRowid;
  res.json({ ok: true, username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(String(password), u.password_hash))
    return res.status(401).json({ error: '用户名或密码错误' });
  if (u.status === 'frozen') return res.status(403).json({ error: '账号已被冻结，请联系管理员' });
  req.session.userId = u.id;
  db.prepare('UPDATE users SET last_login_ip=?, last_login_at=datetime(\'now\') WHERE id=?')
    .run(clientIp(req), u.id);
  res.json({ ok: true, username: u.username, role: u.role });
});

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const u = db.prepare('SELECT username, role, status, total_budget FROM users WHERE id=?').get(req.session.userId);
  res.json({ user: u ? u.username : null, role: u ? u.role : null, status: u ? u.status : null, total_budget: u ? (u.total_budget||0) : 0 });
});

// 设置/修改我的总预算总额
app.put('/api/budget', requireAuth, (req, res) => {
  const v = Number((req.body||{}).total_budget);
  if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: '预算金额无效' });
  db.prepare('UPDATE users SET total_budget=? WHERE id=?').run(v, req.session.userId);
  res.json({ ok: true, total_budget: v });
});

// ---------- 分类 API（每个用户独立一套）----------
// 读取当前用户的分类列表(确保已初始化默认分类)
app.get('/api/categories', requireAuth, (req, res) => {
  const uid_ = req.session.userId;
  const cnt = db.prepare('SELECT COUNT(*) c FROM categories WHERE user_id=?').get(uid_).c;
  if (cnt === 0) seedDefaultCats(uid_);
  const rows = db.prepare('SELECT id, name, color, sort FROM categories WHERE user_id=? ORDER BY sort, created_at').all(uid_);
  res.json(rows);
});

// ---- 管理员：分类管理（按 user_id 操作指定用户，但接口面向当前登录的 admin 自己）----
// 新增分类
app.post('/api/admin/categories', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: '分类名称必填' });
  if (db.prepare('SELECT id FROM categories WHERE user_id=? AND name=?').get(req.session.userId, name))
    return res.status(409).json({ error: '分类已存在' });
  const mx = db.prepare('SELECT COALESCE(MAX(sort),-1) s FROM categories WHERE user_id=?').get(req.session.userId).s;
  const id = uid();
  db.prepare('INSERT INTO categories(id,user_id,name,color,sort) VALUES(?,?,?,?,?)')
    .run(id, req.session.userId, name, catColor(mx + 1), mx + 1);
  res.json(db.prepare('SELECT id,name,color,sort FROM categories WHERE id=?').get(id));
});
// 重命名分类
app.put('/api/admin/categories/:id', requireAuth, requireAdmin, (req, res) => {
  const id = req.params.id;
  const c = db.prepare('SELECT id FROM categories WHERE id=? AND user_id=?').get(id, req.session.userId);
  if (!c) return res.status(404).json({ error: '分类不存在' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: '分类名称必填' });
  if (db.prepare('SELECT id FROM categories WHERE user_id=? AND name=? AND id<>?').get(req.session.userId, name, id))
    return res.status(409).json({ error: '分类已存在' });
  const old = db.prepare('SELECT name FROM categories WHERE id=?').get(id).name;
  db.prepare('UPDATE categories SET name=? WHERE id=?').run(name, id);
  // 同步更新 items 里引用旧分类名的记录
  db.prepare('UPDATE items SET category=? WHERE user_id=? AND category=?').run(name, req.session.userId, old);
  res.json({ ok: true, name });
});
// 删除分类（自动把引用记录归到「其他」）
app.delete('/api/admin/categories/:id', requireAuth, requireAdmin, (req, res) => {
  const id = req.params.id;
  const c = db.prepare('SELECT name FROM categories WHERE id=? AND user_id=?').get(id, req.session.userId);
  if (!c) return res.status(404).json({ error: '分类不存在' });
  const other = db.prepare('SELECT id FROM categories WHERE user_id=? AND name=?').get(req.session.userId, '其他');
  const fallback = other ? other.id : null;
  // 先迁移引用记录到「其他」(若不存在其他分类则建一个)
  if (!fallback) { const mx = db.prepare('SELECT COALESCE(MAX(sort),-1) s FROM categories WHERE user_id=?').get(req.session.userId).s; const nid = uid(); db.prepare('INSERT INTO categories(id,user_id,name,color,sort) VALUES(?,?,?,?,?)').run(nid, req.session.userId,'其他',catColor(mx+1),mx+1); }
  db.prepare('UPDATE items SET category=? WHERE user_id=? AND category=?').run('其他', req.session.userId, c.name);
  db.prepare('DELETE FROM categories WHERE id=? AND user_id=?').run(id, req.session.userId);
  res.json({ ok: true, moved: true });
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

// ---------- 管理员操作 ----------
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.role, u.status, u.last_login_ip, u.last_login_at, u.created_at,
           (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id) AS item_count
    FROM users u ORDER BY u.id
  `).all();
  res.json(rows);
});

app.post('/api/admin/users/:id/freeze', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '无效 id' });
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin') return res.status(403).json({ error: '不能冻结管理员账号' });
  db.prepare('UPDATE users SET status=? WHERE id=?').run('frozen', id);
  res.json({ ok: true, status: 'frozen' });
});

app.post('/api/admin/users/:id/unfreeze', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '无效 id' });
  const u = db.prepare('SELECT id FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  db.prepare('UPDATE users SET status=? WHERE id=?').run('active', id);
  res.json({ ok: true, status: 'active' });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '无效 id' });
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin') return res.status(403).json({ error: '不能删除管理员账号' });
  // 删除用户（items 通过外键 ON DELETE CASCADE 级联删除）
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('reno-expense 已启动，监听端口 ' + PORT));
