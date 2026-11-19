import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";
import * as R from "effect/Record";
import { defineConfig } from "vite-plus";

/** The Oxlint config shape the presets share, named without depending on `oxlint` directly. */
type OxlintConfig = typeof recommended;

/** `config` with every `warn` raised to `error`: this package has no warn tier. */
const atError = (config: OxlintConfig): OxlintConfig => ({
  ...config,
  rules: R.map(config.rules ?? {}, (setting) =>
    setting === "warn"
      ? "error"
      : Array.isArray(setting) && setting[0] === "warn"
        ? ["error", ...setting.slice(1)]
        : setting,
  ),
});

export default defineConfig({
  // Format with fixes, lint without: a type-aware autofix at commit time would
  // make the commit differ from the verified tree. Lint ignores some paths
  // (tests/dist-consumer/), so an unmatched pattern is not an error.
  staged: {
    "*.{js,mjs,ts}": [
      "vp check --fix --no-lint",
      "vp check --no-fmt --no-error-on-unmatched-pattern",
    ],
    "*.{json,md}": "vp check --fix --no-lint",
  },
  run: {
    cache: true,
    tasks: {
      // The Effect-patched native `tsc` (`prepare`), which reports the Effect
      // diagnostics tsgolint in `vp check` does not.
      check: "tsc -p tsconfig.json",
      build: "vp pack",
      // Writes coverage/coverage-final.json, which fallow reads for CRAP
      // scores. Vitest reads back its own `coverage/.tmp/`, so `coverage/`
      // is left out of the fingerprint or the task would never cache.
      "test:unit": {
        command: "vp test run --coverage",
        cache: { input: [{ auto: true }, "!coverage/**"] },
      },
      // Type-checks tests/dist-consumer/ against the emitted declarations,
      // under both TS 7 (`tsc`) and TS 6 (`tsc6`).
      "check:dist": {
        command: [
          "tsc -p tests/dist-consumer/tsconfig.json",
          "tsc6 -p tests/dist-consumer/tsconfig.json",
        ],
        dependsOn: ["build"],
      },
      // TypeDoc fails on an undocumented export or an unresolved `{@link}`.
      docgen: "typedoc",
      // `--no-cache` leaves invalidation to the Vite+ task cache.
      fallow: {
        command: ["fallow dead-code --no-cache", "fallow dupes --no-cache --fail-on-issues"],
      },
      // `--complexity` skips git-churn hotspots, which the task cache can't
      // fingerprint.
      "fallow:health": {
        command: "fallow health --no-cache --complexity",
        dependsOn: ["test:unit"],
      },
      // Run by the pre-commit hook; reads the coverage map.
      "fallow:audit": {
        command: "vp exec fallow audit --base origin/trunk --quiet",
        dependsOn: ["test:unit"],
        cache: false,
      },
      "changeset:version": {
        command: ["changeset version", "vp fmt"],
        cache: false,
      },
      "changeset:publish": {
        command: "changeset publish",
        dependsOn: ["build"],
        cache: false,
      },
      // Everything CI runs, in order; `pnpm audit` needs the network.
      ci: {
        command: [
          "vp check",
          "vp run check",
          "vp run fallow",
          "vp run test:unit",
          "vp run fallow:health",
          "vp run build",
          "vp run check:dist",
          "vp run docgen",
          "pnpm audit --audit-level high",
        ],
        cache: false,
      },
    },
  },

  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    // Only the `Dumps` byte sources touch Node; the rest runs in a browser or Worker.
    platform: "neutral",
    // One output file per module keeps each surface tree-shakeable
    // (tests/tree-shaking.test.ts).
    unbundle: true,
    dts: true,
    sourcemap: true,
    deps: {
      neverBundle: [/^node:/],
    },
  },

  lint: {
    // tests/dist-consumer/ needs the built `dist/`; `check:dist` covers it.
    ignorePatterns: ["**/dist/**", "api-docs/**", "coverage/**", "tests/dist-consumer/**"],
    extends: [atError(recommended), atError(effect.configs.recommended)],
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "vitest", "jsdoc"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    rules: {
      "effect/casting-awareness": "error",
      "effect/prefer-option-over-null": "error",
      "effect/no-unknown-parameters": "error",
      // Effect 4 marks much of `effect/http` and `@effect/vitest` unstable, so
      // this reports the pinned API rather than a defect. It stays a
      // suggestion in tsconfig.json's language-service options.
      "effecttsgo/unstable-api-usage": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
      "effect/no-conditional-empty-object-spread": "error",
      "effecttsgo/strict-effect-provide": "error",
      "effecttsgo/prefer-typed-schema-decoder": "error",
      "effecttsgo/schema-number": "error",
      "effecttsgo/schema-class-missing-brand": "error",
      "effect/effect-run-in-body": "error",
      "no-underscore-dangle": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "typescript/no-unnecessary-type-parameters": "error",
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expect*", "assert", "assert*"] },
      ],
      "vitest/no-standalone-expect": [
        "error",
        {
          additionalTestBlockFunctions: [
            "it",
            "it.each",
            "it.effect",
            "it.effect.each",
            "it.effect.skipIf",
            "it.live",
            "it.live.each",
            "it.live.skipIf",
          ],
        },
      ],
    },
    overrides: [
      // The one Node-only module: it adapts Node read streams and
      // decompressors into a `Stream<Uint8Array>`.
      {
        files: ["src/dumps/sources.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/use-filesystem-service": "off",
          // A classic stream's `write()` can throw inside a Node write
          // callback, outside any Effect.
          "effect/avoid-try-catch": "off",
          // Node's `isReadable` / `isWritable` take a `Duplex`, so a
          // structural `NodeDuplexLike` must be viewed as one to be checked.
          "effect/casting-awareness": "off",
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
      // The parser's cursor drivers: early-exit scans over a mutable index,
      // which `Arr` can't express without allocating per character.
      {
        files: ["src/wikitext/cursor.ts"],
        rules: {
          "effect/imperative-loops": "off",
        },
      },
      // These tests' subject is Node itself (real Node streams; forced GC).
      {
        files: ["tests/dumps/sources.test.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/use-filesystem-service": "off",
        },
      },
      {
        files: ["tests/dumps/entities.test.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
        },
      },
      {
        files: ["tests/**"],
        rules: {
          // `@effect/vitest`'s `layer(...)` hands each block its own `it`.
          "no-shadow": ["error", { allow: ["it"] }],
        },
      },
    ],
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },

  fmt: {
    ignorePatterns: ["**/dist/**", "api-docs/**"],
  },

  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "istanbul",
      // `json` writes coverage-final.json for fallow.
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
});
