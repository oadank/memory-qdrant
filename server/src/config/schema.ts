import type { Tier } from "../core/types.js";

// ── Config Schema Types ─────────────────────────────────────────────────

export interface SqliteConfig {
  path: string;
}

export interface QdrantConfig {
  url: string;
  collection: string;
  apiKey?: string;
}

export interface AgeConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  graph: string;
}

export interface EmbeddingConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  dimensions: number;
}

export interface ExtractionConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  enabled: boolean;
}

export interface AuthConfig {
  token?: string;
  enabled: boolean;
}

export interface AgentConfig {
  id: string;
  name: string;
  role?: string;
  crossAgentRead?: boolean;
}

export interface Config {
  tier?: Tier;
  port?: number;
  host?: string;
  auth?: Partial<AuthConfig>;
  sqlite?: Partial<SqliteConfig>;
  qdrant?: Partial<QdrantConfig> & { url: string };
  age?: Partial<AgeConfig> & { host: string; user: string; password: string; database: string };
  embedding?: Partial<EmbeddingConfig> & { apiKey: string };
  extraction?: Partial<ExtractionConfig> & { apiKey: string };
  agents?: AgentConfig[];
}

// ── Resolved Config (all fields present) ────────────────────────────────

export interface ResolvedConfig {
  tier: Tier;
  port: number;
  host: string;
  auth: AuthConfig;
  sqlite: SqliteConfig;
  qdrant: QdrantConfig | null;
  age: AgeConfig | null;
  embedding: EmbeddingConfig | null;
  extraction: ExtractionConfig | null;
  agents: AgentConfig[];
}
