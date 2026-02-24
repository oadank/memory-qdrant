import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const qdrantUrl = 'http://localhost:6333';
const collection = 'agent_memory';
const ollamaUrl = 'http://localhost:11434';
const embeddingModel = 'bge-m3:latest';

async function embed(text) {
  const res = await axios.post(`${ollamaUrl}/api/embeddings`, {
    model: embeddingModel,
    prompt: text
  });
  return res.data.embedding;
}

async function insertTestMemory() {
  try {
    const text = '这是一条手动测试记忆';
    const vector = await embed(text);
    const pointId = uuidv4();
    const response = await axios.put(`${qdrantUrl}/collections/${collection}/points?wait=true`, {
      points: [{
        id: pointId,
        vector,
        payload: {
          text,
          timestamp: Date.now(),
          userId: 'test',
          conversationId: 'test-session'
        }
      }]
    });
    console.log('✅ 手动插入成功，响应:', response.data);
    console.log('点 ID:', pointId);
  } catch (err) {
    console.error('❌ 手动插入失败:', err.response?.data || err.message);
  }
}

insertTestMemory();