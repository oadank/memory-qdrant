#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { storeCommand } from "./commands/store.js";
import { searchCommand } from "./commands/search.js";
import { migrateCommand } from "./commands/migrate.js";
import { infraCommand } from "./commands/infra.js";

const program = new Command();

program
  .name("openclaw-memory")
  .description("Triple-layer memory system for AI agents — SQLite + Qdrant + Postgres/AGE")
  .version("0.1.0");

// Register commands
program.addCommand(initCommand());
program.addCommand(startCommand());
program.addCommand(stopCommand());
program.addCommand(statusCommand());
program.addCommand(storeCommand());
program.addCommand(searchCommand());
program.addCommand(migrateCommand());
program.addCommand(infraCommand());

program.parse();
