/**
 * 简化版 memory-server - 使用原生 Node.js http 模块
 * 绕过 Elysia 框架的 body 解析 bug
 */

import http from 'http';
import { StorageOrchestrator } from './storage/orchestrator.js';
import { loadConfig } from './config/index.js';

const PORT = process.env.OPENCLAW_MEMORY_PORT ? parseInt(process.env.OPENCLAW_MEMORY_PORT) : 7777;
const AUTH_TOKEN = process.env.MEMORY_AUTH_TOKEN || 'clawx-memory-token';

async function startServer() {
  console.log('[server] Starting simplified memory-server...');
  
  const config = await loadConfig();
  const orchestrator = new StorageOrchestrator(config);
  await orchestrator.init();
  
  console.log('[server] Storage layers initialized');
  
  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    // Health check
    if (req.url === '/api/health' && req.method === 'GET') {
      const health = await orchestrator.healthCheck();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }
    
    // Create memory
    if (req.url === '/api/memories' && req.method === 'POST') {
      // Auth check
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== AUTH_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      
      // Read body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      
      console.log(`[API] POST /api/memories - Body length: ${rawBody.length}`);
      
      try {
        const body = JSON.parse(rawBody);
        const result = await orchestrator.createMemory(body as any);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('[API] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Failed to create memory',
          details: error instanceof Error ? error.message : String(error)
        }));
      }
      return;
    }
    
    // Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  
  server.listen(PORT, () => {
    console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(console.error);
