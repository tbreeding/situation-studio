import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@domain": path.join(root, "packages/domain/src/index.ts"),
      "@": path.join(root, "apps/web/src"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts"],
  },
});
