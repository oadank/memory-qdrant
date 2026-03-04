// text-cleaner.js
// 后端 JS 链路统一清洗规则，减少多处正则漂移导致的回归。

const RE_ROLE_PREFIX = /^\s*(user|assistant)\s*:\s*/i;
const RE_TOOL_IMAGES_LINE = /\[agents\/tool-images\][^\n\r]*/ig;
const RE_UNTRUSTED_BLOCK = /(?:sender|conversation\s*info)\s*\(untrusted metadata\)\s*:\s*```(?:json)?[\s\S]*?```/ig;
const RE_UNTRUSTED_INLINE = /(?:sender|conversation\s*info)\s*\(untrusted metadata\)\s*:\s*/ig;
const RE_PROTOCOL_HEAD = /^\s*(?:\[\[[a-z0-9_:-]+\]\]\s*)+/ig;
const RE_PROTOCOL_INLINE = /\s*\[\[[a-z0-9_:-]+\]\]\s*/ig;

const RE_WEEKDAY_TIME_HEAD = /^\s*\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/ig;
const RE_ISO_TIME_HEAD = /^\s*\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s*/ig;
const RE_BROAD_LEADING_BRACKET = /^\s*\[[^\]]{5,100}\]\s*/g;
const RE_INLINE_WEEKDAY_TIME = /(?:^|\s)\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}[^\]]{0,40}\]\s*/g;
const RE_INLINE_ANY_DATE_BRACKET = /(?:^|\s)\[[^\]]*\d{4}-\d{2}-\d{2}[^\]]*\]\s*/g;

function collapseSpaces(s) {
  return s.replace(/\s+/g, " ").trim();
}

export function stripProtocolMarkers(raw) {
  let s = (raw ?? "").toString();
  s = s.replace(RE_PROTOCOL_HEAD, "");
  s = s.replace(RE_PROTOCOL_INLINE, " ");
  return collapseSpaces(s);
}

export function isProtocolOnly(raw) {
  const s = (raw ?? "").toString().trim();
  return /^\s*(\[\[[a-z0-9_:-]+\]\]\s*)+$/i.test(s);
}

/**
 * 通用文本清洗：
 * - role 前缀
 * - 宿主工具提示
 * - untrusted metadata
 * - 宿主协议标记 [[...]]
 * - 时间头（可按选项控制）
 */
export function sanitizeText(raw, opts = {}) {
  const {
    removeRolePrefix = true,
    removeToolImageNotice = true,
    removeUntrustedMetadata = true,
    removeProtocolMarkers = true,
    removeWeekdayTimeHead = true,
    removeIsoTimeHead = true,
    removeInlineWeekdayTime = true,
    removeBroadLeadingBracket = false,
    removeInlineAnyDateBracket = false
  } = opts;

  let s = (raw ?? "").toString();

  if (removeRolePrefix) s = s.replace(RE_ROLE_PREFIX, "");
  if (removeToolImageNotice) s = s.replace(RE_TOOL_IMAGES_LINE, " ");
  if (removeUntrustedMetadata) {
    s = s.replace(RE_UNTRUSTED_BLOCK, " ");
    s = s.replace(RE_UNTRUSTED_INLINE, " ");
  }
  if (removeProtocolMarkers) {
    s = s.replace(RE_PROTOCOL_HEAD, "");
    s = s.replace(RE_PROTOCOL_INLINE, " ");
  }
  if (removeWeekdayTimeHead) s = s.replace(RE_WEEKDAY_TIME_HEAD, "");
  if (removeIsoTimeHead) s = s.replace(RE_ISO_TIME_HEAD, "");
  if (removeBroadLeadingBracket) s = s.replace(RE_BROAD_LEADING_BRACKET, "");
  if (removeInlineWeekdayTime) s = s.replace(RE_INLINE_WEEKDAY_TIME, " ");
  if (removeInlineAnyDateBracket) s = s.replace(RE_INLINE_ANY_DATE_BRACKET, " ");

  return collapseSpaces(s);
}

