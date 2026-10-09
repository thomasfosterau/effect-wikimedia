/**
 * The **Dumps** surface: Wikimedia dump processing as Effect `Stream`
 * pipelines — constant-memory, backpressured, interruptible, typed. Three
 * dump families, one namespace:
 *
 * - **Wikidata JSON entity dumps** ({@link entityRecords}) — the `.json.gz` /
 *   `.json.bz2` entity dump as a stream of typed
 *   {@link Wikidata.WikidataItem}s, decoded through `Wikidata`'s model,
 *   lenient per line. Filter combinators {@link byType} / {@link withClaim} /
 *   {@link withSitelink}.
 * - **XML pages dumps** ({@link pageRecords}) — `pages-articles` /
 *   `pages-meta-history` streamed to typed page/revision records without
 *   materialising a document, via a scoped SAX-style scanner.
 * - **Incremental dumps** ({@link incrementalRecords}) — the daily
 *   `add/changes` stream, the same XML schema and the same typed surface.
 *
 * Byte sources and decompression ({@link fromFile}, {@link fromHttpRange},
 * {@link decompressWith}) are the one Node-only corner of the package; the
 * pipelines themselves are runtime-agnostic and operate on any
 * `Stream<Uint8Array>`. Even the byte sources' declarations type their Node
 * streams structurally, so type-checking the package needs no `@types/node`.
 *
 * ## Two decisions recorded here
 *
 * **XML decode — a scoped internal scanner, not an XML dependency.** There is
 * no effect-native streaming XML parser, and the package's lean-dependency
 * posture rules out a heavy general parser for one fixed, tiny grammar; a
 * full-history page is also unbounded, so the decode must emit per-revision
 * and never build a document. The XML decoder ({@link XmlPageReader})
 * therefore ships a minimal SAX-style scanner scoped to the MediaWiki export
 * schema, leaning on that format's guarantee that all text is entity-escaped
 * (so `<` always opens a tag, and there is no CDATA).
 *
 * **bz2 — a pluggable stage, not a bundled decoder.** Node `zlib` covers gzip
 * ({@link gunzip}); it has no bzip2, and pure-JS bzip2 decoders are heavy.
 * Decompression is an injectable Node `Transform` factory
 * ({@link Decompressor}) — a `.json.bz2` consumer supplies their own bzip2
 * transform to {@link fromFile} / {@link decompressWith}. No bzip2 dependency
 * ships.
 *
 * ## Worked example — count all items with a `P569` (date of birth) claim
 *
 * ```ts
 * import * as Effect from "effect/Effect";
 * import * as Stream from "effect/Stream";
 * import { Dumps } from "@thomasfosterau/effect-wikimedia";
 *
 * // A gzipped Wikidata entity-dump slice on disk.
 * const born = Dumps.fromFile("wikidata-slice.json.gz").pipe(
 *   Dumps.entityRecords, // Stream<EntityRecord> — lenient, per-line
 *   Dumps.onlyEntities, // drop the per-line error elements
 *   Dumps.withClaim("P569"), // keep only items with a date-of-birth claim
 *   Stream.runCount, // fold to a count at constant memory
 * );
 *
 * const total = await Effect.runPromise(born);
 * console.log(`${total} items carry a P569 claim`);
 * ```
 *
 * Nothing above holds more than one entity in memory at a time; cancelling the
 * `Effect` tears the file read (and any decompression) down immediately.
 *
 * @copyright Thomas Foster
 * @module
 */

export {
  byType,
  type DumpLineError,
  type DumpLineErrorReason,
  decodeEntityLine,
  type EntityHit,
  type EntityRecord,
  entityRecords,
  hasClaim,
  hasSitelink,
  hasType,
  onlyEntities,
  stripFraming,
  withClaim,
  withSitelink,
} from "./entities.ts";
export {
  classifyTag,
  type Contributor,
  decodeXmlEntities,
  incrementalRecords,
  onlyRevisions,
  type PageRef,
  type PageRevisionError,
  type PageRevisionHit,
  type PageRevisionRecord,
  pageRecords,
  type Revision,
  tagName,
  tokenizeXml,
  type XmlToken,
  XmlPageReader,
} from "./xml.ts";
export {
  type Decompressor,
  decompressWith,
  type FromFileOptions,
  type FromHttpRangeOptions,
  fromFile,
  fromHttpRange,
  fromNodeReadable,
  gunzip,
  gunzipTransform,
  type NodeDuplexLike,
  type NodeReadableLike,
  SourceError,
} from "./sources.ts";
