// qdrant.js
import { QdrantClient } from "@qdrant/js-client-rest";
import { v4 as uuidv4 } from "uuid";
import crypto from "node:crypto";

/** ---------------- config ---------------- */

export function buildConfig(pluginConfig = {}) {
  return {
    recallEnabled: pluginConfig.recallEnabled ?? true,
    addEnabled: pluginConfig.addEnabled ?? true,
    debug: pluginConfig.debug ?? true,

    qdrantUrl: pluginConfig.qdrantUrl ?? "http://127.0.0.1:6333",
    collection: pluginConfig.collection ?? "agent_memory",

    embeddingProvider: pluginConfig.embeddingProvider ?? "ollama",
    ollamaUrl: pluginConfig.ollamaUrl ?? "http://127.0.0.1:11434",
    embeddingModel: pluginConfig.embeddingModel ?? "nomic-embed-text",

    // recall limits
    memoryLimitNumber: pluginConfig.memoryLimitNumber ?? 3,
    denseLimit: pluginConfig.denseLimit ?? 60,
    sparseEnabled: pluginConfig.sparseEnabled ?? true,
    sparseCandidateLimit: pluginConfig.sparseCandidateLimit ?? 240,
    sparseLimit: pluginConfig.sparseLimit ?? 80,

    // keywords
    maxKeywords: pluginConfig.maxKeywords ?? 16,
    kwMinHits: pluginConfig.kwMinHits ?? 2,          // 关键词多时最低命中数
    kwMinHitsShort: pluginConfig.kwMinHitsShort ?? 1, // 关键词少时最低命中数

    // scoring (线性加权)
    wDense: pluginConfig.wDense ?? 1.0,
    wKw: pluginConfig.wKw ?? 0.25,
    wRecency: pluginConfig.wRecency ?? 0.15,
    wInsight: pluginConfig.wInsight ?? 0.10,
    wRole: pluginConfig.wRole ?? 0.05,

    // recency: 半衰期（小时）
    recencyHalfLifeHours: pluginConfig.recencyHalfLifeHours ?? 72,

    // text clean
    cleanMaxLen: pluginConfig.cleanMaxLen ?? 600,
    minCaptureChars: pluginConfig.minCaptureChars ?? 12,

    // write
    throttleMs: pluginConfig.throttleMs ?? 800,
    captureStrategy: pluginConfig.captureStrategy ?? "last_turn",
    includeAssistant: pluginConfig.includeAssistant ?? true, // 你现在要默认存 assistant
    maxMessageChars: pluginConfig.maxMessageChars ?? 2000,

    // stopwords
    extraStopWords: Array.isArray(pluginConfig.extraStopWords) ? pluginConfig.extraStopWords : [],
    badQueryTokens: Array.isArray(pluginConfig.badQueryTokens) ? pluginConfig.badQueryTokens : [],

    // dedup
    dedupEnabled: pluginConfig.dedupEnabled ?? true,
    dedupLookbackLimit: pluginConfig.dedupLookbackLimit ?? 1, // 查到一个就够了

    // metadata
    tags: Array.isArray(pluginConfig.tags) ? pluginConfig.tags : [],

    // optional qdrant filter
    filter: pluginConfig.filter ?? null
  };
}

export function makeQdrantClient(cfg) {
  return new QdrantClient({ url: cfg.qdrantUrl });
}

/** ---------------- embedding ---------------- */

async function ollamaEmbed(cfg, text) {
  const url = new URL("/api/embeddings", cfg.ollamaUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.embeddingModel, prompt: text })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ollama embeddings failed: ${res.status} ${t}`);
  }

  const data = await res.json();
  const vec = data?.embedding;
  if (!Array.isArray(vec) || vec.length === 0) throw new Error("ollama returned empty embedding");
  return vec;
}

export async function embedText(cfg, text) {
  try {
    if (!text || !text.trim()) throw new Error("empty text for embedding");
    if (cfg.embeddingProvider === "ollama") return ollamaEmbed(cfg, text);
    throw new Error(`unsupported embeddingProvider: ${cfg.embeddingProvider}`);
  } catch (error) {
    console.error(`[memory-qdrant] 文本嵌入失败: ${error.message}`);
    throw error;
  }
}

/** ---------------- text cleaning ---------------- */

/**
 * 目标：
 * 1) 记忆正文不存 "user:" / "assistant:" 前缀
 * 2) 不存 "[Fri 2026-... GMT+8]" 这种时间戳前缀（时间用 payload.timestamp）
 * 3) 丢/截断日志块（Headers/Body/token...）
 */
export function cleanTextForMemory(raw, maxLen = 600) {
  let t = (raw ?? "").toString();

  // 去掉 role 前缀：user: / assistant:
  t = t.replace(/^\s*(user|assistant)\s*:\s*/i, "");

  // 去掉开头的 [Fri 2026-02-27 ...] 这类时间戳前缀（尽量宽松）
  // 例：[Fri 2026-02-27 11:02 GMT+8] xxx
  t = t.replace(/^\s*\[[^\]]{5,80}\]\s*/g, "");

  // 截断日志块：一出现就把后面砍掉（避免 token/headers/body 主导 embedding）
  const cutMarkers = [
    ">>> ",
    "<<< ",
    "Headers:",
    "Body:",
    "access_token",
    "clientSecret",
    "expires_in",
    "Token cached",
    "[qqbot-api]",
    "Content-Type",
    "application/json"
  ];
  let cutAt = -1;
  for (const m of cutMarkers) {
    const idx = t.indexOf(m);
    if (idx !== -1) cutAt = cutAt === -1 ? idx : Math.min(cutAt, idx);
  }
  if (cutAt !== -1) t = t.slice(0, cutAt);

  // 压缩空白
  t = t.replace(/\s+/g, " ").trim();

  // 最大长度
  if (maxLen > 0 && t.length > maxLen) t = t.slice(0, maxLen) + "…";
  return t;
}

function sha1(s) {
  return crypto.createHash("sha1").update(s, "utf8").digest("hex");
}

/** ---------------- nodejieba lazy-load ---------------- */

let _jieba = null;
async function getJieba() {
  if (_jieba !== null) return _jieba;
  try {
    const mod = await import("nodejieba");
    _jieba = mod?.default ?? mod;
  } catch {
    _jieba = null;
  }
  return _jieba;
}

/** ---------------- stopwords ---------------- */

const BASE_STOP = new Set([
  // 你明确要先禁的
  "你","我","它","他","她","他们","我们","你们",

  // 常见虚词
  "的","了","呢","啊","呀","嘛","吧","吗","是","在","和","与","及","或","就","都","也","还","但","如果","因为","所以",

  // 常见问句/语气词（先保守）
  "什么","怎么","为什么","现在","可以","是否","请问",

  // 英文/日志噪音
  "gmt","utc","json","headers","body","type","token","expires","cached","access","content",
  "post","get","status","server","date","application"
]);

function buildStopSet(cfg) {
  const s = new Set(BASE_STOP);
  for (const w of cfg.extraStopWords ?? []) s.add(String(w).toLowerCase());
  for (const w of cfg.badQueryTokens ?? []) s.add(String(w).toLowerCase());
  return s;
}

function isNoiseToken(token, stopSet) {
  const t = (token ?? "").toString().trim().toLowerCase();
  if (!t) return true;
  if (t.length < 2) return true;
  if (stopSet.has(t)) return true;

  // 纯数字 / 时间碎片
  if (/^\d+$/.test(t)) return true;
  if (/^[0-9\-:tz\.]+$/i.test(t)) return true;

  // 星期缩写
  if (/^(mon|tue|wed|thu|fri|sat|sun)$/i.test(t)) return true;

  return false;
}

function uniqKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

export async function extractKeywords(cfg, raw) {
  const stopSet = buildStopSet(cfg);

  const text = (raw ?? "").toString().trim();
  if (!text) return [];

  // 文本长度调整：对于过长文本，先截断到合适长度以提高处理效率
  const processText = text.length > 2000 ? text.slice(0, 2000) + "..." : text;

  const jieba = await getJieba();

  let tokens = [];
  if (jieba?.cut) {
    // 使用 Jieba 分词，并尝试提取短语
    tokens = jieba.cut(processText, true);

    // 尝试提取短语（2-gram 和 3-gram）
    const phrases = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      if (!isNoiseToken(tokens[i], stopSet) && !isNoiseToken(tokens[i+1], stopSet)) {
        phrases.push(tokens[i] + tokens[i+1]);
      }
      if (i < tokens.length - 2 && !isNoiseToken(tokens[i], stopSet) &&
          !isNoiseToken(tokens[i+1], stopSet) && !isNoiseToken(tokens[i+2], stopSet)) {
        phrases.push(tokens[i] + tokens[i+1] + tokens[i+2]);
      }
    }
    tokens = [...tokens, ...phrases];
  } else {
    tokens = processText
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/);
  }

  tokens = tokens
    .map((t) => (t ?? "").toString().trim().toLowerCase())
    .filter(Boolean)
    .filter((t) => !isNoiseToken(t, stopSet));

  // 频次统计
  const freq = new Map();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  // 计算 TF-IDF（简单版本）
  const totalTokens = tokens.length;
  const tfIdf = new Map();
  for (const [token, count] of freq.entries()) {
    const tf = count / totalTokens;
    // 简化的 IDF：根据词长给予额外权重，短语权重更高
    const idf = 1 + token.length * 0.1;
    tfIdf.set(token, tf * idf);
  }

  // 根据 TF-IDF 排序
  const ranked = [...tfIdf.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  return uniqKeepOrder(ranked).slice(0, Math.max(1, cfg.maxKeywords));
}

/** ---------------- Qdrant search ---------------- */

function buildFilterFromCfg(cfg) {
  if (cfg.filter && typeof cfg.filter === "object") return cfg.filter;
  return null;
}

export async function denseSearch(cfg, queryText) {
  const client = makeQdrantClient(cfg);
  const vector = await embedText(cfg, queryText);
  const filter = buildFilterFromCfg(cfg);

  const res = await client.search(cfg.collection, {
    vector,
    limit: cfg.denseLimit,
    with_payload: true,
    with_vector: false,
    ...(filter ? { filter } : {})
  });

  return Array.isArray(res) ? res : [];
}

/**
 * sparse：OR 召回候选（scroll should）
 * 然后本地用 kwHits 做排序 + 阈值过滤（减少噪声候选）
 */
export async function sparseKeywordCandidates(cfg, queryText) {
  if (!cfg.sparseEnabled) return { keywords: [], points: [] };

  const keywords = await extractKeywords(cfg, queryText);
  if (keywords.length === 0) return { keywords: [], points: [] };

  const client = makeQdrantClient(cfg);
  const baseFilter = buildFilterFromCfg(cfg);

  const should = keywords.map((kw) => ({ key: "tags", match: { value: kw } }));
  const filter = baseFilter
    ? { ...baseFilter, should: [...(baseFilter.should ?? []), ...should] }
    : { should };

  const out = await client.scroll(cfg.collection, {
    limit: cfg.sparseCandidateLimit,
    with_payload: true,
    with_vector: false,
    filter
  });

  return { keywords, points: Array.isArray(out?.points) ? out.points : [] };
}

function scoreByKeywordHits(payload, keywords) {
  const tags = Array.isArray(payload?.tags) ? payload.tags : [];
  let hits = 0;
  for (const kw of keywords) {
    if (kw && tags.includes(kw)) hits += 1;
  }
  return hits;
}

function parseTimestampMs(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  const ms = Date.parse(String(ts));
  return Number.isFinite(ms) ? ms : 0;
}

function recencyScore(tsMs, halfLifeHours) {
  const now = Date.now();
  if (!tsMs || tsMs <= 0) return 0;
  const ageHours = (now - tsMs) / 3600000;
  if (ageHours <= 0) return 1;
  const hl = Math.max(1, Number(halfLifeHours) || 72);
  // score = 0.5^(age/hl)
  return Math.pow(0.5, ageHours / hl);
}

/**
 * 线性加权排序：
 * final = wDense*denseRank + wKw*kwScore + wRecency*recency + wInsight*insight + wRole*role
 */
function rankScore(rank, base = 60) {
  if (!rank || rank <= 0) return 0;
  return 1 / (base + rank);
}

function roleBoost(payload) {
  const role = payload?.role;
  const memType = payload?.mem_type;
  // 简单：assistant 的 rule/skill 略加分（可后续再调）
  if (role === "assistant" && (memType === "rule" || memType === "skill")) return 1;
  return 0;
}

function insightBoost(payload) {
  return payload?.source_type === "insight" ? 1 : 0;
}

export async function searchMemory(cfg, payload) {
  try {
    const memoryLimit = payload?.memory_limit_number ?? cfg.memoryLimitNumber;

    // query 清洗，避免把日志/时间戳当成查询主体
    const cleanQuery = cleanTextForMemory(payload?.query ?? "", cfg.cleanMaxLen);

    const denseRes = await denseSearch(cfg, cleanQuery);

    let sparseRes = [];
    let keywords = [];

    if (cfg.sparseEnabled) {
      const cand = await sparseKeywordCandidates(cfg, cleanQuery);
      keywords = cand.keywords;

      const minHits = keywords.length >= 6 ? cfg.kwMinHits : cfg.kwMinHitsShort;

      sparseRes = (cand.points || [])
        .map((p) => {
          const hits = scoreByKeywordHits(p?.payload, keywords);
          return { ...p, _kwHits: hits };
        })
        .filter((p) => (p._kwHits ?? 0) >= minHits)
        .sort((a, b) => (b._kwHits ?? 0) - (a._kwHits ?? 0))
        .slice(0, cfg.sparseLimit);
    }

  // 建候选池：denseTop + sparseTop
  const pool = new Map(); // id -> item + meta
  denseRes.forEach((it, i) => {
    if (!it?.id) return;
    const id = String(it.id);
    pool.set(id, { item: it, denseRank: i + 1, sparseRank: 0, kwHits: 0 });
  });
  sparseRes.forEach((it, i) => {
    if (!it?.id) return;
    const id = String(it.id);
    const prev = pool.get(id);
    if (prev) {
      prev.sparseRank = i + 1;
      prev.kwHits = it?._kwHits ?? 0;
    } else {
      pool.set(id, { item: it, denseRank: 0, sparseRank: i + 1, kwHits: it?._kwHits ?? 0 });
    }
  });

  const maxKw = Math.max(1, keywords.length || cfg.maxKeywords);

  // 更精细的评分函数
  const scored = [...pool.values()].map(({ item, denseRank, sparseRank, kwHits }) => {
    const p = item?.payload ?? {};
    const tsMs = parseTimestampMs(p.timestamp);

    const denseS = rankScore(denseRank, 60);
    const kwS = Math.min(1, kwHits / maxKw);
    const recS = recencyScore(tsMs, cfg.recencyHalfLifeHours);
    const insS = insightBoost(p);
    const roleS = roleBoost(p);

    // 添加内容匹配度得分（基于文本相似度）
    const contentMatch = 1 - (
      Math.abs(cleanQuery.length - (p.text?.length || 0)) /
      (cleanQuery.length + (p.text?.length || 0) + 1)
    );

    // 综合评分，调整权重
    const final =
      cfg.wDense * denseS +
      cfg.wKw * kwS +
      cfg.wRecency * recS +
      cfg.wInsight * insS +
      cfg.wRole * roleS +
      0.1 * contentMatch;

    return { item, final, denseRank, sparseRank, kwHits, denseS, kwS, recS, insS, roleS };
  });

  scored.sort((a, b) => b.final - a.final);

  const top = scored.slice(0, Math.max(1, memoryLimit));

  const memory_detail_list = top
    .map(({ item }) => ({
      memory_value: item?.payload?.text ?? "",
      create_time: item?.payload?.timestamp ?? "",
      type: item?.payload?.mem_type ?? "fact",
      source_type: item?.payload?.source_type ?? "raw",
      role: item?.payload?.role ?? "",
      tags: item?.payload?.tags ?? []
    }))
    .filter((m) => (m.memory_value ?? "").trim().length > 0);

  const topPreview = scored.slice(0, 3).map((x) => ({
    score: x.final,
    text: (x.item?.payload?.text ?? "").toString().slice(0, 200),
    kwHits: x.kwHits
  }));

    return {
      data: { memory_detail_list, preference_detail_list: [] },
      _debug: {
        denseHits: denseRes.length,
        sparseHits: sparseRes.length,
        fusedHits: top.length,
        keywords,
        topPreview
      }
    };
  } catch (error) {
    console.error(`[memory-qdrant] 搜索记忆失败: ${error.message}`);
    return {
      data: { memory_detail_list: [], preference_detail_list: [] },
      _debug: {
        denseHits: 0,
        sparseHits: 0,
        fusedHits: 0,
        keywords: [],
        topPreview: []
      }
    };
  }
}

/** ---------------- write: addMessage / addInsight + dedup ---------------- */

function normalizeMessages(messages) {
  return (messages ?? [])
    .map((m) => {
      const role = m?.role;
      const content = (m?.content ?? "").toString().trim();
      if (!role || !content) return null;
      return { role, content };
    })
    .filter(Boolean);
}

async function existsHash(cfg, client, hash) {
  if (!cfg.dedupEnabled) return false;
  const baseFilter = buildFilterFromCfg(cfg);

  const must = [{ key: "hash", match: { value: hash } }];
  const filter = baseFilter ? { ...baseFilter, must: [...(baseFilter.must ?? []), ...must] } : { must };

  const out = await client.scroll(cfg.collection, {
    limit: cfg.dedupLookbackLimit,
    with_payload: false,
    with_vector: false,
    filter
  });

  const pts = Array.isArray(out?.points) ? out.points : [];
  return pts.length > 0;
}

/**
 * raw 写入：每条 message 一条 point
 * - 写 role（user/assistant）
 * - text 先 clean：去 user:/assistant:、去 [Fri ...]、去日志块
 * - dedup：hash(role + text) 已存在则跳过
 */
export async function addMessage(cfg, payload) {
  try {
    const client = makeQdrantClient(cfg);

    const msgs = normalizeMessages(payload?.messages);
    if (msgs.length === 0) {
      if (cfg.debug) console.log(`[memory-qdrant] 添加消息: 没有消息需要处理`);
      return { ok: false, reason: "no messages" };
    }

    const points = [];

    for (const m of msgs) {
      const cleaned = cleanTextForMemory(m.content, cfg.cleanMaxLen);
      if (!cleaned || cleaned.length < cfg.minCaptureChars) {
        if (cfg.debug) console.log(`[memory-qdrant] 添加消息: 消息过短 (${cleaned?.length}字符)`);
        continue;
      }

      const hash = sha1(`${m.role}\n${cleaned}`);
      if (await existsHash(cfg, client, hash)) {
        if (cfg.debug) console.log(`[memory-qdrant] 添加消息: 消息已存在 (去重)`);
        continue;
      }

      const vector = await embedText(cfg, cleaned);

      points.push({
        id: uuidv4(),
        vector,
        payload: {
          role: m.role,
          text: cleaned,
          timestamp: new Date().toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false
          }),
          source_type: "raw",
          mem_type: "fact",
          tags: await extractKeywords(cfg, cleaned),
          hash,
          processed: false          // 👈 新增字段，表示未总结
        }
      });
    }

    if (points.length === 0) {
      if (cfg.debug) console.log(`[memory-qdrant] 添加消息: 所有消息都被过滤或去重`);
      return { ok: false, reason: "消息过短或已重复" };
    }

    if (cfg.debug) console.log(`[memory-qdrant] 添加消息: 开始写入 ${points.length} 条记忆`);

    const upsertResult = await client.upsert(cfg.collection, { wait: true, points });

    // 收集所有写入记忆的关键词
    const allKeywords = new Set();
    for (const point of points) {
      if (point.payload.tags) {
        point.payload.tags.forEach(tag => allKeywords.add(tag));
      }
    }

    if (cfg.debug) {
      const keywordsStr = Array.from(allKeywords).join(", ");
      console.log(`[memory-qdrant] 用户输入写入成功，关键词为：${keywordsStr}`);
    }

    return { ok: true, id: points[0].id, count: points.length, keywords: Array.from(allKeywords) };
  } catch (error) {
    console.error(`[memory-qdrant] 添加消息失败: ${error.message}`);
    return { ok: false, reason: error.message };
  }
}

/**
 * insight 写入：你后续本地模型输出 mem_type（fact/preference/rule/skill/persona_trait/experience/error/assistant观点）
 */
export async function addInsight(cfg, payload) {
  try {
    const client = makeQdrantClient(cfg);

    const cleaned = cleanTextForMemory(payload?.text ?? "", Math.max(cfg.cleanMaxLen, 800));
    if (!cleaned || cleaned.length < cfg.minCaptureChars) return { ok: false, reason: "too short" };

  const memType = (payload?.mem_type ?? "assistant观点").toString().trim() || "assistant观点";
  const tags = Array.isArray(payload?.tags) && payload.tags.length
     ? payload.tags.filter(Boolean)
     : await extractKeywords(cfg, cleaned);

  const hash = sha1(`assistant\ninsight\n${memType}\n${cleaned}`);
  if (await existsHash(cfg, client, hash)) return { ok: false, reason: "deduped" };

  const vector = await embedText(cfg, cleaned);

  const point = {
    id: uuidv4(),
    vector,
    payload: {
      role: "assistant",
      text: cleaned,
      timestamp: new Date().toISOString(),
      source_type: "insight",
      mem_type: memType,
      tags,
      hash
    }
  };

    await client.upsert(cfg.collection, { wait: true, points: [point] });
    return { ok: true, id: point.id };
  } catch (error) {
    console.error(`[memory-qdrant] 添加洞察失败: ${error.message}`);
    return { ok: false, reason: error.message };
  }
}