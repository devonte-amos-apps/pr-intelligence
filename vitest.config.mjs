import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["scripts/**/*.mjs"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 75 },
    },
  },
})
