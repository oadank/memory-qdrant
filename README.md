🧠 Memory Qdrant Plugin for OpenClaw

https://img.shields.io/badge/version-2.0.1-blue.svg
https://img.shields.io/badge/license-MIT-green.svg
https://img.shields.io/badge/OpenClaw-2026.2+-orange.svg

一个基于 Qdrant 向量数据库的 OpenClaw 记忆插件，自动为智能体注入长期记忆，支持对话存储、语义检索、记忆删除与总结。

🧩 本插件由社区开发，完美适配 OpenClaw 生命周期钩子，让智能体拥有“记性”。

---

✨ 功能特性

· ✅ 自动记忆存储：用户消息与助手回复自动存入 Qdrant，支持 raw 和 insight 两种记忆类型。
· 🔍 语义检索：基于用户当前输入，检索最相关的历史记忆，并作为上下文注入智能体。
· 🎯 检索优先级：先搜 insight（总结记忆），再搜 assistant 原始消息，最后搜 user 消息，确保答案质量。
· 🧹 记忆管理：
  · 支持通过关键词删除最近一条记忆。
  · 支持按语义删除与某话题相关的记忆。
  · 内置黑名单过滤，避免存储无意义内容（如问候语、指令）。
· 📊 记忆总结：发送“总结记忆”即可触发异步总结，将多条原始记忆提炼为 insight，长期保存。
· ⚙️ 高度可配置：所有参数（如阈值、topK、过滤规则）均可通过 openclaw.json 配置。
· 🛡️ 安全过滤：内置用户黑名单、助手回复黑名单，防止存储敏感或无用信息。

---

📦 安装

1. 将插件克隆或下载到 OpenClaw 的插件目录：
   ```bash
   cd /path/to/openclaw_plugins
   git clone https://github.com/your-repo/memory-qdrant.git
   ```
2. 在 openclaw.json 中加载插件：
   ```json
   "plugins": {
     "load": {
       "paths": ["C:\\path\\to\\openclaw_plugins\\memory-qdrant"]
     },
     "entries": {
       "memory-qdrant": {
         "enabled": true,
         "config": { ... }
       }
     }
   }
   ```
3. 确保 Qdrant 服务已运行（默认 http://localhost:6333）。

---

⚙️ 配置说明

插件支持以下配置项（均在 config 对象中设置）：

参数 类型 默认值 描述
qdrantUrl string http://localhost:6333 Qdrant 服务地址
collection string agent_memory 向量集合名称
ollamaUrl string http://localhost:11434 Ollama 服务地址（用于生成向量）
embeddingModel string bge-m3:latest 嵌入模型名称（需 Ollama 支持）
topK integer 3 检索返回的最大记忆条数
dedupeThreshold number 0.85 去重阈值（暂未使用）
userId string claw 当前用户的标识
sharedUserId string shared 共享记忆的用户ID（用于 insight）
fallbackToRaw boolean true 未找到 insight 时是否降级搜索 raw
summaryModel string qwen2.5:14b-instruct 用于总结的模型
summaryMaxRaw integer 100 一次总结最多处理多少条原始记忆
filterRules object 见下文 过滤规则

filterRules 对象

字段 类型 默认值 描述
minLength integer 10 消息最短长度，小于此值不存储
userBlacklist array ["截屏","截图","重启",...] 用户消息包含这些关键词时不存储
assistantBlacklistPatterns array ["^很高兴见到你","有什么可以帮你的吗",...] 助手回复匹配这些正则时不存储
deleteKeywords array ["删除最后一条记忆",...] 触发删除操作的关键词
summaryKeywords array ["总结记忆","总结一下","帮我总结"] 触发总结操作的关键词

---

🚀 使用方法

基本流程

1. 启动 OpenClaw 后，插件自动工作。
2. 每次对话，用户消息和助手回复都会被存储（除非被过滤规则拦截）。
3. 下次提问时，插件会自动检索相关记忆并注入上下文。

记忆管理指令

· 删除最后一条记忆：发送“删除最后一条记忆”（或配置中的任意 deleteKeywords）。
· 删除关于某话题的记忆：发送“删除关于 XXX”（XXX 为话题关键词）。
· 总结记忆：发送“总结记忆”，插件将异步处理并生成 insight，稍后可查看结果。

检索优先级

插件按以下顺序检索记忆：

1. insight：由总结生成的长期记忆。
2. assistant raw：助手原始回复。
3. user raw：用户原始消息。

检索结果会经过相似度阈值过滤（默认 0.7），高于阈值的记忆才会被注入。

---

🧪 高级调优

调整相似度阈值

在 before_agent_start 钩子中找到 const THRESHOLD = 0.7;，根据需要修改（值越低，召回越多，但可能引入噪音）。

修改检索优先级

你可以在代码中自由调整检索顺序，例如先搜 assistant raw 再搜 insight。

自定义过滤规则

直接修改 filterRules 配置，或在代码中扩展 shouldStore 函数。

---

📝 示例日志输出

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

❓ 常见问题

Q: 为什么 Qdrant 报错 invalid type: integer '1', expected struct MinShould？
A: 请确保插件代码中 min_should 使用对象格式 { min_count: 1 }，而非数字 1。如果已修改但仍有错误，可能是 OpenClaw 加载了旧版插件，请检查插件路径并彻底重启。

Q: 为什么助手问候语还会被存储？
A: 检查 assistantBlacklistPatterns 是否包含“会话已”等模式，并确认过滤函数中的正则匹配已启用（插件日志中应有 检查模式... 输出）。

Q: 记忆检索不到，总是返回 0 条？
A: 可能是相似度阈值过高，尝试降低 THRESHOLD；或确保 Qdrant 集合中有数据（可通过 Qdrant UI 查看）。

Q: Anthropic API key 缺失错误怎么办？
A: 这是 OpenClaw 内置 slug generator 的错误，不影响核心功能。可在配置中关闭："slugGenerator": { "enabled": false }。

---

🤝 贡献

欢迎提交 Issue 和 PR！如果你有新的过滤规则或优化思路，请随时改进。

---

📄 许可证

MIT © 2026 你的名字/组织

---

🌟 如果这个插件对你有帮助，请给仓库点个 Star！