import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Local runs read the repo's .env like `pnpm dev` does (variables already set
// in the shell or CI win) -- above all TF_PLUGIN_CACHE_DIR: without it every
// real-Terraform case downloads the AWS provider again. Test workers inherit
// process.env.
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
