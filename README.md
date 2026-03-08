# OpenClaw 三层记忆系统 🧠

**完整的 AI 长期记忆解决方案** - SQLite + Qdrant + PostgreSQL/AGE

---

## 🎯 功能特性

- ✅ **三层存储** - SQLite（原文）+ Qdrant（向量）+ PostgreSQL/AGE（图谱）
- ✅ **语义搜索** - 基于向量相似度搜索记忆
- ✅ **知识图谱** - 实体关系存储和查询（AGE）
- ✅ **网页管理** - 现代化记忆管理界面（暗黑模式 + 服务监控）
- ✅ **OpenClaw 集成** - 无缝接入 OpenClaw 机器人
- ✅ **对话气泡** - 区分用户/助手消息的可视化显示

---

## 🏗️ 系统架构

```
┌──────────────────┐
│  网页管理界面     │
│  (3001 端口)      │
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
│原文  │ │向量  │ │+ AGE    │
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

### 3. 访问网页管理界面

打开浏览器访问：

```
http://localhost:3001
```

**功能：**
- 📊 实时查看各层记忆数量
- 🔍 关键词搜索 / 语义搜索
- ➕ 新增/编辑/删除记忆
- 🌓 暗黑模式切换
- 🔄 服务状态监控

### 4. 测试 API

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

---

## 🌐 网页管理界面

### 访问地址

```
http://localhost:3001
```

### 界面功能

#### 顶部状态栏
- **服务监控** - SQLite/Qdrant/AGE 实时状态（绿色=正常，红色=异常）
- **记忆统计** - 各层记忆数量一目了然
- **快速切换** - Tab 切换不同存储层
- **主题切换** - 🌓 一键切换亮色/暗黑模式
- **服务重启** - 🔄 快速重启服务

#### 记忆管理
- **对话气泡** - 用户消息（蓝色）和助手回复（白色）区分显示
- **操作按钮** - 查看/编辑/删除（hover 时显示在右上角）
- **搜索功能** - SQLite 关键词搜索 / Qdrant 语义搜索
- **分页浏览** - 固定底部分页栏

---

## ⚙️ 配置说明

### 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `OPENCLAW_MEMORY_TIER` | `full` | 服务层级：lite/standard/full |
| `MEMORY_AUTH_TOKEN` | `clawx-memory-token` | API 认证令牌 |
| `QDRANT_URL` | `http://qdrant:6333` | Qdrant 地址（容器内） |
| `PGHOST` | `postgres` | PostgreSQL 主机（容器内） |
| `PGPORT` | `5432` | PostgreSQL 端口 |
| `PGUSER` | `openclaw` | 数据库用户 |
| `PGPASSWORD` | `openclaw123` | 数据库密码 |
| `PGDATABASE` | `jarvis_memory` | 数据库名 |

### 端口说明

| 服务 | 端口 | 用途 |
|------|------|------|
| Memory Web | 3001 | 网页管理界面 |
| Memory Server | 7777 | HTTP API |
| Qdrant | 6333 | 向量数据库 HTTP |
| Qdrant gRPC | 6334 | 向量数据库 gRPC |
| PostgreSQL | 5432 | 关系数据库 |

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

### 获取所有记忆

```bash
GET /api/memories?limit=20&offset=0
Authorization: Bearer clawx-memory-token
```

### 删除记忆

```bash
DELETE /api/memories/:id
Authorization: Bearer clawx-memory-token
```

### 健康检查

```bash
GET /api/health
```

---

## 🛠️ 开发指南

### 项目结构

```
memory-qdrant/
├── server/                    # 后端服务
│   ├── src/
│   │   ├── server-native.ts   # 主服务器（TypeScript）
│   │   ├── server.web.js      # 网页服务器
│   │   ├── storage/           # 存储层
│   │   ├── extraction/        # 实体提取
│   │   └── search/            # 搜索模块
│   ├── frontend/
│   │   └── memory-manager.html # 网页管理界面
│   ├── docker/
│   │   └── Dockerfile         # 服务器镜像
│   ├── Dockerfile.web         # 网页服务器镜像
│   └── package.json
│
├── docker-compose.yml         # Docker 编排
├── README.md
└── .gitignore
```

### 本地开发

#### 运行 Memory Server

```bash
cd server
npm install
npm run build
npm run dev
```

#### 运行网页服务器

```bash
cd server
node server.web.js
```

访问 `http://localhost:3001`

### Docker 开发

```bash
# 重建镜像
docker compose build

# 重启服务
docker compose restart

# 查看日志
docker compose logs -f memory-server
docker compose logs -f memory-web
```

---

## 🎯 服务层级

| 层级 | 存储 | 用途 | 推荐场景 |
|------|------|------|----------|
| **lite** | SQLite | 基础记忆存储 | 简单对话记录 |
| **standard** | SQLite + Qdrant | + 语义搜索 | 智能问答系统 |
| **full** | SQLite + Qdrant + AGE | + 知识图谱 | 复杂知识管理 |

---

## 📝 更新日志

### v2.0.0 (2026-03-08)

**🎨 网页界面重大更新：**

- ✅ 全新 UI 设计 - 参考 OpenClaw Dashboard 风格
- ✅ 暗黑模式 - 一键切换主题
- ✅ 服务监控 - 实时显示各层服务状态
- ✅ 对话气泡 - 用户/助手消息区分显示
- ✅ 固定布局 - 工具栏和分页固定，内容区滚动
- ✅ 统计合并 - 记忆数量和 Tab 切换整合到一行

**🔧 技术改进：**

- ✅ 简化网页服务器 - 去掉 Qdrant 直接依赖
- ✅ 实时文件读取 - 修改 HTML 后刷新浏览器即可生效
- ✅ 角色识别 - 根据 tags 自动判断用户/助手消息
- ✅ 响应式设计 - 适配不同屏幕尺寸

### v1.0.0

- 初始版本
- 三层存储架构
- 基础网页管理界面

---

## 📄 常见问题

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

### Q: 网页界面不显示？

A: 确保 memory-web 服务运行：

```bash
docker compose ps memory-web
docker compose logs memory-web
```

### Q: 搜索返回空结果？

A: 需要配置 Ollama 或其他嵌入模型来生成向量。当前版本支持基础搜索。

---

## 🔗 相关链接

- [OpenClaw 官方文档](https://docs.openclaw.ai)
- [Qdrant 文档](https://qdrant.tech/documentation/)
- [Apache AGE](https://age.apache.org/)

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
- 现代化网页管理界面
