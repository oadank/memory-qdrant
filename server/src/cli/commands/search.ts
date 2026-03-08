import { Command } from "commander";
import { output, apiPost, isServerRunning, getBaseUrl } from "../utils.js";
import { loadConfig } from "../../config/index.js";

export function searchCommand(): Command {
  const cmd = new Command("search")
    .description("Search memories");

  // Default search (smart auto-select)
  cmd
    .argument("<query>", "Search query")
    .requiredOption("--agent <id>", "Agent ID")
    .option("--limit <n>", "Max results", "10")
    .option("--strategy <s>", "Search strategy (auto, semantic, fulltext, graph, all)", "auto")
    .option("--scopes <scopes>", "Comma-separated scopes")
    .option("--subject <id>", "Subject ID filter")
    .option("--cross-agent", "Search across all agents")
    .option("--no-graph", "Exclude graph results")
    .option("--recall", "Format output for LLM context injection")
    .option("--format <fmt>", "Output format (json, text)", "json")
    .option("--config <path>", "Path to config file")
    .action(async (query, opts) => {
      const config = await loadConfig(opts.config);
      const baseUrl = getBaseUrl(config.port);
      const serverUp = await isServerRunning(baseUrl);

      const body = {
        agent_id: opts.agent,
        query,
        limit: parseInt(opts.limit, 10),
        strategy: opts.strategy,
        scopes: opts.scopes ? opts.scopes.split(",") : undefined,
        subject_id: opts.subject || null,
        cross_agent: opts.crossAgent || false,
        include_graph: opts.graph !== false,
      };

      let result: unknown;
      if (serverUp) {
        result = await apiPost(baseUrl, "/api/search", body, config.auth.token);
      } else {
        const { MemoryService } = await import("../../core/memory-service.js");
        const service = new MemoryService();
        await service.init();
        try {
          result = await service.search({
            agentId: opts.agent,
            query,
            limit: parseInt(opts.limit, 10),
            strategy: opts.strategy,
            scopes: opts.scopes ? opts.scopes.split(",") : undefined,
            subjectId: opts.subject || null,
            crossAgent: opts.crossAgent || false,
            includeGraph: opts.graph !== false,
          });
        } finally {
          await service.close();
        }
      }

      // Recall mode — format for LLM
      if (opts.recall) {
        const data = result as { results?: Array<{ memory: { content: string; scope: string; created_at: string } }> };
        if (data.results && data.results.length > 0) {
          console.log("## Relevant Memories");
          for (const r of data.results) {
            const date = new Date(r.memory.created_at).toLocaleDateString();
            console.log(`- ${r.memory.content} (${r.memory.scope}, ${date})`);
          }
        } else {
          console.log("No relevant memories found.");
        }
      } else {
        output(result, opts.format);
      }
    });

  return cmd;
}
