/**
 * 原生 Node.js HTTP 服务器 - 绕过 Elysia 框架的 body 解析 bug
 */

import http from 'http';
import { StorageOrchestrator } from './storage/orchestrator.js';
import { loadConfig } from './config/index.js';

const PORT = process.env.OPENCLAW_MEMORY_PORT ? parseInt(process.env.OPENCLAW_MEMORY_PORT) : 7777;
const AUTH_TOKEN = process.env.MEMORY_AUTH_TOKEN || 'clawx-memory-token';

async function startServer() {
  console.log('[server] Starting native memory-server...');
  
  const config = await loadConfig();
  const orchestrator = new StorageOrchestrator(config);
  await orchestrator.init();
  
  console.log('[server] Storage layers initialized');
  console.log(`[server] SQLite: ${orchestrator.sqlite ? 'ok' : 'error'}`);
  console.log(`[server] Qdrant: ${orchestrator.qdrant ? 'ok' : 'skipped'}`);
  console.log(`[server] AGE: ${orchestrator.age ? 'ok' : 'skipped'}`);
  
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    // Health check
    if (url.pathname === '/api/health' && req.method === 'GET') {
      const health = await orchestrator.healthCheck();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }
    
    // Get memories
    if (url.pathname === '/api/memories' && req.method === 'GET') {
      // Auth check
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== AUTH_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      
      try {
        const memories = orchestrator.sqlite.listMemories({ limit: 100 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ memories }));
      } catch (error) {
        console.error('[API] Get memories error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Failed to get memories',
          details: error instanceof Error ? error.message : String(error)
        }));
      }
      return;
    }
    
    // Create memory
    if (url.pathname === '/api/memories' && req.method === 'POST') {
      // Auth check
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== AUTH_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      
      // Read body using native Node.js stream
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf-8').trim();
      
      console.log(`[API] POST /api/memories - Body length: ${rawBody.length}`);
      
      if (!rawBody) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Empty body' }));
        return;
      }
      
      try {
        const body = JSON.parse(rawBody);
        console.log(`[API] Parsed body: ${JSON.stringify(body)}`);
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
    
    // Search memory
    if (url.pathname === '/api/search' && req.method === 'POST') {
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
      const rawBody = Buffer.concat(chunks).toString('utf-8').trim();
      
      try {
        const body = JSON.parse(rawBody);
        // 使用 searchEngine 进行搜索
        const searchEngine = new (await import('./search/engine.js')).SearchEngine(orchestrator);
        const results = await searchEngine.search(body as any);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
      } catch (error) {
        console.error('[API] Search error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Search failed',
          details: error instanceof Error ? error.message : String(error)
        }));
      }
      return;
    }
    
    // Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(console.error);
