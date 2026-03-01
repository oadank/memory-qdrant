// 禁用弃用警告（必须放在最前面）
process.noDeprecation = true;

import { buildConfig, searchMemory, addMessage } from "./qdrant.js";
import {
  extractText,
  formatPromptBlock,
  pickFullSessionMessages,
  pickLastTurnMessages
} from "./prompt-builder.js";

let lastCaptureTime = 0;

// ---------- 默认过滤规则 ----------
const defaultFilterRules = {
  minLength: 10,
  userBlacklist: [
    '截屏', '截图', '重启', '打开浏览器', '/new', '/reset', '你好', '测试', '继续', '你挂了？',
    'HEARTBEAT.md', 'Read HEARTBEAT.md', 'If nothing needs attention',
    'Do not infer or repeat old tasks from prior chats', 'Current time',
    '你正在通过 QQ 与用户对话', '定时', '提醒', 'System', '更新', '尼玛', '傻逼'
  ],
  assistantBlacklistPatterns: [
    '^很高兴见到你',
    '有什么可以帮你的吗',
    '你好，我是',
    '我是你的AI助理',
    '新会话',
    '会话已',
    '新会话启动',
    'IDENTITY\\.md 现在是空的',
    '让我自我介绍一下',
    "I'm online",
    "I'm online and ready to go",
    'What do you want',
    '想干点啥',
    '干啥',
    'HEARTBEAT_OK',
    'object Object',
  ],
  deleteKeywords: ['删除最后一条记忆', '删除刚才那句', '删除刚才的问题', '删除上一条', '删除关于'],
  summaryKeywords: ['总结记忆', '总结一下', '帮我总结']
};

function buildFilterRules(config) {
  const configFilterRules = config.filterRules || {};
  return {
    minLength: configFilterRules.minLength ?? defaultFilterRules.minLength,
    userBlacklist: configFilterRules.userBlacklist ?? defaultFilterRules.userBlacklist,
    assistantBlacklistPatterns: configFilterRules.assistantBlacklistPatterns ?? defaultFilterRules.assistantBlacklistPatterns,
    deleteKeywords: configFilterRules.deleteKeywords ?? defaultFilterRules.deleteKeywords,
    summaryKeywords: configFilterRules.summaryKeywords ?? defaultFilterRules.summaryKeywords,
  };
}

// ---------- 统一前缀的过滤函数 ----------
function shouldStore(text, role, filterRules, debug = false) {
  if (!text || text.length < filterRules.minLength) {
    if (debug) console.log(`[memory-qdrant] 过滤：消息过短 (${text?.length})，不存储`);
    return false;
  }

  if (role === 'user') {
    for (const keyword of filterRules.userBlacklist) {
      if (text.includes(keyword)) {
        if (debug) console.log(`[memory-qdrant] 过滤：用户消息命中黑名单词“${keyword}”，被过滤`);
        return false;
      }
    }
    for (const keyword of filterRules.deleteKeywords) {
      if (text.includes(keyword)) {
        if (debug) console.log(`[memory-qdrant] 过滤：用户消息包含删除指令“${keyword}”，不存储`);
        return false;
      }
    }
    for (const keyword of filterRules.summaryKeywords) {
      if (text.includes(keyword)) {
        if (debug) console.log(`[memory-qdrant] 过滤：用户消息包含总结指令“${keyword}”，不存储`);
        return false;
      }
    }
  }

  if (role === 'assistant') {
    for (const pattern of filterRules.assistantBlacklistPatterns) {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(text)) {
        if (debug) console.log(`[memory-qdrant] 过滤：助手消息命中黑名单模式“${pattern}”，被过滤`);
        return false;
      }
    }
  }

  return true;
}

// ---------- 辅助函数 ----------
function shouldSkipRecall(prompt, cfg) {
  if (!cfg.recallEnabled) return true;
  if (!prompt || prompt.trim().length < 3) return true;
  return false;
}

function shouldSkipAdd(event, cfg) {
  if (!cfg.addEnabled) return true;
  if (!event?.success) return true;
  if (!Array.isArray(event?.messages) || event.messages.length === 0) return true;
  return false;
}

export default {
  id: "memory-qdrant",
  name: "memory-qdrant",
  description: "Local Qdrant memory",
  kind: "lifecycle",

  register(api) {
    console.log("[memory-qdrant] 插件已加载");

    api.on("before_agent_start", async (event) => {
      const cfg = buildConfig(api.pluginConfig);
      const filterRules = buildFilterRules(api.pluginConfig);

      const prompt = extractText(event?.prompt);
      if (shouldSkipRecall(prompt, cfg)) {
        if (cfg.debug) console.log(`[memory-qdrant] 跳过召回：${prompt?.length ? '文本过短' : '空文本'}`);
        return;
      }

      // 打印用户原文（无前缀，保持简洁，限制长度）
      if (cfg.debug) {
        let truncatedPrompt = prompt;
        if (truncatedPrompt.length > 90) {
          truncatedPrompt = truncatedPrompt.slice(0, 90) + "…";
        }
        console.log(`[memory-qdrant] 用户原文：${truncatedPrompt}`);
      }

      // 不管是否命中黑名单，检索都要正常进行
      try {
        const payload = {
          query: prompt,
          memory_limit_number: cfg.memoryLimitNumber
        };

        const result = await searchMemory(cfg, payload);

        if (cfg.debug && result?._debug) {
          console.log("\n[MEMORY DEBUG]");
          const kwLine = Array.isArray(result._debug.keywords) && result._debug.keywords.length
            ? result._debug.keywords.join(", ")
            : "无";

          console.log(`关键词: ${kwLine}`);
          console.log(`向量命中: ${result._debug.denseHits} | 关键词命中: ${result._debug.sparseHits} | 最终融合: ${result._debug.fusedHits}`);

          if (Array.isArray(result._debug.topPreview) && result._debug.topPreview.length) {
            console.log("Top 3 结果预览:");
            result._debug.topPreview.slice(0, 3).forEach((item, i) => {
              let preview = (item?.text ?? "").toString().replace(/\n/g, " ");
              // 限制显示长度
              if (preview.length > 90) {
                preview = preview.slice(0, 90) + "…";
              }
              const s = typeof item?.score === "number" ? item.score.toFixed(4) : "n/a";
              console.log(`#${i + 1} 分数=${s} -> ${preview}`);
            });
          }
        }

        const promptBlock = formatPromptBlock(result, {
          wrapTagBlocks: true,
          maxItemChars: cfg.maxItemChars
        });

        if (!promptBlock || !promptBlock.trim()) {
          if (cfg.debug) console.log("[memory-qdrant] 无可注入记忆");
          return; // 不注入任何内容，保持干净
        }

        if (cfg.debug) {
          console.log(`[memory-qdrant] 已注入系统提示词+查询记忆`);
        }

        return { prependContext: promptBlock };
      } catch (err) {
        console.error("[memory-qdrant] 召回失败:", err);
      }
    });

    api.on("agent_end", async (event) => {
      const cfg = buildConfig(api.pluginConfig);
      const filterRules = buildFilterRules(api.pluginConfig);

      if (shouldSkipAdd(event, cfg)) {
        if (cfg.debug) console.log("[memory-qdrant] 跳过添加：事件不满足条件");
        return;
      }

      const now = Date.now();
      if (cfg.throttleMs && now - lastCaptureTime < cfg.throttleMs) {
        if (cfg.debug) console.log(`[memory-qdrant] 跳过添加：节流限制（${cfg.throttleMs}ms）`);
        return;
      }
      lastCaptureTime = now;

      try {
        const rawMessages =
          cfg.captureStrategy === "full_session"
            ? pickFullSessionMessages(event.messages, cfg)
            : pickLastTurnMessages(event.messages, cfg);

        if (!rawMessages.length) {
          if (cfg.debug) console.log("[memory-qdrant] 跳过添加：无符合策略的消息");
          return;
        }

        // 过滤消息：只保留通过 shouldStore 的消息
        const filteredMessages = [];
        for (const msg of rawMessages) {
          const text = extractText(msg.content);
          const role = msg.role;
          if (shouldStore(text, role, filterRules, cfg.debug)) {
            filteredMessages.push(msg);
          }
        }

        if (filteredMessages.length === 0) {
          if (cfg.debug) console.log("[memory-qdrant] 所有消息均被过滤，不写入任何消息");
          return;
        }

        const payload = { messages: filteredMessages };
        const r = await addMessage(cfg, payload);

        if (cfg.debug) {
          if (r?.ok) {
            console.log(`[memory-qdrant] 写入成功: id=${r.id} count=${r.count ?? filteredMessages.length}`);
          } else {
            console.log(`[memory-qdrant] 写入跳过: ${r?.reason || "unknown"}`);
          }
        }
      } catch (err) {
        console.error("[memory-qdrant] 添加消息失败:", err);
      }
    });
  }
};