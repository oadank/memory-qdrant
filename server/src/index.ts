// ── openclaw-memory — Public API ────────────────────────────────────────

// Core service
export { MemoryService } from "./core/memory-service.js";

// Config
export { defineConfig, loadConfig, configSummary } from "./config/index.js";
export type { Config, ResolvedConfig } from "./config/index.js";

// Types
export type {
  Tier,
  Memory,
  MemoryScope,
  MemorySource,
  EntityType,
  RelationshipType,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractionResult,
  CreateMemoryRequest,
  UpdateMemoryRequest,
  SearchRequest,
  SearchResponse,
  ScoredMemory,
  SyncStatus,
  CreateMemoryResponse,
  ConversationLogEntry,
  SummarizeRequest,
  SummarizeResponse,
  HealthResponse,
  SyncQueueItem,
  ListMemoriesQuery,
  MigrateMarkdownRequest,
  StoreParams,
  StoreResult,
  SearchParams,
  UpdateParams,
  ListParams,
  TierCapabilities,
} from "./core/types.js";

export { TIER_CAPABILITIES } from "./core/types.js";

// Server (for embedding as middleware)
export { createApp } from "./api/router.js";
export { createServer } from "./server.js";
