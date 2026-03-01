import express from 'express';
import { QdrantClient } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios'; // 需要安装axios
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

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

// 辅助函数：提取关键词
async function extractKeywords(text) {
    // 这里使用一个简化的方法，实际上可以用jieba或其他分词工具
    const words = text.split(/[\s\p{P}]+/u).filter(word => word.length > 1);

    // 简单的停用词过滤
    const stopwords = new Set([
        '的', '了', '在', '是', '我', '有', '和', '就', '都', '人', '个', '一个', '这个', '那个',
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with'
    ]);

    const keywords = [...new Set(words)]
        .filter(word => word.length >= 2 && !stopwords.has(word.toLowerCase()))
        .slice(0, 15); // 最多15个关键词

    return keywords;
}

// API端点：插入新记忆
app.post('/api/memory', async (req, res) => {
    try {
        const { text, type = 'insight', role = 'assistant' } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: '缺少记忆文本或格式错误' });
        }

        if (text.trim().length < 5) {
            return res.status(400).json({ error: '记忆文本太短' });
        }

        const cleanedText = text.trim();

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
                type,
                mem_type: type,
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

        const memories = response.points || [];

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

// API端点：删除记忆
app.delete('/api/memory/:id', async (req, res) => {
    try {
        const { id } = req.params;

        await client.delete(COLLECTION, {
            points: [id]
        });

        res.json({ success: true, message: '记忆删除成功' });
    } catch (error) {
        console.error('删除记忆失败:', error);
        res.status(500).json({ error: `删除记忆失败: ${error.message}` });
    }
});

// API端点：删除所有记忆
app.delete('/api/memory/all', async (req, res) => {
    try {
        await client.delete(COLLECTION, {
            filter: {
                must: []
            }
        });

        res.json({ success: true, message: '所有记忆删除成功' });
    } catch (error) {
        console.error('删除所有记忆失败:', error);
        res.status(500).json({ error: `删除所有记忆失败: ${error.message}` });
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

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`Qdrant记忆管理API运行在端口 ${PORT}`);
});