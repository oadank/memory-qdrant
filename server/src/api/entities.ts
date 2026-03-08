import { Elysia, t } from "elysia";
import type { StorageOrchestrator } from "../storage/orchestrator.js";

// ── Entity Routes ───────────────────────────────────────────────────────

export function entityRoutes(orchestrator: StorageOrchestrator) {
  return new Elysia({ prefix: "/api/entities" })
    // GET /api/entities/:type — List entities by type
    .get("/:type", async ({ params, query, set }) => {
      if (!orchestrator.age) {
        set.status = 501;
        return { error: "Graph layer not available — requires Full tier" };
      }

      try {
        const entities = await orchestrator.age.listEntities(
          params.type,
          query.agent_id as string | undefined,
          query.limit ? parseInt(String(query.limit), 10) : 50
        );
        return { entities, count: entities.length };
      } catch (error) {
        set.status = 500;
        return {
          error: "Failed to list entities",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    })

    // GET /api/entities/:type/:id — Get entity with relationships
    .get("/:type/:id", async ({ params, set }) => {
      if (!orchestrator.age) {
        set.status = 501;
        return { error: "Graph layer not available — requires Full tier" };
      }

      try {
        const result = await orchestrator.age.getEntityWithRelationships(
          params.type,
          params.id
        );
        if (!result.entity) {
          set.status = 404;
          return { error: "Entity not found" };
        }
        return result;
      } catch (error) {
        set.status = 500;
        return {
          error: "Failed to get entity",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    })

    // GET /api/entities/:type/:id/related — Get related entities
    .get("/:type/:id/related", async ({ params, query, set }) => {
      if (!orchestrator.age) {
        set.status = 501;
        return { error: "Graph layer not available — requires Full tier" };
      }

      try {
        const depth = query.depth ? parseInt(String(query.depth), 10) : 2;
        const related = await orchestrator.age.getRelatedEntities(
          params.id,
          depth
        );
        return { related, count: related.length };
      } catch (error) {
        set.status = 500;
        return {
          error: "Failed to get related entities",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    })

    // POST /api/entities/extract — Manually trigger entity extraction
    .post(
      "/extract",
      async ({ body, set }) => {
        if (!orchestrator.entityExtractor) {
          set.status = 501;
          return { error: "Entity extraction not available — requires extraction config" };
        }

        try {
          const result = await orchestrator.entityExtractor.extract(body.text);
          return result;
        } catch (error) {
          set.status = 500;
          return {
            error: "Entity extraction failed",
            details: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        body: t.Object({
          text: t.String(),
        }),
      }
    );
}
