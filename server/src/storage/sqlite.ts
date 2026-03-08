import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  Memory,
  MemoryScope,
  MemorySource,
  ExtractedEntity,
  ConversationLogEntry,
  SyncQueueItem,
  ListMemoriesQuery,
} from "../core/types.js";

// ── SQLite Row Types ────────────────────────────────────────────────────

interface MemoryRow {
  id: string;
  agent_id: string;
  scope: string;
  subject_id: string | null;
  content: string;
  tags: string;
  entities: string;
  source: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  embedding_hash: string | null;
}

interface SyncQueueRow {
  id: number;
  memory_id: string;
  layer: string;
  operation: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

// ── Database Adapter ────────────────────────────────────────────────────
// Abstracts over bun:sqlite (Bun) and better-sqlite3 (Node)

interface DbAdapter {
  exec(sql: string): void;
  prepare(sql: string): StmtAdapter;
  close(): void;
}

interface StmtAdapter {
  run(params?: Record<string, unknown>): { changes: number };
  get(params?: Record<string, unknown>): unknown;
  all(params?: Record<string, unknown>): unknown[];
}

function createDatabase(dbPath: string): DbAdapter {
  // Bun: use bun:sqlite
  const bun = (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
  if (typeof bun !== "undefined") {
    // In Bun, require() is available globally
    const req = createRequire(import.meta.url);
    const { Database } = req("bun:sqlite") as {
      Database: new (path: string, opts?: { create?: boolean }) => {
        exec(sql: string): void;
        prepare(sql: string): {
          run(params?: Record<string, unknown>): { changes: number };
          get(params?: Record<string, unknown>): unknown;
          all(params?: Record<string, unknown>): unknown[];
        };
        close(): void;
      };
    };
    const db = new Database(dbPath, { create: true });
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        return {
          run: (params?: Record<string, unknown>) => stmt.run(params || {}),
          get: (params?: Record<string, unknown>) => stmt.get(params || {}),
          all: (params?: Record<string, unknown>) => stmt.all(params || {}),
        };
      },
      close: () => db.close(),
    };
  }

  // Node: use better-sqlite3
  try {
    // Use createRequire for CommonJS optional dependency in ESM context
    const req = createRequire(import.meta.url);
    const Database = req("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(dbPath);
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        return {
          run: (params?: Record<string, unknown>) => {
            const result = stmt.run(params || {});
            return { changes: result.changes };
          },
          get: (params?: Record<string, unknown>) => stmt.get(params || {}),
          all: (params?: Record<string, unknown>) => stmt.all(params || {}),
        };
      },
      close: () => db.close(),
    };
  } catch {
    throw new Error(
      "No SQLite driver available. Install better-sqlite3 for Node.js, or use Bun runtime."
    );
  }
}

// ── SQLite Storage Layer ────────────────────────────────────────────────

export class SqliteStorage {
  private db: DbAdapter;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = createDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initSchema();
  }

  // ── Schema ──────────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id             TEXT PRIMARY KEY,
        agent_id       TEXT NOT NULL,
        scope          TEXT NOT NULL CHECK (scope IN ('user', 'agent', 'global', 'project', 'session')),
        subject_id     TEXT,
        content        TEXT NOT NULL,
        tags           TEXT NOT NULL DEFAULT '[]',
        entities       TEXT NOT NULL DEFAULT '[]',
        source         TEXT NOT NULL DEFAULT 'explicit',
        created_by     TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        expires_at     TEXT,
        embedding_hash TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_mem_agent       ON memories(agent_id);
      CREATE INDEX IF NOT EXISTS idx_mem_scope        ON memories(scope);
      CREATE INDEX IF NOT EXISTS idx_mem_subject      ON memories(subject_id);
      CREATE INDEX IF NOT EXISTS idx_mem_agent_scope  ON memories(agent_id, scope);
      CREATE INDEX IF NOT EXISTS idx_mem_created      ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_mem_source       ON memories(source);
    `);

    // FTS5 virtual table for full-text search
    const ftsExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get();

    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content,
          tags,
          content=memories,
          content_rowid=rowid
        );

        CREATE TRIGGER mem_fts_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, tags)
          VALUES (new.rowid, new.content, new.tags);
        END;

        CREATE TRIGGER mem_fts_delete AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags)
          VALUES ('delete', old.rowid, old.content, old.tags);
        END;

        CREATE TRIGGER mem_fts_update AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags)
          VALUES ('delete', old.rowid, old.content, old.tags);
          INSERT INTO memories_fts(rowid, content, tags)
          VALUES (new.rowid, new.content, new.tags);
        END;
      `);
    }

    // Conversation log table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        channel    TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        timestamp  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_convlog_agent   ON conversation_log(agent_id);
      CREATE INDEX IF NOT EXISTS idx_convlog_session  ON conversation_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_convlog_ts       ON conversation_log(timestamp);
    `);

    // Sync queue table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_queue (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id  TEXT NOT NULL,
        layer      TEXT NOT NULL CHECK (layer IN ('qdrant', 'age')),
        operation  TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
        attempts   INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(memory_id, layer, operation)
      );
    `);
  }

  // ── Memory CRUD ─────────────────────────────────────────────────────

  createMemory(memory: Memory): Memory {
    this.db.prepare(`
      INSERT INTO memories (id, agent_id, scope, subject_id, content, tags, entities, source, created_by, created_at, updated_at, expires_at, embedding_hash)
      VALUES (:id, :agent_id, :scope, :subject_id, :content, :tags, :entities, :source, :created_by, :created_at, :updated_at, :expires_at, :embedding_hash)
    `).run({
      id: memory.id,
      agent_id: memory.agent_id,
      scope: memory.scope,
      subject_id: memory.subject_id,
      content: memory.content,
      tags: JSON.stringify(memory.tags),
      entities: JSON.stringify(memory.entities),
      source: memory.source,
      created_by: memory.created_by,
      created_at: memory.created_at,
      updated_at: memory.updated_at,
      expires_at: memory.expires_at,
      embedding_hash: memory.embedding_hash,
    });
    return memory;
  }

  getMemory(id: string): Memory | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = :id")
      .get({ id: id }) as MemoryRow | null;
    if (!row) return null;
    return this.rowToMemory(row);
  }

  updateMemory(id: string, updates: Partial<Memory>): Memory | null {
    const existing = this.getMemory(id);
    if (!existing) return null;

    const updated: Memory = {
      ...existing,
      ...updates,
      id: existing.id,
      updated_at: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE memories SET
        content = :content, tags = :tags, entities = :entities, scope = :scope, subject_id = :subject_id,
        expires_at = :expires_at, embedding_hash = :embedding_hash, updated_at = :updated_at
      WHERE id = :id
    `).run({
      content: updated.content,
      tags: JSON.stringify(updated.tags),
      entities: JSON.stringify(updated.entities),
      scope: updated.scope,
      subject_id: updated.subject_id,
      expires_at: updated.expires_at,
      embedding_hash: updated.embedding_hash,
      updated_at: updated.updated_at,
      id: id,
    });
    return updated;
  }

  deleteMemory(id: string): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE id = :id").run({ id: id });
    return result.changes > 0;
  }

  listMemories(query: ListMemoriesQuery): Memory[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.agent_id) {
      conditions.push("agent_id = :agent_id");
      params.agent_id = query.agent_id;
    }
    if (query.scope) {
      conditions.push("scope = :scope");
      params.scope = query.scope;
    }
    if (query.subject_id) {
      conditions.push("subject_id = :subject_id");
      params.subject_id = query.subject_id;
    }
    if (query.source) {
      conditions.push("source = :source");
      params.source = query.source;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = query.order === "asc" ? "ASC" : "DESC";
    const limit = query.limit || 50;
    const offset = query.offset || 0;

    params.limit = limit;
    params.offset = offset;

    const sql = `SELECT * FROM memories ${where} ORDER BY created_at ${order} LIMIT :limit OFFSET :offset`;
    const rows = this.db.prepare(sql).all(params) as MemoryRow[];

    if (query.tags) {
      const tagList = query.tags.split(",").map((t) => t.trim().toLowerCase());
      return rows
        .map((r) => this.rowToMemory(r))
        .filter((m) => {
          const memTags = m.tags.map((t) => t.toLowerCase());
          return tagList.some((t) => memTags.includes(t));
        });
    }

    return rows.map((r) => this.rowToMemory(r));
  }

  // ── Full-Text Search ────────────────────────────────────────────────

  searchFullText(
    query: string,
    agentId?: string,
    scopes?: MemoryScope[],
    subjectId?: string | null,
    limit: number = 10
  ): Array<Memory & { fts_rank: number }> {
    const ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term.replace(/"/g, "")}"`)
      .join(" OR ");

    if (!ftsQuery) return [];

    const conditions: string[] = [];
    const params: Record<string, unknown> = { fts: ftsQuery, limit: limit };

    if (agentId) {
      conditions.push("m.agent_id = :agent_id");
      params.agent_id = agentId;
    }
    if (scopes && scopes.length > 0) {
      const scopePlaceholders = scopes.map((_, i) => `:scope_${i}`);
      conditions.push(`m.scope IN (${scopePlaceholders.join(",")})`);
      scopes.forEach((s, i) => { params[`scope_${i}`] = s; });
    }
    if (subjectId !== undefined && subjectId !== null) {
      conditions.push("m.subject_id = :subject_id");
      params.subject_id = subjectId;
    }

    const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT m.*, rank
      FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH :fts
      ${where}
      ORDER BY rank
      LIMIT :limit
    `;

    const rows = this.db.prepare(sql).all(params) as (MemoryRow & { rank: number })[];
    return rows.map((r) => ({
      ...this.rowToMemory(r),
      fts_rank: r.rank,
    }));
  }

  // ── Conversation Log ────────────────────────────────────────────────

  appendConversationLog(entry: ConversationLogEntry): void {
    this.db.prepare(
      `INSERT INTO conversation_log (agent_id, session_id, user_id, channel, role, content, timestamp)
       VALUES (:agent_id, :session_id, :user_id, :channel, :role, :content, :timestamp)`
    ).run({
      agent_id: entry.agent_id,
      session_id: entry.session_id,
      user_id: entry.user_id,
      channel: entry.channel,
      role: entry.role,
      content: entry.content,
      timestamp: entry.timestamp,
    });
  }

  getConversationLog(
    agentId: string,
    sessionId: string,
    limit: number = 100
  ): ConversationLogEntry[] {
    return this.db.prepare(
      `SELECT agent_id, session_id, user_id, channel, role, content, timestamp
       FROM conversation_log
       WHERE agent_id = :agent_id AND session_id = :session_id
       ORDER BY timestamp ASC
       LIMIT :limit`
    ).all({ agent_id: agentId, session_id: sessionId, limit: limit }) as ConversationLogEntry[];
  }

  // ── Sync Queue ──────────────────────────────────────────────────────

  addToSyncQueue(memoryId: string, layer: "qdrant" | "age", operation: "upsert" | "delete"): void {
    this.db.prepare(
      `INSERT INTO sync_queue (memory_id, layer, operation, created_at)
       VALUES (:memory_id, :layer, :operation, :created_at)
       ON CONFLICT(memory_id, layer, operation) DO UPDATE SET
         attempts = 0,
         last_error = NULL,
         created_at = excluded.created_at`
    ).run({
      memory_id: memoryId,
      layer: layer,
      operation: operation,
      created_at: new Date().toISOString(),
    });
  }

  getSyncQueue(limit: number = 50): SyncQueueItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM sync_queue
       WHERE attempts < 5
       ORDER BY created_at ASC
       LIMIT :limit`
    ).all({ limit: limit }) as SyncQueueRow[];
    return rows.map((r) => ({
      id: r.id,
      memory_id: r.memory_id,
      layer: r.layer as "qdrant" | "age",
      operation: r.operation as "upsert" | "delete",
      attempts: r.attempts,
      last_error: r.last_error,
      created_at: r.created_at,
    }));
  }

  updateSyncQueueItem(id: number, attempts: number, lastError: string | null): void {
    this.db.prepare("UPDATE sync_queue SET attempts = :attempts, last_error = :last_error WHERE id = :id")
      .run({ attempts: attempts, last_error: lastError, id: id });
  }

  removeSyncQueueItem(id: number): void {
    this.db.prepare("DELETE FROM sync_queue WHERE id = :id").run({ id: id });
  }

  clearCompletedSyncItems(): number {
    const result = this.db.prepare("DELETE FROM sync_queue WHERE attempts >= 5").run();
    return result.changes;
  }

  // ── Stats ───────────────────────────────────────────────────────────

  getMemoryCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number };
    return row.count;
  }

  getDatabaseSize(): number {
    try {
      const row = this.db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number };
      return row.size;
    } catch {
      return 0;
    }
  }

  // ── Health Check ────────────────────────────────────────────────────

  healthCheck(): boolean {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private rowToMemory(row: MemoryRow): Memory {
    return {
      id: row.id,
      agent_id: row.agent_id,
      scope: row.scope as MemoryScope,
      subject_id: row.subject_id,
      content: row.content,
      tags: JSON.parse(row.tags || "[]"),
      entities: JSON.parse(row.entities || "[]"),
      source: row.source as MemorySource,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at,
      embedding_hash: row.embedding_hash,
    };
  }

  close(): void {
    this.db.close();
  }
}
