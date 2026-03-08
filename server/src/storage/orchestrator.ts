import { createHash } from "node:crypto";
import type { ResolvedConfig } from "../config/index.js";
import { SqliteStorage } from "./sqlite.js";
import { QdrantStorage } from "./qdrant.js";
import { AgeStorage } from "./age.js";
import { SyncQueueProcessor } from "./sync-queue.js";
import { EmbeddingService } from "../extraction/embeddings.js";
import { EntityExtractor } from "../extraction/entity-extractor.js";
import type {
  Tier,
  Memory,
  CreateMemoryRequest,
  UpdateMemoryRequest,
  SyncStatus,
  CreateMemoryResponse,
  ExtractedEntity,
  ExtractedRelationship,
  HealthResponse,
} from "../core/types.js";
import { v7 as uuidv7 } from "uuid";

// ── Storage Orchestrator ────────────────────────────────────────────────

export class StorageOrchestrator {
  readonly tier: Tier;
  readonly sqlite: SqliteStorage;
  readonly qdrant: QdrantStorage | null;
  readonly age: AgeStorage | null;
  readonly embeddings: EmbeddingService | null;
  readonly entityExtractor: EntityExtractor | null;
  private syncProcessor: SyncQueueProcessor;
  private startTime: number;

  constructor(config: ResolvedConfig) {
    this.tier = config.tier;
    this.sqlite = new SqliteStorage(config.sqlite.path);
    this.startTime = Date.now();

    // L2: Qdrant — only for standard/full tiers
    if (config.qdrant) {
      this.qdrant = new QdrantStorage(config.qdrant);
    } else {
      this.qdrant = null;
    }

    // L3: AGE — only for full tier
    if (config.age) {
      this.age = new AgeStorage(config.age);
    } else {
      this.age = null;
    }

    // Embeddings — needed for Qdrant
    if (config.embedding) {
      this.embeddings = new EmbeddingService(config.embedding);
    } else {
      this.embeddings = null;
    }

    // Entity extraction — for standard/full
    if (config.extraction && config.extraction.enabled) {
      this.entityExtractor = new EntityExtractor(config.extraction);
    } else {
      this.entityExtractor = null;
    }

    this.syncProcessor = new SyncQueueProcessor(
      this.sqlite,
      this.qdrant,
      this.age,
      this.embeddings
    );
  }

  async init(): Promise<void> {
    // Initialize L2 if available
    if (this.qdrant) {
      try {
        const dimensions = this.embeddings?.getDimensions() || 1536;
        await this.qdrant.ensureCollection(dimensions);
        console.log("[orchestrator] Qdrant collection ready");
      } catch (error) {
        console.warn(`[orchestrator] Qdrant init failed (will retry): ${error}`);
      }
    }

    // Initialize L3 if available
    if (this.age) {
      try {
        await this.age.ensureGraph();
        console.log("[orchestrator] AGE graph ready");
      } catch (error) {
        console.warn(`[orchestrator] AGE init failed (will retry): ${error}`);
      }
    }

    // Start sync queue processor if we have L2 or L3
    if (this.qdrant || this.age) {
      this.syncProcessor.start(60_000);
    }
  }

  // ── Create Memory ───────────────────────────────────────────────────

  async createMemory(req: CreateMemoryRequest): Promise<CreateMemoryResponse> {
    const now = new Date().toISOString();
    const id = uuidv7();

    // Extract entities if extractor is available and requested
    let entities: ExtractedEntity[] = [];
    let relationships: ExtractedRelationship[] = [];
    const shouldExtract =
      this.entityExtractor &&
      req.extract_entities !== false &&
      req.content &&
      req.content.length >= 20 &&
      req.source !== "entity_extraction";

    if (shouldExtract) {
      try {
        const extraction = await this.entityExtractor!.extract(req.content);
        entities = extraction.entities;
        relationships = extraction.relationships;
      } catch (error) {
        console.warn(`[orchestrator] Entity extraction failed: ${error}`);
      }
    }

    const embeddingHash = contentHash(req.content);

    const memory: Memory = {
      id,
      agent_id: req.agent_id,
      scope: req.scope,
      subject_id: req.subject_id ?? null,
      content: req.content,
      tags: req.tags || [],
      entities,
      source: req.source || "explicit",
      created_by: req.created_by ?? null,
      created_at: now,
      updated_at: now,
      expires_at: req.expires_at ?? null,
      embedding_hash: embeddingHash,
    };

    // L1: SQLite — authoritative, synchronous
    this.sqlite.createMemory(memory);

    // L2: Qdrant — async best-effort
    const qdrantStatus = await this.asyncL2Upsert(memory);

    // L3: AGE — async best-effort
    const ageStatus = await this.asyncL3Upsert(memory, entities, relationships);

    return {
      id: memory.id,
      agent_id: memory.agent_id,
      scope: memory.scope,
      content: memory.content,
      entities: memory.entities,
      created_at: memory.created_at,
      sync_status: {
        sqlite: "ok",
        qdrant: qdrantStatus,
        age: ageStatus,
      },
    };
  }

  // ── Update Memory ───────────────────────────────────────────────────

  async updateMemory(
    id: string,
    req: UpdateMemoryRequest
  ): Promise<CreateMemoryResponse | null> {
    const existing = this.sqlite.getMemory(id);
    if (!existing) return null;

    let entities = existing.entities;
    let relationships: ExtractedRelationship[] = [];
    if (req.content && req.content !== existing.content) {
      const shouldExtract =
        this.entityExtractor &&
        req.extract_entities !== false &&
        req.content.length >= 20;
      if (shouldExtract) {
        try {
          const extraction = await this.entityExtractor!.extract(req.content);
          entities = extraction.entities;
          relationships = extraction.relationships;
        } catch (error) {
          console.warn(`[orchestrator] Entity extraction failed on update: ${error}`);
        }
      }
    }

    const embeddingHash = req.content
      ? contentHash(req.content)
      : existing.embedding_hash;

    const updates: Partial<Memory> = {
      ...(req.content !== undefined && { content: req.content }),
      ...(req.tags !== undefined && { tags: req.tags }),
      ...(req.scope !== undefined && { scope: req.scope }),
      ...(req.subject_id !== undefined && { subject_id: req.subject_id }),
      ...(req.expires_at !== undefined && { expires_at: req.expires_at }),
      entities,
      embedding_hash: embeddingHash,
    };

    const updated = this.sqlite.updateMemory(id, updates);
    if (!updated) return null;

    const qdrantStatus = await this.asyncL2Upsert(updated);
    const ageStatus = await this.asyncL3Upsert(updated, entities, relationships);

    return {
      id: updated.id,
      agent_id: updated.agent_id,
      scope: updated.scope,
      content: updated.content,
      tags: updated.tags,
      entities: updated.entities,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
      sync_status: {
        sqlite: "ok",
        qdrant: qdrantStatus,
        age: ageStatus,
      },
    };
  }

  // ── Delete Memory ───────────────────────────────────────────────────

  async deleteMemory(id: string): Promise<boolean> {
    const deleted = this.sqlite.deleteMemory(id);
    if (!deleted) return false;

    // L2: Qdrant
    if (this.qdrant) {
      try {
        await this.qdrant.deleteMemory(id);
      } catch (error) {
        console.warn(`[orchestrator] Qdrant delete failed, queuing: ${error}`);
        this.sqlite.addToSyncQueue(id, "qdrant", "delete");
      }
    }

    // L3: AGE
    if (this.age) {
      try {
        await this.age.deleteMemoryNode(id);
      } catch (error) {
        console.warn(`[orchestrator] AGE delete failed, queuing: ${error}`);
        this.sqlite.addToSyncQueue(id, "age", "delete");
      }
    }

    return true;
  }

  // ── Health Check ────────────────────────────────────────────────────

  async healthCheck(): Promise<HealthResponse> {
    const details: Record<string, string> = {};

    const sqliteOk = this.sqlite.healthCheck();
    if (!sqliteOk) details.sqlite = "SQLite health check failed";

    let qdrantStatus: "ok" | "error" | "disabled" = "disabled";
    if (this.qdrant) {
      try {
        qdrantStatus = (await this.qdrant.healthCheck()) ? "ok" : "error";
      } catch (error) {
        qdrantStatus = "error";
        details.qdrant = String(error);
      }
    }

    let ageStatus: "ok" | "error" | "disabled" = "disabled";
    if (this.age) {
      try {
        ageStatus = (await this.age.healthCheck()) ? "ok" : "error";
      } catch (error) {
        ageStatus = "error";
        details.age = String(error);
      }
    }

    return {
      sqlite: sqliteOk ? "ok" : "error",
      qdrant: qdrantStatus,
      age: ageStatus,
      tier: this.tier,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      ...(Object.keys(details).length > 0 && { details }),
    };
  }

  // ── Retry Sync ──────────────────────────────────────────────────────

  async retrySyncQueue(): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
  }> {
    return this.syncProcessor.processQueue();
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.syncProcessor.stop();
    this.sqlite.close();
    if (this.age) await this.age.close();
  }

  // ── Private Helpers ─────────────────────────────────────────────────

  private async asyncL2Upsert(
    memory: Memory
  ): Promise<"ok" | "queued" | "failed" | "disabled"> {
    if (!this.qdrant || !this.embeddings) return "disabled";

    try {
      const vector = await this.embeddings.embed(memory.content);
      if (!vector) {
        this.sqlite.addToSyncQueue(memory.id, "qdrant", "upsert");
        return "queued";
      }
      await this.qdrant.upsertMemory(memory, vector);
      this.sqlite.updateMemory(memory.id, {
        embedding_hash: contentHash(memory.content),
      });
      return "ok";
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : 'no stack';
      console.warn(`[orchestrator] Qdrant upsert failed, queuing: ${errorMsg}`);
      console.warn(`[orchestrator] Error stack: ${errorStack}`);
      this.sqlite.addToSyncQueue(memory.id, "qdrant", "upsert");
      return "queued";
    }
  }

  private async asyncL3Upsert(
    memory: Memory,
    entities: ExtractedEntity[],
    relationships: ExtractedRelationship[]
  ): Promise<"ok" | "queued" | "failed" | "disabled"> {
    if (!this.age) return "disabled";

    try {
      await this.age.upsertMemoryNode(memory);

      for (const entity of entities) {
        const entityId = await this.age.upsertEntityNode(entity, memory.agent_id);
        await this.age.linkMemoryToEntity(memory.id, entityId);
      }

      for (const rel of relationships) {
        await this.age.createRelationship(rel, memory.agent_id);
      }

      return "ok";
    } catch (error) {
      console.warn(`[orchestrator] AGE upsert failed, queuing: ${error}`);
      this.sqlite.addToSyncQueue(memory.id, "age", "upsert");
      return "queued";
    }
  }
}

// ── Utility ─────────────────────────────────────────────────────────────

function contentHash(content: string): string {
  // Use crypto.createHash for universal Node/Bun compatibility
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
