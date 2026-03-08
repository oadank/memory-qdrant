import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "server-native": "src/server-native.ts",
  },
  format: ["esm"],
  dts: false,
  splitting: true,
  clean: true,
  target: "node20",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  external: [
    "better-sqlite3",
    "@qdrant/js-client-rest",
    "pg",
    "bun:sqlite",
  ],
  banner: ({ format }) => {
    // Only add shebang to CLI entry in ESM format
    return {};
  },
  onSuccess: async () => {
    // Add shebang to CLI entries
    const fs = await import("node:fs");
    const path = await import("node:path");

    for (const ext of ["js", "cjs"]) {
      const cliPath = path.join("dist", `cli`, `index.${ext}`);
      if (fs.existsSync(cliPath)) {
        const content = fs.readFileSync(cliPath, "utf-8");
        if (!content.startsWith("#!")) {
          fs.writeFileSync(cliPath, `#!/usr/bin/env node\n${content}`);
        }
        fs.chmodSync(cliPath, 0o755);
      }
    }
    console.log("✓ CLI shebang added");
  },
});
