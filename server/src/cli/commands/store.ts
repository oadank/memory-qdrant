import { Command } from "commander";
import { output, readStdin, apiPost, isServerRunning, getBaseUrl } from "../utils.js";
import { loadConfig } from "../../config/index.js";

export function storeCommand(): Command {
  return new Command("store")
    .description("Store a new memory")
    .argument("[content]", "Memory content (or pipe via stdin)")
    .requiredOption("--agent <id>", "Agent ID")
    .requiredOption("--scope <scope>", "Memory scope (user, agent, global, project, session)")
    .option("--subject <id>", "Subject ID")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--source <source>", "Memory source", "explicit")
    .option("--no-extract", "Skip entity extraction")
    .option("--format <fmt>", "Output format (json, text)", "json")
    .option("--config <path>", "Path to config file")
    .action(async (contentArg, opts) => {
      const content = contentArg || await readStdin();
      if (!content) {
        console.error("Error: content is required (pass as argument or pipe via stdin)");
        process.exit(1);
      }

      const config = await loadConfig(opts.config);
      const baseUrl = getBaseUrl(config.port);
      const serverUp = await isServerRunning(baseUrl);

      const body = {
        agent_id: opts.agent,
        scope: opts.scope,
        subject_id: opts.subject || null,
        content,
        tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [],
        source: opts.source,
        extract_entities: opts.extract !== false,
      };

      if (serverUp) {
        // Use HTTP API
        const result = await apiPost(baseUrl, "/api/memories", body, config.auth.token);
        output(result, opts.format);
      } else {
        // Direct mode — instantiate MemoryService in-process
        const { MemoryService } = await import("../../core/memory-service.js");
        const service = new MemoryService();
        await service.init();

        try {
          const result = await service.store({
            agentId: opts.agent,
            scope: opts.scope,
            subjectId: opts.subject || null,
            content,
            tags: body.tags,
            source: opts.source,
            extractEntities: opts.extract !== false,
          });
          output(result, opts.format);
        } finally {
          await service.close();
        }
      }
    });
}
