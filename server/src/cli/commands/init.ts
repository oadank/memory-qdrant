import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { header, success, info, warn, error as logError } from "../utils.js";
import { getDataDir, getDefaultSqlitePath } from "../../config/index.js";

export function initCommand(): Command {
  return new Command("init")
    .description("Interactive setup wizard")
    .option("--tier <tier>", "Tier: lite, standard, or full")
    .option("--non-interactive", "Skip prompts, use defaults + flags")
    .action(async (opts) => {
      header("Setup Wizard");

      // For non-interactive mode, generate config from flags/defaults
      const tier = opts.tier || "lite";
      const dataDir = getDataDir();
      const sqlitePath = getDefaultSqlitePath();

      // Ensure data directory exists
      fs.mkdirSync(dataDir, { recursive: true });
      info(`Data directory: ${dataDir}`);

      // Auto-detect available services
      let qdrantAvailable = false;
      let ageAvailable = false;

      if (tier !== "lite") {
        info("Checking Qdrant connectivity...");
        try {
          const res = await fetch("http://localhost:6333/collections", {
            signal: AbortSignal.timeout(2000),
          });
          qdrantAvailable = res.ok;
        } catch { /* not available */ }

        if (qdrantAvailable) {
          success("Qdrant is reachable at http://localhost:6333");
        } else {
          warn("Qdrant not reachable at http://localhost:6333");
        }
      }

      if (tier === "full") {
        info("Checking PostgreSQL/AGE connectivity...");
        try {
          // Simple TCP check
          const net = await import("node:net");
          ageAvailable = await new Promise<boolean>((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(2000);
            socket.connect(5432, "localhost", () => {
              socket.destroy();
              resolve(true);
            });
            socket.on("error", () => resolve(false));
            socket.on("timeout", () => { socket.destroy(); resolve(false); });
          });
        } catch { /* not available */ }

        if (ageAvailable) {
          success("PostgreSQL is reachable at localhost:5432");
        } else {
          warn("PostgreSQL not reachable at localhost:5432");
        }
      }

      // Determine effective tier
      let effectiveTier = tier;
      if (tier === "full" && !ageAvailable) {
        effectiveTier = qdrantAvailable ? "standard" : "lite";
        warn(`Downgrading to ${effectiveTier} tier (missing dependencies)`);
      } else if (tier === "standard" && !qdrantAvailable) {
        effectiveTier = "lite";
        warn("Downgrading to lite tier (Qdrant not available)");
      }

      // Generate config file
      const configContent = generateConfig(effectiveTier, sqlitePath);
      const configPath = path.join(process.cwd(), "openclaw-memory.config.ts");

      fs.writeFileSync(configPath, configContent, "utf-8");
      success(`Config written to ${configPath}`);

      // Generate .env.example
      const envExample = generateEnvExample(effectiveTier);
      const envPath = path.join(process.cwd(), ".env.example");
      fs.writeFileSync(envPath, envExample, "utf-8");
      success(`Environment template written to ${envPath}`);

      console.log();
      info("Next steps:");
      console.log("  openclaw-memory start     # Start the server");
      console.log("  openclaw-memory status    # Check all layers");
      console.log();
    });
}

function generateConfig(tier: string, sqlitePath: string): string {
  const lines = [
    `import { defineConfig } from '@poprobertdaniel/openclaw-memory';`,
    ``,
    `export default defineConfig({`,
    `  tier: '${tier}',`,
    `  port: 7777,`,
    `  auth: {`,
    `    token: process.env.MEMORY_AUTH_TOKEN || 'change-me',`,
    `  },`,
    `  sqlite: {`,
    `    path: '${sqlitePath}',`,
    `  },`,
  ];

  if (tier === "standard" || tier === "full") {
    lines.push(`  qdrant: {`);
    lines.push(`    url: process.env.QDRANT_URL || 'http://localhost:6333',`);
    lines.push(`    collection: 'openclaw_memories',`);
    lines.push(`  },`);
    lines.push(`  embedding: {`);
    lines.push(`    apiKey: process.env.OPENAI_API_KEY || '',`);
    lines.push(`    model: 'text-embedding-3-small',`);
    lines.push(`    dimensions: 1536,`);
    lines.push(`  },`);
    lines.push(`  extraction: {`);
    lines.push(`    apiKey: process.env.OPENAI_API_KEY || '',`);
    lines.push(`    model: 'gpt-5-nano',`);
    lines.push(`    enabled: true,`);
    lines.push(`  },`);
  }

  if (tier === "full") {
    lines.push(`  age: {`);
    lines.push(`    host: process.env.PGHOST || 'localhost',`);
    lines.push(`    port: parseInt(process.env.PGPORT || '5432', 10),`);
    lines.push(`    user: process.env.PGUSER || 'openclaw',`);
    lines.push(`    password: process.env.PGPASSWORD || '',`);
    lines.push(`    database: process.env.PGDATABASE || 'agent_memory',`);
    lines.push(`    graph: 'agent_memory',`);
    lines.push(`  },`);
  }

  lines.push(`});`);
  lines.push(``);

  return lines.join("\n");
}

function generateEnvExample(tier: string): string {
  const lines = [
    `# openclaw-memory environment variables`,
    ``,
    `# Server`,
    `# OPENCLAW_MEMORY_PORT=7777`,
    `# OPENCLAW_MEMORY_HOST=0.0.0.0`,
    ``,
    `# Authentication`,
    `MEMORY_AUTH_TOKEN=change-me-to-a-secure-token`,
    ``,
    `# SQLite (always required)`,
    `# SQLITE_PATH=~/.openclaw-memory/memory.sqlite`,
    ``,
  ];

  if (tier === "standard" || tier === "full") {
    lines.push(`# Qdrant (Standard/Full tier)`);
    lines.push(`QDRANT_URL=http://localhost:6333`);
    lines.push(``);
    lines.push(`# Embedding provider`);
    lines.push(`OPENAI_API_KEY=sk-your-key-here`);
    lines.push(`# EMBEDDING_MODEL=text-embedding-3-small`);
    lines.push(`# EMBEDDING_BASE_URL=https://api.openai.com/v1`);
    lines.push(``);
    lines.push(`# Entity extraction`);
    lines.push(`# EXTRACTION_MODEL=gpt-5-nano`);
    lines.push(``);
  }

  if (tier === "full") {
    lines.push(`# PostgreSQL + Apache AGE (Full tier)`);
    lines.push(`PGHOST=localhost`);
    lines.push(`PGPORT=5432`);
    lines.push(`PGUSER=openclaw`);
    lines.push(`PGPASSWORD=your-password`);
    lines.push(`PGDATABASE=agent_memory`);
    lines.push(`# AGE_GRAPH=agent_memory`);
    lines.push(``);
  }

  return lines.join("\n");
}
