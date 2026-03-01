// prompt-builder.js
export const USER_QUERY_MARKER = "\n\n# 用户输入\n";

function safeTrim(s) {
  return (s ?? "").toString().trim();
}

function clip(text, maxLen) {
  const t = (text ?? "").toString();
  if (!maxLen || maxLen <= 0) return t;
  return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;
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
  return String(content);
}

// 中英文类型映射
const typeMap = {
  fact: "记忆",
  preference: "偏好",
  rule: "规则",
  skill: "技能",
  personality: "性格",
  experience: "经验",
  error: "错误",
  inference: "推测总结",
  insight: "精华"
};

// 来源类型映射
const sourceMap = {
  raw: "原始",
  insight: "洞察",
};

// 角色映射
const roleMap = {
  user: "用户",
  assistant: "助手",
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
  lines.push("- `[记忆]`：客观事实（用户陈述或确认的信息）");
  lines.push("- `[偏好]`：用户偏好（喜欢/不喜欢、习惯）");
  lines.push("- `[规则]`：行为规则或约束（必须遵守）");
  lines.push("- `[技能]`：技能或方法（如何做某事）");
  lines.push("- `[性格]`：人格特质（回复风格等）");
  lines.push("- `[经验]`：经验总结（从过往任务中习得）");
  lines.push("- `[错误]`：错误教训（应避免的行为）");
  lines.push("- `[推测总结]`：AI 推断或总结，非用户直接陈述");
  lines.push("- `[精华]`：用户手动输入的重要信息");
  lines.push("# 匹配的记忆");
  lines.push("");

  for (const item of list) {
    const text = safeTrim(item?.memory_value);
    if (!text) continue;

    // 原始字段
    const typeEn = safeTrim(item?.mem_type) || safeTrim(item?.type) || "fact";
    const timestamp = safeTrim(item?.create_time);
    const sourceTypeEn = safeTrim(item?.source_type); // raw / insight
    const roleEn = safeTrim(item?.role);             // user / assistant

    if (wrapTagBlocks) {
      // 转换为中文
      const typeZh = typeMap[typeEn] || typeEn;

      // 构建元数据部分（只显示记忆类型）
      const metaParts = [];
      metaParts.push(`[${typeZh}]`);

      const metaLine = metaParts.join("");

      // 输出：元数据行 + 换行 + 文本（可能截断），然后空行分隔
      lines.push(`${metaLine}：`);
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