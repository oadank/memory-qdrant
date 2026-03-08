import { loadConfig, type Config, type ResolvedConfig } from "../config/index.js";
import { StorageOrchestrator } from "../storage/orchestrator.js";
import { SearchEngine } from "../search/engine.js";
import type {
  Tier,
  Memory,
  StoreParams,
  StoreResult,
  SearchParams,
  UpdateParams,
  ListParams,
  SearchResponse,
  HealthResponse,
  ConversationLogEntry,
  SummarizeResponse,
  CreateMemoryRequest,
} from "./types.js";
import { ConversationSummarizer } from "../extraction/summarizer.js";

// ── MemoryService — Programmatic API ────────────────────────────────────

export class MemoryService {
  private orchestrator!: StorageOrchestrator;
  private searchEngine!: SearchEngine;
  private summarizer: ConversationSummarizer | null = null;
  private config!: ResolvedConfig;
  private initialized = false;

  private pendingConfig: Config | string | undefined;

  constructor(config?: Config | string) {
    this.pendingConfig = config;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // Resolve config
    if (typeof this.pendingConfig === "string") {
      this.config = await loadConfig(this.pendingConfig);
    } else if (this.pendingConfig) {
      this.config = await loadConfig();
      // Override with passed config (simplified — in production you'd deep merge)
      if (this.pendingConfig.tier) this.config.tier = this.pendingConfig.tier;
      if (this.pendingConfig.port) this.config.port = this.pendingConfig.port;
    } else {
      this.config = await loadConfig();
    }

    // Initialize orchestrator
    this.orchestrator = new StorageOrchestrator(this.config);
    await this.orchestrator.init();

    // Initialize search engine
    this.searchEngine = new SearchEngine(this.orchestrator);

    // Initialize summarizer if extraction config available
    if (this.config.extraction) {
      this.summarizer = new ConversationSummarizer({
        apiKey: this.config.extraction.apiKey,
        baseUrl: this.config.extraction.baseUrl,
        model: this.config.extraction.model,
      });
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    if (!this.initialized) return;
    await this.orchestrator.close();
    this.initialized = false;
  }

  // ── Memory CRUD ─────────────────────────────────────────────────────

  async store(params: StoreParams): Promise<StoreResult> {
    this.ensureInit();
    const result = await this.orchestrator.createMemory({
      agent_id: params.agentId,
      scope: params.scope,
      subject_id: params.subjectId ?? null,
      content: params.content,
      tags: params.tags,
      source: params.source,
      created_by: params.createdBy ?? null,
      extract_entities: params.extractEntities,
      expires_at: params.expiresAt ?? null,
    });

    return {
      id: result.id,
      agentId: result.agent_id,
      scope: result.scope,
      content: result.content,
      entities: result.entities,
      createdAt: result.created_at,
      syncStatus: result.sync_status,
    };
  }

  async get(id: string): Promise<Memory | null> {
    this.ensureInit();
    return this.orchestrator.sqlite.getMemory(id);
  }

  async update(id: string, params: UpdateParams): Promise<Memory | null> {
    this.ensureInit();
    const result = await this.orchestrator.updateMemory(id, {
      content: params.content,
      tags: params.tags,
      scope: params.scope,
      subject_id: params.subjectId,
      expires_at: params.expiresAt,
      extract_entities: params.extractEntities,
    });
    if (!result) return null;
    return this.orchestrator.sqlite.getMemory(id);
  }

  async delete(id: string): Promise<boolean> {
    this.ensureInit();
    return this.orchestrator.deleteMemory(id);
  }

  async list(params?: ListParams): Promise<Memory[]> {
    this.ensureInit();
    return this.orchestrator.sqlite.listMemories({
      agent_id: params?.agentId,
      scope: params?.scope,
      subject_id: params?.subjectId,
      source: params?.source,
      tags: params?.tags,
      limit: params?.limit,
      offset: params?.offset,
      order: params?.order,
    });
  }

  // ── Search ──────────────────────────────────────────────────────────

  async search(params: SearchParams): Promise<SearchResponse> {
    this.ensureInit();
    return this.searchEngine.search({
      agent_id: params.agentId,
      query: params.query,
      scopes: params.scopes,
      subject_id: params.subjectId,
      limit: params.limit,
      include_graph: params.includeGraph,
      cross_agent: params.crossAgent,
      strategy: params.strategy,
    });
  }

  async searchSemantic(params: SearchParams): Promise<SearchResponse> {
    return this.search({ ...params, strategy: "semantic" });
  }

  async searchFulltext(params: SearchParams): Promise<SearchResponse> {
    return this.search({ ...params, strategy: "fulltext" });
  }

  async searchGraph(params: SearchParams): Promise<SearchResponse> {
    return this.search({ ...params, strategy: "graph" });
  }

  // ── Conversations ───────────────────────────────────────────────────

  async logConversation(entry: ConversationLogEntry): Promise<void> {
    this.ensureInit();
    this.orchestrator.sqlite.appendConversationLog(entry);
  }

  async summarizeConversation(params: {
    agentId: string;
    sessionId: string;
    userId: string;
    channel: string;
    messages: Array<{ role: "user" | "assistant" | "system"; content: string; timestamp: string }>;
  }): Promise<SummarizeResponse | null> {
    this.ensureInit();

    if (!this.summarizer) return null;

    const summary = await this.summarizer.summarize(params.messages);
    if (!summary) return null;

    const result = await this.orchestrator.createMemory({
      agent_id: params.agentId,
      scope: "session",
      subject_id: params.userId,
      content: summary,
      tags: ["conversation_summary", params.channel, `session:${params.sessionId}`],
      source: "conversation_summary",
      created_by: params.agentId,
      extract_entities: true,
    });

    return {
      memory_id: result.id,
      summary,
      entities_extracted: result.entities,
      relationships_created: 0,
    };
  }

  // ── Entities ────────────────────────────────────────────────────────

  async getEntity(type: string, id: string): Promise<Record<string, unknown> | null> {
    this.ensureInit();
    if (!this.orchestrator.age) return null;
    const result = await this.orchestrator.age.getEntityWithRelationships(type, id);
    return result.entity;
  }

  async listEntities(type?: string): Promise<Array<Record<string, unknown>>> {
    this.ensureInit();
    if (!this.orchestrator.age) return [];
    return this.orchestrator.age.listEntities(type);
  }

  async getRelatedEntities(entityId: string, depth?: number): Promise<Array<Record<string, unknown>>> {
    this.ensureInit();
    if (!this.orchestrator.age) return [];
    const results = await this.orchestrator.age.getRelatedEntities(entityId, depth);
    return results.map((r) => r.entity);
  }

  // ── Admin ───────────────────────────────────────────────────────────

  async health(): Promise<HealthResponse> {
    this.ensureInit();
    return this.orchestrator.healthCheck();
  }

  async retrySyncQueue(): Promise<{ processed: number; succeeded: number; failed: number }> {
    this.ensureInit();
    return this.orchestrator.retrySyncQueue();
  }

  async migrateMarkdown(paths: string[], agentId: string): Promise<{
    migrated: number;
    errors: string[];
  }> {
    this.ensureInit();
    // Use the admin migration logic through the orchestrator directly
    const fs = await import("node:fs");
    const pathLib = await import("node:path");
    let migrated = 0;
    const errors: string[] = [];

    for (const filePath of paths) {
      try {
        if (!fs.existsSync(filePath)) {
          errors.push(`File not found: ${filePath}`);
          continue;
        }
        const content = fs.readFileSync(filePath, "utf-8");
        const req: CreateMemoryRequest = {
          agent_id: agentId,
          scope: "global",
          content: content.trim(),
          source: "migration",
          created_by: "migration",
          extract_entities: true,
        };
        await this.orchestrator.createMemory(req);
        migrated++;
      } catch (error) {
        errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { migrated, errors };
  }

  // ── Config ──────────────────────────────────────────────────────────

  get tier(): Tier {
    return this.config.tier;
  }

  get resolvedConfig(): ResolvedConfig {
    return this.config;
  }

  // ── Internal: expose orchestrator for server mode ───────────────────

  getOrchestrator(): StorageOrchestrator {
    this.ensureInit();
    return this.orchestrator;
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error("MemoryService not initialized. Call .init() first.");
    }
  }
}
