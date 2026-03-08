// ── Default Configuration Values ────────────────────────────────────────

export const DEFAULTS = {
  port: 7777,
  host: "0.0.0.0",
  sqlite: {
    path: "~/.openclaw-memory/memory.sqlite",
  },
  qdrant: {
    collection: "openclaw_memories",
  },
  age: {
    port: 5432,
    graph: "agent_memory",
  },
  embedding: {
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  extraction: {
    model: "gpt-5-nano",
    enabled: true,
  },
  auth: {
    enabled: true,
  },
} as const;
