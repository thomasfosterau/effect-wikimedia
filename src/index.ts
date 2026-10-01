/**
 * `@thomasfosterau/effect-wikimedia` — a strongly typed, Effect-idiomatic
 * client family for Wikimedia properties (Wikipedia, Wikidata, Commons, and
 * siblings). One package, **module-per-surface**: each namespace below is a
 * tree-shakeable slice built on {@link Core} — importing `Action` never pulls
 * `Rest` or `Commons` into a bundle. The only cross-surface imports are
 * `Dumps` → `Wikidata` (its model) and `Reconciliation` → `Action` /
 * `Wikidata` (the clients it drives).
 *
 * - **`Core`** — the shared `HttpClient`-based service (`WikimediaClient`),
 *   per-wiki host validation, the typed error family, and the polite-UA /
 *   `maxlag` / retry-after etiquette every surface module builds on.
 * - **`Action`** — the Action API (`/w/api.php`): page wikitext, page
 *   metadata, search, and the `parse` endpoint's typed sections / links /
 *   categories / templates.
 * - **`Rest`** — the Core REST API / Parsoid surface (`/w/rest.php/v1/...`):
 *   parsed HTML for a title or revision, typed page/revision metadata.
 * - **`Commons`** — Commons file info and `Special:FilePath` URL
 *   construction.
 * - **`Wikidata`** — the typed Wikidata item / claim model (branded
 *   `Q`/`P`/`L` ids, the full snak datavalue union) plus `wbgetentities`
 *   (batched, 50-id chunking) and `wbsearchentities`.
 * - **`Sparql`** — the Wikidata Query Service (WDQS) SPARQL client: typed
 *   result terms and a LIMIT-enforcing query helper.
 * - **`Wikitext`** — a pure, dependency-free wikitext → typed AST parser:
 *   round-trip serializer plus a query/manipulation surface. The one module
 *   here that imports nothing (not even {@link Core}).
 * - **`Dumps`** — Wikimedia dump processing as `Stream` pipelines: the
 *   Wikidata JSON entity dump decoded through {@link Wikidata}'s model,
 *   MediaWiki XML pages / incrementals via a scoped SAX-style scanner, and
 *   Node-only byte sources (file / resumable HTTP range) with pluggable
 *   gzip / bz2 decompression stages. Those byte sources are the package's
 *   only Node-only exports; the pipelines themselves stay runtime-agnostic
 *   over any `Stream<Uint8Array>`.
 * - **`Reconciliation`** — the opinionated layer above the raw clients: resolve
 *   a label or an external identifier to candidate Wikidata items (Match), then
 *   pull the selected facts for a confirmed QID (Enrich). Unlike the surface
 *   modules it carries *policy* — input validators, curated property
 *   allowlists, and the candidate/fact shapes — so it is the one namespace here
 *   with an opinion about how you should reconcile. Everything below it stays
 *   neutral.
 *
 * @copyright Thomas Foster
 * @module index
 */

export * as Action from "./action.ts";
export * as Commons from "./commons.ts";
export * as Core from "./core.ts";
export * as Dumps from "./dumps/index.ts";
export * as Reconciliation from "./reconciliation/index.ts";
export * as Rest from "./rest.ts";
export * as Sparql from "./sparql.ts";
export * as Wikidata from "./wikidata.ts";
export * as Wikitext from "./wikitext/index.ts";
