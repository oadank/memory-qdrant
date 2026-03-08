import { Elysia, t } from "elysia";
import type { StorageOrchestrator } from "../storage/orchestrator.js";
import type { ResolvedConfig } from "../config/index.js";
import { ConversationSummarizer } from "../extraction/summarizer.js";
import type { ConversationLogEntry, CreateMemoryRequest, SummarizeResponse } from "../core/types.js";

// ── Conversation Routes ─────────────────────────────────────────────────

export function conversationRoutes(
  orchestrator: StorageOrchestrator,
  config: ResolvedConfig
) {
  // Summarizer is only available if extraction config is present
  const summarizer = config.extraction
    ? new ConversationSummarizer({
        apiKey: config.extraction.apiKey,
        baseUrl: config.extraction.baseUrl,
        model: config.extraction.model,
      })
    : null;

  return new Elysia({ prefix: "/api/conversations" })
    // POST /api/conversations/log — Append conversation entry
    .post(
      "/log",
      ({ body, set }) => {
        try {
          orchestrator.sqlite.appendConversationLog(body as ConversationLogEntry);
          set.status = 201;
          return { ok: true };
        } catch (error) {
          set.status = 500;
          return {
            error: "Failed to append conversation log",
            details: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        body: t.Object({
          agent_id: t.String(),
          session_id: t.String(),
          user_id: t.String(),
          channel: t.String(),
          role: t.Union([
            t.Literal("user"),
            t.Literal("assistant"),
            t.Literal("system"),
          ]),
          content: t.String(),
          timestamp: t.String(),
        }),
      }
    )

    // POST /api/conversations/summarize — Summarize a session
    .post(
      "/summarize",
      async ({ body, set }) => {
        if (!summarizer) {
          set.status = 501;
          return { error: "Summarization not available — extraction config required" };
        }

        try {
          const { agent_id, session_id, user_id, channel, messages } = body;

          const summary = await summarizer.summarize(messages);
          if (!summary) {
            set.status = 422;
            return { error: "Failed to generate summary" };
          }

          const memoryReq: CreateMemoryRequest = {
            agent_id,
            scope: "session",
            subject_id: user_id,
            content: summary,
            tags: ["conversation_summary", channel, `session:${session_id}`],
            source: "conversation_summary",
            created_by: agent_id,
            extract_entities: true,
          };

          const result = await orchestrator.createMemory(memoryReq);

          const response: SummarizeResponse = {
            memory_id: result.id,
            summary,
            entities_extracted: result.entities,
            relationships_created: 0,
          };

          set.status = 201;
          return response;
        } catch (error) {
          set.status = 500;
          return {
            error: "Summarization failed",
            details: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        body: t.Object({
          agent_id: t.String(),
          session_id: t.String(),
          user_id: t.String(),
          channel: t.String(),
          messages: t.Array(
            t.Object({
              role: t.Union([
                t.Literal("user"),
                t.Literal("assistant"),
                t.Literal("system"),
              ]),
              content: t.String(),
              timestamp: t.String(),
            })
          ),
          reason: t.Optional(t.String()),
        }),
      }
    );
}
