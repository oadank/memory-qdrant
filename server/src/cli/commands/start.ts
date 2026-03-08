import { Command } from "commander";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { header, success, info, error as logError } from "../utils.js";
import { getPidFilePath, getDataDir } from "../../config/index.js";

export function startCommand(): Command {
  return new Command("start")
    .description("Start the HTTP server")
    .option("-p, --port <port>", "Server port")
    .option("--bg", "Run in background (daemon mode)")
    .option("--config <path>", "Path to config file")
    .action(async (opts) => {
      if (opts.bg) {
        await startBackground(opts);
      } else {
        await startForeground(opts);
      }
    });
}

async function startForeground(opts: { port?: string; config?: string }): Promise<void> {
  // Set port if specified
  if (opts.port) {
    process.env.OPENCLAW_MEMORY_PORT = opts.port;
    process.env.PORT = opts.port;
  }

  // Import and run server directly
  const { createServer } = await import("../../server.js");
  const { app, config } = await createServer(opts.config);

  const port = opts.port ? parseInt(opts.port, 10) : config.port;

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

  httpServer.listen(port, "0.0.0.0");
  console.log(`[server] Listening on http://0.0.0.0:${port}`);

  // Write PID file for status/stop commands
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(getPidFilePath(), String(process.pid), "utf-8");

  const cleanup = () => {
    try { fs.unlinkSync(getPidFilePath()); } catch {}
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

async function startBackground(opts: { port?: string; config?: string }): Promise<void> {
  header("Starting Server (background)");

  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  // Build the command to run
  const args = ["run", "src/server.ts"];
  const env = { ...process.env };

  if (opts.port) {
    env.OPENCLAW_MEMORY_PORT = opts.port;
    env.PORT = opts.port;
  }

  // Detect runtime
  const runtime = typeof Bun !== "undefined" ? "bun" : "node";
  const execPath = runtime === "bun" ? "bun" : process.execPath;
  const execArgs = runtime === "bun" ? args : ["--import", "tsx", ...args];

  const child = spawn(execPath, execArgs, {
    env,
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
  });

  child.unref();

  if (child.pid) {
    fs.writeFileSync(getPidFilePath(), String(child.pid), "utf-8");
    success(`Server started in background (PID: ${child.pid})`);
    info(`PID file: ${getPidFilePath()}`);
    info(`Stop with: openclaw-memory stop`);
  } else {
    logError("Failed to start server");
    process.exit(1);
  }
}
