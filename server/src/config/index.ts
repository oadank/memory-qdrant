import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { Tier } from "../core/types.js";
import { ConfigError } from "../core/errors.js";
import { DEFAULTS } from "./defaults.js";
import type { Config, ResolvedConfig, QdrantConfig, AgeConfig, EmbeddingConfig, ExtractionConfig } from "./schema.js";

export type { Config, ResolvedConfig } from "./schema.js";

// ── Helper: expand ~ to home dir ────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// ── Data Directory ──────────────────────────────────────────────────────

export function getDataDir(): string {
  return process.env.OPENCLAW_MEMORY_DATA_DIR || path.join(os.homedir(), ".openclaw-memory");
}

export function getDefaultSqlitePath(): string {
  return path.join(getDataDir(), "memory.sqlite");
}

export function getPidFilePath(): string {
  return path.join(getDataDir(), "server.pid");
}

// ── Config File Discovery ───────────────────────────────────────────────

function getConfigSearchPaths(cwd: string): string[] {
  return [
    path.join(cwd, "openclaw-memory.config.ts"),
    path.join(cwd, "openclaw-memory.config.js"),
    path.join(cwd, "openclaw-memory.config.json"),
    path.join(getDataDir(), "config.ts"),
    path.join(getDataDir(), "config.json"),
  ];
}

async function loadConfigFile(configPath?: string): Promise<Config | null> {
  const searchPaths = configPath ? [configPath] : getConfigSearchPaths(process.cwd());

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      if (p.endsWith(".json")) {
        const content = fs.readFileSync(p, "utf-8");
        return JSON.parse(content) as Config;
      }
      // For .ts and .js files, try dynamic import
      try {
        const mod = await import(p);
        return (mod.default || mod) as Config;
      } catch {
        // Can't import .ts outside of Bun — skip
      }
    }
  }

  return null;
}

// ── Environment Variable Loading ────────────────────────────────────────

function loadFromEnv(): Partial<Config> {
  const config: Partial<Config> = {};

  // Load .env file if dotenv is available
  try {
    const dotenvPath = path.join(process.cwd(), ".env");
    if (fs.existsSync(dotenvPath)) {
      const envContent = fs.readFileSync(dotenvPath, "utf-8");
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    // No .env file — that's fine
  }

  const env = process.env;

  // Tier
  const tier = env.OPENCLAW_MEMORY_TIER || env.MEMORY_TIER;
  if (tier && ["lite", "standard", "full"].includes(tier)) {
    config.tier = tier as Tier;
  }

  // Port/Host
  const port = env.OPENCLAW_MEMORY_PORT || env.PORT;
  if (port) config.port = parseInt(port, 10);

  const host = env.OPENCLAW_MEMORY_HOST;
  if (host) config.host = host;

  // Auth
  const authToken = env.OPENCLAW_MEMORY_AUTH__TOKEN || env.AUTH_TOKEN || env.MEMORY_TOKEN;
  if (authToken) {
    config.auth = { token: authToken, enabled: true };
  }

  // SQLite
  const sqlitePath = env.OPENCLAW_MEMORY_SQLITE__PATH || env.SQLITE_PATH;
  if (sqlitePath) {
    config.sqlite = { path: sqlitePath };
  }

  // Qdrant
  const qdrantUrl = env.OPENCLAW_MEMORY_QDRANT__URL || env.QDRANT_URL;
  if (qdrantUrl) {
    config.qdrant = {
      url: qdrantUrl,
      collection: env.OPENCLAW_MEMORY_QDRANT__COLLECTION || env.QDRANT_COLLECTION || DEFAULTS.qdrant.collection,
      apiKey: env.OPENCLAW_MEMORY_QDRANT__API_KEY,
    };
  }

  // AGE
  const ageHost = env.OPENCLAW_MEMORY_AGE__HOST || env.PGHOST;
  if (ageHost) {
    config.age = {
      host: ageHost,
      port: parseInt(env.OPENCLAW_MEMORY_AGE__PORT || env.PGPORT || String(DEFAULTS.age.port), 10),
      user: env.OPENCLAW_MEMORY_AGE__USER || env.PGUSER || "",
      password: env.OPENCLAW_MEMORY_AGE__PASSWORD || env.PGPASSWORD || "",
      database: env.OPENCLAW_MEMORY_AGE__DATABASE || env.PGDATABASE || "",
      graph: env.OPENCLAW_MEMORY_AGE__GRAPH || env.AGE_GRAPH || DEFAULTS.age.graph,
    };
  }

  // Embedding
  const embeddingEnabled = env.EMBEDDING_ENABLED === "true" || env.OPENCLAW_MEMORY_EMBEDDING__ENABLED === "true";
  const embeddingProvider = env.EMBEDDING_PROVIDER || "openai";
  const embeddingApiKey = env.OPENCLAW_MEMORY_EMBEDDING__API_KEY || env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || (embeddingProvider === "ollama" ? "ollama" : undefined);
  
  if (embeddingEnabled || embeddingApiKey) {
    config.embedding = {
      apiKey: embeddingApiKey || "dummy",
      baseUrl: env.OPENCLAW_MEMORY_EMBEDDING__BASE_URL || env.EMBEDDING_BASE_URL || (embeddingProvider === "ollama" ? "http://localhost:11434/api/embeddings" : undefined),
      model: env.OPENCLAW_MEMORY_EMBEDDING__MODEL || env.EMBEDDING_MODEL || DEFAULTS.embedding.model,
      dimensions: parseInt(env.OPENCLAW_MEMORY_EMBEDDING__DIMENSIONS || env.EMBEDDING_DIMENSIONS || String(DEFAULTS.embedding.dimensions), 10),
    };
  }

  // Extraction
  const extractionApiKey = env.OPENCLAW_MEMORY_EXTRACTION__API_KEY || env.OPENROUTER_API_KEY || env.OPENAI_API_KEY;
  if (extractionApiKey) {
    config.extraction = {
      apiKey: extractionApiKey,
      baseUrl: env.OPENCLAW_MEMORY_EXTRACTION__BASE_URL || env.EXTRACTION_BASE_URL,
      model: env.OPENCLAW_MEMORY_EXTRACTION__MODEL || env.EXTRACTION_MODEL || DEFAULTS.extraction.model,
      enabled: env.OPENCLAW_MEMORY_EXTRACTION__ENABLED !== "false",
    };
  }

  return config;
}

// ── Tier Inference ──────────────────────────────────────────────────────

function inferTier(config: Partial<Config>): Tier {
  if (config.tier) return config.tier;
  if (config.qdrant && config.age) return "full";
  if (config.qdrant) return "standard";
  return "lite";
}

// ── Config Resolution ───────────────────────────────────────────────────

export async function loadConfig(configPath?: string): Promise<ResolvedConfig> {
  // 1. Load from file
  const fileConfig = await loadConfigFile(configPath);

  // 2. Load from env
  const envConfig = loadFromEnv();

  // 3. Merge: file < env (env wins)
  const merged: Partial<Config> = {
    ...fileConfig,
    ...envConfig,
    // Deep merge nested objects
    auth: { ...fileConfig?.auth, ...envConfig.auth },
    sqlite: { ...fileConfig?.sqlite, ...envConfig.sqlite },
  };

  if (envConfig.qdrant || fileConfig?.qdrant) {
    merged.qdrant = { ...fileConfig?.qdrant, ...envConfig.qdrant } as Config["qdrant"];
  }
  if (envConfig.age || fileConfig?.age) {
    merged.age = { ...fileConfig?.age, ...envConfig.age } as Config["age"];
  }
  if (envConfig.embedding || fileConfig?.embedding) {
    merged.embedding = { ...fileConfig?.embedding, ...envConfig.embedding } as Config["embedding"];
  }
  if (envConfig.extraction || fileConfig?.extraction) {
    merged.extraction = { ...fileConfig?.extraction, ...envConfig.extraction } as Config["extraction"];
  }

  // 4. Infer tier
  const tier = inferTier(merged);

  // 5. Resolve defaults
  const sqlitePath = expandHome(merged.sqlite?.path || DEFAULTS.sqlite.path);

  // 6. Resolve optional layers based on tier
  let qdrant: QdrantConfig | null = null;
  if (tier !== "lite" && merged.qdrant?.url) {
    qdrant = {
      url: merged.qdrant.url,
      collection: merged.qdrant.collection || DEFAULTS.qdrant.collection,
      apiKey: merged.qdrant.apiKey,
    };
  }

  let age: AgeConfig | null = null;
  if (tier === "full" && merged.age?.host) {
    if (!merged.age.user || !merged.age.password || !merged.age.database) {
      throw new ConfigError("Full tier requires age.user, age.password, and age.database");
    }
    age = {
      host: merged.age.host,
      port: merged.age.port || DEFAULTS.age.port,
      user: merged.age.user,
      password: merged.age.password,
      database: merged.age.database,
      graph: merged.age.graph || DEFAULTS.age.graph,
    };
  }

  let embedding: EmbeddingConfig | null = null;
  if (tier !== "lite" && merged.embedding?.apiKey) {
    embedding = {
      apiKey: merged.embedding.apiKey,
      baseUrl: merged.embedding.baseUrl,
      model: merged.embedding.model || DEFAULTS.embedding.model,
      dimensions: merged.embedding.dimensions || DEFAULTS.embedding.dimensions,
    };
  }

  let extraction: ExtractionConfig | null = null;
  if (tier !== "lite" && merged.extraction?.apiKey) {
    extraction = {
      apiKey: merged.extraction.apiKey,
      baseUrl: merged.extraction.baseUrl,
      model: merged.extraction.model || DEFAULTS.extraction.model,
      enabled: merged.extraction.enabled ?? DEFAULTS.extraction.enabled,
    };
  }

  return {
    tier,
    port: merged.port || DEFAULTS.port,
    host: merged.host || DEFAULTS.host,
    auth: {
      token: merged.auth?.token,
      enabled: merged.auth?.enabled ?? DEFAULTS.auth.enabled,
    },
    sqlite: { path: sqlitePath },
    qdrant,
    age,
    embedding,
    extraction,
    agents: merged.agents || fileConfig?.agents || [],
  };
}

// ── defineConfig helper for config files ────────────────────────────────

export function defineConfig(config: Config): Config {
  return config;
}

// ── Config summary (redacted) for logging ───────────────────────────────

export function configSummary(config: ResolvedConfig): string {
  const lines: string[] = [
    `Tier: ${config.tier}`,
    `Port: ${config.port}`,
    `Host: ${config.host}`,
    `SQLite: ${config.sqlite.path}`,
    `Auth: ${config.auth.enabled ? "enabled" : "disabled"}`,
  ];

  if (config.qdrant) {
    lines.push(`Qdrant: ${config.qdrant.url} (collection: ${config.qdrant.collection})`);
  }
  if (config.age) {
    lines.push(`AGE: ${config.age.host}:${config.age.port}/${config.age.database}`);
  }
  if (config.embedding) {
    lines.push(`Embedding: ${config.embedding.model}${config.embedding.baseUrl ? ` via ${config.embedding.baseUrl}` : ""}`);
  }
  if (config.extraction) {
    lines.push(`Extraction: ${config.extraction.model}${config.extraction.enabled ? "" : " (disabled)"}`);
  }

  return lines.join("\n");
}
