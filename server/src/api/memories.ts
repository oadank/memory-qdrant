import { Elysia, t } from "elysia";
import type { StorageOrchestrator } from "../storage/orchestrator.js";
import type { CreateMemoryRequest, UpdateMemoryRequest, MemoryScope, MemorySource } from "../core/types.js";

// ── Memory CRUD Routes ──────────────────────────────────────────────────

export function memoriesRoutes(orchestrator: StorageOrchestrator) {
  const AUTH_TOKEN = process.env.MEMORY_AUTH_TOKEN || 'clawx-memory-token';
  
  // 全局变量缓存 body
  let cachedBody: string | null = null;
  
  return new Elysia({ prefix: "/api/memories" })
    // 使用 onRequest 在路由处理前读取原始 body
    .onRequest(async ({ request }) => {
      if (request.method === 'POST') {
        cachedBody = await request.text();
        console.log(`[onRequest] Cached body: ${cachedBody?.substring(0, 100)}`);
      }
    })
    // Test route
    .get("/test", () => {
      return { status: "ok", timestamp: new Date().toISOString() };
    })
    // POST /api/memories — Create a new memory
    .post("/", async ({ set, headers }) => {
      // 手动检查认证
      const authHeader = headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      if (authHeader.slice(7) !== AUTH_TOKEN) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      
      try {
        const rawBody = cachedBody;
        cachedBody = null; // 清除缓存
        console.log(`[API] Using cached body: ${rawBody?.substring(0, 100)}`);
        if (!rawBody) {
          set.status = 400;
          return { error: "Empty body" };
        }
        const body = JSON.parse(rawBody);
        const result = await orchestrator.createMemory(body as any);
        set.status = 201;
        return result;
      } catch (error) {
        set.status = 500;
        return {
          error: "Failed to create memory",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    })

    // GET /api/memories/:id — Get a memory by ID
    .get("/:id", ({ params, set }) => {
      const memory = orchestrator.sqlite.getMemory(params.id);
      if (!memory) {
        set.status = 404;
        return { error: "Memory not found" };
      }
      return memory;
    })

    // PUT /api/memories/:id — Update a memory
    .put(
      "/:id",
      async ({ params, body, set }) => {
        try {
          const result = await orchestrator.updateMemory(
            params.id,
            body as UpdateMemoryRequest
          );
          if (!result) {
            set.status = 404;
            return { error: "Memory not found" };
          }
          return result;
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to update memory",
            details: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        body: t.Object({
          content: t.Optional(t.String()),
          tags: t.Optional(t.Array(t.String())),
          scope: t.Optional(
            t.Union([
              t.Literal("user"),
              t.Literal("agent"),
              t.Literal("global"),
              t.Literal("project"),
              t.Literal("session"),
            ])
          ),
          subject_id: t.Optional(t.Nullable(t.String())),
          expires_at: t.Optional(t.Nullable(t.String())),
          extract_entities: t.Optional(t.Boolean()),
        }),
      }
    )

    // DELETE /api/memories/:id — Delete a memory
    .delete("/:id", async ({ params, set }) => {
      try {
        const deleted = await orchestrator.deleteMemory(params.id);
        if (!deleted) {
          set.status = 404;
          return { error: "Memory not found" };
        }
        return { deleted: true, id: params.id };
      } catch (error) {
        set.status = 500;
        return {
          error: "Failed to delete memory",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    })

    // GET /api/memories — List memories with filters
    .get("/", ({ query }) => {
      const memories = orchestrator.sqlite.listMemories({
        agent_id: query.agent_id as string | undefined,
        scope: query.scope as MemoryScope | undefined,
        subject_id: query.subject_id as string | undefined,
        source: query.source as MemorySource | undefined,
        tags: query.tags as string | undefined,
        limit: query.limit ? parseInt(String(query.limit), 10) : undefined,
        offset: query.offset ? parseInt(String(query.offset), 10) : undefined,
        order: (query.order as "asc" | "desc") || "desc",
      });
      return { memories, count: memories.length };
    });
}
