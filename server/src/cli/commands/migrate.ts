import { Command } from "commander";
import { output, apiPost, isServerRunning, getBaseUrl, success, info, header } from "../utils.js";
import { loadConfig } from "../../config/index.js";

export function migrateCommand(): Command {
  return new Command("migrate")
    .description("Import memories from markdown files")
    .requiredOption("--paths <paths>", "Comma-separated file paths")
    .requiredOption("--agent <id>", "Agent ID")
    .option("--dry-run", "Preview without writing")
    .option("--format <fmt>", "Output format (json, text)", "json")
    .option("--config <path>", "Path to config file")
    .action(async (opts) => {
      const config = await loadConfig(opts.config);
      const baseUrl = getBaseUrl(config.port);
      const serverUp = await isServerRunning(baseUrl);

      const paths = opts.paths.split(",").map((p: string) => p.trim());

      if (opts.dryRun) {
        header("Migration (dry run)");
      }

      const body = {
        markdown_paths: paths,
        agent_id: opts.agent,
        dry_run: opts.dryRun || false,
      };

      let result: unknown;
      if (serverUp) {
        result = await apiPost(baseUrl, "/api/admin/migrate-markdown", body, config.auth.token);
      } else {
        // Direct mode
        const { MemoryService } = await import("../../core/memory-service.js");
        const service = new MemoryService();
        await service.init();
        try {
          const migrated = await service.migrateMarkdown(paths, opts.agent);
          result = migrated;
        } finally {
          await service.close();
        }
      }

      if (opts.format === "text") {
        const data = result as { migrated?: number; skipped?: number; errors?: string[] };
        if (data.migrated !== undefined) {
          success(`Migrated ${data.migrated} memories`);
        }
        if (data.skipped) {
          info(`Skipped ${data.skipped} sections`);
        }
        if (data.errors && data.errors.length > 0) {
          for (const err of data.errors) {
            console.error(`  ✗ ${err}`);
          }
        }
      } else {
        output(result, opts.format);
      }
    });
}
