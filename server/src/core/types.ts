// ── Core Types ──────────────────────────────────────────────────────────

export type MemoryScope = "user" | "agent" | "global" | "project" | "session";
export type MemorySource = "explicit" | "derived" | "observation" | "conversation_summary" | "entity_extraction" | "daily_digest" | "migration";
export type EntityType = "Person" | "Project" | "Organization" | "Decision" | "Preference" | "Event" | "Tool" | "Location" | "Concept";
export type RelationshipType =
  | "WORKS_ON"
  | "DECIDED"
  | "PREFERS"
  | "KNOWS"
  | "USES"
  | "LOCATED_AT"
  | "BELONGS_TO"
  | "MENTIONED_IN"
  | "RELATED_TO"
  | "CREATED_BY"
  | "DEPENDS_ON";

export type Tier = "lite" | "standard" | "full";

// ── Data Models ─────────────────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  properties: Record<string, string>;
}

export interface ExtractedRelationship {
  from_entity: string;
  to_entity: string;
  relationship: RelationshipType;
  properties: Record<string, string>;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

export interface Memory {
  id: string;
  agent_id: string;
  scope: MemoryScope;
  subject_id: string | null;
  content: string;
  tags: string[];
  entities: ExtractedEntity[];
  source: MemorySource;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  embedding_hash: string | null;
}

// ── API Request/Response Types (snake_case for HTTP API) ────────────────

export interface CreateMemoryRequest {
  agent_id: string;
  scope: MemoryScope;
  subject_id?: string | null;
  content: string;
  tags?: string[];
  source?: MemorySource;
  created_by?: string | null;
  extract_entities?: boolean;
  expires_at?: string | null;
}

export interface UpdateMemoryRequest {
  content?: string;
  tags?: string[];
  scope?: MemoryScope;
  subject_id?: string | null;
  expires_at?: string | null;
  extract_entities?: boolean;
}

export interface SearchRequest {
  agent_id: string;
  query: string;
  scopes?: MemoryScope[];
  subject_id?: string | null;
  limit?: number;
  include_graph?: boolean;
  cross_agent?: boolean;
  strategy?: "auto" | "semantic" | "fulltext" | "graph" | "all";
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
  source_layer: "sqlite" | "qdrant" | "age";
  graph_context?: {
    related_entities: Array<{
      type: EntityType;
      name: string;
      relationship: string;
    }>;
  };
}

export interface SearchResponse {
  results: ScoredMemory[];
  strategy_used: string;
  layer_stats: {
    sqlite: { count: number; ms: number };
    qdrant: { count: number; ms: number };
    age: { count: number; ms: number };
  };
}

export interface SyncStatus {
  sqlite: "ok";
  qdrant: "ok" | "queued" | "failed" | "disabled";
  age: "ok" | "queued" | "failed" | "disabled";
}

export interface CreateMemoryResponse {
  id: string;
  agent_id: string;
  scope: MemoryScope;
  content: string;
  tags?: string[];
  entities: ExtractedEntity[];
  created_at: string;
  updated_at?: string;
  sync_status: SyncStatus;
}

export interface ConversationLogEntry {
  agent_id: string;
  session_id: string;
  user_id: string;
  channel: string;
  role: string;
  content: string;
  timestamp: string;
}

export interface SummarizeRequest {
  agent_id: string;
  session_id: string;
  user_id: string;
  channel: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: string;
  }>;
  reason?: string;
}

export interface SummarizeResponse {
  memory_id: string;
  summary: string;
  entities_extracted: ExtractedEntity[];
  relationships_created: number;
}

export interface HealthResponse {
  sqlite: "ok" | "error" | "disabled";
  qdrant: "ok" | "error" | "disabled";
  age: "ok" | "error" | "disabled";
  tier: Tier;
  uptime: number;
  details?: Record<string, string>;
}

export interface SyncQueueItem {
  id: number;
  memory_id: string;
  layer: "qdrant" | "age";
  operation: "upsert" | "delete";
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export interface ListMemoriesQuery {
  agent_id?: string;
  scope?: MemoryScope;
  subject_id?: string;
  source?: MemorySource;
  tags?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

export interface MigrateMarkdownRequest {
  markdown_paths: string[];
  agent_id: string;
  dry_run?: boolean;
}

// ── Programmatic API Types (camelCase) ──────────────────────────────────

export interface StoreParams {
  agentId: string;
  scope: MemoryScope;
  subjectId?: string | null;
  content: string;
  tags?: string[];
  source?: MemorySource;
  createdBy?: string | null;
  extractEntities?: boolean;
  expiresAt?: string | null;
}

export interface StoreResult {
  id: string;
  agentId: string;
  scope: MemoryScope;
  content: string;
  entities: ExtractedEntity[];
  createdAt: string;
  syncStatus: {
    sqlite: "ok";
    qdrant: "ok" | "queued" | "failed" | "disabled";
    age: "ok" | "queued" | "failed" | "disabled";
  };
}

export interface SearchParams {
  agentId: string;
  query: string;
  scopes?: MemoryScope[];
  subjectId?: string | null;
  limit?: number;
  includeGraph?: boolean;
  crossAgent?: boolean;
  strategy?: "auto" | "semantic" | "fulltext" | "graph" | "all";
}

export interface UpdateParams {
  content?: string;
  tags?: string[];
  scope?: MemoryScope;
  subjectId?: string | null;
  expiresAt?: string | null;
  extractEntities?: boolean;
}

export interface ListParams {
  agentId?: string;
  scope?: MemoryScope;
  subjectId?: string;
  source?: MemorySource;
  tags?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

// ── Tier Capabilities ───────────────────────────────────────────────────

export interface TierCapabilities {
  sqlite: true;
  qdrant: boolean;
  age: boolean;
  embeddings: boolean;
  extraction: boolean;
}

export const TIER_CAPABILITIES: Record<Tier, TierCapabilities> = {
  lite: {
    sqlite: true,
    qdrant: false,
    age: false,
    embeddings: false,
    extraction: false,
  },
  standard: {
    sqlite: true,
    qdrant: true,
    age: false,
    embeddings: true,
    extraction: true,
  },
  full: {
    sqlite: true,
    qdrant: true,
    age: true,
    embeddings: true,
    extraction: true,
  },
};
