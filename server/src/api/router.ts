import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import type { ResolvedConfig } from "../config/index.js";
import type { StorageOrchestrator } from "../storage/orchestrator.js";
import { AuthError, MemoryError, NotFoundError, ValidationError } from "../core/errors.js";
import { memoriesRoutes } from "./memories.js";
import type { ResolvedConfig } from "../config/index.js";
import { searchRoutes } from "./search.js";
import { conversationRoutes } from "./conversations.js";
import { entityRoutes } from "./entities.js";
import { adminRoutes } from "./admin.js";

// ── App Router ──────────────────────────────────────────────────────────

export function createApp(orchestrator: StorageOrchestrator, config: ResolvedConfig) {
  const app = new Elysia()
    .use(cors())
    // 移除全局认证中间件，改为在每个路由里手动检查

    // ── Error Handler ─────────────────────────────────────────────────
    .onError(({ code, error, set }) => {
      // Handle AuthError
      if (error instanceof AuthError) {
        const status = error.message.includes("Invalid token") ? 403 : 401;
        set.status = status;
        return { error: error.message, code: error.code };
      }

      // Handle other custom errors
      if (error instanceof NotFoundError) {
        set.status = 404;
        return { error: error.message, code: error.code };
      }

      if (error instanceof ValidationError) {
        set.status = 400;
        return { error: error.message, code: error.code, details: error.details };
      }

      if (error instanceof MemoryError) {
        set.status = 500;
        return { error: error.message, code: error.code };
      }

      // Elysia validation errors
      if (code === "VALIDATION") {
        const msg = error && "message" in error ? (error as Error).message : String(error);
        set.status = 400;
        return { error: "Validation error", details: msg };
      }

      // Elysia built-in not found errors
      if (code === "NOT_FOUND") {
        const msg =
          error && "message" in error ? (error as Error).message : "Route not found";
        set.status = 404;
        return { error: msg, code };
      }

      // Unknown errors
      const msg = error instanceof Error ? error.stack || error.message : String(error);
      console.error(`[api] Unhandled error: ${msg}`);
      set.status = 500;
      return { error: "Internal server error" };
    })

    // ── Mount Routes ──────────────────────────────────────────────────
    .use(memoriesRoutes(orchestrator))
    .use(searchRoutes(orchestrator))
    .use(conversationRoutes(orchestrator, config))
    .use(entityRoutes(orchestrator))
    .use(adminRoutes(orchestrator));

  return app;
}
