import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative base so the static build works from any sub-path (e.g. GitHub Pages /<repo>/).
  base: "./",
  server: { port: 5173, strictPort: true },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
