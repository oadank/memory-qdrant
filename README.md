# 🧠 Memory Qdrant Plugin for OpenClaw

一个基于 **Qdrant** 向量数据库的 OpenClaw 记忆插件，自动为智能体注入长期记忆，支持对话存储、语义检索、记忆删除与总结。  
🧩 本插件由社区开发，完美适配 OpenClaw 生命周期钩子，让智能体拥有“记性”。

👉 **项目地址**：[https://github.com/oadank/memory-qdrant](https://github.com/oadank/memory-qdrant)

---

## 📁 目录结构

```
memory-qdrant/
├── qdrant/                 # Qdrant 数据库核心文件
│   └── qdrant.exe          # Qdrant 可执行文件（已内置）
├── nssm/                   # NSSM (Non-Sucking Service Manager)
│   └── nssm.exe            # 用于将 Qdrant 注册为 Windows 服务
├── 管理Qdrant记忆.ps1      # 查看、按序号删除记忆的交互脚本
├── auto_summary/           # 自动总结技能模块（Python）
├── tools/                  # 其他辅助工具（预留）
├── install.ps1             # 一键安装脚本（以管理员身份运行）
├── uninstall.ps1           # 一键卸载脚本
├── index.js                # OpenClaw 插件主逻辑
├── package.json            # Node.js 依赖配置
├── openclaw.plugin.json    # 插件元数据
└── README.md               # 本文档
```

---

## 🧩 核心依赖说明

| 组件 | 说明 |
|------|------|
| **Qdrant** | 向量数据库，所有记忆以向量形式存储。`qdrant.exe` 已内置在 `qdrant/` 文件夹中，无需额外下载。 |
| **NSSM** | Windows 服务管理器，用于将 Qdrant 注册为后台服务。`nssm.exe` 已内置在 `nssm/` 文件夹中，无需额外下载。 |
| **Node.js** | 插件核心逻辑由 Node.js 实现。**需自行安装 Node.js 环境**（推荐 v18 或更高版本），但项目依赖的 `node_modules` 已打包在仓库中（约 2MB），无需运行 `npm install`。 |
| **Python** | 自动总结功能需要 Python 环境，（需要系统已安装，并写入环境变量即可）。 |
| **Ollama** | 用于生成向量嵌入和文本总结。需提前安装 Ollama 并拉取以下模型：<br>- 向量模型：`bge-m3:latest`（或其它兼容模型）<br>- 总结模型：`qwen2.5:14b-instruct`（或其它模型，可在配置中修改） |
---

## 🚀 安装与使用

### 1. 克隆仓库
```bash
git clone https://github.com/oadank/memory-qdrant.git
cd memory-qdrant
```

### 2. 一键安装（Windows）
以 **管理员身份** 打开 PowerShell，执行安装脚本：
```powershell
.\install.ps1
```
脚本会自动完成：
- 创建 Qdrant 数据目录 `qdrant/data` 和日志目录 `qdrant/logs`
- 使用 NSSM 将 Qdrant 注册为 Windows 服务 `QdrantMemory` 并启动
- 验证服务运行状态（默认端口 `6333`）
- 在桌面创建快捷方式 `Qdrant记忆管理.lnk`，方便随时调用管理记忆

> ⚠️ **注意**：如果之前安装过旧版本，脚本会自动停止并删除旧服务，请确保已备份重要数据。

### 3. 管理记忆
安装后，您可以通过以下方式查看和删除记忆：
- 双击桌面上的 **`Qdrant记忆管理`** 快捷方式
- 或在 PowerShell 中直接运行：
  ```powershell
  .\管理Qdrant记忆.ps1
  ```

管理脚本提供交互式界面：
- **显示所有记忆**（按时间排序）
- **输入数字**：删除对应序号的单条记忆
- **输入 `A`**：删除全部记忆
- **直接回车**：刷新列表
- **空格**：退出脚本

### 4. 卸载
如需彻底移除插件及相关服务，以管理员身份运行：
```powershell
.\uninstall.ps1
```
脚本会停止并删除 Qdrant 服务，并询问是否删除数据目录。

---

## ✨ 功能特性

- ✅ **自动记忆存储**：用户消息与助手回复自动存入 Qdrant，支持 `raw` 和 `insight` 两种记忆类型。
   - `raw`：原始对话记录，包括用户输入和助手回复，用于短期记忆和即时检索。
   - `insight`：由总结功能生成的浓缩记忆，代表长期、高层次的语义信息。
- 🔍 **语义检索**：基于用户当前输入，检索最相关的历史记忆，并作为上下文注入智能体。
- 🎯 **检索优先级**：先搜 `insight`（总结记忆），再搜 `assistant` 原始消息，最后搜 `user` 消息，确保答案质量。
- 🧹 **记忆管理**：
  - 支持通过关键词删除最近一条记忆。
  - 支持按语义删除与某话题相关的记忆。
  - 内置黑名单过滤，避免存储无意义内容（如问候语、指令）。
- 📊 **记忆总结**：发送“总结记忆”即可触发异步总结，将多条原始记忆提炼为 `insight`，长期保存。
- ⚙️ **高度可配置**：所有参数（如阈值、topK、过滤规则）均可通过 `openclaw.json` 配置。
- 🛡️ **安全过滤**：内置用户黑名单、助手回复黑名单，防止存储敏感或无用信息。

---

## ⚙️ 配置说明

插件支持以下配置项（均在 `config` 对象中设置）：

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `qdrantUrl` | string | `http://localhost:6333` | Qdrant 服务地址 |
| `collection` | string | `agent_memory` | 向量集合名称 |
| `ollamaUrl` | string | `http://localhost:11434` | Ollama 服务地址（用于生成向量） |
| `embeddingModel` | string | `bge-m3:latest` | 嵌入模型名称（需 Ollama 支持） |
| `topK` | integer | `3` | 检索返回的最大记忆条数 |
| `dedupeThreshold` | number | `0.85` | 去重阈值（暂未使用） |
| `userId` | string | `claw` | 当前用户的标识 |
| `sharedUserId` | string | `shared` | 共享记忆的用户ID（用于 insight） |
| `fallbackToRaw` | boolean | `true` | 未找到 insight 时是否降级搜索 raw |
| `summaryModel` | string | `qwen2.5:14b-instruct` | 用于总结的模型 |
| `summaryMaxRaw` | integer | `100` | 一次总结最多处理多少条原始记忆 |
| `filterRules` | object | 见下文 | 过滤规则 |

### `filterRules` 对象
  - filterRules 是过滤规则，用于控制哪些对话内容不被存储。

| 字段 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `minLength` | integer | `10` | 消息最短长度，小于此值不存储 |
| `userBlacklist` | array | `["截屏","截图","重启",...]` | 用户消息包含这些关键词时不存储 |
| `assistantBlacklistPatterns` | array | `["^很高兴见到你","有什么可以帮你的吗",...]` | 助手回复匹配这些正则时不存储 |
| `deleteKeywords` | array | `["删除最后一条记忆",...]` | 触发删除操作的关键词 |
| `summaryKeywords` | array | `["总结记忆","总结一下","帮我总结"]` | 触发总结操作的关键词 |

---

## 📖 使用方法

### 基本流程
1. 正确配置到 OpenClaw 并启用后，插件自动工作，并在后台打印相关日志。
2. 每次对话，用户消息和助手回复都会被存储（除非被过滤规则拦截）。
3. 下次提问时，插件会自动检索相关记忆并注入上下文。

### 记忆管理指令
- **删除最后一条记忆**：发送“删除最后一条记忆”（或配置中的任意 `deleteKeywords`）。
- **删除关于某话题的记忆**：发送“删除关于 XXX”（XXX 为话题关键词）。
- **总结记忆**：发送“总结记忆”，插件将异步处理并生成 insight，稍后可查看结果。

### 检索优先级
插件按以下顺序检索记忆：
1. **insight**：由总结生成的长期记忆。
2. **assistant raw**：助手原始回复。
3. **user raw**：用户原始消息。

检索结果会经过相似度阈值过滤（默认 0.7），高于阈值的记忆才会被注入。

---

## 🧪 高级调优

- **调整相似度阈值**：在 `before_agent_start` 钩子中找到 `const THRESHOLD = 0.7;`，根据需要修改（值越低，召回越多，但可能引入噪音）。
- **修改检索优先级**：可在代码中自由调整检索顺序。
- **自定义过滤规则**：直接修改 `filterRules` 配置，或在代码中扩展 `shouldStore` 函数。

---

## 📝 示例日志输出

```
13:42:08 📋 [memory-qdrant] filterRules in use: { ... }
13:42:10 🧪 insightFilter = {
  "must": [{ "key": "type", "match": { "value": "insight" } }],
  "should": [...],
  "min_should": { "min_count": 1 }
}
13:42:10 📊 raw_assistant 候选分数: 0.494, 内容: "⚙️ 会话已就绪..."
13:42:10 🔍 未找到高于阈值 0.7 的相关记忆。
13:42:55 检查模式 "会话已" 是否匹配: true
13:42:55 过滤：AI回复匹配黑名单模式 "会话已"
```

---

## ❓ 常见问题

**Q: 为什么 Qdrant 报错 `invalid type: integer '1', expected struct MinShould`？**  
A: 请确保插件代码中 `min_should` 使用对象格式 `{ min_count: 1 }`，而非数字 `1`。如果已修改但仍有错误，可能是 OpenClaw 加载了旧版插件，请检查插件路径并彻底重启。

**Q: 为什么助手问候语还会被存储？**  
A: 检查 `assistantBlacklistPatterns` 是否包含“会话已”等模式，并确认过滤函数中的正则匹配已启用（插件日志中应有“检查模式...”输出）。

**Q: 记忆检索不到，总是返回 0 条？**  
A: 可能是相似度阈值过高，尝试降低 `THRESHOLD`；或确保 Qdrant 集合中有数据（可通过 `管理Qdrant记忆.ps1` 查看）。

**Q: 一键安装后，Qdrant 服务无法启动？**  
A: 检查端口 6333 是否被占用，或查看 `qdrant/logs/` 下的日志文件。也可手动运行 `qdrant.exe` 测试。

**Q: Anthropic API key 缺失错误怎么办？**  
A: 这是 OpenClaw 内置 slug generator 的错误，不影响核心功能。可在配置中关闭：`"slugGenerator": { "enabled": false }`。

---

## 🤝 贡献

欢迎提交 Issue 和 PR！如果你有新的过滤规则或优化思路，请随时改进。

---

## 📄 许可证

MIT © 2026 [oadank](https://github.com/oadank)

---

🌟 **如果这个插件对你有帮助，请给仓库点个 Star！**
```
