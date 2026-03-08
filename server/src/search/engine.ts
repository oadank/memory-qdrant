import type { ScoredMemory, SearchResponse, SearchRequest, MemoryScope } from "../core/types.js";
import type { StorageOrchestrator } from "../storage/orchestrator.js";
import { selectStrategy, type Strategy } from "./strategy.js";
import { normalizeFtsScore, applyBoosts } from "./ranker.js";

// ── Search Engine ───────────────────────────────────────────────────────

export class SearchEngine {
  private static readonly LAYER_TIMEOUT_MS = 5_000;
  private orchestrator: StorageOrchestrator;

  constructor(orchestrator: StorageOrchestrator) {
    this.orchestrator = orchestrator;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const strategy = selectStrategy(request);
    const limit = request.limit || 10;
    const scopes = request.scopes || ["user", "agent", "global"];
    const includeGraph = request.include_graph !== false;

    const layerStats = {
      sqlite: { count: 0, ms: 0 },
      qdrant: { count: 0, ms: 0 },
      age: { count: 0, ms: 0 },
    };

    const allResults: ScoredMemory[] = [];
    const searches: Promise<void>[] = [];

    if (shouldSearchFulltext(strategy)) {
      searches.push(
        this.collectLayerResults("sqlite", () => this.searchFulltext(request, scopes, limit), layerStats, allResults)
      );
    }

    if (shouldSearchSemantic(strategy) && this.orchestrator.qdrant && this.orchestrator.embeddings) {
      searches.push(
        this.collectLayerResults(
          "qdrant",
          () =>
            this.withLayerTimeout(
              "qdrant",
              () => this.searchSemantic(request, scopes, limit),
              SearchEngine.LAYER_TIMEOUT_MS
            ),
          layerStats,
          allResults
        )
      );
    }

    if (shouldSearchGraph(strategy) && includeGraph && this.orchestrator.age) {
      searches.push(
        this.collectLayerResults(
          "age",
          () =>
            this.withLayerTimeout(
              "age",
              () => this.searchGraph(request, limit),
              SearchEngine.LAYER_TIMEOUT_MS
            ),
          layerStats,
          allResults
        )
      );
    }

    await Promise.allSettled(searches);

    const merged = this.mergeResults(allResults, limit);

    return {
      results: merged,
      strategy_used: strategy,
      layer_stats: layerStats,
    };
  }

  // ── Layer-Specific Searches ─────────────────────────────────────────

  private async searchFulltext(
    request: SearchRequest,
    scopes: MemoryScope[],
    limit: number
  ): Promise<ScoredMemory[]> {
    try {
      const results = this.orchestrator.sqlite.searchFullText(
        request.query,
        request.cross_agent ? undefined : request.agent_id,
        scopes,
        request.subject_id,
        limit
      );

      return results.map((r) => ({
        memory: r,
        score: normalizeFtsScore(r.fts_rank),
        source_layer: "sqlite" as const,
      }));
    } catch (error) {
      console.warn(`[search] Fulltext search failed: ${error}`);
      return [];
    }
  }

  private async searchSemantic(
    request: SearchRequest,
    scopes: MemoryScope[],
    limit: number
  ): Promise<ScoredMemory[]> {
    try {
      if (!this.orchestrator.embeddings || !this.orchestrator.qdrant) return [];

      const queryVector = await this.orchestrator.embeddings.embed(request.query);
      if (!queryVector) return [];

      return await this.orchestrator.qdrant.search(
        queryVector,
        request.cross_agent ? undefined : request.agent_id,
        scopes,
        request.subject_id,
        limit,
        request.cross_agent
      );
    } catch (error) {
      console.warn(`[search] Semantic search failed: ${error}`);
      return [];
    }
  }

  private async searchGraph(
    request: SearchRequest,
    limit: number
  ): Promise<ScoredMemory[]> {
    try {
      if (!this.orchestrator.age) return [];

      const entityName = extractEntityFromQuery(request.query);
      if (!entityName) return [];

      return await this.orchestrator.age.searchByEntity(
        entityName,
        undefined,
        request.cross_agent ? undefined : request.agent_id,
        limit
      );
    } catch (error) {
      console.warn(`[search] Graph search failed: ${error}`);
      return [];
    }
  }

  private async collectLayerResults(
    layer: "sqlite" | "qdrant" | "age",
    fn: () => Promise<ScoredMemory[]>,
    layerStats: SearchResponse["layer_stats"],
    allResults: ScoredMemory[]
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const results = await fn();
      layerStats[layer].count = results.length;
      allResults.push(...results);
    } finally {
      layerStats[layer].ms = Date.now() - startedAt;
    }
  }

  private async withLayerTimeout(
    layer: "qdrant" | "age",
    fn: () => Promise<ScoredMemory[]>,
    timeoutMs: number
  ): Promise<ScoredMemory[]> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const layerPromise = fn().catch((error) => {
      console.warn(`[search] ${layer} search failed: ${error}`);
      return [];
    });

    const timeoutPromise = new Promise<ScoredMemory[]>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        console.warn(
          `[search] ${layer} search timed out after ${timeoutMs}ms, returning results from other layers`
        );
        resolve([]);
      }, timeoutMs);
    });

    try {
      const results = await Promise.race([layerPromise, timeoutPromise]);
      return results;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (timedOut) {
        // Keep the original promise observed so late rejections do not become unhandled.
        void layerPromise;
      }
    }
  }

  // ── Result Merging ──────────────────────────────────────────────────

  private mergeResults(
    allResults: ScoredMemory[],
    limit: number
  ): ScoredMemory[] {
    // 1. Group by memory ID
    const byId = new Map<string, ScoredMemory[]>();
    for (const result of allResults) {
      const existing = byId.get(result.memory.id) || [];
      existing.push(result);
      byId.set(result.memory.id, existing);
    }

    // 2. For each group, take best + apply boosts
    const merged: ScoredMemory[] = [];
    for (const [_id, results] of byId) {
      results.sort((a, b) => b.score - a.score);
      const best = results[0];

      const graphContext = results
        .filter((r) => r.graph_context)
        .flatMap((r) => r.graph_context!.related_entities);

      const boosted = applyBoosts(best, results.length);

      if (graphContext.length > 0) {
        boosted.graph_context = { related_entities: graphContext };
      }

      merged.push(boosted);
    }

    // 3. Sort by final score descending
    merged.sort((a, b) => b.score - a.score);

    return merged.slice(0, limit);
  }
}

// ── Helper Functions ────────────────────────────────────────────────────

function shouldSearchFulltext(strategy: Strategy): boolean {
  return ["fulltext", "fulltext+graph", "all"].includes(strategy);
}

function shouldSearchSemantic(strategy: Strategy): boolean {
  return ["semantic", "semantic+graph", "graph+semantic", "all"].includes(strategy);
}

function shouldSearchGraph(strategy: Strategy): boolean {
  return ["graph", "fulltext+graph", "graph+semantic", "semantic+graph", "all"].includes(strategy);
}

/**
 * Extract potential entity names from natural language queries.
 */
function extractEntityFromQuery(query: string): string | null {
  const quoted = query.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1];

  const aboutMatch = query.match(
    /(?:about|on|for|regarding|related to|connected to)\s+([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*)/i
  );
  if (aboutMatch) return aboutMatch[1];

  const capitalWords = query.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g);
  if (capitalWords && capitalWords.length > 0) {
    return capitalWords.sort((a, b) => b.length - a.length)[0];
  }

  const whoPattern = query.match(
    /who\s+(?:works on|knows|created|uses|manages)\s+(.+)/i
  );
  if (whoPattern) return whoPattern[1].trim();

  if (query.split(/\s+/).length <= 3) {
    return query.trim();
  }

  return null;
}
