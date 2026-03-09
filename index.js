// OpenClaw 三层记忆插件 - 纯血极简版
// 直接调用：SQLite + Qdrant + PostgreSQL/AGE

import axios from 'axios';

let config = {};
let axiosInstance = null;
let openclawApi = null;
let log = console;  // 全局 log 对象
let storedMessageHashes = new Set();  // 已存储的消息哈希（去重用）

// 简单的字符串哈希函数
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
}

// ========== 生命周期 ==========

function initAxios() {
  axiosInstance = axios.create({
    baseURL: config.memoryServerUrl || 'http://localhost:7777',
    timeout: 60000, // 60 秒超时 - 实体提取可能需要更长时间
    headers: {
      'Authorization': `Bearer ${config.authToken || 'clawx-memory-token'}`,
      'Content-Type': 'application/json'
    }
  });
}

// ========== 规则过滤 ==========

const IGNORE_PATTERNS = [
  /^(早 | 好 | 嗯 | 哦 | 啊 | 哈哈 | 呵呵 | 嘿嘿 | 嘻嘻)/i,
  /(在吗 | 干嘛 | 干嘛呢 | 干啥 | 咋了 | 咋样)/i,
  /^(谢谢 | 感谢 | 麻烦了 | 辛苦了)/i,
  /^(好的 | 好的好的 | 没问题 | 可以的)/i,
];

const SYSTEM_MESSAGE_PATTERNS = [
  /Conversation info \(untrusted metadata\)/i,
  /sender_id.*openclaw-control-ui/i,
  /\[message_id:.*\]/i,
  /Pre-compaction memory flush/i,
  /\[Queued messages while agent was busy\]/i,
  /A new session was started/i,
  /Execute your Session Startup/i,
  /Heartbeat/i,
  /^\s*```/m,
  /^\s*{-/m,
];

function shouldFilterMessage(text) {
  // 临时关闭所有过滤，测试用
  return false;
  
  if (!text || text.length < 8) return true;
  if (text.length > 500) return true;
  
  for (const pattern of SYSTEM_MESSAGE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  
  if (IGNORE_PATTERNS.some(pattern => pattern.test(text))) return true;
  
  return false;
}

// ========== 对话捕获 ==========

async function captureMessage(event, ctx) {
  console.warn('[memory-qdrant] >>> captureMessage 被调用');
  console.warn('[memory-qdrant] 全局变量状态检查:');
  console.warn('[memory-qdrant]   config:', config ? '已设置' : '未设置', 'memoryServerUrl:', config?.memoryServerUrl);
  console.warn('[memory-qdrant]   axiosInstance:', axiosInstance ? '已初始化' : '未初始化');
  console.warn('[memory-qdrant]   openclawApi:', openclawApi ? '已设置' : '未设置');
  console.warn('[memory-qdrant]   log:', log ? '已设置' : '未设置');

  console.warn('[memory-qdrant] event.success:', event?.success);
  console.warn('[memory-qdrant] event.messages 长度:', event?.messages?.length);
  console.warn('[memory-qdrant] event.messages[0]:', JSON.stringify(event?.messages?.[0]).substring(0, 300));
  console.warn('[memory-qdrant] config.addEnabled:', config?.addEnabled);
  console.warn('[memory-qdrant] axiosInstance:', axiosInstance ? 'initialized' : 'NOT initialized');
  console.warn('[memory-qdrant] 完整 event 对象:', JSON.stringify(event, null, 2).substring(0, 2000));

  if (!config.addEnabled) {
    log.warn('[memory-qdrant] addEnabled=false, 跳过');
    return;
  }
  if (!event?.success) {
    log.warn('[memory-qdrant] event.success=false, 跳过');
    return;
  }
  if (!Array.isArray(event?.messages) || event.messages.length === 0) {
    log.warn('[memory-qdrant] 没有消息，跳过');
    return;
  }

  const now = Date.now();
  if (config.throttleMs && now - config.lastCaptureTime < config.throttleMs) return;
  config.lastCaptureTime = now;

  try {
    // 只存储最后一轮对话（从最后一个用户消息开始）- MemOS 方案
    const lastUserIndex = event.messages
      .map((m, idx) => ({ m, idx }))
      .filter(({ m }) => m?.role === 'user')
      .map(({ idx }) => idx)
      .pop();

    const messagesToStore = lastUserIndex !== undefined
      ? event.messages.slice(lastUserIndex)
      : event.messages;

    const filteredMessages = messagesToStore.filter(m => m.role === 'user' || m.role === 'assistant');
    if (!filteredMessages.length) {
      log.warn('[memory-qdrant] 没有用户或助手消息，跳过');
      // 调试：输出所有消息的 role
      log.warn('[memory-qdrant] 所有消息的 role:', event.messages.map(m => m.role || 'undefined').join(', '));
      log.warn('[memory-qdrant] 完整消息数组:', JSON.stringify(event.messages, null, 2).substring(0, 2000));
      return;
    }

    console.warn(`[memory-qdrant] 存储最后一轮对话，共 ${filteredMessages.length} 条消息`);

    for (const msg of filteredMessages) {
      // 完整消息结构日志
      console.warn('[memory-qdrant] 当前消息完整结构:', JSON.stringify(msg, null, 2).substring(0, 500));

      // 去重检查：基于文本哈希
      let textForHash = '';
      if (typeof msg.content === 'string') textForHash = msg.content;
      else if (msg.content?.text) textForHash = msg.content.text;
      else if (Array.isArray(msg.content)) textForHash = msg.content.map(c => c.text || '').join(' ');

      const textHash = hashString(textForHash);
      if (storedMessageHashes.has(textHash)) {
        console.warn('[memory-qdrant] ⏭️ 消息已存储（哈希去重），跳过');
        continue;
      }

      // 提取文本内容（支持多种格式）
      let text = '';
      console.warn('[memory-qdrant] msg.role:', msg.role);
      console.warn('[memory-qdrant] msg.content 类型:', typeof msg.content, Array.isArray(msg.content) ? '(array)' : '');
      
      if (typeof msg.content === 'string') {
        text = msg.content.trim();
      } else if (msg.content?.text) {
        text = msg.content.text.trim();
      } else if (Array.isArray(msg.content)) {
        text = msg.content.map(c => c.text || '').join(' ').trim();
      }
      
      log.warn('[memory-qdrant] 提取的 text 长度:', text.length);

      if (!text || text.length < 3) {
        log.warn('[memory-qdrant] ⏭️ 跳过：文本太短或为空');
        continue;
      }

      log.warn('[memory-qdrant] 准备检查文本:', text.substring(0, 100));

      // 规则过滤
      if (shouldFilterMessage(text)) {
        log.warn('[memory-qdrant] ⏭️ 过滤:', text.substring(0, 30));
        continue;
      }

      // ========== 强力清理注入内容（防止循环） ==========
      let cleanText = text;

      // 1. 移除整个【相关记忆】部分（从"【相关记忆】"到下一个"---"或"本轮用户输入"）
      const memoryStartIndex = cleanText.indexOf('【相关记忆】');
      if (memoryStartIndex !== -1) {
        const memoryEndIndex = cleanText.indexOf('本轮用户输入', memoryStartIndex);
        if (memoryEndIndex !== -1) {
          // 只保留"本轮用户输入"之后的内容
          cleanText = cleanText.substring(memoryEndIndex + '本轮用户输入'.length);
        } else {
          // 没有"本轮用户输入"，说明整条都是注入内容，跳过
          log.warn('[memory-qdrant] ⏭️ 跳过：整条消息都是注入内容');
          continue;
        }
      }

      // 2. 移除"---"分隔线以上的所有内容（保留最后一轮）
      const separatorIndex = cleanText.lastIndexOf('---');
      if (separatorIndex !== -1 && separatorIndex > cleanText.length * 0.5) {
        // 如果分隔线在后半部分，保留分隔线后的内容
        const afterSeparator = cleanText.substring(separatorIndex + 3).trim();
        if (afterSeparator.length > 10) {
          cleanText = afterSeparator;
        }
      }

      // 3. 移除所有注入格式标记
      cleanText = cleanText
        .replace(/^\*\*.*?\*\*\s*/g, '')  // 移除 **加粗**
        .replace(/^\[Sun.*?GMT.*?\]\s*/gi, '')  // 移除 [Sun ... GMT]
        .replace(/^\[Mon.*?GMT.*?\]\s*/gi, '')  // 移除 [Mon ... GMT]
        .replace(/^\[\d{4}-\d{2}-\d{2}.*?\]\s*/gi, '')  // 移除 [2026-...]
        .replace(/^>\s*/gm, '')  // 移除所有行首的 > 引用标记
        .replace(/^本轮用户输入 [:：]?\s*\n?/i, '')  // 移除"本轮用户输入:"
        .replace(/^\[2026-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/gi, '')  // 移除 [2026-03-09 01:08]
        .replace(/^\[Mon.*?\]\s*/gi, '')  // 移除 [Mon ...]
        .replace(/^\[Sun.*?\]\s*/gi, '')  // 移除 [Sun ...]
        .replace(/^Sender\s*\(untrusted.*?\)\s*:?\s*\n?/gi, '')  // 移除 "Sender (untrusted metadata):"
        .replace(/```json\s*\{[^}]*\}\s*```/gi, '')  // 移除 ```json {...}```
        .replace(/^\s*\n+/, '')  // 移除开头空行
        .replace(/\n+\s*$/, '')  // 移除结尾空行
        .replace(/^[:：\s]*/, '')  // 移除开头冒号和空格
        .trim();

      // 4. 二次检查：如果清理后仍然包含注入标记，跳过
      if (cleanText.includes('【相关记忆】') ||
          cleanText.includes('---') ||
          cleanText.includes('[记忆') ||
          cleanText.length < 3) {
        log.warn('[memory-qdrant] ⏭️ 跳过：仍包含注入内容或太短');
        log.warn('[memory-qdrant] 清理后的文本:', cleanText.substring(0, 100));
        continue;
      }

      // 5. 压缩多余空行（保留单个换行，移除连续空行）
      cleanText = cleanText.replace(/\n{3,}/g, '\n\n');

      log.warn('[memory-qdrant] ✅ 清理后的文本:', cleanText.substring(0, 100));
      
      // 格式化时间
      const now = new Date();
      const timestamp = `[${now.getFullYear()}/${now.getMonth()+1}/${now.getDate()} ${now.getHours()}:${now.getMinutes().toString().padStart(2,'0')}]`;
      
      // 确定角色
      const role = msg.role === 'assistant' ? '助手' : '用户';
      
      log.warn(`[memory-qdrant] 准备存储 (${role}):`, cleanText.substring(0, 50));

      try {
        const payload = {
          agent_id: openclawApi?.agentId || 'main',
          scope: 'user',
          content: cleanText,
          tags: ['conversation', msg.role === 'assistant' ? 'assistant_reply' : 'user_message'],
          source: 'explicit',
          extract_entities: true, // 启用实体提取（AGE 知识图谱）
          info: {
            role: role,
            timestamp: timestamp,
            sessionKey: ctx?.sessionKey || '',
            channel: 'webchat'
          }
        };

        console.warn('[memory-qdrant] 发送存储请求:', JSON.stringify(payload));
        console.warn('[memory-qdrant] axiosInstance 状态:', axiosInstance ? '已初始化' : '未初始化!');
        console.warn('[memory-qdrant] openclawApi?.agentId:', openclawApi?.agentId || 'undefined');
        console.warn('[memory-qdrant] config.memoryServerUrl:', config?.memoryServerUrl);

        if (!axiosInstance) {
          console.error('[memory-qdrant] ❌ axiosInstance 未初始化！');
          continue;
        }

        const response = await axiosInstance.post('/api/memories', payload);

        console.warn('[memory-qdrant] 存储响应状态:', response.status);
        console.warn('[memory-qdrant] 存储响应:', JSON.stringify(response.data));
        console.warn(`[memory-qdrant] ✅ 已存储 (${role}):`, cleanText.substring(0, 80));
      } catch (error) {
        console.error('[memory-qdrant] ❌ 存储失败 - 完整错误:', JSON.stringify({
          message: error.message,
          code: error.code,
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          config: {
            url: error.config?.url,
            method: error.config?.method,
            baseURL: error.config?.baseURL
          }
        }, null, 2));
      }
    }
  } catch (error) {
    if (config.debug) log.error('[memory] ❌ 存储失败:', error.message);
  }
}

// ========== 搜索记忆注入 ==========

async function searchAndInject(event, ctx) {
  console.log('[memory-qdrant] >>> searchAndInject 被调用');
  console.log('[memory-qdrant] event.prompt:', event?.prompt?.substring(0, 50));

  if (!config.recallEnabled) {
    console.log('[memory-qdrant] recallEnabled=false, 跳过');
    return null;
  }

  const prompt = event?.prompt;
  if (!prompt || prompt.trim().length < 3) {
    console.log('[memory-qdrant] prompt 太短，跳过');
    return null;
  }

  // 跳过新会话提示
  if (/\/new|\/reset|A new session was started/i.test(prompt)) {
    console.log('[memory-qdrant] 新会话提示，跳过');
    return null;
  }

  // 跳过系统级提示词（生成 slug、总结等）
  const systemPromptPatterns = [
    /generate.*slug/i,
    /filename slug/i,
    /1-2 word/i,
    /lowercase.*hyphen.*separated/i,
    /Reply with ONLY/i,
    /Based on this conversation/i,
    /Conversation summary:/i,
    /summarize.*conversation/i,
    /generate.*title/i,
  ];

  for (const pattern of systemPromptPatterns) {
    if (pattern.test(prompt)) {
      console.log('[memory-qdrant] 系统提示词，跳过搜索');
      return null;
    }
  }
  
  try {
    console.log('[memory-qdrant] 准备搜索:', prompt.substring(0, 30));
    
    const searchPayload = {
      agent_id: openclawApi?.agentId || 'main',
      query: prompt,
      limit: config.topK || 5
    };
    
    console.log('[memory-qdrant] 搜索 payload:', JSON.stringify(searchPayload));
    
    const response = await axiosInstance.post('/api/search', searchPayload);
    
    console.log('[memory-qdrant] 搜索响应:', JSON.stringify(response.data).substring(0, 200));
    
    const memories = response.data?.memories || response.data?.results || [];
    console.log('[memory-qdrant] 找到记忆数量:', memories.length);
    
    if (memories.length === 0) {
      console.log('[memory-qdrant] 没有找到相关记忆');
      return null;
    }
    
    // 修复：结果结构是 { memory: { content: ..., info: {...} } }
    const memoryContext = memories.map((m, i) => {
      const memory = m.memory || m;
      const content = memory.content || '无内容';
      const info = memory.info || {};
      
      // 格式化标题栏：[角色] [时间]
      const roleTag = info.role ? `[${info.role}]` : '';
      const timeTag = info.timestamp ? `${info.timestamp}` : '';
      const title = [roleTag, timeTag].filter(Boolean).join(' ');
      
      // 格式：[记忆 1] [用户] [2026/3/8 2:40]
      //       缩进的文本内容...
      return {
        index: i + 1,
        title: title,
        content: content,
        hash: content.substring(0, 50)  // 用于去重
      };
    });
    
    // 去重：相同 content 只保留第一次出现
    const seen = new Set();
    const uniqueMemories = memoryContext.filter(m => {
      if (seen.has(m.hash)) return false;
      seen.add(m.hash);
      return true;
    });
    
    // 重新编号
    const memoryContextText = uniqueMemories.map((m, i) => {
      // 用 MD 引用块包裹记忆内容，防止 MD 格式污染
      const escapedContent = m.content
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
      return `[记忆${i + 1}]${m.title ? ' ' + m.title : ''}\n${escapedContent}`;
    }).join('\n\n---\n\n');
    
    if (config.debug) log.warn(`[memory] 🔍 找到 ${memories.length} 条，去重后 ${uniqueMemories.length} 条`);
    
    // 格式化时间戳（去掉星期，只显示日期时间）
    const now = new Date();
    const timestamp = `[${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-${now.getDate().toString().padStart(2,'0')} ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}]`;
    
    // 添加固定提示词 - 用分隔线明确区分
    const fixedPrompt = `\n\n---\n\n本轮用户输入:\n${timestamp}\n`;
    
    const result = { prependContext: `\n\n**【相关记忆】**\n\n${memoryContextText}\n\n---\n${fixedPrompt}` };
    log.warn('[memory-qdrant] 返回注入内容:', result.prependContext.substring(0, 300));
    
    return result;
  } catch (error) {
    console.error('[memory-qdrant] ❌ 搜索失败:', error.response?.data || error.message);
    return null;
  }
}

// ========== OpenClaw 插件导出 ==========

export default {
  id: "memory-qdrant",
  name: "memory-qdrant",
  description: "OpenClaw 三层记忆架构插件 - SQLite + Qdrant + AGE",
  kind: "lifecycle",

  register(api) {
    console.warn('[memory-qdrant] >>> register 被调用');
    console.warn('[memory-qdrant] api 对象 keys:', Object.keys(api || {}).join(', '));
    console.warn('[memory-qdrant] api.pluginConfig:', JSON.stringify(api?.pluginConfig));

    openclawApi = api;
    config = api.pluginConfig || {};
    config.debug = true;
    config.lastCaptureTime = 0;
    config.recallEnabled = true;
    config.addEnabled = true;
    config.throttleMs = 0; // 不限制频率
    config.topK = 4; // 最多注入 4 条记忆
    config.memoryServerUrl = config.memoryServerUrl || 'http://localhost:7777';
    config.authToken = config.authToken || 'clawx-memory-token';

    console.warn('[memory-qdrant] 设置 config.memoryServerUrl:', config.memoryServerUrl);
    console.warn('[memory-qdrant] 设置 config.authToken:', config.authToken);

    log = api.logger ?? console;  // ← 赋值给全局 log
    initAxios();

    console.warn('[memory-qdrant] initAxios 完成，axiosInstance:', axiosInstance ? '已初始化' : '未初始化!');
    console.warn('[memory-qdrant] axiosInstance baseURL:', axiosInstance?.defaults?.baseURL);

    log.warn('[memory-qdrant] 插件已注册 | SQLite+Qdrant+AGE | Full Tier');
    log.warn('[memory-qdrant] 调试模式已启用');
    log.warn('[memory-qdrant] API 对象:', Object.keys(api || {}).join(', '));
    log.warn('[memory-qdrant] pluginConfig:', JSON.stringify(config));

    // 注册钩子
    api.on("before_agent_start", async (event, ctx) => {
      log.warn('[memory-qdrant] >>> before_agent_start 触发');
      log.warn('[memory-qdrant] event.prompt:', event?.prompt?.substring(0, 50));
      return await searchAndInject(event, ctx);
    });

    api.on("agent_end", async (event, ctx) => {
      log.warn('[memory-qdrant] >>> agent_end 触发');
      log.warn('[memory-qdrant] event:', JSON.stringify({ success: event?.success, messages: event?.messages?.length }));
      return await captureMessage(event, ctx);
    });

    console.warn('[memory-qdrant] >>> 钩子注册完成');
  },
  
  activate() {
    console.log('[memory-qdrant] 插件已激活');
  },
  
  cleanup() {
    console.log('[memory-qdrant] 插件已清理');
  }
};

