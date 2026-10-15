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
  // Literals unique to the Dumps modules, on the referenced pipeline paths —
  // one per sub-module (entities / xml / sources). Their presence proves the
  // Dumps surface bundled; their absence proves it did not.
  dumps: ["dumps/not-an-entity", "dumps/malformed-revision", "dumps/source-read-failed"],
  reconciliation: [
    "WikidataLookup.searchByLabel",
    "WikidataLookup.searchByIdentifier",
    "WikidataLookup.enrich",
  ],
  // Wikitext has no `Effect.fn`: these are names from its HTML5 entity table
  // (`src/wikitext/entities.ts`), the largest thing it bundles (#118).
  wikitext: ["CounterClockwiseContourIntegral", "DoubleLongLeftRightArrow"],
} as const;

type Surface =
  | "Action"
  | "Rest"
  | "Commons"
  | "Wikidata"
  | "Sparql"
  | "Dumps"
  | "Reconciliation"
  | "Wikitext";

/** Bundles a one-line entry that imports and uses only the given namespace from the package barrel. */
async function bundleImporting(namespace: Surface): Promise<string> {
  const entryByNamespace: Record<Surface, string> = {
    Action: `import { Action } from "./index";\nconsole.log(Action.getWikitext, Action.getPageMetadata, Action.search, Action.parsePage);\n`,
    Rest: `import { Rest } from "./index";\nconsole.log(Rest.getPageMetadata, Rest.getRevisionMetadata, Rest.getParsedHtml, Rest.getRevisionHtml);\n`,
    Commons: `import { Commons } from "./index";\nconsole.log(Commons.getFileInfo, Commons.filePathUrl);\n`,
    Wikidata: `import { Wikidata } from "./index";\nconsole.log(Wikidata.getEntities, Wikidata.searchEntities);\n`,
    Sparql: `import { Sparql } from "./index";\nconsole.log(Sparql.query, Sparql.hasLimitClause);\n`,
    Dumps: `import { Dumps } from "./index";\nconsole.log(Dumps.entityRecords, Dumps.pageRecords, Dumps.incrementalRecords, Dumps.fromFile, Dumps.gunzip);\n`,
    Reconciliation: `import { Reconciliation } from "./index";\nconsole.log(Reconciliation.WikidataLookup, Reconciliation.wikidataLookupLayer);\n`,
    Wikitext: `import { Wikitext } from "./index";\nconsole.log(Wikitext.parse, Wikitext.stripToText, Wikitext.serialize);\n`,
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
    // bundle fast — effect is large). `node:*` builtins are external too — the
    // Dumps sources module is the one Node-only module.
    external: ["effect", "effect/*", "node:*"],
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
    foreign: [
      MARKERS.rest,
      MARKERS.commons,
      MARKERS.wikidata,
      MARKERS.sparql,
      MARKERS.dumps,
      MARKERS.reconciliation,
      MARKERS.wikitext,
    ],
  },
  {
    namespace: "Rest",
    own: MARKERS.rest,
    foreign: [
      MARKERS.action,
      MARKERS.commons,
      MARKERS.wikidata,
      MARKERS.sparql,
      MARKERS.dumps,
      MARKERS.reconciliation,
      MARKERS.wikitext,
    ],
  },
  {
    namespace: "Commons",
    own: MARKERS.commons,
    foreign: [
      MARKERS.action,
      MARKERS.rest,
      MARKERS.wikidata,
      MARKERS.sparql,
      MARKERS.dumps,
      MARKERS.reconciliation,
      MARKERS.wikitext,
    ],
  },
  {
    namespace: "Wikidata",
    own: MARKERS.wikidata,
    foreign: [
      MARKERS.action,
      MARKERS.rest,
      MARKERS.commons,
      MARKERS.sparql,
      MARKERS.dumps,
      MARKERS.reconciliation,
      MARKERS.wikitext,
    ],
  },
  {
    namespace: "Sparql",
    own: MARKERS.sparql,
    foreign: [
      MARKERS.action,
      MARKERS.rest,
      MARKERS.commons,
      MARKERS.wikidata,
      MARKERS.dumps,
      MARKERS.reconciliation,
      MARKERS.wikitext,
    ],
  },
  {
    // Dumps legitimately depends on the Wikidata module (it decodes each dump
    // line through `Wikidata`'s item model), so Wikidata is *not* foreign here — only
    // the unrelated Action / Rest / Commons / Sparql surfaces are.
    namespace: "Dumps",
    own: MARKERS.dumps,
    foreign: [
      MARKERS.action,
      MARKERS.rest,
      MARKERS.commons,
      MARKERS.sparql,
      MARKERS.reconciliation,
      MARKERS.wikitext,
    ],
  },
  {
    // Reconciliation is the one namespace layered *on top* of the raw clients:
    // it drives Action (label search) and Wikidata (entity fetch) over Core, so
    // those are not foreign. The surfaces it never touches are.
    namespace: "Reconciliation",
    own: MARKERS.reconciliation,
    foreign: [MARKERS.rest, MARKERS.commons, MARKERS.sparql, MARKERS.dumps, MARKERS.wikitext],
  },
  {
    // Wikitext imports nothing outside `src/wikitext/` (AGENTS.md).
    namespace: "Wikitext",
    own: MARKERS.wikitext,
    foreign: [
      MARKERS.action,
      MARKERS.rest,
      MARKERS.commons,
      MARKERS.wikidata,
      MARKERS.sparql,
      MARKERS.dumps,
      MARKERS.reconciliation,
    ],
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
