/**
 * A consumer of the published package, type-checked against the emitted
 * `dist/*.d.ts` by `vp run check:dist` (see `./tsconfig.json`). It is never run
 * or bundled: every line exists to make the compiler resolve and check one
 * piece of the public surface. Keep it to a few representative uses per
 * namespace; an assertion here pins a type a consumer relies on, so update it
 * only alongside a changeset that changes that type.
 *
 * @module dist-consumer
 */

import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import type { HttpClient } from "effect/http";

// The public name, resolved through package.json `exports` (a self-reference:
// the nearest package.json is the package's own), so this reaches
// `dist/index.d.ts` exactly as an installed copy would.
import {
  Action,
  Commons,
  Core,
  Dumps,
  Reconciliation,
  Rest,
  Sparql,
  Wikidata,
  Wikitext,
} from "@thomasfosterau/effect-wikimedia";

/** `true` only when `A` and `B` are mutually assignable, invariantly. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails to type-check unless its type argument is `true`. */
const assert = <_ extends true>(): void => undefined;

// --- Core -------------------------------------------------------------------

assert<Equals<typeof Core.wikimediaLayer, Layer.Layer<Core.WikimediaClient>>>();
assert<
  Equals<
    typeof Core.wikimediaClientLayer,
    Layer.Layer<Core.WikimediaClient, never, HttpClient.HttpClient>
  >
>();
assert<Equals<Core.WikimediaError, Core.InvalidRequest | Core.RequestFailed | Core.RateLimited>>();
assert<Equals<Core.WikimediaError["_tag"], "InvalidRequest" | "RequestFailed" | "RateLimited">>();
assert<Equals<ReturnType<typeof Core.normaliseWikimediaHost>, string | null>>();

// --- Action -----------------------------------------------------------------

assert<
  Equals<
    ReturnType<typeof Action.search>,
    Effect.Effect<readonly Action.SearchResult[], Core.WikimediaError, Core.WikimediaClient>
  >
>();
assert<
  Equals<
    ReturnType<typeof Action.getWikitext>,
    Effect.Effect<Action.WikitextResult | null, Core.WikimediaError, Core.WikimediaClient>
  >
>();

// --- Rest -------------------------------------------------------------------

assert<
  Equals<
    ReturnType<typeof Rest.getParsedHtml>,
    Effect.Effect<string, Core.WikimediaError, Core.WikimediaClient>
  >
>();

// --- Commons ----------------------------------------------------------------

assert<Equals<ReturnType<typeof Commons.filePathUrl>, string | null>>();
assert<
  Equals<
    ReturnType<typeof Commons.getFileInfo>,
    Effect.Effect<Commons.FileInfo | null, Core.WikimediaError, Core.WikimediaClient>
  >
>();

// --- Wikidata ---------------------------------------------------------------

const qid: Wikidata.ItemId | null = Wikidata.parseItemId("Q42");
// @ts-expect-error -- `ItemId` is branded: a bare string is not one.
const unbranded: Wikidata.ItemId = "Q42";
assert<
  Equals<
    ReturnType<typeof Wikidata.getEntities>,
    Effect.Effect<Record<string, Wikidata.WikidataItem>, Core.WikimediaError, Core.WikimediaClient>
  >
>();

// --- Sparql -----------------------------------------------------------------

assert<Equals<Sparql.SparqlTerm["_tag"], "uri" | "literal" | "bnode" | "unknown">>();
assert<Equals<Sparql.SparqlResults["boolean"], boolean | null>>();
assert<
  Equals<
    ReturnType<typeof Sparql.query>,
    Effect.Effect<Sparql.SparqlResults, Core.WikimediaError, Core.WikimediaClient>
  >
>();

// --- Wikitext ---------------------------------------------------------------

const document: Wikitext.Document = Wikitext.parse("{{Infobox person|name=Ada}}");
const templates: Wikitext.Template[] = Wikitext.findTemplates(document, "Infobox person");
const roundTrip: string = Wikitext.serialize(document);

// --- Dumps ------------------------------------------------------------------

declare const bytes: Stream.Stream<Uint8Array>;
assert<
  Equals<ReturnType<typeof Dumps.onlyEntities<never, never>>, Stream.Stream<Wikidata.WikidataItem>>
>();
const items: Stream.Stream<Wikidata.WikidataItem> = Dumps.onlyEntities(Dumps.entityRecords(bytes));
assert<Equals<ReturnType<typeof Dumps.fromFile>, Stream.Stream<Uint8Array, Dumps.SourceError>>>();
// The Node-only byte sources type their streams structurally, so naming them
// needs no `@types/node` (#73).
assert<Equals<Dumps.Decompressor, () => Dumps.NodeDuplexLike>>();
assert<
  Equals<Parameters<typeof Dumps.fromNodeReadable>, [evaluate: () => Dumps.NodeReadableLike]>
>();

// --- Reconciliation ---------------------------------------------------------

assert<
  Equals<typeof Reconciliation.wikidataLookupLayer, Layer.Layer<Reconciliation.WikidataLookup>>
>();
assert<
  Equals<Reconciliation.LookupError, Reconciliation.InvalidQuery | Reconciliation.LookupFailed>
>();
assert<Equals<Reconciliation.WikidataFact["_tag"], "Item" | "Identifier" | "Date" | "Image">>();
assert<Equals<typeof Reconciliation.WikidataFact.Type, Reconciliation.WikidataFact>>();
assert<Equals<Reconciliation.DateFact["calendar"], "gregorian" | "julian" | null>>();

export { document, items, qid, roundTrip, templates, unbranded };
