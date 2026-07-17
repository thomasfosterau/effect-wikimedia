import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// $env/$app/@test-helpers aliases — kept verbatim across every consumer's
// vite.config.ts since the shared @thomasfosterau/test-config factory was
// inlined per-file (#962); a mismatch here silently breaks this suite's
// $env/$app resolution.
const mock = (p: string) => fileURLToPath(new URL(`../../tests/${p}`, import.meta.url));

const testMockAliases: Record<string, string> = {
  "$app/env/public": mock("mocks/app-env-public.ts"),
  "$app/env/private": mock("mocks/app-env-private.ts"),
  "$app/server": mock("__mocks__/$app/server.ts"),
  "$app/navigation": mock("__mocks__/$app/navigation.ts"),
  "@test-helpers": mock("helpers"),
};

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    ...(process.env.VITEST_MAX_WORKERS
      ? { maxWorkers: Number(process.env.VITEST_MAX_WORKERS) }
      : {}),
    alias: testMockAliases,
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts"],
      thresholds: { statements: 91, branches: 77, functions: 85, lines: 97 },
    },
  },
});
