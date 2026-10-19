import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // The golden fixture is ~750KB of JSON imported by the terrain tests.
    // Node's ESM JSON import attributes handle it; no transform needed.
    environment: "node",
  },
});
