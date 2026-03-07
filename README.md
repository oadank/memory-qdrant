# OpenClaw 三层记忆插件 🧠

**完整的 AI 长期记忆解决方案** - SQLite + Qdrant + PostgreSQL/AGE

---

## 🎯 功能

- ✅ **自动记忆** - 捕获用户对话，自动存储
- ✅ **语义搜索** - 基于向量相似度搜索记忆
- ✅ **知识图谱** - 实体关系存储和查询
- ✅ **网页管理** - 可视化管理记忆数据
- ✅ **OpenClaw 集成** - 无缝接入 OpenClaw 机器人

---

## 🏗️ 架构

```
┌──────────────────┐
│  OpenClaw        │
│  (聊天机器人)     │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  插件层           │
│  (index.js)      │
└────────┬─────────┘
         │ HTTP API
         ▼
┌──────────────────┐
│  Memory Server   │
│  (7777 端口)      │
└────────┬─────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
┌──────┐ ┌──────┐ ┌─────────┐
│SQLite│ │Qdrant│ │Postgres │
│本地  │ │向量  │ │+ AGE    │
└──────┘ └──────┘ └─────────┘
```

---

## 🚀 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/oadank/memory-qdrant.git
cd memory-qdrant
```

### 2. 启动三层服务

```bash
docker compose up -d
```

等待服务启动（约 30 秒）：

```bash
docker compose ps
# 应该显示 3 个容器都在运行
```

### 3. 测试服务

```bash
# 健康检查
curl http://localhost:7777/api/health

# 存储记忆
curl -X POST http://localhost:7777/api/memories \
  -H "Authorization: Bearer clawx-memory-token" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"default","scope":"user","content":"我喜欢吃红烧肉","tags":["food"],"source":"explicit"}'

# 搜索记忆
curl -X POST http://localhost:7777/api/search \
  -H "Authorization: Bearer clawx-memory-token" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"default","query":"红烧肉","limit":5}'
```

### 4. 安装 OpenClaw 插件

```bash
# 复制插件到 OpenClaw 插件目录
cp -r plugin ~/.openclaw/plugins/openclaw_qdrant_age_server

# 或者创建软链接
ln -s $(pwd)/plugin ~/.openclaw/plugins/openclaw_qdrant_age_server
```

### 5. 配置 OpenClaw

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "plugins": {
    "load": {
      "paths": [
        "~/.openclaw/plugins/openclaw_qdrant_age_server"
      ]
    },
    "entries": {
      "openclaw_qdrant_age_server": {
        "enabled": true,
        "config": {
          "memoryServerUrl": "http://localhost:7777",
          "authToken": "clawx-memory-token"
        }
      }
    }
  }
}
```

### 6. 重启 OpenClaw

```bash
openclaw gateway restart
```

---

## 🌐 网页管理界面

打开浏览器访问：

```
file:///path/to/memory-qdrant/frontend/memory-manager.html
```

功能：
- 查看所有记忆
- 搜索记忆
- 删除记忆
- 手动添加记忆

---

## ⚙️ 配置说明

### 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `OPENCLAW_MEMORY_TIER` | `full` | 服务层级：lite/standard/full |
| `MEMORY_AUTH_TOKEN` | `clawx-memory-token` | API 认证令牌 |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant 地址 |
| `PGHOST` | `localhost` | PostgreSQL 主机 |
| `PGPORT` | `5432` | PostgreSQL 端口 |
| `PGUSER` | `openclaw` | 数据库用户 |
| `PGPASSWORD` | `openclaw123` | 数据库密码 |
| `PGDATABASE` | `jarvis_memory` | 数据库名 |

### 端口说明

| 服务 | 端口 | 用途 |
|------|------|------|
| Memory Server | 7777 | HTTP API |
| Qdrant | 6333 | HTTP API |
| Qdrant gRPC | 6334 | gRPC API |
| PostgreSQL | 5432 | 数据库连接 |

---

## 📊 API 接口

### 存储记忆

```bash
POST /api/memories
Authorization: Bearer clawx-memory-token
Content-Type: application/json

{
  "agent_id": "default",
  "scope": "user",
  "content": "记忆内容",
  "tags": ["标签 1", "标签 2"],
  "source": "explicit"
}
```

### 搜索记忆

```bash
POST /api/search
Authorization: Bearer clawx-memory-token
Content-Type: application/json

{
  "agent_id": "default",
  "query": "搜索关键词",
  "limit": 5
}
```

### 健康检查

```bash
GET /api/health
```

---

## 🛠️ 开发

### 构建 Memory Server

```bash
cd server
npm install
npm run build
```

### 运行 Memory Server（本地开发）

```bash
cd server
npm run dev
```

### 查看日志

```bash
docker compose logs -f memory-server
docker compose logs -f qdrant
docker compose logs -f postgres
```

---

## 📦 项目结构

```
memory-qdrant/
├── plugin/                    # OpenClaw 插件
│   ├── index.js
│   ├── frontend/
│   │   └── memory-manager.html
│   ├── package.json
│   └── openclaw.plugin.json
│
├── server/                    # 三层服务
│   ├── src/
│   │   └── server-native.ts
│   ├── docker/
│   │   └── Dockerfile
│   ├── package.json
│   └── tsup.config.ts
│
├── docker-compose.yml         # Docker 编排
├── README.md
└── .gitignore
```

---

## 🎯 服务层级

| 层级 | 存储 | 用途 |
|------|------|------|
| **lite** | SQLite | 基础记忆存储 |
| **standard** | SQLite + Qdrant | + 语义搜索 |
| **full** | SQLite + Qdrant + AGE | + 知识图谱 |

---

## 📝 常见问题

### Q: 服务启动失败？

A: 检查 Docker 是否运行：

```bash
docker ps
docker compose up -d
```

### Q: API 返回 401？

A: 检查认证令牌是否正确：

```bash
curl http://localhost:7777/api/health \
  -H "Authorization: Bearer clawx-memory-token"
```

### Q: 搜索返回空结果？

A: 需要配置 Ollama 或其他嵌入模型来生成向量。当前版本支持基础搜索。

---

## 📄 许可证

MIT License

---

## 🙏 致谢

基于 [openclaw-memory](https://github.com/robipop22/openclaw-memory) 项目改进

**主要改进：**
- 修复 Elysia 框架 body 解析 bug
- 使用原生 Node.js HTTP 服务器
- 简化部署流程
- 整合插件和服务到统一仓库
