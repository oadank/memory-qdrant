import type {
  Memory,
  MemoryScope,
  ScoredMemory,
  ExtractedEntity,
} from "../core/types.js";

// ── Qdrant Storage Layer ────────────────────────────────────────────────

// Dynamically imported — this is an optional peer dependency
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QdrantClient = any;

export interface QdrantStorageConfig {
  url: string;
  collection: string;
  apiKey?: string;
}

export class QdrantStorage {
  private client: QdrantClient | null = null;
  private collection: string;
  private config: QdrantStorageConfig;
  private ready = false;

  constructor(config: QdrantStorageConfig) {
    this.config = config;
    this.collection = config.collection;
  }

  // ── Lazy Client Init ────────────────────────────────────────────────

  private async getClient(): Promise<QdrantClient> {
    if (this.client) return this.client;

    try {
      // Dynamic import — @qdrant/js-client-rest is an optional peer dependency
      // @ts-ignore — optional peer dep, may not be installed
      const mod = await import("@qdrant/js-client-rest");
      const QdrantClientClass = mod.QdrantClient;
      this.client = new QdrantClientClass({
        url: this.config.url,
        apiKey: this.config.apiKey,
      });
      return this.client;
    } catch {
      throw new Error(
        "Qdrant client not available. Install @qdrant/js-client-rest: bun add @qdrant/js-client-rest"
      );
    }
  }

  // ── Collection Init ─────────────────────────────────────────────────

  async ensureCollection(vectorSize: number = 1536): Promise<void> {
    if (this.ready) {
      console.log(`[qdrant] Collection ${this.collection} already ready, skipping`);
      return;
    }

    const client = await this.getClient();

    try {
      console.log(`[qdrant] Checking if collection ${this.collection} exists...`);
      const collections = await client.getCollections();
      const exists = collections.collections?.some(
        (c: { name: string }) => c.name === this.collection
      );
      console.log(`[qdrant] Collection exists: ${exists}`);

      if (!exists) {
        console.log(`[qdrant] Creating collection ${this.collection} with vector size ${vectorSize}...`);
        await client.createCollection(this.collection, {
          vectors: {
            size: vectorSize,
            distance: "Cosine",
          },
          optimizers_config: {
            default_segment_number: 2,
          },
          replication_factor: 1,
        });

        // Create payload indexes for efficient filtering
        const indexFields = [
          { field_name: "agent_id", field_schema: "keyword" as const },
          { field_name: "scope", field_schema: "keyword" as const },
          { field_name: "subject_id", field_schema: "keyword" as const },
          { field_name: "tags", field_schema: "keyword" as const },
          { field_name: "entity_types", field_schema: "keyword" as const },
          { field_name: "entity_names", field_schema: "keyword" as const },
          { field_name: "source", field_schema: "keyword" as const },
        ];

        for (const idx of indexFields) {
          await client.createPayloadIndex(this.collection, idx);
        }

        console.log(`[qdrant] Created collection: ${this.collection}`);
      } else {
        console.log(`[qdrant] Collection ${this.collection} already exists`);
      }

      this.ready = true;
      console.log(`[qdrant] Collection ${this.collection} is now ready`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[qdrant] Failed to ensure collection: ${errorMsg}`);
      console.error(`[qdrant] Error stack: ${error instanceof Error ? error.stack : 'no stack'}`);
      throw error;
    }
  }

  // ── Upsert ──────────────────────────────────────────────────────────

  async upsertMemory(memory: Memory, vector: number[]): Promise<void> {
    const client = await this.getClient();
    await this.ensureCollection(vector.length);

    const entityTypes = memory.entities.map((e) => e.type);
    const entityNames = memory.entities.map((e) => e.name);

    await client.upsert(this.collection, {
      points: [
        {
          id: memory.id,
          vector,
          payload: {
            agent_id: memory.agent_id,
            scope: memory.scope,
            subject_id: memory.subject_id,
            content: memory.content,
            tags: memory.tags,
            entity_types: entityTypes,
            entity_names: entityNames,
            source: memory.source,
            created_by: memory.created_by,
            created_at: memory.created_at,
            updated_at: memory.updated_at,
          },
        },
      ],
    });
  }

  // ── Delete ──────────────────────────────────────────────────────────

  async deleteMemory(id: string): Promise<void> {
    const client = await this.getClient();
    if (!this.ready) await this.ensureCollection();
    await client.delete(this.collection, {
      points: [id],
    });
  }

  // ── Semantic Search ─────────────────────────────────────────────────

  async search(
    queryVector: number[],
    agentId?: string,
    scopes?: MemoryScope[],
    subjectId?: string | null,
    limit: number = 10,
    crossAgent: boolean = false
  ): Promise<ScoredMemory[]> {
    const client = await this.getClient();
    await this.ensureCollection(queryVector.length);

    const filter = this.buildFilter(agentId, scopes, subjectId, crossAgent);

    const results = await client.search(this.collection, {
      vector: queryVector,
      limit,
      with_payload: true,
      filter: filter || undefined,
      score_threshold: 0.3,
    });

    return results.map((point: { id: string | number; payload?: Record<string, unknown>; score: number }) => {
      const payload = (point.payload || {}) as Record<string, unknown>;
      return {
        memory: this.payloadToMemory(String(point.id), payload),
        score: point.score,
        source_layer: "qdrant" as const,
      };
    });
  }

  // ── Health Check ────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.getClient();
      await client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  // ── Collection Info ─────────────────────────────────────────────────

  async getCollectionInfo(): Promise<{ vectorCount: number } | null> {
    try {
      const client = await this.getClient();
      const info = await client.getCollection(this.collection);
      return { vectorCount: info.points_count || 0 };
    } catch {
      return null;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private buildFilter(
    agentId?: string,
    scopes?: MemoryScope[],
    subjectId?: string | null,
    crossAgent: boolean = false
  ): Record<string, unknown> | null {
    const must: Array<Record<string, unknown>> = [];

    if (agentId && !crossAgent) {
      must.push({ key: "agent_id", match: { value: agentId } });
    }
    if (scopes && scopes.length > 0) {
      must.push({ key: "scope", match: { any: scopes } });
    }
    if (subjectId !== undefined && subjectId !== null) {
      must.push({ key: "subject_id", match: { value: subjectId } });
    }

    if (must.length === 0) return null;
    return { must };
  }

  private payloadToMemory(id: string, payload: Record<string, unknown>): Memory {
    return {
      id,
      agent_id: (payload.agent_id as string) || "",
      scope: (payload.scope as MemoryScope) || "agent",
      subject_id: (payload.subject_id as string | null) ?? null,
      content: (payload.content as string) || "",
      tags: (payload.tags as string[]) || [],
      entities: ((payload.entity_names as string[]) || []).map(
        (name, i) => ({
          name,
          type: ((payload.entity_types as string[]) || [])[i] || "Concept",
          properties: {},
        })
      ) as ExtractedEntity[],
      source: (payload.source as Memory["source"]) || "explicit",
      created_by: (payload.created_by as string | null) ?? null,
      created_at: (payload.created_at as string) || "",
      updated_at: (payload.updated_at as string) || "",
      expires_at: null,
      embedding_hash: null,
    };
  }
}
