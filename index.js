import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

export default {
  id: 'memory-qdrant',
  name: 'Memory Qdrant Plugin',
  description: 'Qdrant向量数据库记忆插件，自动检索并注入上下文，支持对话删除记忆',
  kind: 'lifecycle',

  register(api) {
    const config = api.pluginConfig;
    console.log('✅ [memory-qdrant] Plugin registered, config:', config);

    // ---------- 默认规则（当配置缺失时使用）----------
    const defaultFilterRules = {
      minLength: 10,
      userBlacklist: ['截屏', '截图', '重启', '打开浏览器', '/new', '/reset', '你好', '测试', '继续', '你挂了？'],
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
        '干啥'
      ],
      deleteKeywords: ['删除最后一条记忆', '删除刚才那句', '删除刚才的问题', '删除上一条', '删除关于'],
      summaryKeywords: ['总结记忆', '总结一下', '帮我总结']
    };

    // 从 config 中提取配置，缺失的用默认值填充
    const {
      qdrantUrl = 'http://localhost:6333',
      collection = 'agent_memory',
      ollamaUrl = 'http://localhost:11434',
      embeddingModel = 'bge-m3:latest',
      topK = 3,
      dedupeThreshold = 0.85,
      userId = 'claw',
      fallbackToRaw = true,
      summaryModel = 'qwen2.5:14b-instruct',
      summaryMaxRaw = 100
    } = config;

    // 合并 filterRules（确保每个子属性都有值）
    const configFilterRules = config.filterRules || {};
    const filterRules = {
      minLength: configFilterRules.minLength ?? defaultFilterRules.minLength,
      userBlacklist: configFilterRules.userBlacklist ?? defaultFilterRules.userBlacklist,
      assistantBlacklistPatterns: configFilterRules.assistantBlacklistPatterns ?? defaultFilterRules.assistantBlacklistPatterns,
      deleteKeywords: configFilterRules.deleteKeywords ?? defaultFilterRules.deleteKeywords,
      summaryKeywords: configFilterRules.summaryKeywords ?? defaultFilterRules.summaryKeywords,
    };

    console.log('📋 [memory-qdrant] filterRules in use:', filterRules);

    const processedRuns = new Set();        // 去重 before_agent_start 事件
    const processedUserMsgIds = new Set();  // 用户消息去重（防止重复存储）

    // ---------- 过滤函数（增强调试）----------
    function shouldStore(text, role) {
      if (!text || text.length < filterRules.minLength) {
        console.log(`过滤：消息过短 (${text?.length})`);
        return false;
      }

      // 用户消息黑名单关键词
      if (role === 'user') {
        for (const keyword of filterRules.userBlacklist) {
          if (text.includes(keyword)) {
            console.log(`过滤：用户消息包含黑名单词 "${keyword}"`);
            return false;
          }
        }
        // 检查是否是删除指令（不存储）
        for (const keyword of filterRules.deleteKeywords) {
          if (text.includes(keyword)) {
            console.log(`过滤：用户消息是删除指令，不存储`);
            return false;
          }
        }
        // 检查是否是总结指令（不存储）
        for (const keyword of filterRules.summaryKeywords) {
          if (text.includes(keyword)) {
            console.log(`过滤：用户消息是总结指令，不存储`);
            return false;
          }
        }
      }

      // AI回复黑名单模式（增强调试）
      if (role === 'assistant') {
        for (const pattern of filterRules.assistantBlacklistPatterns) {
          const regex = new RegExp(pattern, 'i');
          const match = regex.test(text);
          console.log(`检查模式 "${pattern}" 是否匹配: ${match}`);
          if (match) {
            console.log(`过滤：AI回复匹配黑名单模式 "${pattern}"`);
            return false;
          }
        }
      }

      return true;
    }

    // ---------- 工具函数（不变）----------
    function extractText(content) {
      if (!content) return '';
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .filter(block => block && typeof block === 'object' && block.type === 'text')
          .map(block => block.text)
          .join(' ');
      }
      return '';
    }

    async function embed(text) {
      try {
        const res = await axios.post(`${ollamaUrl}/api/embeddings`, {
          model: embeddingModel,
          prompt: text
        });
        return res.data.embedding;
      } catch (err) {
        console.error('🔴 [Embed Error]:', err.response?.data || err.message);
        throw err;
      }
    }

    async function ensureCollection(vectorSize) {
      try {
        await axios.get(`${qdrantUrl}/collections/${collection}`);
      } catch {
        console.log(`🟡 [Qdrant]: 集合 ${collection} 不存在，正在创建...`);
        await axios.put(`${qdrantUrl}/collections/${collection}`, {
          vectors: { size: vectorSize, distance: 'Cosine' }
        });
        console.log(`✅ [Qdrant]: 集合 ${collection} 创建成功 (维度: ${vectorSize})`);
      }
    }

    async function searchSimilar(vector, filter = null) {
      try {
        const payload = {
          vector,
          limit: topK,
          with_payload: true
        };
        if (filter) payload.filter = filter;
        const res = await axios.post(`${qdrantUrl}/collections/${collection}/points/search`, payload);
        return res.data?.result || [];
      } catch (err) {
        console.error('🔴 [Qdrant Search Error]:', err.response?.data || err.message);
        return [];
      }
    }

    // 更新点 payload（用于标记 processed）
    async function updatePointPayload(pointId, newPayload) {
      try {
        await axios.post(`${qdrantUrl}/collections/${collection}/points`, {
          points: [{ id: pointId, payload: newPayload }]
        });
        console.log(`✅ 已更新点 ${pointId} 的 payload`);
      } catch (err) {
        console.error(`🔴 更新点 ${pointId} 失败:`, err.response?.data || err.message);
      }
    }

    // 插入记忆（通用，支持 role, type, processed, sourceIds）
    async function insertMemory(text, userId, conversationId, role, type = 'raw', processed = false, sourceIds = []) {
      if (typeof text !== 'string') text = String(text);
      console.log(`[insertMemory] 开始插入: type=${type}, role=${role}, text="${text.substring(0,30)}..."`);
      if (!shouldStore(text, role)) {
        console.log('过滤：消息不符合存储规则');
        return;
      }
      if (!text || text.length < 5) {
        console.log('跳过插入：文本太短');
        return;
      }
      try {
        const vector = await embed(text);
        await ensureCollection(vector.length);
        const pointId = crypto.randomUUID ? crypto.randomUUID() : uuidv4();
        const payload = {
          text,
          timestamp: Date.now(),
          userId,
          conversationId,
          role,
          type,
        };
        if (type === 'raw') {
          payload.processed = processed;
        } else if (type === 'insight') {
          payload.source_ids = sourceIds;
        }
        const response = await axios.put(`${qdrantUrl}/collections/${collection}/points?wait=true`, {
          points: [{
            id: pointId,
            vector,
            payload
          }]
        });
        console.log(`✅ [Memory] ${type} 记忆已存入 Qdrant, 响应:`, response.data);
      } catch (err) {
        console.error('🔴 [Memory Insert Error]:', err.response?.data || err.message);
      }
    }

    // 删除最新一条记忆（不分类型）
    async function deleteLatestMemory(userId, conversationId) {
      try {
        const filter = {
          must: [
            { key: 'userId', match: { value: userId } },
            { key: 'conversationId', match: { value: conversationId } }
          ]
        };
        const scrollRes = await axios.post(`${qdrantUrl}/collections/${collection}/points/scroll`, {
          limit: 1,
          filter: filter,
          with_payload: false,
          order_by: { key: 'timestamp', direction: 'desc' }
        });
        const points = scrollRes.data?.result?.points || [];
        if (points.length === 0) {
          console.log('ℹ️ [Delete] 没有找到可删除的记忆');
          return false;
        }
        const pointId = points[0].id;
        await axios.post(`${qdrantUrl}/collections/${collection}/points/delete`, {
          points: [pointId]
        });
        console.log(`✅ [Delete] 已删除记忆 ID: ${pointId}`);
        return true;
      } catch (err) {
        console.error('🔴 [Delete Error]:', err.response?.data || err.message);
        return false;
      }
    }

    // 按查询文本删除相关记忆
    async function deleteMemoriesByQuery(userId, queryText) {
      try {
        const vector = await embed(queryText);
        const searchRes = await axios.post(`${qdrantUrl}/collections/${collection}/points/search`, {
          vector,
          limit: 50,
          with_payload: false,
          filter: {
            must: [{ key: 'userId', match: { value: userId } }]
          }
        });
        const points = searchRes.data?.result || [];
        if (points.length === 0) {
          console.log(`ℹ️ [DeleteByQuery] 没有找到与“${queryText}”相关的记忆`);
          return 0;
        }
        const pointIds = points.map(p => p.id);
        await axios.post(`${qdrantUrl}/collections/${collection}/points/delete`, {
          points: pointIds
        });
        console.log(`✅ [DeleteByQuery] 已删除 ${pointIds.length} 条与“${queryText}”相关的记忆`);
        return pointIds.length;
      } catch (err) {
        console.error('🔴 [DeleteByQuery Error]:', err.response?.data || err.message);
        return 0;
      }
    }

    // 手动总结函数（异步）
    async function runManualSummary(userId, conversationId) {
      console.log('开始手动总结...');
      try {
        // 获取当前用户所有未总结的 raw 记忆（限制数量）
        const filter = {
          must: [
            { key: 'userId', match: { value: userId } },
            { key: 'type', match: { value: 'raw' } },
            { key: 'processed', match: { value: false } }
          ]
        };
        const scrollRes = await axios.post(`${qdrantUrl}/collections/${collection}/points/scroll`, {
          limit: summaryMaxRaw,
          filter: filter,
          with_payload: true,
          with_vector: false
        });
        const rawPoints = scrollRes.data?.result?.points || [];
        if (rawPoints.length === 0) {
          console.log('没有可总结的原始记忆');
          return;
        }

        // 提取文本，构建prompt
        const texts = rawPoints.map(p => p.payload.text).join('\n');
        const prompt = `请根据以下用户的多条对话记录，总结出用户的长期偏好、习惯或重要信息。以JSON格式输出，包含 topic（主题）、stable_preferences（稳定偏好列表）、temporary_states（临时状态列表）、confidence（置信度0-1）。对话记录：\n${texts}`;

        // 调用Ollama总结
        const summaryRes = await axios.post(`${ollamaUrl}/api/chat`, {
          model: summaryModel,
          messages: [{ role: 'user', content: prompt }],
          stream: false
        });
        const summaryText = summaryRes.data.message.content;

        // 解析JSON（简单处理，直接存）
        let insightText = summaryText;
        try {
          const parsed = JSON.parse(summaryText);
          insightText = JSON.stringify(parsed, null, 2); // 美化
        } catch (e) {
          console.log('总结不是有效JSON，直接存储文本');
        }

        // 存入 insight
        const sourceIds = rawPoints.map(p => p.id);
        await insertMemory(insightText, config.sharedUserId || 'shared', conversationId, 'assistant', 'insight', false, sourceIds);

        // 标记这些raw为已处理
        for (const point of rawPoints) {
          const newPayload = { ...point.payload, processed: true };
          await updatePointPayload(point.id, newPayload);
        }
        console.log('手动总结完成，insight已存储');
      } catch (err) {
        console.error('手动总结失败:', err.message);
      }
    }

    // ==================== 生命周期钩子 ====================

    api.on('before_agent_start', async (event, ctx) => {
      const runId = event.runId || event.message?.id;
      if (runId) {
        if (processedRuns.has(runId)) {
          console.log('⏭️ 跳过重复的 before_agent_start');
          return;
        }
        processedRuns.add(runId);
        setTimeout(() => processedRuns.delete(runId), 60000);
      }

      const userMsg = event.prompt || '';
      if (!userMsg) return;

      const currentUserId = userId;
      const conversationId = ctx?.sessionKey || 'global';

      // ----- 删除意图识别 -----
      const deleteKeyword = filterRules.deleteKeywords.find(k => userMsg.includes(k));
      if (deleteKeyword) {
        console.log(`🗑️ 检测到删除意图（关键词：${deleteKeyword}），执行删除操作...`);
        if (deleteKeyword === '删除关于') {
          const query = userMsg.split('删除关于')[1]?.trim();
          if (!query) {
            return { prependContext: '【系统】请告诉我要删除关于什么内容的记忆。' };
          }
          const deletedCount = await deleteMemoriesByQuery(currentUserId, query);
          return { prependContext: deletedCount > 0 ? `【系统】已删除 ${deletedCount} 条相关记忆。` : '【系统】没有找到相关记忆。' };
        } else {
          const deleted = await deleteLatestMemory(currentUserId, conversationId);
          return { prependContext: deleted ? '【系统】已删除最近一条记忆。' : '【系统】没有找到可删除的记忆。' };
        }
      }

      // ----- 总结意图识别 -----
      const summaryKeyword = filterRules.summaryKeywords.find(k => userMsg.includes(k));
      if (summaryKeyword) {
        console.log(`📝 检测到总结意图，开始异步总结...`);
        // 异步执行总结，不阻塞
        runManualSummary(currentUserId, conversationId).catch(err => console.error('异步总结出错:', err));
        // 返回系统提示，不存储用户消息（因为过滤规则已排除）
        return { prependContext: '【系统】正在为你总结记忆，稍后请查看总结结果。' };
      }

      // ----- 存储用户消息（去重）-----
      const msgId = event.message?.id;
      if (msgId && !processedUserMsgIds.has(msgId)) {
        processedUserMsgIds.add(msgId);
        insertMemory(userMsg, currentUserId, conversationId, 'user', 'raw', false).catch(err => {
          console.error('用户消息存储失败:', err.message);
        });
      } else if (!msgId) {
        insertMemory(userMsg, currentUserId, conversationId, 'user', 'raw', false).catch(err => {
          console.error('用户消息存储失败:', err.message);
        });
      }

      // ----- 检索相关记忆（优先 insight，然后 assistant raw，最后 user raw）-----
      try {
        const vector = await embed(userMsg);
        
        // 共享用户 ID（从 config 读取，默认 'shared'）
        const sharedUserId = config.sharedUserId || 'shared';

        // 1. 先搜 insight
        const insightFilter = {
          must: [
            { key: 'type', match: { value: 'insight' } }
          ],
          should: [
            { key: 'userId', match: { value: currentUserId } },
            { key: 'userId', match: { value: sharedUserId } }
          ],
          min_should: {
              min_count: 1
          }
        };
        let matches = await searchSimilar(vector, insightFilter);
        let usedType = 'insight';

        // 2. 如果没找到 insight，降级搜索 assistant raw
        if (matches.length === 0 && fallbackToRaw) {
          console.log('未找到 insight，尝试搜索 assistant raw...');
          const assistantRawFilter = {
            must: [
              { key: 'userId', match: { value: currentUserId } },
              { key: 'type', match: { value: 'raw' } },
              { key: 'role', match: { value: 'assistant' } }
            ]
          };
          matches = await searchSimilar(vector, assistantRawFilter);
          usedType = 'raw_assistant';
        }

        // 3. 如果还没找到，降级搜索 user raw
        if (matches.length === 0 && fallbackToRaw) {
          console.log('未找到 assistant raw，尝试搜索 user raw...');
          const userRawFilter = {
            must: [
              { key: 'userId', match: { value: currentUserId } },
              { key: 'type', match: { value: 'raw' } },
              { key: 'role', match: { value: 'user' } }
            ]
          };
          matches = await searchSimilar(vector, userRawFilter);
          usedType = 'raw_user';
        }

        // 相似度阈值过滤
        const THRESHOLD = 0.7;
        const relevantMatches = matches.filter(m => {
          const score = m.score || 0;
          console.log(`📊 ${usedType} 候选分数: ${score.toFixed(3)}, 内容: "${m.payload?.text?.substring(0, 50)}..."`);
          return score >= THRESHOLD;
        });

        if (relevantMatches.length > 0) {
          const topMatches = relevantMatches.slice(0, topK);
          const memoryList = topMatches.map(m => `- ${m.payload.text}`).join('\n');
          console.log(`🔍 最终采用 ${topMatches.length} 条 ${usedType} 记忆（阈值 ${THRESHOLD}）`);
          return {
            prependContext: `[相关记忆]\n${memoryList}\n`
          };
        } else {
          console.log(`🔍 未找到高于阈值 ${THRESHOLD} 的相关记忆。`);
        }
      } catch (err) {
        console.error('检索记忆出错:', err.message);
      }
    });

    api.on('agent_end', async (event, ctx) => {
      console.log('🔵 [memory-qdrant] agent_end triggered');

      if (!event?.messages || !Array.isArray(event.messages) || event.messages.length === 0) {
        console.log('event.messages 为空或不存在');
        return;
      }

      const lastMessage = event.messages[event.messages.length - 1];
      if (!lastMessage) {
        console.log('无法获取最后一条消息');
        return;
      }

      const rawContent = lastMessage.content;
      const aiContent = extractText(rawContent);
      console.log('AI回复提取后长度:', aiContent.length, '预览:', aiContent.substring(0, 100));

      if (aiContent && aiContent.length > 5) {
        const currentUserId = userId;
        const conversationId = ctx?.sessionKey || 'global';
        await insertMemory(aiContent, currentUserId, conversationId, 'assistant', 'raw', false);
      } else {
        console.log('跳过插入：aiContent为空或太短');
      }
    });
  }
};