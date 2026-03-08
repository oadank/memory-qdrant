import { Command } from "commander";
import fs from "node:fs";
import { header, success, warn, error as logError } from "../utils.js";
import { getPidFilePath } from "../../config/index.js";

export function stopCommand(): Command {
  return new Command("stop")
    .description("Stop the running server")
    .action(async () => {
      header("Stopping Server");

      const pidPath = getPidFilePath();
      if (!fs.existsSync(pidPath)) {
        warn("No PID file found — server may not be running");
        return;
      }

      const pidStr = fs.readFileSync(pidPath, "utf-8").trim();
      const pid = parseInt(pidStr, 10);

      if (isNaN(pid)) {
        logError(`Invalid PID in ${pidPath}: ${pidStr}`);
        return;
      }

      try {
        // Send SIGTERM for graceful shutdown
        process.kill(pid, "SIGTERM");
        success(`Sent SIGTERM to PID ${pid}`);

        // Wait up to 3 seconds for graceful shutdown
        let alive = true;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 100));
          try {
            process.kill(pid, 0);
          } catch {
            alive = false;
            break;
          }
        }

        if (alive) {
          warn("Process still running after 3s, sending SIGKILL...");
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }

        success("Server stopped");
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          warn(`Process ${pid} not found — may have already stopped`);
        } else {
          logError(`Failed to stop process ${pid}: ${err}`);
        }
      }

      // Clean up PID file
      try {
        fs.unlinkSync(pidPath);
      } catch {}
    });
}
