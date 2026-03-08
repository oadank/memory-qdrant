import { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { header, success, info, warn, error as logError } from "../utils.js";
import { getDataDir, loadConfig } from "../../config/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function infraCommand(): Command {
  const infra = new Command("infra")
    .description("Manage Docker infrastructure");

  infra
    .command("up")
    .description("Start Docker containers for the configured tier")
    .option("--tier <tier>", "Override tier (standard, full)")
    .action(async (opts) => {
      header("Infrastructure Up");

      let tier = opts.tier;
      if (!tier) {
        try {
          const config = await loadConfig();
          tier = config.tier;
        } catch {
          tier = "standard";
        }
      }

      if (tier === "lite") {
        info("Lite tier uses only SQLite — no Docker infrastructure needed.");
        return;
      }

      const templateFile = tier === "full" ? "full.yml" : "standard.yml";
      const templatePath = findTemplate(templateFile);

      if (!templatePath) {
        logError(`Template not found: ${templateFile}`);
        logError("Expected in ./docker/ or ./templates/ directory");
        process.exit(1);
      }

      const dataDir = getDataDir();
      fs.mkdirSync(dataDir, { recursive: true });

      const targetPath = path.join(dataDir, "docker-compose.yml");
      fs.copyFileSync(templatePath, targetPath);
      info(`Using template: ${templatePath}`);

      try {
        execSync(`docker compose -f ${targetPath} up -d`, {
          stdio: "inherit",
          cwd: dataDir,
        });
        success("Docker containers started");
      } catch (error) {
        logError("Failed to start Docker containers");
        logError("Make sure Docker is installed and running");
        process.exit(1);
      }
    });

  infra
    .command("down")
    .description("Stop Docker containers")
    .action(async () => {
      header("Infrastructure Down");

      const dataDir = getDataDir();
      const composePath = path.join(dataDir, "docker-compose.yml");

      if (!fs.existsSync(composePath)) {
        warn("No docker-compose.yml found in data directory");
        return;
      }

      try {
        execSync(`docker compose -f ${composePath} down`, {
          stdio: "inherit",
          cwd: dataDir,
        });
        success("Docker containers stopped");
      } catch (error) {
        logError("Failed to stop Docker containers");
        process.exit(1);
      }
    });

  infra
    .command("status")
    .description("Show Docker container status")
    .action(async () => {
      header("Infrastructure Status");

      const dataDir = getDataDir();
      const composePath = path.join(dataDir, "docker-compose.yml");

      if (!fs.existsSync(composePath)) {
        info("No docker-compose.yml found — infrastructure not set up");
        info("Run: openclaw-memory infra up");
        return;
      }

      try {
        execSync(`docker compose -f ${composePath} ps`, {
          stdio: "inherit",
          cwd: dataDir,
        });
      } catch {
        logError("Failed to get container status");
      }
    });

  return infra;
}

function findTemplate(filename: string): string | null {
  const searchPaths = [
    path.join(process.cwd(), "docker", filename),
    path.join(process.cwd(), "templates", filename),
    // Look in the package's installed location
    path.join(__dirname, "../../docker", filename),
    path.join(__dirname, "../../templates", filename),
  ];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}
