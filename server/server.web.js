// Memory Web Server - 三层记忆管理界面后端
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// 静态文件服务 - 实时读取，不缓存
app.use('/frontend', express.static(path.join(__dirname, 'frontend'), {
    maxAge: '0',
    etag: true,
    lastModified: true
}));

// 根路径 - 直接读取文件
app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'frontend', 'memory-manager.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    res.type('text/html').send(html);
});

// API 代理到 memory-server (7777) - 本机访问
const MEMORY_SERVER = 'http://localhost:7777';

app.use('/api', async (req, res) => {
    try {
        const targetUrl = `${MEMORY_SERVER}${req.originalUrl}`;
        const response = await axios({
            method: req.method,
            url: targetUrl,
            data: req.body,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': req.headers.authorization
            },
            timeout: 10000
        });
        res.json(response.data);
    } catch (error) {
        res.status(error.response?.status || 500).json({
            error: error.message,
            details: error.response?.data
        });
    }
});

// Qdrant 计数 - 通过 memory-server 代理
app.post('/api/qdrant/count', async (req, res) => {
    try {
        const response = await axios.post(
            `${MEMORY_SERVER}/api/qdrant/count`,
            req.body,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': req.headers.authorization
                },
                timeout: 10000
            }
        );
        res.json(response.data);
    } catch (error) {
        res.json({ count: 0, error: error.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🧠 Memory Web Server running on port ${PORT}`);
    console.log(`📊 Frontend: http://localhost:${PORT}`);
    console.log(`🔗 Memory Server: ${MEMORY_SERVER}`);
});
