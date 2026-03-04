# handoff.md

## 最后更新时间
- 日期：2026-03-04（仓库大整理/大清洗）
- 更新者：Codex
- 仓库：`C:\Users\oadan\openclaw_plugins\memory-qdrant`

## 本轮改动（按时间）
- 仓库卫生与结构整理（在不改 `server.js`、`auto_summary/auto_summary.py` 文件名与职责前提下）：
  - Git 仓库清洗：
    - 从版本库追踪中移除 `node_modules/`（历史误入库），保留本地依赖目录，不影响当前运行。
    - 从版本库移除运行日志：`auto_summary/auto_summary.log`、`auto_summary/summary_stderr.log`、`auto_summary/summary_stdout.log`。
  - 忽略规则完善（`.gitignore`）：
    - 新增 `auto_summary/__pycache__/`、`*.bak`、`*.tmp`、`*.temp`。
  - 清理无效文件：
    - 删除 `auto_summary/__pycache__/`、`frontend/memory-manager-new.html.bak`。
  - 说明：
    - `server.js` 与 `auto_summary/auto_summary.py` 文件名和对外服务职责未改变。
  - 语法校验：
    - `node --check index.js qdrant.js prompt-builder.js filter-service.js server.js`
    - `python -m py_compile auto_summary/auto_summary.py`
- 按审查报告落地 1/2/3 三项补丁：
  - 1) 并发锁修复（`auto_summary`）：
    - `auto_summary/auto_summary.py`：`get_unprocessed_candidates` 的 `must_not` 新增 `processed="processing"`，避免“正在处理”记录被重复捞取。
  - 2) 配置 schema 与运行时对齐：
    - `openclaw.plugin.json`：
      - `embeddingModel` 默认值由 `nomic-embed-text` 改为 `bge-m3`（与 `qdrant.js` 一致）。
      - 新增 `keywordMin`（8）、`keywordTarget`（12）。
      - `maxKeywords` 默认值由 16 改为 15（与 `qdrant.js` 一致）。
      - 新增 `useLLMFilter`（true）、`filterRules`（object，默认 `{}`）。
  - 3) 时间头清洗收紧（避免误删正常方括号内容）：
    - `index.js`：
      - `stripSenderMeta` 去掉“泛方括号时间”清洗，改为仅清理已知系统时间头格式（`[Wed YYYY-MM-DD HH:mm GMT+8]` 与 ISO 时间头）。
      - `sanitizeUserPromptForModel` 删除“中括号含日期即清理”的宽匹配，仅保留空白归一。
  - 校验通过：
    - `node --check index.js`
    - `python -m py_compile auto_summary/auto_summary.py`
    - `openclaw.plugin.json` 结构校验通过（PowerShell `ConvertFrom-Json`）。
- 屏蔽宿主工具提示 `[agents/tool-images] Image resized to fit limits ...`（用户要求“关闭提示，避免影响视觉”）：
  - 目标：该提示不再进入记忆、不参与召回、不在管理页显示。
  - `index.js`：
    - 用户/助手黑名单新增 `[agents/tool-images]` 与 `Image resized to fit limits`。
    - `stripSenderMeta` 新增正则清理该提示行。
  - `filter-service.js`：
    - `_quickFilter` 黑名单新增 `[agents/tool-images]` 与 `Image resized to fit limits`，队列层直接丢弃。
  - `qdrant.js` / `server.js` / `auto_summary/auto_summary.py` / `prompt-builder.js` / `frontend/memory-manager-new.html`：
    - 清洗函数统一新增该提示行清理，覆盖写库、总结、注入、页面展示全链路。
  - 语法检查通过：`node --check index.js qdrant.js prompt-builder.js filter-service.js server.js`、`python -m py_compile auto_summary/auto_summary.py`。
- 修复“CMD 日志仍打印脏头（Conversation info / 协议头）”：
  - 根因：`index.js` 的 `agent_end` 调试打印与入队前处理仍使用原始 `rawMessages`，未统一走清洗口径。
  - `index.js`：
    - `shouldStore` 改为先走 `sanitizeUserPromptForModel(text)` 再判定。
    - `agent_end` 新增 `cleanedMessages`：先清洗 metadata/协议头/时间头，再用于日志打印、基础过滤和入队/写库。
    - 调试日志从“原始消息”改为“清洗后消息”。
  - 语法检查通过：`node --check index.js`。
- `[[reply_to_current]]` 二次加固（用户反馈“助手回复仍有脏头”）：
  - `index.js`：`stripSenderMeta` 也加入 `[[...]]` 协议标记清洗，确保“用户原文清洗链路”不再漏过该标记。
  - `server.js`：`cleanInputText` 加入 `[[...]]` 清洗，手动录入/接口返回过滤口径一致。
  - `auto_summary/auto_summary.py`：`strip_sender_metadata` 加入 `[[...]]` 清洗，避免自动总结把协议标记再写回 insight。
  - `frontend/memory-manager-new.html`：`cleanTextForDisplay` 加入 `[[...]]` 清洗，页面不再显示该脏头。
  - 语法检查通过：`node --check index.js`、`node --check server.js`、`python -m py_compile auto_summary/auto_summary.py`。
- 修复 assistant 消息中的宿主协议头（`[[reply_to_current]]`）污染日志/记忆：
  - 现象：CMD 调试日志出现 `消息2: role=assistant, content="[[reply_to_current]]..."`。
  - 原因：该标记来自宿主（OpenClaw）消息协议，不是业务对话文本；插件在 `agent_end` 采集调试输出与写库前未统一清理该协议头。
  - `index.js`：
    - 新增 `stripProtocolMarkers`，在 `shouldStore` 和调试打印前统一清洗 `[[...]]` 协议标记。
    - assistant 分支增加规则：仅协议控制消息直接过滤，不入库。
  - `qdrant.js`：
    - `cleanTextForMemory` 增加 `[[...]]` 协议头与孤立标记清理，确保写库文本不带控制头。
  - `prompt-builder.js`：
    - `cleanInjectedMemoryText` 增加 `[[...]]` 协议头清理，防止注入显示残留。
  - 语法检查通过：`node --check index.js`、`node --check qdrant.js`、`node --check prompt-builder.js`。
- 确认“用户原文垃圾头”来源并补齐清洗：
  - 来源确认：垃圾头来自宿主传入的 `event.prompt / event.messages`（上游未受信元数据），非本插件主动拼接。
  - 变化原因：上游文案从 `Sender (untrusted metadata)` 扩展为 `Conversation info (untrusted metadata)`，旧清洗规则未覆盖新前缀。
  - `index.js`：`stripSenderMeta` 扩展支持 `Conversation info (untrusted metadata)`（含代码块/无代码块）。
  - `prompt-builder.js`：`cleanInjectedMemoryText` 同步扩展支持 `Conversation info (untrusted metadata)`。
  - 语法检查通过：`node --check index.js`、`node --check prompt-builder.js`。
- 修复“清洗后出现大量 助手 + 未知时间 + 空信息 记录”的显示/接口问题：
  - `frontend/memory-manager-new.html`：
    - 新增 `hasRenderableText`：清洗后正文为空的记录不再显示、不参与分页/删除序号/搜索结果。
    - 角色判定修复：不再 `payload.role || 'assistant'`，缺失 role 显示为“记录（📝）”而非“助手（🤖）”。
    - 展示清洗扩展：同步清理 `Conversation info (untrusted metadata)` 头。
    - `loadMemories` 时先过滤不可展示记录，避免前端状态中残留空记录。
  - `server.js`：
    - `GET /api/memory` 增加过滤：`cleanInputText(payload.text)` 为空的点不返回前端。
  - 结果：管理页不再出现“空文本 + 助手 + 未知时间”的幽灵记录。
  - 语法检查通过：`node --check server.js`（HTML 文件不适用 `node --check`）。
- 关键词过滤去垃圾词（修复 `Conversation info (untrusted metadata)` 污染 tags）：
  - `qdrant.js`：
    - `cleanTextForMemory` 清洗规则从仅 `Sender (untrusted metadata)` 扩展为同时清洗 `Conversation info (untrusted metadata)`（含代码块与无代码块两种形式）。
    - 关键词噪音词库新增：`conversation/info/untrusted/metadata/message_id/...`。
    - `isNoiseToken` 新增 UUID/长哈希/key 变体过滤（如 `message_id/conversation_id/user_id`）。
    - `sanitizeKeywords` 改为复用噪音判定，连同模型返回关键词一起清洗后再入库。
  - `server.js`：
    - `cleanInputText` 同步扩展清洗 `Conversation info (untrusted metadata)`。
    - 手动录入关键词提取新增噪音词与 UUID 过滤，避免手动写入路径污染 `tags`。
  - `auto_summary/auto_summary.py`：
    - `strip_sender_metadata` 同步扩展到 `Conversation info (untrusted metadata)`。
    - `extract_keywords_from_text` 与 `build_insight_keywords` 增加 metadata 词与 UUID/哈希过滤。
  - 语法检查通过：`node --check qdrant.js`、`node --check server.js`、`python -m py_compile auto_summary/auto_summary.py`。
- 注入记忆说明中的“多代理监控看板”链接端口从 `3010` 调整为 `3000`：
  - `prompt-builder.js`：`- 多代理监控看板：[http://localhost:3000/](http://localhost:3000/)`
  - 语法检查通过：`node --check prompt-builder.js`。
- 修复“模型筛选看似失效”回归（用户反馈“加油，好了吗”未被过滤）：
  - `filter-service.js`：
    - 严格执行模型 `action`：`discard` 直接丢弃不入库。
    - 新增兜底：`type=conversation` 且非 `store_refined` 时丢弃，避免闲聊噪音落库。
    - 提示词补充明确示例（“加油/好了吗/收到/在吗”应 `discard`），强化模型筛选意图。
  - 明确保留：不恢复“按字数阈值”拦截；仅保留“清洗后为空”拦截。
  - 语法检查通过：`node --check filter-service.js`。
- 自动总结改为“按批次归纳”，不再逐条总结（用户明确要求）：
  - `auto_summary/auto_summary.py`：
    - 新增 `summarize_batch_with_llm`：把一批已梳理文本合并后输出 1 条综合 insight。
    - 新增 `mark_processed`：批次结束后仅标记 `processed=true`，不改原文本体。
    - `get_unprocessed_candidates`：候选改为 `source_type in {refined, raw}` 且未处理（兼容异常回退 raw）。
    - `BATCH_SIZE` 调整为 `20`，`INTERVAL_SECONDS` 保持 `7200`（2 小时）。
  - 目的：第一阶段做逐条梳理；第二阶段做批次总结，避免“每条都总结”。
  - 语法检查通过：`python -m py_compile auto_summary/auto_summary.py`。
- 对齐“只存梳理文本，异常回退原文”口径（用户明确要求）：
  - `filter-service.js`：回退分支不再携带 `original_text`，确保异常回退消息按 `raw` 入库，不再误标为 `refined`。
  - `auto_summary/auto_summary.py`：`get_unprocessed_raw` 改为只处理 `source_type=raw`（不再处理 `refined`）。
  - `auto_summary/auto_summary.py`：`INTERVAL_SECONDS` 从 `60` 调整为 `7200`（2 小时）。
  - 语法检查通过：`node --check filter-service.js`、`python -m py_compile auto_summary/auto_summary.py`。
- 新增宿主显示补丁一键恢复脚本（用于 OpenClaw 升级后快速恢复）：
  - 新增 `apply-openclaw-display-mask.ps1`
  - 功能：给 `reply-DhtejUNZ.js` 重打“仅显示隐藏 `# 用户输入` 时间头”补丁。
  - 特性：自动备份、重复执行幂等、语法检查与失败回滚提示。
- 尝试改写宿主“用户输入”文本（实验性，针对用户反馈仍显示时间头）：
  - `index.js`：新增 `sanitizeUserPromptForModel`（基于 `stripSenderMeta` + 宽匹配去时间头）。
  - `before_agent_start`：
    - 召回查询从 `prompt` 改为 `cleanPrompt`，避免时间头影响检索词。
    - 尝试就地改写 `event.prompt` 与最后一条 `event.messages[user]` 内容为 `cleanPrompt`。
  - 说明：是否影响“注入块里的用户输入显示”取决于宿主是否允许该事件对象可变；若宿主忽略改写则不会生效。
  - 语法检查：`node --check index.js` 通过。
- 注入时间头清洗第三轮加固（覆盖更多系统格式）：
  - `prompt-builder.js`：`cleanInjectedMemoryText` 从“固定 weekday+GMT 格式”改为“中括号内含 `YYYY-MM-DD` 即清理”的宽匹配。
  - 目的：兼容 `[2026-03-04T..]`、`[TimeTag 2026-03-04 ...]` 等变体，避免注入块继续显示时间头。
  - 本地样例验证：多种时间头格式均可被清理。
- 注入记忆正文显示再清洗（用户反馈“注入里仍看到时间头”）：
  - `prompt-builder.js`：新增 `cleanInjectedMemoryText`，在 `formatPromptBlock` 输出前清理：
    - `[Wed ... GMT+8]` 这类时间头
    - `user:/assistant:` 前缀
    - `Sender (untrusted metadata)` 头
  - 仅影响“注入提示块显示文本”，不改 Qdrant 底层存储内容。
  - 语法检查：`node --check prompt-builder.js` 通过。
- 注入记忆提示块新增监控链接（用户要求）：
  - `prompt-builder.js`：在 `# 注入记忆` 说明区新增
    - `多代理监控看板：http://localhost:3000/`
  - 语法检查：`node --check prompt-builder.js` 通过。
- 前端“只隐藏不删库”显示清洗（用户要求“模型可见、用户不见”）：
  - `frontend/memory-manager-new.html`：新增 `cleanTextForDisplay`，页面展示时清理以下头信息：
    - `user:/assistant:` 前缀
    - `Sender (untrusted metadata): ...`
    - `[Wed 2026-03-04 02:45 GMT+8]` 这类时间头
  - 仅影响前端显示与复制内容，不改 Qdrant payload 原文，模型召回仍可使用原文。
- 放开手动录入“短文本”限制（用户要求）：
  - `server.js`：删除 `POST /api/memory` 中 `text.trim().length < 5` 的硬拦截，不再因字数短拒绝写入。
  - `server.js`：新增“清洗后为空”校验（`cleanedText` 为空时返回 `400`），保留对纯噪音/空内容的兜底。
  - `qdrant.js`：删除 `addMessage` 中 `cleaned.length < minCaptureChars` 的“消息过短”拦截，改为仅在清洗后为空时跳过。
  - `qdrant.js`：过滤原因文案从“消息过短或已重复”改为“消息为空或已重复”。
  - 语法检查：`node --check server.js`、`node --check qdrant.js` 通过。
- 修复“录入用户消息仍有脏头”残留变体（第二轮加固）：
  - `server.js`：`cleanInputText` 改为全局清洗 `Sender (untrusted metadata)`（支持开头/中间/多次）并先去掉 `user:/assistant:` 前缀。
  - `qdrant.js`：`cleanTextForMemory` 同步为全局清洗，并补中间时间片段 `[Wed 2026-... GMT+8]` 清理。
  - `auto_summary/auto_summary.py`：`strip_sender_metadata` 同步同口径全局清洗，避免 raw/refined 到 insight 再带回噪音。
  - `index.js`：`stripSenderMeta` 同步增强，确保注入判定与入库存储清洗口径一致。
  - 语法检查通过：`node --check server.js`、`node --check qdrant.js`、`node --check index.js`、`python -m py_compile auto_summary/auto_summary.py`。
- 分页区三次修正（解决“按钮不见 + 底部空白变丑”）：
  - `frontend/memory-manager-new.html`：
    - 将 `--footer-height` 从 `150px` 回调为 `108px`，恢复紧凑。
    - 新增 `.footer-bottom`，把“统计 + 分页”放在同一行，移除额外空白层。
    - `stats` 去掉上边框与多余间距。
    - 分页容器改为右侧单行显示。
    - `renderPagination` 不再在 `totalPages<=1` 时隐藏整块分页区，至少显示页码信息与禁用按钮。
- 分页按钮位置调整（按用户要求放到底部统计区）：
  - `frontend/memory-manager-new.html` 将 `#pagination` 从 `.content` 移动到 `.footer`（统计文字下方）。
  - 提升底部可用空间并避免遮挡：
    - `--footer-height` 调整为 `150px`
    - `.footer` 改为 `min-height + auto`，并设置 `overflow-y: visible`
    - 新增 `.footer .pagination` 的间距样式
  - 目的：确保“上一页/下一页”在网页端稳定可见。
- 修复“手动录入仍带 Sender metadata 噪音”：
  - 根因：此前只在 `qdrant.js` 采集链路清洗，`server.js` 的手动录入接口未清洗。
  - `server.js` 新增 `cleanInputText`，统一去除：
    - `Sender (untrusted metadata): ```json ... ````
    - 无代码块的 `Sender (untrusted metadata):`
    - 前缀时间片段 `[Wed 2026-... GMT+8]`
  - `POST /api/memory` 与 `POST /api/refine` 均改为先清洗后写入/提炼，避免“录入信息”继续带噪音。
- 修复网页端“无下一页功能/翻页无效”：
  - `frontend/memory-manager-new.html` 在 `.content` 内固定增加 `#pagination` 容器，避免分页栏被底部固定区遮挡。
  - `renderPagination` 改为直接渲染到 `#pagination`，不再动态插入到 `footer` 外层。
  - `goToPage` 改为基于“当前数据集”分页：
    - 搜索中按 `filteredMemories` 计算总页数。
    - 非搜索按 `allMemories` 计算总页数。
  - 搜索逻辑同步维护 `currentState.filteredMemories`，保证搜索结果也能正常翻页。
- 修复用户文本中 `Sender (untrusted metadata)` 噪音入库：
  - `qdrant.js` 的 `cleanTextForMemory` 新增专门清洗规则：
    - 去掉 `Sender (untrusted metadata): ```json ... ````
    - 兼容去掉无代码块的 `Sender (untrusted metadata):` 前缀
  - 该规则对写入与检索 query 清洗都生效，后续不会再把这段无意义元数据当正文保存/召回。
- 总结精华正文增加可见类型前缀：
  - `auto_summary/auto_summary.py` 新增 `build_labeled_essence`，在写入 insight 时把正文改为：
    - `技术：...` / `事实：...` / `决策：...` / `规则：...` / `经验：...`
  - 若正文本身已带同类前缀，不重复添加。
  - 目的：不只靠 tags/徽标，正文第一眼即可识别分类。
- 按用户要求将图片轮次注入开关默认值改为 `false`（用于测试）：
  - `qdrant.js`：`disableRecallOnImage` 默认从 `true` 改为 `false`。
  - `openclaw.plugin.json`：补充 `disableRecallOnImage` 到 `configSchema`，默认 `false`，便于在配置面板显式查看与切换。
- 新增图片轮次注入开关（用户确认需要）：
  - `qdrant.js` 的 `buildConfig` 新增 `disableRecallOnImage`，默认 `true`。
  - `index.js` 在 `before_agent_start` 中改为受该开关控制：
    - `true`：图片轮次跳过记忆注入。
    - `false`：图片轮次允许注入（仍保留“无正文 metadata”兜底跳过）。
  - 调试日志增加开关状态：`跳过注入：disableRecallOnImage=...`。
- 修复“新记录显示为助手 + 未知时间”的数据口径问题：
  - `auto_summary/auto_summary.py`：
    - 新增 `normalize_role`，统一 role 仅允许 `user/assistant`，缺失时默认 `user`。
    - `update_memory` 回写 payload 时补齐 `role` 与 `timestamp`（缺失 timestamp 时写当前毫秒时间）。
    - `process_raw_memory` 调用 `update_memory` 时显式传入 role/timestamp，避免回写后出现空值。
  - `frontend/memory-manager-new.html`：
    - 对缺失 role 的记录不再标注为“助手”，改为“记录（📝）”，减少误导。
- 修复“只发图片仍注入记忆”的兼容问题（第二轮增强）：
  - `index.js` 图片轮次跳过注入逻辑升级为三重判定：
    1) 结构化内容检测（`type/image_* / mimeType=image/* / data:image / 图片URL`）。
    2) 对整个 `event` 的字符串兜底扫描（`data:image / image_url / type=image / mime=image/*`）。
    3) 对 prompt 去除 sender metadata + 时间戳后，若无真实用户正文（<3 字符）则跳过注入。
  - 新增调试日志：`[memory-qdrant] 跳过注入：image=..., noRealUserText=...`，便于现场确认是否生效。
- 多模态兼容保护（图片输入场景）：
  - `index.js` 新增 `hasImageContent` 检测。
  - 在 `before_agent_start` 中，如果本轮用户消息包含图片内容，则跳过 `prependContext` 记忆注入。
  - 目的：避免在视觉模型请求中插入大段文本造成潜在干扰，排除“插件注入导致看不到图”的风险。
- 暗黑模式滚动条视觉优化：
  - `frontend/memory-manager-new.html` 新增暗黑主题滚动条样式，覆盖 `content/chat-container/footer/input-box`。
  - 轨道与滑块改为深灰配色（`track #252525`、`thumb #4a4a4a`、hover `#5a5a5a`），解决“滚动条过亮”问题。
- 全链路关键词策略统一（用户确认“按你建议执行”）：
  - `qdrant.js` 新增关键词配置与策略：
    - `keywordMin=8`、`keywordTarget=12`、`maxKeywords=15`（默认）。
    - 按文本长度动态目标：短文本约 10，中等文本 10-12，长文本可到 15。
    - 新增 `buildKeywords`：合并“模型关键词 + nodejieba 分词补全”，去重后入库，减少“分词太少”。
  - `filter-service.js` 模型输出关键词截断由“最多 5 个”改为“最多 15 个”，并做关键词清洗（长度/纯数字过滤）。
  - 取舍落实：模型失败不阻塞（原有降级保留），最终写库关键词由 `qdrant.js` 兜底补全。
- 自动总结质量增强（关键词与分类）：
  - `auto_summary/auto_summary.py` 新增 `normalize_mem_type`，将模型类型归一到固定枚举：`technical/fact/decision/instruction/experience`。
  - 新增 `build_insight_keywords`，将精华标签扩展为“模型关键词 + 文本分词 + 类型提示词”，目标 8-15 个标签，缓解“分词太少”。
  - 总结提示词中关键词要求从 `3-8` 调整为“至少 8 个，最多 15 个”。
- 前端显示分类标签：
  - `frontend/memory-manager-new.html` 为精华消息新增类型徽标（技术/事实/决策/规则/经验/手动），在消息头部直接可见。
- 前端间距二次收紧（针对“滚动区与插入记忆区仍有空行”）：
  - `frontend/memory-manager-new.html` 将 `--footer-height` 从 `120px` 下调到 `108px`。
  - 在最终 `.content` 覆盖块中显式设置 `padding-bottom: 0;`，消除早期样式残留的 `20px` 底部内边距。
- 前端细节优化（间距微调）：
  - `frontend/memory-manager-new.html` 收紧“消息滚动区”和“插入记忆区”的视觉空隙：
    - footer padding 从 `15px 20px` 调整为 `10px 20px`
    - input-area 底部间距从 `10px` 调整为 `6px`
    - stats 上方 padding/margin 从 `10px` 调整为 `6px`
    - chat-messages 底部 padding 从 `8px` 调整为 `2px`
- 修复管理页“未知时间”显示问题：
  - `frontend/memory-manager-new.html` 新增时间兜底解析：
    - 优先使用 payload.timestamp（支持秒/毫秒/ISO）。
    - 若 timestamp 缺失，则从文本中的 `[Tue 2026-03-03 22:22 GMT+8]` 片段提取时间并显示。
  - 列表排序同步改为使用同一时间解析逻辑，避免缺失 timestamp 的记录排序异常。
- 修复“手动输入必须是精华”的展示与存储口径：
  - `server.js` 的 `POST /api/memory` 改为强制写入 `type="insight"`、`mem_type="insight"`、`source_type="manual"`（不依赖总结分类标签）。
  - `frontend/memory-manager-new.html` 的精华判定改为：`source_type in {insight, manual}` 或 `mem_type=insight`，确保自动总结与手动输入都显示为“精华”。
  - 前端统计“记忆/精华”改为按上述精华判定计算，避免因第一阶段 `mem_type=raw` 导致统计失真。
- 统一第一阶段（采集阶段）分类口径：
  - `index.js` 移除“首阶段直接写 insight”的分流逻辑，采集消息统一走 `addMessage`。
  - `qdrant.js` 中 `addMessage` 固定写入 `mem_type = "raw"`，不在采集阶段做 `fact/rule/experience` 分类。
- 对齐第二阶段（自动总结）输入范围：
  - `auto_summary/auto_summary.py` 处理条件从仅 `source_type=raw` 调整为 `source_type in {raw, refined}`，避免漏处理已提炼采集记录。
- 用户确认的目标口径已落地：
  - 第一阶段只做“清洗与提炼存储”，不做总结分类。
  - 总结分类留在自动总结阶段输出（insight）。
- 修复 `auto_summary` 处理中状态写回失败：
  - `auto_summary/auto_summary.py` 将 `PATCH /points/payload` 改为 `PUT /points/payload`，解决 `404` 导致“全部跳过处理”的问题。
- 修复单条删除接口的无效 ID 报错噪音：
  - `server.js` 的 `DELETE /api/memory/:id` 增加 ID 格式校验与规范化（仅允许整数或 UUID），无效值直接返回 `400`，避免 Qdrant `PointsSelector` 报错堆栈。
- 现场排障结论：
  - `auto_summary` 的 `scroll 400` 根因为 `order_by: timestamp` 需要 range index；去掉 `order_by` 后请求可成功。
  - 当前持续出现的 `scroll 400` 日志来自“旧进程仍在运行旧逻辑”，不是本轮代码语法错误（已本地编译校验通过）。
- 修复 `auto_summary` 的 scroll 兼容与 payload 更新路径，停止总结循环中的 Qdrant 400 重复报错。
- 修复前端管理页问题：
  - `DELETE /api/memory/all` 路由冲突（`/api/memory/:id` 抢占了 `all`）。
  - 搜索框输入正则特殊字符导致崩溃。
  - 仅对 `processed === false` 显示“重新梳理”按钮。
  - 修复底部滚动与间距问题，移除不需要的底部滚动条。
- 修复后端“删除全部”逻辑：
  - ` /api/memory/all` 路由优先于 `/api/memory/:id`。
  - 删除全部增加“主路径 + 兜底批删”策略，提升兼容性。
- 记忆注入说明更新：
  - 在记忆提示块中加入可点击后台地址：`http://localhost:3001/`。
- 按用户决策调整记忆存储策略：
  - 保持 `agent_end` 为采集源。
  - 两段式存储：优先存梳理结论；梳理失败回退存原文（包含 assistant）。
  - 移除强制 think 清洗逻辑。
  - 不再把 `original_text` 持久化到 Qdrant payload。
- 新增并强化流程文件：
  - 新建 `AGENTS.md`，后升级为严格工作流规则。
  - `handoff.md` 从模板升级为可接班的运行状态文件。

## 当前项目状态
- 核心服务：
  - Qdrant 预期地址：`http://localhost:6333`
  - 管理端 API/UI 预期地址：`http://localhost:3001/`
- 管理页：
  - 仓库已完成一次“去脏”整理：不再把 `node_modules` 与运行日志作为版本化内容，后续提交噪音会明显降低。
  - 审查项 1/2/3 已落地：`auto_summary` 重复捞取风险已降低；插件配置面板与代码默认值更一致；采集清洗不再宽删“任意含日期方括号”文本。
  - `[agents/tool-images] Image resized...` 已在采集/写库/总结/注入/显示链路统一屏蔽，视觉上不应再出现。
  - `agent_end` 采集链路已统一按清洗后文本处理，CMD 中“消息1/消息2”预览不应再出现 `Conversation info (untrusted metadata)`。
  - `[[reply_to_current]]` 已做“采集日志 + 写库清洗 + 用户原文清洗 + 自动总结清洗 + 前端显示清洗”全链路处理。
  - 宿主协议标记（如 `[[reply_to_current]]`）已在采集日志、写库清洗、注入显示三处清理，不再作为记忆正文出现。
  - 上游 `Conversation info (untrusted metadata)` 头已在注入与用户原文清洗链路覆盖，不再以“用户原文垃圾头”形式出现。
  - 已屏蔽“清洗后空文本”记录：空消息不会展示、不会参与分页和批量删除序号计算。
  - 缺失 role 的记录显示为“记录（📝）”，不再误标为“助手（🤖）”。
  - 关键词生成链路已加固：`Conversation info (untrusted metadata)` 与 `message_id/UUID` 类噪音不再参与新写入记录的 tags 计算。
  - 过滤链路现为“模型优先”：`discard` 必丢弃，普通闲聊（conversation 且无提炼结论）会被过滤，不再依赖字数阈值。
  - 删除全部路由抢占问题已在代码中修复。
  - 搜索特殊字符导致的崩溃已修复。
  - 中间滚动区与底部输入区间距问题，用户已确认修复。
  - 单条删除接口已增加 ID 校验，非法 ID 将返回 `400`（不再打到 Qdrant）。
  - 精华展示规则已加强：`source_type=insight/manual` 均显示“精华”。
  - 精华分类可视化已上线：每条精华在前端头部显示类型标签（技术/事实/决策/规则/经验/手动）。
  - 关键词策略已统一：全链路目标 10-12，范围 8-15，模型与分词混合生成。
  - 时间显示已增强：无 payload.timestamp 的历史记录可从文本时间片段回填显示，减少“未知时间”。
  - 底部布局更紧凑：消息区与插入记忆区之间多余空隙已缩小。
  - 已清理 `.content` 残留底部 padding，滚动区与输入区应更贴合。
  - 暗黑模式滚动条已降亮度，消息区与输入区滚动条不再刺眼。
  - 图片输入轮次默认不注入记忆（仅本轮跳过），用于保障视觉识别稳定性。
  - 已补充“仅 metadata 无正文”兜底跳过，避免 openclaw-control-ui 场景下误注入。
  - 自动总结回写阶段已补齐 role/timestamp，后续新记录应显著减少“助手 + 未知时间”的误显示。
  - 图片轮次注入可配置：当前默认允许注入（`disableRecallOnImage=false`），可手动切回 `true`。
  - 自动总结新写入的精华正文带中文类型前缀，便于直接阅读分类。
  - sender metadata 噪音已加入统一清洗，后续新入库文本会更干净。
  - sender metadata 清洗已加固为“全局匹配”，即使脏头不在文本开头也会被清掉。
  - 分页栏已移到底部统计区，下一页/上一页在普通列表与搜索结果下都可用。
  - 手动录入与重梳理路径已接入 metadata 清洗，新录入文本应不再包含 `Sender (untrusted metadata)` 噪音头。
  - 手动录入接口不再限制最小 5 字符；短句（如“我女儿叫XX”）现在允许入库。
  - 采集链路（`agent_end -> addMessage`）不再因“消息过短”拒存；仅清洗后为空时才跳过。
  - 管理页正文展示新增“显示清洗”：注入时间头与 metadata 头不再显示给用户，但底层原文仍保留供模型使用。
  - 注入记忆提示块现含两个入口：管理页 `http://localhost:3001/` 与多代理看板 `http://localhost:3000/`。
  - 注入记忆块正文也已做显示清洗，避免在用户侧再次看到 `[Wed ... GMT+8]` 时间头。
  - 注入时间头清洗已改为宽匹配规则（中括号内含日期即去除）。
  - 已增加“宿主用户输入”改写尝试，若宿主允许可进一步去掉 `# 用户输入` 区时间头。
  - 已提供“升级后快速恢复”脚本，可直接重打宿主显示补丁。
  - 自动总结已收敛：按批次归纳（非逐条），周期为 2 小时。
- 记忆存储行为（当前预期）：
  - 采集源仍是 `agent_end`。
  - 第一阶段（采集）：user/assistant 都会进入过滤与提炼流程后入库，`mem_type` 固定为 `raw`。
  - 第二阶段（自动总结）：再生成分类后的 summary/insight（`fact/rule/experience/...`）。
  - assistant 允许原文回退，不会被强制丢弃。
  - `original_text` 不写入向量库 payload。
 - auto_summary：
  - 当前代码已修复 `points/payload` 的方法不兼容问题。
  - 线上是否生效取决于进程重启；未重启时仍会持续写入旧报错日志。

## 已确认决策
- 用户明确要求：未确认的问题不要擅自扩展修改。
- 用户希望通过 `handoff.md` 实现跨会话无缝续接。
- 单条删除接口的 ID 输入口径：仅接受整数或 UUID；非法输入在 API 层拦截。
- 用户确认分类策略：第一阶段不做语义分类，固定 `mem_type=raw`；分类只在自动总结阶段执行。
- 用户明确要求：手动输入必须作为“精华”展示，可不按总结分类标签细分。
- 用户同意关键词策略：全链路按“默认 10-12，最低 8，最高 15”，并采用“模型 + nodejieba”混合方案。
- 用户确认：去掉“消息过短”过滤，短文本也应允许写入（仅清洗后为空时拒绝）。
- 用户确认：`[Wed ... GMT+8]` 等头信息不在前端正文显示；但底层原文保留给模型。
- 用户新增要求：在注入记忆说明中加入“多代理监控看板”链接，当前端口为 `http://localhost:3000/`。
- 用户新增要求：注入记忆正文里也不显示时间头（如 `[Wed ... GMT+8]`）。
- 用户反馈重启后仍见时间头，已追加第三轮宽匹配清洗并做样例验证。
- 用户要求继续排查并尝试去除 `# 用户输入` 区的时间头，已落地实验性改写方案。
- 用户要求：记录恢复方案，升级失效后可立即恢复（已新增一键脚本）。
- 用户明确要求：原文梳理后仅存梳理文本；仅在异常时回退存原文。
- 用户明确要求：自动总结必须按批次，不是一句一句总结。
- 用户明确要求：保留模型筛选；取消“筛选后再按字数卡掉文本”的拦截策略。
- 用户明确要求：前端可隐藏脏头，但关键词与召回侧也必须去掉 metadata 垃圾词，避免影响准确率。
- 用户新增要求：出现“助手+未知时间+空信息”时应直接修正代码，不再让空记录出现在管理页。
- 用户新增要求：确认“用户原文垃圾头”来源并在代码层清理，而不是仅前端隐藏。
- 用户新增要求：assistant 协议头（`[[reply_to_current]]`）不应出现在记忆链路与调试可见内容中。
- 用户新增反馈：若仍出现协议头，继续按链路补齐，不只修单点。
- 用户新增要求：日志里看到脏头就视为未修复，必须在采集打印与入队前彻底清理。
- 用户新增要求：`[agents/tool-images] Image resized...` 提示需关闭（与业务记忆无关且影响视觉）。
- 用户确认：按审查报告中的 1/2/3 三项直接给出补丁。
- 用户确认：在保证现有功能前提下执行一次“大整理/大清洗”；nssm 服务相关核心文件名和功能不变。

## 未解决问题 / 风险
- 当前工作区存在大量历史未提交改动，操作时需避免误回滚。
- 日志中有历史错误，排障时要看最新时间段，不要被旧错误误导。
- 后端改动后需结合服务重启做实机验证。
- `server.js` 当前由 `nssm` 系统服务托管，本轮代码改动需由有权限账户重启服务后才会在线生效。
- 当前“显示清洗”仅作用于管理页列表正文；若后续在别的页面/接口直接展示 raw text，仍可能看到时间头。
- 线程中出现 `[agents/tool-images] Image resized...` 文案，属于宿主工具层提示，非本插件日志；若频繁出现需到宿主端排查触发源。
- 目前注入正文清洗会移除时间头，若后续需要“模型保留时间但用户不显示”，需改为双通道（显示文本/模型文本分离）。
- 若时间文本出现在注入块的 `# 用户输入` 部分，则来源是宿主传入的用户消息原文，非 memory list 注入内容（插件当前仅控制 memory list 文本）。
- `# 用户输入` 去时间头目前为“依赖宿主是否接受事件对象改写”的实验方案，存在不生效风险。
- 宿主 `node_modules` 改动会被 OpenClaw 升级覆盖；需在升级后重新执行恢复脚本。
- 仍需重启 `MemoryAutoSummary` 服务后，2 小时周期与“按批次总结”才会在线生效。
- 记忆分类口径（raw/insight 细分规则）仍待用户最终定稿。
- `auto_summary` 的 `order_by=timestamp` 依赖 Qdrant payload range index；若不建索引，旧逻辑会触发 `scroll 400`。
- 自动总结生成的 insight 目前仍写 `role=assistant`；当前已通过前端判定保证显示为“精华（用户侧）”，如后续要在数据层统一角色还需单独改口径。
- 若历史记录既无 `timestamp` 也无可解析文本时间片段，仍会显示“未知时间”（属于数据源缺失）。
- `filter-service.js` 新逻辑需要对应服务重启后才会在线生效；未重启时仍会表现为旧筛选行为。
- 若宿主实际看板服务仍运行在 `3010`，注入提示将与真实入口不一致；需以当前部署端口为准。
- 历史已入库记录的旧 `tags` 不会自动回写清理；本次修复仅对“新写入/新总结”生效。
- 本轮仅做“接口返回 + 前端展示”过滤，未物理删除向量库中历史空记录；如需彻底清理需单独执行清库脚本。
- 若宿主未来再改 metadata 头字段名（非 Sender/Conversation info），仍可能出现新噪音，需按新字段追加清洗模式。
- 若宿主未来新增其它协议控制标记（非 `[[...]]` 形式），仍需按新格式补充清洗规则。
- 宿主聊天主界面的最终渲染若直接展示上游原始 assistant 内容（绕过插件链路），仍可能看到协议头；该部分需宿主侧修正。
- 当前改动需重启托管服务后才生效；未重启时日志仍会显示旧行为。
- 该提示若在宿主主界面“非插件链路”直接渲染，插件无法从源头关闭；本次已在插件可控链路全部屏蔽。
- `auto_summary` 仍使用“写入 `processed=\"processing\"` 后再汇总”的软锁方案；若未来出现异常退出，可能留下处理中状态，需要补“超时回收”策略。
- 由于本次移除了大量历史误追踪文件（`node_modules`），首次推送变更体量较大；需关注远端仓库接收耗时。

## 下一步
- 下一次要继续开发时：
  1. 先读本文件。
  2. 用最新日志确认目标问题。
  3. 重启服务以加载本轮修复（至少重启 `node server.js` 与 `auto_summary.py` 进程）。
  4. 执行语法/运行检查。
  5. 验证点：
     - `DELETE /api/memory/:id` 对非法 ID 返回 400，合法 UUID 可删除。
     - `auto_summary` 不再出现 `points/payload 404`；如仍有 `scroll 400`，确认是否为旧进程或补建 `timestamp` 索引。
     - 新采集记录的 `mem_type` 应固定为 `raw`。
     - 自动总结应能处理 `source_type=refined` 的未处理记录。
     - 手动输入与自动总结产物都应显示为“精华”。
     - 管理页中历史记录时间应尽量可显示；仅完全缺失时间信息时显示“未知时间”。
     - 自动总结新生成精华的 tags 数量应明显增加（目标 8-15）；前端应可直接看到类型徽标。
     - 普通采集记录（非总结）也应观察 tags 数量提升（目标 8-15），并关注召回质量与速度平衡。
     - 复测“上传图片 + 问图内容”场景，确认模型不再回复“未看到图片”；如仍异常，优先排查 OpenClaw 上游多模态转发链路。
     - 如需 A/B 验证：切换 `disableRecallOnImage=true/false` 对比视觉识别稳定性。
     - 回归“用户录入带脏头”样例：`user: Sender (untrusted metadata): ```json ...``` [time] 正文`，确认入库仅保留正文。
     - 回归短文本写入：例如“我女儿叫小雨”（7 字），应可通过 `POST /api/memory` 写入成功，不再返回“记忆文本太短”。
     - 回归管理页显示：正文开头含 `[Wed ... GMT+8]` 的记录，页面应隐藏该头信息；模型侧检索/向量库原文保持不变。
     - 回归注入提示块：应同时显示 `http://localhost:3001/` 与 `http://localhost:3000/` 两个链接。
     - 回归注入正文：含 `[Wed ... GMT+8]` 的记忆在注入块中不再显示该时间头。
     - 若仍看到时间头，区分位置：`[记忆]/[精华]` 区仍出现=插件清洗问题；`# 用户输入` 区出现=宿主原文传入。
     - 回归实验改写：观察 `# 用户输入` 区时间头是否消失；若仍存在，判定宿主忽略 `event.prompt/event.messages` 改写。
     - OpenClaw 升级后执行 `apply-openclaw-display-mask.ps1`，并重启宿主验证显示层是否恢复。
     - 回归存储口径：正常消息应以 `source_type=refined` 入库；仅模型梳理异常时回退为 `source_type=raw`。
     - 回归模型筛选：输入“加油，好了吗”应被判定为闲聊并过滤，不写入记忆。
     - 回归关键词清洗：构造 `Conversation info (untrusted metadata): ```json ... message_id ...``` 正文`，确认新写入记录 `tags` 不含 `conversation/info/untrusted/metadata/message_id/UUID`。
     - 回归空记录问题：列表中不应再出现“助手 + 未知时间 + 空正文”；缺失 role 的记录应显示为“记录（📝）”。
     - 回归宿主 metadata 头：输入包含 `Conversation info (untrusted metadata)` 的样本，确认注入和用户原文展示都不再出现该头。
     - 回归 assistant 协议头：模拟含 `[[reply_to_current]]` 的 assistant 内容，确认 CMD 日志预览与最终入库文本都不再出现该标记。
     - 回归助手最终回复展示：若主界面仍见 `[[reply_to_current]]`，判定为宿主渲染层问题，转宿主侧处理。
     - 回归 CMD 日志：观察 `消息1/消息2` 预览，确认不再包含 `Conversation info (untrusted metadata)` 头。
     - 回归工具提示：构造或等待出现 `[agents/tool-images] Image resized...`，确认管理页、注入记忆、写库 tags/正文均不再出现。
     - 回归审查项 1：并发/快速连续触发 `auto_summary`，确认同一批记录不再被重复抓取处理。
     - 回归审查项 2：在插件配置页确认新增字段可见（`keywordMin/keywordTarget/useLLMFilter/filterRules`），且默认值与运行日志一致。
     - 回归审查项 3：输入正常方括号日期文本（非系统时间头）后，确认正文不会被误清理。
     - 回归仓库清洁度：`git status` 仅出现真实代码/文档改动，不再出现 `node_modules` 与运行日志噪音。
     - 回归总结节奏：`auto_summary` 每 2 小时按批次（最多 20 条）生成 1 条综合 insight，而非逐条生成。
  6. 在同一轮更新本文件。

## 常用命令
```powershell
# 在本项目恢复 Codex 最近会话
codex resume --all --last -C "C:\Users\oadan\openclaw_plugins\memory-qdrant"

# 手工启动管理端（调试）
Set-Location "C:\Users\oadan\openclaw_plugins\memory-qdrant"
node server.js

# 手工运行 auto_summary（单次/循环）
python auto_summary\auto_summary.py --once
python auto_summary\auto_summary.py

# 若使用 nssm 托管（需管理员权限）
nssm restart <memory-qdrant-server-service-name>
nssm restart <memory-qdrant-auto-summary-service-name>
nssm restart MemoryAutoSummary

# 查看关键日志
Get-Content -Tail 200 "C:\Users\oadan\openclaw_plugins\memory-qdrant\logs\qdmmerr.log"
Get-Content -Tail 200 "C:\Users\oadan\openclaw_plugins\memory-qdrant\logs\qdmmout.log"
Get-Content -Tail 200 "C:\Users\oadan\openclaw_plugins\memory-qdrant\auto_summary\auto_summary.log"

# 本地快速检查前端显示清洗函数是否在位
rg -n "cleanTextForDisplay|message-text-content|copyMessage\\(" frontend\memory-manager-new.html

# 本地快速检查注入文本清洗函数是否在位
rg -n "cleanInjectedMemoryText|formatPromptBlock|memory_value" prompt-builder.js

# 本地快速检查注入看板链接端口
rg -n "多代理监控看板|localhost:3000" prompt-builder.js handoff.md

# 本地快速检查模型筛选逻辑是否在位
rg -n "action === 'discard'|conversation.*store_refined|加油|好了吗" filter-service.js

# 本地快速检查 metadata 垃圾词过滤是否在位
rg -n "conversation\\s*info|message_id|sanitizeKeywords\\(|isNoiseToken\\(" qdrant.js server.js auto_summary/auto_summary.py

# 本地快速检查“空记录/助手误标”修复是否在位
rg -n "hasRenderableText|payload\\.role \\|\\| 'assistant'|cleanInputText\\(payload\\.text" frontend/memory-manager-new.html server.js

# 本地快速检查上游 metadata 头清洗是否覆盖 Conversation info
rg -n "conversation\\s*info\\s*\\(untrusted metadata\\)|stripSenderMeta|cleanInjectedMemoryText" index.js prompt-builder.js

# 本地快速检查宿主协议头清洗是否在位
rg -n "stripProtocolMarkers|\\[\\[a-z0-9_:-\\]\\]|reply_to_current" index.js qdrant.js prompt-builder.js

# 本地快速检查 `[[...]]` 全链路清洗是否在位
rg -n "\\[\\[a-z0-9_:-\\]\\]|strip_sender_metadata|cleanInputText|cleanTextForDisplay" index.js server.js auto_summary/auto_summary.py frontend/memory-manager-new.html

# 本地快速检查 agent_end 是否改为清洗后日志/入队
rg -n "cleanedMessages|捕获到 .*清洗后消息|sanitizeUserPromptForModel\\(text\\)" index.js

# 本地快速检查 `[agents/tool-images]` 屏蔽是否在位
rg -n "agents/tool-images|Image resized to fit limits" index.js qdrant.js server.js prompt-builder.js auto_summary/auto_summary.py frontend/memory-manager-new.html filter-service.js

# 本地快速检查 1/2/3 审查项补丁
Select-String -Path auto_summary\auto_summary.py -Pattern '"value": "processing"'
Select-String -Path openclaw.plugin.json -Pattern 'keywordMin|keywordTarget|useLLMFilter|filterRules|bge-m3'
rg -n "sanitizeUserPromptForModel|仅匹配已知系统格式|\\[\\^\\]\\*\\\\d\\{4\\}-\\\\d\\{2\\}-\\\\d\\{2\\}" index.js

# 本地快速检查仓库是否仍追踪 node_modules/log
git ls-files node_modules
git ls-files auto_summary/*.log

# 升级后重打宿主显示层补丁（仅隐藏显示，不改模型输入）
powershell -NoProfile -ExecutionPolicy Bypass -File .\apply-openclaw-display-mask.ps1
```
