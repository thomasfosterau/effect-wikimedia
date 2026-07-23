/**
 * Proves the package's module-per-surface tree-shaking boundary (issue
 * #1063's acceptance criterion): importing one surface namespace from the
 * barrel (`Action`, `Rest`, or `Commons`) must not pull the other two
 * surface modules' code into a bundle.
 *
 * This is a **bundle check**, not an assertion about the source graph:
 * each case runs a real `esbuild` bundle (tree-shaking + `sideEffects:
 * false` enabled, `effect` marked external so the check isolates this
 * package's own module boundaries) over an entry that imports and uses
 * exactly one surface namespace, then inspects the emitted code for each
 * surface's `Effect.fn` span-name markers (`"Action.getWikitext"`,
 * `"Rest.getPageMetadata"`, `"Commons.getFileInfo"`, `"Wikidata.getEntities"`,
 * `"Sparql.query"`, …) — string literals unique to each module's source, so
 * their presence/absence in the output is a direct, unambiguous read of what
 * got bundled.
 *
 * @module tests/tree-shaking
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { build } from "esbuild";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

/** Span-name markers unique to each surface module's `Effect.fn` calls. */
const MARKERS = {
  action: ["Action.getWikitext", "Action.getPageMetadata", "Action.search", "Action.parsePage"],
  rest: [
    "Rest.getPageMetadata",
    "Rest.getRevisionMetadata",
    "Rest.getParsedHtml",
    "Rest.getRevisionHtml",
  ],
  commons: ["Commons.getFileInfo"],
  wikidata: ["Wikidata.getEntities", "Wikidata.searchEntities"],
  sparql: ["Sparql.query"],
} as const;

type Surface = "Action" | "Rest" | "Commons" | "Wikidata" | "Sparql";

/** Bundles a one-line entry that imports and uses only the given namespace from the package barrel. */
async function bundleImporting(namespace: Surface): Promise<string> {
  const entryByNamespace: Record<Surface, string> = {
    Action: `import { Action } from "./index";\nconsole.log(Action.getWikitext, Action.getPageMetadata, Action.search, Action.parsePage);\n`,
    Rest: `import { Rest } from "./index";\nconsole.log(Rest.getPageMetadata, Rest.getRevisionMetadata, Rest.getParsedHtml, Rest.getRevisionHtml);\n`,
    Commons: `import { Commons } from "./index";\nconsole.log(Commons.getFileInfo, Commons.filePathUrl);\n`,
    Wikidata: `import { Wikidata } from "./index";\nconsole.log(Wikidata.getEntities, Wikidata.searchEntities);\n`,
    Sparql: `import { Sparql } from "./index";\nconsole.log(Sparql.query, Sparql.hasLimitClause);\n`,
  };

  const result = await build({
    stdin: {
      contents: entryByNamespace[namespace],
      resolveDir: srcDir,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    treeShaking: true,
    minify: false,
    logLevel: "silent",
    // `effect` is the package's only dependency; excluding it keeps the
    // check focused on this package's own module boundaries (and keeps the
    // bundle fast — effect is large).
    external: ["effect", "effect/*"],
  });
  const output = result.outputFiles?.[0]?.text;
  if (output === undefined) throw new Error("esbuild produced no output");
  return output;
}

/** Each surface, its own markers, and the marker groups it must NOT pull. */
const SURFACES: readonly {
  readonly namespace: Surface;
  readonly own: readonly string[];
  readonly foreign: readonly (readonly string[])[];
}[] = [
  {
    namespace: "Action",
    own: MARKERS.action,
    foreign: [MARKERS.rest, MARKERS.commons, MARKERS.wikidata, MARKERS.sparql],
  },
  {
    namespace: "Rest",
    own: MARKERS.rest,
    foreign: [MARKERS.action, MARKERS.commons, MARKERS.wikidata, MARKERS.sparql],
  },
  {
    namespace: "Commons",
    own: MARKERS.commons,
    foreign: [MARKERS.action, MARKERS.rest, MARKERS.wikidata, MARKERS.sparql],
  },
  {
    namespace: "Wikidata",
    own: MARKERS.wikidata,
    foreign: [MARKERS.action, MARKERS.rest, MARKERS.commons, MARKERS.sparql],
  },
  {
    namespace: "Sparql",
    own: MARKERS.sparql,
    foreign: [MARKERS.action, MARKERS.rest, MARKERS.commons, MARKERS.wikidata],
  },
];

describe("module-per-surface tree-shaking", () => {
  for (const { namespace, own, foreign } of SURFACES) {
    it(`importing ${namespace} pulls no other surface's code`, async () => {
      const bundle = await bundleImporting(namespace);
      for (const marker of own) expect(bundle).toContain(marker);
      for (const group of foreign) {
        for (const marker of group) expect(bundle).not.toContain(marker);
      }
    });
  }
});
