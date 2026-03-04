import express from 'express';
import { QdrantClient } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios'; // 需要安装axios
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { sanitizeText } from './text-cleaner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// 静态文件服务 - 提供前端页面
app.use(express.static(path.join(__dirname, 'frontend')));

// 提供根路径的页面 - 使用新的界面
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'memory-manager-new.html'));
});

// 为所有其他非API路径提供前端页面（用于SPA路由）
app.get(/^(?!\/api).*$/, (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'memory-manager-new.html'));
});

// Qdrant配置
const QDRANT_URL = 'http://localhost:6333';
const COLLECTION = 'agent_memory';
const OLLAMA_URL = 'http://localhost:11434';
const EMBEDDING_MODEL = 'bge-m3:latest';

const client = new QdrantClient({ url: QDRANT_URL });
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanInputText(raw) {
    return sanitizeText(raw, {
        removeRolePrefix: true,
        removeToolImageNotice: true,
        removeUntrustedMetadata: true,
        removeProtocolMarkers: true,
        removeWeekdayTimeHead: true,
        removeIsoTimeHead: true,
        removeInlineWeekdayTime: true,
        // 手动录入保持宽口径，最大化清掉前缀脏头
        removeBroadLeadingBracket: true,
        removeInlineAnyDateBracket: false
    });
}

// 辅助函数：生成向量
async function generateEmbedding(text) {
    try {
        const response = await axios.post(`${OLLAMA_URL}/api/embeddings`, {
            model: EMBEDDING_MODEL,
            prompt: text
        });
        return response.data.embedding;
    } catch (error) {
        console.error('生成向量失败:', error.message);
        throw error;
    }
}

// 辅助函数：计算文本相似度（改进版）
function calculateSimilarity(text1, text2) {
    // 清理文本，去掉常见的无意义字符
    const clean1 = text1.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '');
    const clean2 = text2.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '');

    if (clean1 === clean2) return 1.0;

    // 长度差异过大则直接判断为不相似
    if (Math.abs(clean1.length - clean2.length) > Math.max(clean1.length, clean2.length) * 0.6) return 0.1;

    // 计算最长公共子序列比例
    const len1 = clean1.length;
    const len2 = clean2.length;

    if (len1 === 0 || len2 === 0) return 0;

    // 动态规划计算最长公共子序列
    const dp = Array(len1 + 1).fill().map(() => Array(len2 + 1).fill(0));

    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            if (clean1[i - 1] === clean2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    const lcsLength = dp[len1][len2];
    const similarity = (2 * lcsLength) / (len1 + len2); // 使用LCS比例作为相似度

    return similarity;
}

// 检查是否已存在相似的记忆
async function checkDuplicate(text) {
    try {
        // 获取最近的几条记忆进行比较
        const response = await client.scroll(COLLECTION, {
            limit: 50, // 检查最近50条，增加检测范围
            with_payload: true,
            with_vector: false
        });

        const points = response.points || [];

        for (const point of points) {
            const existingText = point.payload?.text || '';

            // 长度过短的不比较
            if (existingText.length < 10 || text.length < 10) continue;

            const similarity = calculateSimilarity(text, existingText);

            // 如果相似度超过阈值，认为是重复
            if (similarity > 0.85) {
                console.log(`检测到重复记忆: 相似度 ${similarity.toFixed(2)}, 已存在的: "${existingText.substring(0, 50)}..."`);
                return { isDuplicate: true, similarity, existingText: existingText.substring(0, 100) };
            }
        }

        return { isDuplicate: false, similarity: 0 };
    } catch (error) {
        console.error('检查重复记忆失败:', error.message);
        // 出错时仍允许插入，避免阻塞功能
        return { isDuplicate: false, similarity: 0 };
    }
}

// 辅助函数：提取关键词 - 使用 AI 模型
async function extractKeywords(text) {
    // 构建提示词，让 AI 提取关键词
    const prompt = `请从以下文本中提取3-8个最重要的关键词/短语。关键词应该能代表文本的核心内容。

文本内容：
${text}

请按以下JSON格式输出关键词数组：
{
  "keywords": ["关键词1", "关键词2", "关键词3"]
}

只需要输出JSON，不要其他解释。`;

    try {
        const response = await axios.post(`${OLLAMA_URL}/api/chat`, {
            model: 'qwen2.5:14b-instruct', // 使用支持中文的模型
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            format: 'json',
            options: {
                temperature: 0.1
            }
        }, {
            timeout: 15000
        });

        const data = response.data;
        const content = data.message?.content || data.choices?.[0]?.message?.content || '';

        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed.keywords)) {
                // 只保留最长的5个关键词，避免过长的术语
                return parsed.keywords
                    .filter(kw => kw && kw.length >= 1 && kw.length <= 20)  // 过滤无效关键词
                    .filter(kw => !/^(conversation|info|untrusted|metadata|message_id|conversation_id|user_id|channel_id)$/i.test(String(kw).trim()))
                    .filter(kw => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(kw).trim()))
                    .slice(0, 8)  // 最多8个
                    .map(kw => kw.trim());
            }
        } catch (e) {
            console.log('JSON解析失败，尝试从纯文本中提取关键词');
        }

        // 如果JSON解析失败，从原始内容中尝试提取
        // 简单的备用方案：查找引号内的词或按句号分割后提取名词性短语
        const fallbackKeywords = [];
        const matches = content.match(/[""''「」『』]([^""''「」『』]{2,10})[""''「」『』]/g);
        if (matches) {
            matches.forEach(match => {
                const kw = match.replace(/[""''「」『』]/g, '').trim();
                if (kw && !fallbackKeywords.includes(kw) && kw.length >= 2) {
                    fallbackKeywords.push(kw);
                }
            });
        }

        return fallbackKeywords.slice(0, 5);
    } catch (error) {
        console.error('AI关键词提取失败，使用备用方法:', error.message);
        // 备用方法：简单的中文关键词提取
        return extractKeywordsFallback(text);
    }
}

// 备用关键词提取方法
function extractKeywordsFallback(text) {
    // 简单的中文处理方法
    const sentences = text.split(/[。！？.!?]/);
    const longestSentence = sentences.reduce((longest, current) =>
        current.length > longest.length ? current : longest, ""
    );

    // 基于常见中文名词模式提取关键词
    const patterns = [
        /[a-zA-Z0-9_-]{2,}|[\u4e00-\u9fa5]{2,10}/g,  // 中文词或英文单词
        /[\u4e00-\u9fa5]{2,5}(?=的|是|在|有|和)/g,    // 中文名词短语
        /[a-zA-Z][a-zA-Z0-9_]*(?=函数|方法|接口|API|命令)/g,  // 技术词汇
        /[\u4e00-\u9fa5]{2,4}(?=配置|设置|参数|选项)/g      // 配置相关词汇
    ];

    let keywords = [];
    for (const pattern of patterns) {
        const matches = longestSentence.match(pattern) || [];
        keywords = keywords.concat(matches);
    }

    // 去重并限制长度
    keywords = [...new Set(keywords)]
        .filter(kw => kw && kw.length >= 2 && kw.length <= 10)
        .slice(0, 8);

    return keywords;
}

// API端点：插入新记忆
app.post('/api/memory', async (req, res) => {
    try {
        const { text, role = 'user' } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: '缺少记忆文本或格式错误' });
        }

        const cleanedText = cleanInputText(text);
        if (!cleanedText) {
            return res.status(400).json({ error: '清洗后记忆文本为空' });
        }

        // 检查是否为重复记忆
        const duplicateCheck = await checkDuplicate(cleanedText);
        if (duplicateCheck.isDuplicate) {
            return res.status(409).json({
                error: '记忆内容重复',
                message: '相同或高度相似的记忆已存在',
                similarity: duplicateCheck.similarity
            });
        }

        // 生成向量
        const vector = await generateEmbedding(cleanedText);

        // 提取关键词
        const tags = await extractKeywords(cleanedText);

        // 创建记忆点
        const point = {
            id: uuidv4(),
            vector,
            payload: {
                text: cleanedText,
                tags,
                timestamp: Date.now(), // 使用毫秒时间戳
                userId: "shared",
                conversationId: "manual",
                role,
                type: "insight",
                mem_type: "insight",
                source_type: "manual",
                processed: true
            }
        };

        // 插入到Qdrant
        await client.upsert(COLLECTION, {
            wait: true,
            points: [point]
        });

        res.json({
            success: true,
            id: point.id,
            message: '记忆插入成功',
            keywords: tags
        });

    } catch (error) {
        console.error('插入记忆失败:', error);
        res.status(500).json({ error: `插入记忆失败: ${error.message}` });
    }
});

// API端点：获取所有记忆
app.get('/api/memory', async (req, res) => {
    try {
        const response = await client.scroll(COLLECTION, {
            limit: 1000,
            with_payload: true,
            with_vector: false
        });

        const memories = (response.points || []).filter(point => {
            const payload = point?.payload || {};
            const cleanedText = cleanInputText(payload.text || '');
            return cleanedText.length > 0;
        });

        // 按时间戳排序（最新的在前）
        memories.sort((a, b) => {
            const timeA = a.payload?.timestamp ? new Date(a.payload.timestamp).getTime() : 0;
            const timeB = b.payload?.timestamp ? new Date(b.payload.timestamp).getTime() : 0;
            return timeB - timeA;
        });

        res.json({ memories });
    } catch (error) {
        console.error('获取记忆失败:', error);
        res.status(500).json({ error: `获取记忆失败: ${error.message}` });
    }
});

// API端点：删除所有记忆
app.delete('/api/memory/all', async (req, res) => {
    try {
        console.log('[server] 开始删除所有记忆...');

        // 先检查是否有记忆点存在
        const countResponse = await client.count(COLLECTION, { exact: true });
        const totalBefore = countResponse.count || 0;
        console.log(`[server] 删除前的记忆数量: ${totalBefore}`);

        if (totalBefore === 0) {
            return res.json({
                success: true,
                message: '没有可删除的记忆',
                deleted_count: 0
            });
        }

        let deletedCount = 0;

        // 与“管理Qdrant记忆.ps1”保持一致：调用 points/delete + 空 must 过滤器
        try {
            const deleteResp = await axios.post(
                `${QDRANT_URL}/collections/${COLLECTION}/points/delete?wait=true`,
                { filter: { must: [] } },
                { timeout: 30000 }
            );
            console.log('[server] points/delete 响应:', deleteResp.data);
            deletedCount = totalBefore;
        } catch (primaryError) {
            console.warn('[server] points/delete 失败，切换到按ID批量删除兜底:', primaryError.message);

            // 兜底：先 scroll 全量拿 ID，再按 points 删除
            const allIds = [];
            let offset = undefined;

            while (true) {
                const scrollResult = await client.scroll(COLLECTION, {
                    limit: 256,
                    with_payload: false,
                    with_vector: false,
                    offset
                });

                const points = scrollResult?.points || [];
                for (const p of points) {
                    if (p?.id !== undefined && p?.id !== null) allIds.push(p.id);
                }

                if (!scrollResult?.next_page_offset || points.length === 0) break;
                offset = scrollResult.next_page_offset;
            }

            const batchSize = 256;
            for (let i = 0; i < allIds.length; i += batchSize) {
                const batch = allIds.slice(i, i + batchSize);
                if (batch.length === 0) continue;
                await client.delete(COLLECTION, { points: batch });
                deletedCount += batch.length;
            }
        }

        console.log(`[server] 删除操作完成，删除数量: ${deletedCount}`);

        // 验证删除后的状态
        const countAfterResponse = await client.count(COLLECTION, {
            exact: true
        });
        console.log(`[server] 删除后的记忆数量: ${countAfterResponse.count}`);

        res.json({
            success: true,
            message: '所有记忆删除成功',
            deleted_count: deletedCount
        });
    } catch (error) {
        console.error('删除所有记忆失败:', error);
        res.status(500).json({
            error: `删除所有记忆失败: ${error.message}`,
            success: false
        });
    }
});

// API端点：删除记忆（注意：必须放在 /api/memory/all 之后，避免路由冲突）
app.delete('/api/memory/:id', async (req, res) => {
    try {
        const rawId = String(req.params.id || '').trim();
        const numericId = Number(rawId);
        const isIntId = Number.isInteger(numericId) && String(numericId) === rawId;
        const isUuidId = UUID_V4_REGEX.test(rawId);

        if (!isIntId && !isUuidId) {
            return res.status(400).json({ error: '记忆ID格式无效，只支持整数或UUID' });
        }

        const pointId = isIntId ? numericId : rawId;

        await client.delete(COLLECTION, {
            points: [pointId]
        });

        res.json({ success: true, message: '记忆删除成功' });
    } catch (error) {
        console.error('删除记忆失败:', error);
        res.status(500).json({ error: `删除记忆失败: ${error.message}` });
    }
});

// API端点：触发总结
app.post('/api/summary', async (req, res) => {
    try {
        // 这里可以触发Python脚本执行总结
        // 简单响应，实际实现可以在后端调用Python脚本
        res.json({ success: true, message: '总结任务已触发，请查看后端日志' });
    } catch (error) {
        console.error('触发总结失败:', error);
        res.status(500).json({ error: `触发总结失败: ${error.message}` });
    }
});

// API端点：重新梳理单条记忆
app.post('/api/refine', async (req, res) => {
    try {
        const { id, text, role } = req.body;
        const normalizedText = cleanInputText(text);

        if (!id || !normalizedText) {
            return res.status(400).json({ error: '缺少记忆ID或文本内容' });
        }

        // 检查该记忆是否已经被处理过（防止重复处理）
        const existingPoints = await client.retrieve(COLLECTION, {
            ids: [id],
            with_payload: true,
            with_vector: false
        });

        if (!existingPoints || existingPoints.length === 0) {
            return res.status(404).json({ error: '未找到指定的记忆' });
        }

        const existingPayload = existingPoints[0].payload || {};

        // 如果记忆已经处理过，就不重复处理
        if (existingPayload.processed === true) {
            return res.status(400).json({
                error: '该记忆已经处理过，无需重复处理',
                success: false
            });
        }

        // 从AI服务获取提炼后的内容
        const response = await axios.post(`${OLLAMA_URL}/api/chat`, {
            model: 'qwen2.5:14b-instruct',
            messages: [{
                role: 'user',
                content: `你是一个专业的记忆提炼师。请将以下内容提炼为核心要点：

内容：${normalizedText}

要求：
1. 保留关键信息和核心要点
2. 去除冗余和无关内容
3. 长度控制在80-250字之间
4. 保持原意不变

输出提炼后的内容：`
            }],
            stream: false,
            options: {
                temperature: 0.1
            }
        }, {
            timeout: 30000
        });

        const refinedText = response.data.message?.content?.trim() || normalizedText;

        // 更新记忆点
        const vector = await generateEmbedding(refinedText);

        // 创建更新后的有效载荷
        const updatedPayload = {
            ...existingPayload,
            text: refinedText,
            tags: await extractKeywords(refinedText),
            timestamp: Date.now(),
            // 梳理后仍保持未处理，后续再由总结流程处理为 true
            processed: false
        };

        // 更新到Qdrant
        await client.upsert(COLLECTION, {
            wait: true,
            points: [{
                id: id,
                vector,
                payload: updatedPayload
            }]
        });

        res.json({
            success: true,
            message: '记忆重新梳理成功',
            refinedText: refinedText
        });
    } catch (error) {
        console.error('重新梳理记忆失败:', error);
        res.status(500).json({ error: `重新梳理记忆失败: ${error.message}` });
    }
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`Qdrant记忆管理API运行在端口 ${PORT}`);
});
