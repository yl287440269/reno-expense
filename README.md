# 装修费用与预算记录 · Reno Expense

一个面向家装/装修场景的**多用户费用与预算记账应用**。用于记录装修期间每一笔支出：类别、原预算、实际花费、已付定金、待付尾款，自动汇总与对比，帮你一眼看清「预算有没有超支、还有多少尾款没付」。

- 🌐 后端：Node.js + Express
- 💾 数据库：SQLite（数据落盘到数据卷，多用户数据严格隔离）
- 🐳 部署：Docker，一键启动
- 🔐 鉴权：用户注册 / 登录（bcrypt 密码哈希 + 加密 Cookie 会话）
- 🧩 前端：原生 HTML/CSS/JS 单页应用（无框架、无构建、即开即用）

---

## 功能特性

- **五大类别**：硬装 / 软装 / 电器 / 家具 / 其他（可筛选）
- **每笔详细记录**：
  - 项目名称、商家/供应商、日期、备注
  - 原先预算、实际总价
  - 已付定金、已付进度款/其他
- **自动计算**（无需手算）：
  - 已付合计 = 定金 + 进度款
  - 待付尾款 = 实际总价 − 已付合计
  - 付款进度百分比、是否已结清
  - 相对预算的 **超支 / 结余**
- **总览看板**：总预算、实际总价、已付合计、待付尾款、预算差额
- **分类对比图**：每个类别「预算 vs 实际」条形图
- **多用户隔离**：每个账号的数据按用户独立存储，互不可见
- **导入 / 导出备份**：按账号导出 JSON 备份，可随时导入恢复

---

## 快速开始（Docker 推荐）

前置：已安装 Docker / Docker Compose。

```bash
# 1. 进入项目目录
cd reno-expense

# 2. （可选）修改配置
#    编辑 docker-compose.yml，务必把 SESSION_SECRET 改成随机长字符串
vim docker-compose.yml

# 3. 构建并启动
docker compose up -d --build

# 4. 浏览器访问
open http://localhost:3000
# 注册第一个账号即可开始使用
```

> `SESSION_SECRET` 用于加密会话 Cookie，**默认值是占位符，上线 / 公网使用前必须替换**，否则会话可能存在被伪造风险。

### 数据持久化

数据库文件保存在容器的 `./data` 卷（宿主机目录），通过 `./data:/data` 挂载：

| 卷 | 说明 |
| --- | --- |
| `./data:/data` | SQLite 数据库文件 `reno.db`（含 WAL 日志），重装镜像 / 重启容器数据不丢 |

### 停止与移除

```bash
docker compose down        # 停止容器（数据保留在 ./data）
docker compose down -v     # 停止并删除数据卷（会清空数据，慎用）
```

---

## 本地开发（不依赖 Docker）

需要 Node.js 18+。

```bash
npm install
DATA_DIR=./data PORT=3000 SESSION_SECRET=随便一串随机字符 node server.js
# 打开 http://localhost:3000
```

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 运行时 | Node.js 18+ |
| Web 框架 | Express 4 |
| 数据库 | better-sqlite3（SQLite，WAL 模式） |
| 密码哈希 | bcryptjs |
| 会话管理 | cookie-session（加密 Cookie） |
| 前端 | 原生 HTML / CSS / JS（无框架） |
| 部署 | Docker + Docker Compose |

---

## 目录结构

```
reno-expense/
├── server.js              # Node 后端：鉴权 + 记录 CRUD + 静态服务
├── public/
│   └── index.html         # 前端单页应用（登录注册 + 费用记录）
├── Dockerfile             # 镜像构建（node:18-bookworm-slim）
├── docker-compose.yml     # 编排：端口 / 数据卷 / 环境变量
├── .dockerignore          # Docker 构建忽略项
├── package.json           # 依赖与启动脚本
├── data/                  #（运行时生成）SQLite 数据库持久化目录
└── README.md
```

---

## 鉴权与 API

所有写操作都需要登录（Cookie 会话）。每个用户的记录通过 `user_id` 隔离。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/register` | 注册（用户名 + 密码≥6位） |
| POST | `/api/login` | 登录 |
| POST | `/api/logout` | 登出 |
| GET | `/api/me` | 获取当前登录用户 |
| GET | `/api/items` | 当前用户的全部记录 |
| POST | `/api/items` | 新增记录 |
| PUT | `/api/items/:id` | 更新记录 |
| DELETE | `/api/items/:id` | 删除记录 |

记录字段：`name`（必填）、`category`、`supplier`、`budget`、`actual`、`deposit`、`other`、`date`、`note`。

---

## 数据备份

- **单文件导出**：登录后在页面右上角「导出备份」，可下载当前账号的全部记录为 JSON。
- **数据库级备份**：直接复制 `./data/reno.db` 文件即可（建议停服时复制，保证一致性）。

---

## 安全说明

- 已启用 bcrypt 密码哈希、加密 httpOnly Cookie 会话。
- 生产环境默认单实例、无 HTTPS。若暴露到公网，建议前置 HTTPS 反向代理（如 Nginx / Caddy）。
- `SESSION_SECRET` 请务必替换为高强度随机字符串。

---

## License

本项目仅供学习 / 个人部署使用。
