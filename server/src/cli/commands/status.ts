import { Command } from "commander";
import pc from "picocolors";
import { header, bullet, info, getServerPid, isServerRunning, getBaseUrl, apiGet } from "../utils.js";
import { loadConfig } from "../../config/index.js";

export function statusCommand(): Command {
  return new Command("status")
    .description("Show server and layer health status")
    .option("-p, --port <port>", "Server port to check")
    .option("--config <path>", "Path to config file")
    .action(async (opts) => {
      header("Status");

      let config;
      try {
        config = await loadConfig(opts.config);
      } catch {
        config = null;
      }

      const port = opts.port ? parseInt(opts.port, 10) : config?.port || 7777;
      const baseUrl = getBaseUrl(port);
      const pid = getServerPid();
      const running = await isServerRunning(baseUrl);

      // Server status
      if (running && pid) {
        bullet("Server", `Running (PID ${pid}, port ${port})`, "ok");
      } else if (running) {
        bullet("Server", `Running (port ${port})`, "ok");
      } else if (pid) {
        bullet("Server", `PID file exists (${pid}) but not responding`, "error");
      } else {
        bullet("Server", "Not running", "disabled");
      }

      if (config) {
        bullet("Tier", config.tier, undefined);
      }

      console.log();

      // If server is running, get health from API
      if (running) {
        try {
          const health = await apiGet(baseUrl, "/api/health", config?.auth?.token) as Record<string, unknown>;

          info("Layers:");
          const sqliteStatus = health.sqlite === "ok" ? "ok" as const : "error" as const;
          bullet("L1 SQLite", String(health.sqlite), sqliteStatus);

          if (health.qdrant !== "disabled") {
            const qdrantStatus = health.qdrant === "ok" ? "ok" as const : "error" as const;
            bullet("L2 Qdrant", String(health.qdrant), qdrantStatus);
          } else {
            bullet("L2 Qdrant", "disabled", "disabled");
          }

          if (health.age !== "disabled") {
            const ageStatus = health.age === "ok" ? "ok" as const : "error" as const;
            bullet("L3 AGE", String(health.age), ageStatus);
          } else {
            bullet("L3 AGE", "disabled", "disabled");
          }

          if (health.uptime !== undefined) {
            const uptime = formatUptime(Number(health.uptime));
            console.log();
            info(`Uptime: ${uptime}`);
          }
        } catch (error) {
          info("Could not fetch health status from server");
        }
      } else {
        // Server not running — try direct layer checks
        if (config) {
          info("Server not running. Checking layers directly...");
          console.log();

          // SQLite — always available
          bullet("L1 SQLite", config.sqlite.path, "ok");

          // Qdrant
          if (config.qdrant) {
            try {
              const res = await fetch(`${config.qdrant.url}/collections`, {
                signal: AbortSignal.timeout(2000),
              });
              bullet("L2 Qdrant", config.qdrant.url, res.ok ? "ok" : "error");
            } catch {
              bullet("L2 Qdrant", `${config.qdrant.url} (unreachable)`, "error");
            }
          } else {
            bullet("L2 Qdrant", "not configured", "disabled");
          }

          // AGE
          if (config.age) {
            try {
              const net = await import("node:net");
              const reachable = await new Promise<boolean>((resolve) => {
                const socket = new net.Socket();
                socket.setTimeout(2000);
                socket.connect(config!.age!.port, config!.age!.host, () => {
                  socket.destroy();
                  resolve(true);
                });
                socket.on("error", () => resolve(false));
                socket.on("timeout", () => { socket.destroy(); resolve(false); });
              });
              bullet("L3 AGE", `${config.age.host}:${config.age.port}`, reachable ? "ok" : "error");
            } catch {
              bullet("L3 AGE", "unreachable", "error");
            }
          } else {
            bullet("L3 AGE", "not configured", "disabled");
          }
        }
      }

      console.log();
    });
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
