// prompt-builder.js
import { sanitizeText } from "./text-cleaner.js";
export const USER_QUERY_MARKER = "\n\n# 用户输入\n";

function safeTrim(s) {
  return (s ?? "").toString().trim();
}

function clip(text, maxLen) {
  const t = (text ?? "").toString();
  if (!maxLen || maxLen <= 0) return t;
  return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;
}

function cleanInjectedMemoryText(text) {
  return sanitizeText(text, {
    removeRolePrefix: true,
    removeToolImageNotice: true,
    removeUntrustedMetadata: true,
    removeProtocolMarkers: true,
    removeWeekdayTimeHead: true,
    removeIsoTimeHead: true,
    removeInlineWeekdayTime: true,
    removeBroadLeadingBracket: false,
    // 注入显示继续保留“日期方括号宽清理”，避免用户侧看到时间头噪音
    removeInlineAnyDateBracket: true
  });
}

export function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractText).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    if (Array.isArray(content.content)) return content.content.map(extractText).filter(Boolean).join("\n");
  }
  return "";
}

// 中英文类型映射 - 简化为 2 种显示类型
const typeMap = {
  // 原始对话类型 -> [记忆]
  fact: "记忆",
  user: "记忆",
  assistant: "记忆",
  raw: "记忆",
  // 精华类型 -> [精华]
  preference: "精华",
  rule: "精华",
  skill: "精华",
  personality: "精华",
  experience: "精华",
  error: "精华",
  inference: "精华",
  insight: "精华",
  "assistant 观点": "精华",
  manual: "精华"
};

/**
 * result: { data: { memory_detail_list: [...] } }
 * opts: { wrapTagBlocks: boolean, maxItemChars: number }
 */
export function formatPromptBlock(result, opts = {}) {
  const list = result?.data?.memory_detail_list ?? [];
  if (!Array.isArray(list) || list.length === 0) return "";

  const wrapTagBlocks = opts.wrapTagBlocks !== false; // 默认为 true
  const maxItemChars = opts.maxItemChars ?? 800;

  const lines = [];
  lines.push("# 注入记忆");
  lines.push("");
  lines.push("记忆类型说明：");
  lines.push("- `[记忆]`：用户或者助手的聊天记录原文");
  lines.push("- `[精华]`：用户手动输入的重要信息，或 AI 自动总结的洞察");
  lines.push("- 后台管理页面：[http://localhost:3001/](http://localhost:3001/)");
  lines.push("- 多代理监控看板：[http://localhost:3000/](http://localhost:3000/)");
  lines.push("# 匹配的记忆");
  lines.push("");

  for (const item of list) {
    const text = cleanInjectedMemoryText(safeTrim(item?.memory_value));
    if (!text) continue;

    // 原始字段
    const typeEn = safeTrim(item?.mem_type) || safeTrim(item?.type) || "fact";

    if (wrapTagBlocks) {
      // 转换为中文
      const typeZh = typeMap[typeEn] || "记忆";

      lines.push(`[${typeZh}]：`);
      lines.push(clip(text, maxItemChars));
      lines.push(""); // 空行
    } else {
      // wrapTagBlocks = false 时，只输出文本（无元数据，无前缀）
      lines.push(clip(text, maxItemChars));
    }
  }

  const block = lines.join("\n").trim();
  return block ? `${block}\n${USER_QUERY_MARKER}` : "";
}

// ----- 以下函数完全保持不变 -----
export function stripPrependedPrompt(content) {
  if (!content) return content;
  const idx = content.lastIndexOf(USER_QUERY_MARKER);
  if (idx === -1) return content;
  return content.slice(idx + USER_QUERY_MARKER.length).trimStart();
}

export function truncate(text, maxLen) {
  if (!text) return "";
  if (!maxLen) return text;
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

export function pickLastTurnMessages(messages, cfg) {
  const lastUserIndex = (messages ?? [])
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m?.role === "user")
    .map(({ idx }) => idx)
    .pop();

  if (lastUserIndex === undefined) return [];

  const slice = messages.slice(lastUserIndex);
  const results = [];

  for (const msg of slice) {
    if (!msg || !msg.role) continue;

    if (msg.role === "user") {
      const content = stripPrependedPrompt(extractText(msg.content));
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
      continue;
    }

    if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }

  return results;
}

export function pickFullSessionMessages(messages, cfg) {
  const results = [];
  for (const msg of messages ?? []) {
    if (!msg || !msg.role) continue;

    if (msg.role === "user") {
      const content = stripPrependedPrompt(extractText(msg.content));
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
    }

    if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }
  return results;
}
