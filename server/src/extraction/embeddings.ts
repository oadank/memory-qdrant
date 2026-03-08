import OpenAI from "openai";
import axios from "axios";

// ── Embedding Service ───────────────────────────────────────────────────

export interface EmbeddingConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  dimensions: number;
}

export class EmbeddingService {
  private client: OpenAI | null = null;
  private isOllama: boolean = false;
  private model: string;
  private dimensions: number;
  private baseUrl?: string;

  constructor(config: EmbeddingConfig) {
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.baseUrl = config.baseUrl;
    
    // 检测是否是 Ollama
    this.isOllama = config.baseUrl?.includes("11434") || config.apiKey === "ollama";
    
    if (!this.isOllama) {
      this.client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
    }
  }

  async embed(text: string): Promise<number[] | null> {
    if (!text || text.trim().length === 0) return null;

    try {
      if (this.isOllama) {
        // Ollama API
        const baseUrl = this.baseUrl || "http://localhost:11434";
        const url = baseUrl.endsWith('/api/embeddings') ? baseUrl : `${baseUrl}/api/embeddings`;
        const response = await axios.post(url, {
          model: this.model,
          prompt: text.slice(0, 8000),
        });
        
        const embedding = response.data.embedding;
        if (!embedding || embedding.length === 0) {
          console.warn("[embeddings] Empty embedding returned from Ollama");
          return null;
        }
        
        return embedding;
      } else {
        // OpenAI API
        const response = await this.client!.embeddings.create({
          model: this.model,
          input: text.slice(0, 8000),
        });

        const embedding = response.data[0]?.embedding;
        if (!embedding || embedding.length === 0) {
          console.warn("[embeddings] Empty embedding returned");
          return null;
        }

        return embedding;
      }
    } catch (error) {
      console.error(`[embeddings] Failed to generate embedding: ${error}`);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];

    try {
      const cleanTexts = texts.map((t) => (t || "").slice(0, 8000));
      const response = await this.client.embeddings.create({
        model: this.model,
        input: cleanTexts,
      });

      return response.data.map((item) =>
        item.embedding && item.embedding.length > 0 ? item.embedding : null
      );
    } catch (error) {
      console.error(`[embeddings] Batch embedding failed: ${error}`);
      return texts.map(() => null);
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }
}
