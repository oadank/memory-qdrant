import type { SqliteStorage } from "./sqlite.js";
import type { QdrantStorage } from "./qdrant.js";
import type { AgeStorage } from "./age.js";
import type { EmbeddingService } from "../extraction/embeddings.js";
import type { SyncQueueItem } from "../core/types.js";

// ── Sync Queue Processor ────────────────────────────────────────────────

export class SyncQueueProcessor {
  private static batchSizeOverride: number | null = null;
  private static readonly SQLITE_ATTEMPT_CEILING = 5;
  private static readonly DEFAULT_BATCH_SIZE = 50;
  private static readonly DEFAULT_MAX_RETRIES = 20;

  private sqlite: SqliteStorage;
  private qdrant: QdrantStorage | null;
  private age: AgeStorage | null;
  private embeddings: EmbeddingService | null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(
    sqlite: SqliteStorage,
    qdrant: QdrantStorage | null,
    age: AgeStorage | null,
    embeddings: EmbeddingService | null
  ) {
    this.sqlite = sqlite;
    this.qdrant = qdrant;
    this.age = age;
    this.embeddings = embeddings;
  }

  static async withBatchSize<T>(batchSize: number, fn: () => Promise<T>): Promise<T> {
    const previous = SyncQueueProcessor.batchSizeOverride;
    SyncQueueProcessor.batchSizeOverride = clampPositiveInt(
      batchSize,
      SyncQueueProcessor.DEFAULT_BATCH_SIZE
    );

    try {
      return await fn();
    } finally {
      SyncQueueProcessor.batchSizeOverride = previous;
    }
  }

  start(intervalMs: number = 60_000): void {
    if (this.interval) return;
    console.log(`[sync-queue] Starting processor (every ${intervalMs / 1000}s)`);
    this.interval = setInterval(() => {
      void this.processQueue();
    }, intervalMs);
    // Also process immediately
    void this.processQueue();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log("[sync-queue] Stopped");
    }
  }

  async processQueue(batchSize?: number): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.processing) return { processed: 0, succeeded: 0, failed: 0 };
    this.processing = true;

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    const effectiveBatchSize = this.resolveBatchSize(batchSize);
    const maxRetries = this.resolveMaxRetries();

    try {
      const items = this.sqlite.getSyncQueue(effectiveBatchSize);
      if (items.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      console.log(
        `[sync-queue] Processing ${items.length} items (batch=${effectiveBatchSize}, maxRetries=${maxRetries})`
      );

      for (const item of items) {
        processed++;
        try {
          await this.processItem(item);
          this.sqlite.removeSyncQueueItem(item.id);
          succeeded++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.handleFailure(item, errorMsg, maxRetries);
          failed++;
          console.warn(
            `[sync-queue] Failed item ${item.id} (${item.layer}/${item.operation}/${item.memory_id}): ${errorMsg}`
          );
        }
      }

      const cleared = this.sqlite.clearCompletedSyncItems();
      if (cleared > 0) {
        console.log(`[sync-queue] Cleared ${cleared} items that reached retry limit`);
      }
    } finally {
      this.processing = false;
    }

    if (processed > 0) {
      console.log(`[sync-queue] Done: ${succeeded} ok, ${failed} failed out of ${processed}`);
    }

    return { processed, succeeded, failed };
  }

  private async processItem(item: SyncQueueItem): Promise<void> {
    if (item.layer === "qdrant") {
      await this.processQdrantItem(item);
    } else if (item.layer === "age") {
      await this.processAgeItem(item);
    }
  }

  private async processQdrantItem(item: SyncQueueItem): Promise<void> {
    if (!this.qdrant) throw new Error("Qdrant layer not configured");

    if (item.operation === "delete") {
      await this.qdrant.deleteMemory(item.memory_id);
      return;
    }

    const memory = this.sqlite.getMemory(item.memory_id);
    if (!memory) return; // Deleted since queuing

    if (!this.embeddings) throw new Error("Embedding service not configured");
    const vector = await this.embeddings.embed(memory.content);
    if (!vector) throw new Error("Failed to generate embedding");

    await this.qdrant.upsertMemory(memory, vector);
  }

  private async processAgeItem(item: SyncQueueItem): Promise<void> {
    if (!this.age) throw new Error("AGE layer not configured");

    if (item.operation === "delete") {
      await this.age.deleteMemoryNode(item.memory_id);
      return;
    }

    const memory = this.sqlite.getMemory(item.memory_id);
    if (!memory) return;

    await this.age.upsertMemoryNode(memory);

    for (const entity of memory.entities) {
      const entityId = await this.age.upsertEntityNode(entity, memory.agent_id);
      await this.age.linkMemoryToEntity(memory.id, entityId);
    }
  }

  private resolveBatchSize(batchSize?: number): number {
    if (batchSize !== undefined) {
      return clampPositiveInt(batchSize, SyncQueueProcessor.DEFAULT_BATCH_SIZE);
    }
    if (SyncQueueProcessor.batchSizeOverride !== null) {
      return SyncQueueProcessor.batchSizeOverride;
    }
    return clampPositiveInt(
      parseInt(process.env.SYNC_QUEUE_BATCH_SIZE || "", 10),
      SyncQueueProcessor.DEFAULT_BATCH_SIZE
    );
  }

  private resolveMaxRetries(): number {
    return Math.max(
      SyncQueueProcessor.SQLITE_ATTEMPT_CEILING,
      clampPositiveInt(
        parseInt(process.env.SYNC_QUEUE_MAX_RETRIES || "", 10),
        SyncQueueProcessor.DEFAULT_MAX_RETRIES
      )
    );
  }

  private handleFailure(item: SyncQueueItem, errorMessage: string, maxRetries: number): void {
    const priorLogicalAttempts = extractLogicalAttempts(item.last_error, item.attempts);
    const nextLogicalAttempts = priorLogicalAttempts + 1;
    const physicalNextAttempt = item.attempts + 1;

    // We keep SQLite attempts under its hardcoded fetch/clear ceiling (5) to
    // tolerate temporary outages while still respecting a configurable maxRetries.
    if (nextLogicalAttempts >= maxRetries) {
      this.sqlite.updateSyncQueueItem(
        item.id,
        SyncQueueProcessor.SQLITE_ATTEMPT_CEILING,
        formatAttemptError(errorMessage, nextLogicalAttempts, maxRetries)
      );
      return;
    }

    if (physicalNextAttempt >= SyncQueueProcessor.SQLITE_ATTEMPT_CEILING) {
      this.sqlite.updateSyncQueueItem(
        item.id,
        0,
        formatAttemptError(errorMessage, nextLogicalAttempts, maxRetries)
      );
      return;
    }

    this.sqlite.updateSyncQueueItem(
      item.id,
      physicalNextAttempt,
      formatAttemptError(errorMessage, nextLogicalAttempts, maxRetries)
    );
  }
}

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded <= 0) return fallback;
  return rounded;
}

function formatAttemptError(errorMessage: string, attempts: number, maxRetries: number): string {
  return `[attempt ${attempts}/${maxRetries}] ${errorMessage}`;
}

function extractLogicalAttempts(lastError: string | null, fallback: number): number {
  if (lastError) {
    const match = /^\[attempt (\d+)\/\d+\]\s*/.exec(lastError);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return fallback;
}
