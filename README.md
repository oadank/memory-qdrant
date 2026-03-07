# OpenClaw 三层记忆插件

**版本**: 2.0.0  
**架构**: SQLite + Qdrant + PostgreSQL/AGE (Full Tier)

---

## 🚀 快速开始

### 1. 安装依赖

```bash
cd C:\Users\oadan\openclaw_plugins\openclaw_qdrant_age_server
npm install
```

### 2. 启动 Docker 服务

```bash
# 确保以下容器运行中
docker ps | grep memory
# - memory-server (Port 7777)
# - openclaw-memory-qdrant (Port 6333, 6334)
# - openclaw-memory-age (Port 5432)
```

### 3. 在 OpenClaw 中启用

编辑 `C:\Users\oadan\.openclaw\openclaw.json`:
```json
{
  "plugins": {
    "paths": [
      "C:\\Users\\oadan\\openclaw_plugins\\openclaw_qdrant_age_server"
    ],
    "allow": ["openclaw_qdrant_age_server"]
  }
}
```

---

## 🌐 前端管理界面

**访问地址**: 直接用浏览器打开
```
C:\Users\oadan\openclaw_plugins\openclaw_qdrant_age_server\frontend\memory-manager-new.html
```

**功能**:
- ✅ 查看/搜索所有记忆
- ✅ 手动添加/删除记忆
- ✅ 管理 Qdrant 向量数据库
- ✅ 监控服务状态

---

## 🔧 配置项

```json
{
  "memoryServerUrl": "http://localhost:7777",
  "qdrantUrl": "http://localhost:6333",
  "qdrantGrpcPort": 6334,
  "pgPort": 5432,
  "collection": "openclaw_memories",
  "authToken": "clawx-memory-token",
  "recallEnabled": true,
  "addEnabled": true,
  "topK": 5,
  "debug": false
}
```

---

## 📊 架构说明

```
OpenClaw Agent
    ↓
插件 (index.js)
    ↓ HTTP (axios)
memory-server (7777)
    ↓
┌───────┬────────┬────────┐
SQLite  Qdrant   PostgreSQL
        6333/6334  + AGE
                   5432
```

---

## 🛠️ 常用命令

### 查看服务状态
在 OpenClaw 中输入：
```
memory.status
```

### 搜索记忆
```
memory.search <关键词>
```

---

## 📝 目录结构

```
openclaw_qdrant_age_server/
├── index.js                  # 核心插件代码
├── openclaw.plugin.json      # OpenClaw 配置
├── package.json              # Node.js 依赖
├── README.md                 # 说明文档
└── frontend/
    └── memory-manager-new.html  # 前端管理界面
```

---

## ⚠️ 注意事项

1. **必须先启动 Docker 容器** 才能使用插件
2. **端口不要冲突**: 7777, 6333, 6334, 5432
3. **定期备份**: Qdrant 和 PostgreSQL 数据卷

---

**最后更新**: 2026-03-07  
**作者**: 老青鱼 🐟🔥
