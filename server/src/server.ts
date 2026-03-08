import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { loadConfig, configSummary } from "./config/index.js";
import { StorageOrchestrator } from "./storage/orchestrator.js";
import { createApp } from "./api/router.js";

// ── Server Entry Point ──────────────────────────────────────────────────

export async function createServer(configPath?: string) {
  const config = await loadConfig(configPath);
  const orchestrator = new StorageOrchestrator(config);
  await orchestrator.init();

  const app = createApp(orchestrator, config);

  return { app, orchestrator, config };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log("┌──────────────────────────────────────────┐");
  console.log("│       openclaw-memory service v0.1.0      │");
  console.log("│       Triple-Layer Memory System          │");
  console.log("└──────────────────────────────────────────┘");

  const { app, orchestrator, config } = await createServer();

  console.log("[config]");
  console.log(configSummary(config).split("\n").map((l) => `  ${l}`).join("\n"));

  // Use native Node.js HTTP server for Elysia compatibility
  const httpServer = createHttpServer(async (req, res) => {
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
    });
    const response = await app.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) {
        res.write(chunk);
      }
    }
    res.end();
  });

  httpServer.listen(config.port, config.host);
  console.log(`[server] Listening on http://${config.host}:${config.port}`);
  console.log(`[server] Health check: http://localhost:${config.port}/api/health`);

  const shutdown = async () => {
    console.log("\n[server] Shutting down...");
    await orchestrator.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run if executed directly (works in both Bun and Node ESM)
function isMainModule(): boolean {
  try {
    // Bun runtime
    const bun = (globalThis as typeof globalThis & { Bun?: { main?: string } }).Bun;
    if (typeof bun !== "undefined") {
      return bun.main === fileURLToPath(import.meta.url);
    }
    // Node.js
    if (process.argv[1]) {
      return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
    }
    return false;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error("[fatal]", error);
    process.exit(1);
  });
}
