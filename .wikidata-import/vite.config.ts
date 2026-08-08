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

/**
 * Input fingerprint for this package's cached tasks.
 *
 * Auto tracking otherwise records node_modules bookkeeping that pnpm rewrites
 * on every install (`.modules.yaml`) and vitest's own `.vite/vitest` scratch
 * dirs. That churn busted 24 of 43 cacheable tasks on an EXACT-key cache
 * restore of an identical commit (#1549 Phase 2, run 31166569075 attempt 2) —
 * the cache was working, it was the fingerprint that was wrong.
 *
 * Excluding node_modules alone would be unsafe: a dependency upgrade genuinely
 * must invalidate a type-check or a test run. So the lockfile comes back
 * explicitly, capturing the real dependency state without the bookkeeping
 * noise. Verified: node_modules churn no longer busts, while a pnpm-lock.yaml
 * edit and a source edit both still do, each naming the file responsible.
 */
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

export default defineConfig({
  // Promoted from package.json scripts (#1549 Phase 1b). Vite+'s global
  // default is `run.cache = { scripts: false, tasks: true }`, so a
  // package.json script can never be cached however pure it is — which is
  // why CI reported 0/81 cache hits with most tasks never even eligible.
  run: {
    tasks: {
      check: {
        command: "tsc -p tsconfig.json",
        input: cacheInputs,
        output: [],
      },
      "test:unit": {
        command: "vp test run tests",
        env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
        input: cacheInputs,
        output: [],
      },
      "test:coverage": {
        command: "vp test run tests --coverage",
        env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
        input: cacheInputs,
        output: ["coverage/**"],
      },
    },
  },
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
