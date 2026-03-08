import type {
  Memory,
  ExtractedEntity,
  ExtractedRelationship,
  EntityType,
  ScoredMemory,
} from "../core/types.js";

// ── AGE Storage Layer ───────────────────────────────────────────────────

// Dynamically imported — this is an optional peer dependency
type Pool = import("pg").Pool;
type PoolClient = import("pg").PoolClient;

export interface AgeStorageConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  graph: string;
}

// Max input length for user-supplied strings in Cypher queries
const MAX_CYPHER_INPUT_LENGTH = 1000;

export class AgeStorage {
  private pool: Pool | null = null;
  private config: AgeStorageConfig;
  private graph: string;
  private initialized = false;

  constructor(config: AgeStorageConfig) {
    this.config = config;
    this.graph = config.graph;
  }

  // ── Lazy Pool Init ──────────────────────────────────────────────────

  private async getPool(): Promise<Pool> {
    if (this.pool) return this.pool;

    try {
      const pg = await import("pg");
      const PoolClass = pg.default?.Pool || pg.Pool;
      this.pool = new PoolClass({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        max: 5,
        idleTimeoutMillis: 30000,
      });
      return this.pool;
    } catch {
      throw new Error(
        "pg client not available. Install pg: bun add pg"
      );
    }
  }

  // ── Graph Init ──────────────────────────────────────────────────────

  async ensureGraph(): Promise<void> {
    if (this.initialized) return;

    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("LOAD 'age';");
      await client.query('SET search_path = ag_catalog, "$user", public;');

      const exists = await client.query(
        "SELECT 1 FROM ag_catalog.ag_graph WHERE name = $1",
        [this.graph]
      );

      if (exists.rowCount === 0) {
        await client.query("SELECT ag_catalog.create_graph($1)", [this.graph]);
        console.log(`[age] Created graph: ${this.graph}`);
      }

      this.initialized = true;
    } catch (error) {
      console.error(`[age] Failed to ensure graph: ${error}`);
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Cypher Query Helper ─────────────────────────────────────────────

  private async cypherQuery<T>(
    query: string,
    resultColumns: string = "v agtype"
  ): Promise<T[]> {
    await this.ensureGraph();
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("LOAD 'age';");
      await client.query('SET search_path = ag_catalog, "$user", public;');

      const sql = `SELECT * FROM ag_catalog.cypher('${escGraphName(this.graph)}', $$${query}$$) as (${resultColumns})`;
      const result = await client.query(sql);

      return result.rows.map((row: Record<string, unknown>) => {
        const parsed: Record<string, unknown> = {};
        for (const key of Object.keys(row)) {
          parsed[key] = this.parseAgtype(row[key]);
        }
        if (Object.keys(parsed).length === 1 && "v" in parsed) {
          return parsed.v as T;
        }
        return parsed as T;
      });
    } finally {
      client.release();
    }
  }

  private async cypherExec(query: string): Promise<void> {
    await this.ensureGraph();
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("LOAD 'age';");
      await client.query('SET search_path = ag_catalog, "$user", public;');

      const sql = `SELECT * FROM ag_catalog.cypher('${escGraphName(this.graph)}', $$${query}$$) as (v agtype)`;
      await client.query(sql);
    } finally {
      client.release();
    }
  }

  // ── Memory Node Operations ──────────────────────────────────────────

  async upsertMemoryNode(memory: Memory): Promise<void> {
    const contentTruncated = memory.content.slice(0, 500);
    const now = new Date().toISOString();

    try {
      await this.cypherExec(
        `MERGE (m:Memory {id: '${esc(memory.id)}'})
         SET m.agent_id = '${esc(memory.agent_id)}',
             m.scope = '${esc(memory.scope)}',
             m.subject_id = '${esc(memory.subject_id || "")}',
             m.content = '${esc(contentTruncated)}',
             m.source = '${esc(memory.source)}',
             m.created_at = '${esc(memory.created_at)}',
             m.updated_at = '${esc(now)}'
         RETURN m`
      );
    } catch (error) {
      console.error(`[age] Failed to upsert memory node: ${error}`);
      throw error;
    }
  }

  // ── Entity Node Operations ──────────────────────────────────────────

  async upsertEntityNode(
    entity: ExtractedEntity,
    agentId: string
  ): Promise<string> {
    const entityId = slugify(`${entity.type}:${entity.name}`);
    const now = new Date().toISOString();
    const propsJson = JSON.stringify(entity.properties || {});

    try {
      await this.cypherExec(
        `MERGE (e:Entity {id: '${esc(entityId)}'})
         SET e.name = '${esc(entity.name)}',
             e.entity_type = '${esc(entity.type)}',
             e.agent_id = '${esc(agentId)}',
             e.properties = '${esc(propsJson)}',
             e.updated_at = '${esc(now)}'
         RETURN e`
      );
    } catch (error) {
      console.error(`[age] Failed to upsert entity node ${entityId}: ${error}`);
      throw error;
    }

    return entityId;
  }

  // ── Relationship Operations ─────────────────────────────────────────

  async createRelationship(
    rel: ExtractedRelationship,
    agentId: string
  ): Promise<void> {
    const fromId = slugify(`${this.guessEntityType(rel.from_entity)}:${rel.from_entity}`);
    const toId = slugify(`${this.guessEntityType(rel.to_entity)}:${rel.to_entity}`);
    const context = rel.properties?.context || "";

    // Validate relationship type is a valid identifier
    const relType = sanitizeLabel(rel.relationship);
    if (!relType) {
      console.warn(`[age] Invalid relationship type: ${rel.relationship}`);
      return;
    }

    try {
      await this.cypherExec(
        `MATCH (a:Entity {id: '${esc(fromId)}'}), (b:Entity {id: '${esc(toId)}'})
         MERGE (a)-[r:${relType}]->(b)
         SET r.context = '${esc(context)}',
             r.agent_id = '${esc(agentId)}'
         RETURN r`
      );
    } catch (error) {
      console.warn(`[age] Failed to create relationship ${fromId} -[${relType}]-> ${toId}: ${error}`);
    }
  }

  async linkMemoryToEntity(
    memoryId: string,
    entityId: string
  ): Promise<void> {
    try {
      await this.cypherExec(
        `MATCH (m:Memory {id: '${esc(memoryId)}'}), (e:Entity {id: '${esc(entityId)}'})
         MERGE (m)-[r:MENTIONS]->(e)
         RETURN r`
      );
    } catch (error) {
      console.warn(`[age] Failed to link memory ${memoryId} to entity ${entityId}: ${error}`);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────

  async deleteMemoryNode(memoryId: string): Promise<void> {
    try {
      try {
        await this.cypherExec(
          `MATCH (m:Memory {id: '${esc(memoryId)}'})-[r]-()
           DELETE r
           RETURN r`
        );
      } catch {
        // No edges to delete
      }

      await this.cypherExec(
        `MATCH (m:Memory {id: '${esc(memoryId)}'})
         DELETE m
         RETURN m`
      );
    } catch (error) {
      console.warn(`[age] Failed to delete memory node ${memoryId}: ${error}`);
      throw error;
    }
  }

  // ── Graph Queries ───────────────────────────────────────────────────

  async getEntityWithRelationships(
    entityType: string,
    entityId: string
  ): Promise<{
    entity: Record<string, unknown> | null;
    relationships: Array<{
      type: string;
      direction: string;
      target: Record<string, unknown>;
    }>;
  }> {
    try {
      const entities = await this.cypherQuery<Record<string, unknown>>(
        `MATCH (e:Entity {id: '${esc(entityId)}'})
         RETURN properties(e) as v`
      );

      if (entities.length === 0) {
        return { entity: null, relationships: [] };
      }

      const relationships: Array<{
        type: string;
        direction: string;
        target: Record<string, unknown>;
      }> = [];

      // Get outgoing relationships
      try {
        const outgoing = await this.cypherQuery<Record<string, unknown>>(
          `MATCH (e:Entity {id: '${esc(entityId)}'})-[r]->(target)
           RETURN type(r) as rel_type, properties(target) as target_props`,
          "rel_type agtype, target_props agtype"
        );

        for (const r of outgoing) {
          relationships.push({
            type: String(r.rel_type || ""),
            direction: "outgoing",
            target: (r.target_props as Record<string, unknown>) || {},
          });
        }
      } catch {
        // No outgoing relationships
      }

      // Get incoming relationships
      try {
        const incoming = await this.cypherQuery<Record<string, unknown>>(
          `MATCH (e:Entity {id: '${esc(entityId)}'})<-[r]-(source)
           RETURN type(r) as rel_type, properties(source) as source_props`,
          "rel_type agtype, source_props agtype"
        );

        for (const r of incoming) {
          relationships.push({
            type: String(r.rel_type || ""),
            direction: "incoming",
            target: (r.source_props as Record<string, unknown>) || {},
          });
        }
      } catch {
        // No incoming relationships
      }

      return { entity: entities[0], relationships };
    } catch (error) {
      console.error(`[age] Failed to get entity: ${error}`);
      return { entity: null, relationships: [] };
    }
  }

  async getRelatedEntities(
    entityId: string,
    depth: number = 2
  ): Promise<
    Array<{
      entity: Record<string, unknown>;
      relationship: string;
      distance: number;
    }>
  > {
    try {
      const maxDepth = Math.min(depth, 4);
      const results = await this.cypherQuery<Record<string, unknown>>(
        `MATCH (start:Entity {id: '${esc(entityId)}'})-[*1..${maxDepth}]-(target:Entity)
         WHERE target.id <> '${esc(entityId)}'
         RETURN DISTINCT properties(target) as target_props`,
        "target_props agtype"
      );

      return results.map((r) => ({
        entity: (r.target_props as Record<string, unknown>) || r,
        relationship: "RELATED_TO",
        distance: 1,
      }));
    } catch (error) {
      console.error(`[age] Failed to get related entities: ${error}`);
      return [];
    }
  }

  async searchByEntity(
    entityName: string,
    entityType?: string,
    agentId?: string,
    limit: number = 10
  ): Promise<ScoredMemory[]> {
    // Validate input length
    if (entityName.length > MAX_CYPHER_INPUT_LENGTH) {
      console.warn("[age] Entity name too long, truncating");
      entityName = entityName.slice(0, MAX_CYPHER_INPUT_LENGTH);
    }

    try {
      const entityId = slugify(`${entityType || "Concept"}:${entityName}`);
      const safeLimit = Math.min(Math.max(1, limit), 100);

      let results: Record<string, unknown>[] = [];
      try {
        results = await this.cypherQuery<Record<string, unknown>>(
          `MATCH (m:Memory)-[:MENTIONS]->(e:Entity {id: '${esc(entityId)}'})
           ${agentId ? `WHERE m.agent_id = '${esc(agentId)}'` : ""}
           RETURN properties(m) as mem_props
           ORDER BY m.created_at DESC
           LIMIT ${safeLimit}`,
          "mem_props agtype"
        );
      } catch {
        // Exact match failed
      }

      if (results.length === 0) {
        return await this.searchByEntityNameFuzzy(entityName, agentId, safeLimit);
      }

      return results.map((r, i) => this.graphResultToScoredMemory(r, entityName, entityType, i));
    } catch (error) {
      console.error(`[age] Graph search failed: ${error}`);
      return [];
    }
  }

  private async searchByEntityNameFuzzy(
    name: string,
    agentId?: string,
    limit: number = 10
  ): Promise<ScoredMemory[]> {
    // Validate input length
    if (name.length > MAX_CYPHER_INPUT_LENGTH) {
      console.warn("[age] Fuzzy search name too long, truncating");
      name = name.slice(0, MAX_CYPHER_INPUT_LENGTH);
    }

    try {
      // Escape regex metacharacters to prevent regex injection
      const escapedName = escRegex(esc(name));
      const safeLimit = Math.min(Math.max(1, limit), 100);

      const results = await this.cypherQuery<Record<string, unknown>>(
        `MATCH (m:Memory)-[:MENTIONS]->(e:Entity)
         WHERE e.name =~ '(?i).*${escapedName}.*'
         ${agentId ? `AND m.agent_id = '${esc(agentId)}'` : ""}
         RETURN properties(m) as mem_props, e.name as entity_name, e.entity_type as entity_type
         ORDER BY m.created_at DESC
         LIMIT ${safeLimit}`,
        "mem_props agtype, entity_name agtype, entity_type agtype"
      );

      return results.map((r, i) => {
        const props = (r.mem_props as Record<string, unknown>) || {};
        return {
          memory: this.propsToMemory(props),
          score: 0.8 / (1 + i * 0.1),
          source_layer: "age" as const,
          graph_context: {
            related_entities: [
              {
                type: (String(r.entity_type) || "Concept") as EntityType,
                name: String(r.entity_name || name),
                relationship: "MENTIONED_IN",
              },
            ],
          },
        };
      });
    } catch (error) {
      console.error(`[age] Fuzzy entity search failed: ${error}`);
      return [];
    }
  }

  async listEntities(
    entityType?: string,
    agentId?: string,
    limit: number = 50
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const conditions: string[] = [];
      if (entityType) conditions.push(`e.entity_type = '${esc(entityType)}'`);
      if (agentId) conditions.push(`e.agent_id = '${esc(agentId)}'`);

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const safeLimit = Math.min(Math.max(1, limit), 200);

      const results = await this.cypherQuery<Record<string, unknown>>(
        `MATCH (e:Entity)
         ${where}
         RETURN properties(e) as props
         ORDER BY e.updated_at DESC
         LIMIT ${safeLimit}`,
        "props agtype"
      );

      return results.map((r) => (r.props as Record<string, unknown>) || r);
    } catch (error) {
      console.error(`[age] Failed to list entities: ${error}`);
      return [];
    }
  }

  // ── Agent Node ──────────────────────────────────────────────────────

  async ensureAgentNode(
    agentId: string,
    name: string,
    role: string
  ): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.cypherExec(
        `MERGE (a:Agent {id: '${esc(agentId)}'})
         SET a.name = '${esc(name)}',
             a.role = '${esc(role)}',
             a.created_at = '${esc(now)}'
         RETURN a`
      );
    } catch (error) {
      console.warn(`[age] Failed to ensure agent node: ${error}`);
    }
  }

  // ── Stats ───────────────────────────────────────────────────────────

  async getStats(): Promise<{ entityCount: number; relationshipCount: number } | null> {
    try {
      const entities = await this.cypherQuery<Record<string, unknown>>(
        `MATCH (e:Entity) RETURN count(e) as cnt`,
        "cnt agtype"
      );
      const rels = await this.cypherQuery<Record<string, unknown>>(
        `MATCH ()-[r]->() RETURN count(r) as cnt`,
        "cnt agtype"
      );
      return {
        entityCount: Number(entities[0] || 0),
        relationshipCount: Number(rels[0] || 0),
      };
    } catch {
      return null;
    }
  }

  // ── Health Check ────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const pool = await this.getPool();
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        return true;
      } finally {
        client.release();
      }
    } catch {
      return false;
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private parseAgtype(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        const cleaned = value.replace(/::(?:vertex|edge|path|agtype)$/g, "").trim();
        try {
          return JSON.parse(cleaned);
        } catch {
          return cleaned;
        }
      }
    }
    return value;
  }

  private propsToMemory(props: Record<string, unknown>): Memory {
    return {
      id: String(props.id || ""),
      agent_id: String(props.agent_id || ""),
      scope: String(props.scope || "agent") as Memory["scope"],
      subject_id: (props.subject_id as string) || null,
      content: String(props.content || ""),
      tags: [],
      entities: [],
      source: String(props.source || "explicit") as Memory["source"],
      created_by: null,
      created_at: String(props.created_at || ""),
      updated_at: String(props.updated_at || ""),
      expires_at: null,
      embedding_hash: null,
    };
  }

  private graphResultToScoredMemory(
    r: Record<string, unknown>,
    entityName: string,
    entityType: string | undefined,
    index: number
  ): ScoredMemory {
    const props = (r.mem_props as Record<string, unknown>) || {};
    return {
      memory: this.propsToMemory(props),
      score: 1.0 / (1 + index * 0.1),
      source_layer: "age" as const,
      graph_context: {
        related_entities: [
          {
            type: (entityType || "Concept") as EntityType,
            name: entityName,
            relationship: "MENTIONED_IN",
          },
        ],
      },
    };
  }

  private guessEntityType(_name: string): string {
    return "Concept";
  }
}

// ── Utility Functions ───────────────────────────────────────────────────

/**
 * Escape a string for safe inclusion in a Cypher single-quoted string literal.
 * Also strips dollar signs to prevent $$ dollar-quote breakout in the
 * pg cypher() wrapper.
 *
 * NOTE: This is NOT a complete SQL injection defence on its own.
 * It is a best-effort sanitisation layer for AGE's $$-quoted Cypher
 * passthrough, where parameterised queries are not supported.
 */
function esc(value: string): string {
  if (!value) return "";
  // Enforce max length
  const truncated = value.slice(0, MAX_CYPHER_INPUT_LENGTH);
  return truncated
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\$/g, "")       // strip dollar signs — prevents $$ breakout
    .replace(/\0/g, "");      // strip null bytes
}

/**
 * Escape the graph name (alphanumeric + underscore only).
 */
function escGraphName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "");
}

/**
 * Escape regex metacharacters so user input can be safely embedded in
 * Cypher =~ regex patterns without causing injection or ReDoS.
 */
function escRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sanitize a Cypher label/relationship type.
 * Only alphanumeric and underscore are allowed.
 * Returns null if the result is empty.
 */
function sanitizeLabel(label: string): string | null {
  const sanitized = label.replace(/[^a-zA-Z0-9_]/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
}
