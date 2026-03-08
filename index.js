// OpenClaw 三层记忆插件 - 纯血极简版
// 直接调用：SQLite + Qdrant + PostgreSQL/AGE

import axios from 'axios';

let config = {};
let axiosInstance = null;
let openclawApi = null;
let log = console;  // 全局 log 对象

// ========== 生命周期 ==========

function initAxios() {
  axiosInstance = axios.create({
    baseURL: config.memoryServerUrl || 'http://localhost:7777',
    timeout: 10000,
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
  log.warn('[memory-qdrant] >>> captureMessage 被调用');
  log.warn('[memory-qdrant] event:', JSON.stringify({ success: event?.success, messages: event?.messages?.length }));
  
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
    // 存储所有消息（用户 + 助手）
    const messages = event.messages.filter(m => m.role === 'user' || m.role === 'assistant');
    if (!messages.length) {
      log.warn('[memory-qdrant] 没有用户或助手消息，跳过');
      return;
    }
    
    for (const msg of messages) {
      // 提取文本内容（支持多种格式）
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content.trim();
      } else if (msg.content?.text) {
        text = msg.content.text.trim();
      } else if (Array.isArray(msg.content)) {
        text = msg.content.map(c => c.text || '').join(' ').trim();
      }
      
      if (!text) {
        log.warn('[memory-qdrant] 没有有效文本，跳过');
        continue;
      }
      
      log.warn('[memory-qdrant] 准备检查文本:', text.substring(0, 50));
      
      // 规则过滤
      if (shouldFilterMessage(text)) {
        log.warn('[memory-qdrant] ⏭️ 过滤:', text.substring(0, 30));
        continue;
      }
      
      // 过滤掉注入的记忆内容（防止无限套娃）
      if (text.includes('【相关记忆】') || text.includes('[记忆') || text.includes('本轮用户输入：')) {
        log.warn('[memory-qdrant] ⏭️ 过滤注入的记忆内容');
        continue;
      }
      
      // 清理文本：只移除 metadata 垃圾，保留时间戳
      const cleanText = text
        .replace(/Sender \(untrusted metadata\):[\s\S]*?```json[\s\S]*?```\s*/gi, '')
        .replace(/^\[Sun.*?GMT.*?\]\s*/gi, '')
        .trim();
      
      if (!cleanText || cleanText.length < 3) {
        log.warn('[memory-qdrant] 清理后文本太短，跳过');
        continue;
      }
      
      // 格式化时间
      const now = new Date();
      const timestamp = `[${now.getFullYear()}/${now.getMonth()+1}/${now.getDate()} ${now.getHours()}:${now.getMinutes().toString().padStart(2,'0')}]`;
      
      // 确定角色
      const role = msg.role === 'assistant' ? '助手' : '用户';
      
      log.warn(`[memory-qdrant] 准备存储 (${role}):`, cleanText.substring(0, 50));
      
      try {
        const response = await axiosInstance.post('/api/memories', {
          agent_id: openclawApi?.agentId || 'default',
          scope: 'user',
          content: cleanText,
          tags: ['conversation', msg.role === 'assistant' ? 'assistant_reply' : 'user_message'],
          source: 'explicit',
          info: {
            role: role,
            timestamp: timestamp,
            sessionKey: ctx?.sessionKey || '',
            channel: 'webchat'
          }
        });
        
        log.warn('[memory-qdrant] 存储响应:', JSON.stringify(response.data).substring(0, 100));
        if (config.debug) log.warn(`[memory] ✅ 已存储 (${role}):`, cleanText.substring(0, 50));
      } catch (error) {
        log.error('[memory-qdrant] ❌ 存储失败:', error.response?.data || error.message);
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
  
  try {
    console.log('[memory-qdrant] 准备搜索:', prompt.substring(0, 30));
    
    const searchPayload = {
      agent_id: openclawApi?.agentId || 'default',
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
    
    // 添加固定提示词 - 用分隔线明确区分
    const fixedPrompt = '\n\n---\n\n**本轮用户输入**:\n';
    
    const result = { prependContext: `\n**【相关记忆】**:\n\n${memoryContextText}${fixedPrompt}` };
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
    openclawApi = api;
    config = api.pluginConfig || {};
    config.debug = true;
    config.lastCaptureTime = 0;
    config.recallEnabled = true;
    config.addEnabled = true;
    config.throttleMs = 0; // 不限制频率
    log = api.logger ?? console;  // ← 赋值给全局 log
    initAxios();
    
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
  },
  
  activate() {
    console.log('[memory-qdrant] 插件已激活');
  },
  
  cleanup() {
    console.log('[memory-qdrant] 插件已清理');
  }
};
