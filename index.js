// OpenClaw 三层记忆插件 - 纯血极简版
// 直接调用：SQLite + Qdrant + PostgreSQL/AGE

import axios from 'axios';

let config = {};
let axiosInstance = null;
let openclawApi = null;

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

// ========== 对话捕获 ==========

async function captureMessage(event) {
  if (!config.addEnabled) return;
  if (!event?.success) return;
  if (!Array.isArray(event?.messages) || event.messages.length === 0) return;
  
  const now = Date.now();
  if (config.throttleMs && now - config.lastCaptureTime < config.throttleMs) return;
  config.lastCaptureTime = now;
  
  try {
    const messages = event.messages.filter(m => m.role === 'user');
    if (!messages.length) return;
    
    for (const msg of messages) {
      const text = msg.content?.trim();
      if (!text || text.length < 5) continue;
      
      await axiosInstance.post('/api/memories', {
        agent_id: openclawApi?.agentId || 'default',
        scope: 'session',
        content: text,
        tags: ['conversation'],
        source: 'explicit'
      });
      
      if (config.debug) console.log('[memory] ✅ 已存储:', text.substring(0, 50));
    }
  } catch (error) {
    if (config.debug) console.error('[memory] ❌ 存储失败:', error.message);
  }
}

// ========== 搜索记忆注入 ==========

async function searchAndInject(event) {
  if (!config.recallEnabled) return null;
  
  const prompt = event?.prompt;
  if (!prompt || prompt.trim().length < 3) return null;
  
  // 跳过新会话提示
  if (/\/new|\/reset|A new session was started/i.test(prompt)) return null;
  
  try {
    const response = await axiosInstance.post('/api/search', {
      agent_id: openclawApi?.agentId || 'default',
      query: prompt,
      limit: config.topK || 5
    });
    
    const memories = response.data?.results || [];
    if (memories.length === 0) return null;
    
    const memoryContext = memories.map((m, i) => `[记忆${i + 1}] ${m.content}`).join('\n');
    if (config.debug) console.log(`[memory] 🔍 找到 ${memories.length} 条相关记忆`);
    
    return { prependContext: `\n【相关记忆】\n${memoryContext}\n` };
  } catch (error) {
    if (config.debug) console.error('[memory] ❌ 搜索失败:', error.message);
    return null;
  }
}

// ========== OpenClaw 插件导出 ==========

export default {
  id: "openclaw_qdrant_age_server",
  name: "三层记忆插件",
  description: "OpenClaw 三层记忆架构插件 - SQLite + Qdrant + AGE",
  kind: "lifecycle",
  
  register(api) {
    openclawApi = api;
    config = api.pluginConfig || {};
    config.debug = true;  // 启用调试
    config.lastCaptureTime = 0;
    initAxios();
    
    console.log('[memory] 插件已注册 | SQLite+Qdrant+AGE | Full Tier');
    console.log('[memory] 调试模式已启用');
    
    // 注册事件监听
    api.on('agent_end', captureMessage);
    api.on('before_agent_start', searchAndInject);
  },
  
  activate() {
    console.log('[memory] 插件已激活');
  },
  
  cleanup() {
    console.log('[memory] 插件已清理');
  }
};
