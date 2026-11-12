# Migrating

## 0.9 → 0.10: `Option` for absent values

0.10 replaces `null` and `undefined` with Effect's `Option` wherever this package reports that a value is missing (#224). It is breaking for every surface, but the change is mechanical: each place you checked for `null` or `undefined`, you now match on an `Option`.

### If you only use `Reconciliation`

Three things change, all from `null` to `Option`. Everything else these apps use is unchanged, including fact fields such as `item.qid`, `identifier.value` and `date.time`:

- `WikidataFact` and its `.match` arms (`Item`, `Identifier`, `Date`, `Image`) and their fields.
- `WikidataFacts`.
- `wikidataEntityIri`.
- `LookupFailed` / `LookupError`.
- `wikidataLookupLayer`.

```ts
import * as Option from "effect/Option";

// 1. `WikidataLookup.enrich` succeeds with `Option<WikidataFacts>`, not `WikidataFacts | null`.
// 0.9
const facts = yield * lookup.enrich(qid);
if (facts === null) return notFound();
render(facts.facts);
// 0.10
const facts = yield * lookup.enrich(qid);
if (Option.isNone(facts)) return notFound();
render(facts.value.facts);

// 2. `WikidataCandidate.label` and `.description` (from `searchByLabel` / `searchByIdentifier`) are `Option<string>`.
// 0.9: candidate.label ?? candidate.qid
Option.getOrElse(candidate.label, () => candidate.qid);

// 3. `normaliseQid` returns `Option<string>`.
// 0.9: const qid = normaliseQid(input); if (qid === null) …
const qid = normaliseQid(input);
if (Option.isNone(qid)) return invalid();
use(qid.value);
```

If you store facts, nothing changes there: the fact shapes are persisted JSON and still use `null`, for example `DateFact.precision` and `DateFact.calendar`.

### The pattern

| 0.9                                | 0.10 (`import * as Option from "effect/Option"`)      |
| ---------------------------------- | ----------------------------------------------------- |
| `x ?? fallback`                    | `Option.getOrElse(x, () => fallback)`                 |
| `x === null` / `x === undefined`   | `Option.isNone(x)`                                    |
| `x !== null ? f(x) : other`        | `Option.match(x, { onNone: () => other, onSome: f })` |
| `result?.field` (both absent-able) | `Option.flatMap(result, (r) => r.field)`              |
| writing JSON or a nullable column  | `Option.getOrNull(x)`                                 |

A getter that used to **succeed with `null`** when the thing doesn't exist upstream (a missing page, file or item) now succeeds with `Option.none()`. It still fails only with `WikimediaError`:

```ts
// 0.9
const page = yield * Action.getWikitext(host, title);
if (page === null) return notFound();
use(page.wikitext);

// 0.10
const page = yield * Action.getWikitext(host, title);
if (Option.isNone(page)) return notFound();
use(page.value.wikitext);
```

Wire-shape schemas (`*Response`) keep `undefined` for absent JSON keys. Only the normalised results change.

### By surface

**Core**

- `sanitiseText(value)` takes an optional `string` (`value?: string`) and `toNonNegativeInt(value, max)` an optional `number`, where both took `unknown`. They still return `string | null` and `number | null`. Narrow a value you hold as `unknown` first, or decode it with a schema.
- `detectMaxlagSignal(body)` takes a `Schema.Json` (what `response.json` yields) rather than `unknown`.

**Action**

- `getWikitext`, `getPageMetadata` and `parsePage` (and `normaliseWikitext`, `normalisePageMetadata`, `normaliseParse`): `T | null` → `Option<T>`.
- Result fields that are now `Option`s:
  - `WikitextResult`: `pageId`, `revisionId`, `timestamp`.
  - `PageMetadata`: every field except `title`.
  - `SearchResult`: `pageId`, `snippet`, `wordCount`.
  - `ParsedSection`: `level`, `anchor`.
  - `ParsedPage`: `pageId`.
- `SiteinfoResponse` and `MagicWordsResponse` leaves are typed (`number`, `string`) rather than `unknown`. This matters only if you build them by hand.
- So are the leaves of `WikitextResponse`, `PageMetadataResponse`, `SearchResponse` and `ParseResponse` that the normalisers read (page ids and lengths are `number`; titles, timestamps, snippets and anchors are `string`; a section's `hLevel` is `number`, decoded from a numeric string too). A value of the wrong kind is dropped at decode.

**Rest**

- `PageMetadataResponse` and `RevisionMetadataResponse` leaves are typed (`number`, `string`, `boolean`) rather than `unknown`. This matters only if you build them by hand.
- `PageMetadata`: `pageId`, `key`, `contentModel`, `latestRevisionId`, `latestTimestamp`, `licenseUrl` are `Option`s.
- `RevisionMetadata`: `pageId`, `pageTitle`, `size`, `minor`, `timestamp`, `contentModel`, `licenseUrl` are `Option`s.

**Commons**

- `filePathUrl` returns `Option<string>`.
- `getFileInfo` succeeds with `Option<FileInfo>`.
- `FileInfo`: `url`, `descriptionUrl`, `width`, `height`, `mime`, `size` are `Option`s.

**Sparql**

- `LiteralTerm`: `datatype`, `language` are `Option`s.
- `UnknownTerm`: `type`, `value` are `Option`s.
- `SparqlResults.boolean` (the `ASK` answer) is an `Option`.
- `literalKind(datatype, language)` takes `Option`s.
- `SparqlResultsResponse` term leaves are `string`. This matters only if you build them by hand or call `normaliseTerm` directly.

**Dumps**

- `PageRef`: `title`, `ns`, `id`, `redirect` are `Option`s.
- `Contributor`: `username`, `id`, `ip` are `Option`s.
- `Revision`: `parentId`, `timestamp`, `contributor`, `comment`, `model`, `format`, `text`, `sha1` are `Option`s, and `Revision.id` is a plain `number`.
- `PageRevisionError.page` is always a `PageRef`.
- `MultistreamRange.end` is `Option<number>`.
- `decodeIndexLine`, `stripFraming` and `decodeEntityLine` return `Option`.
- `Revision.minor` is renamed `isMinor`.
- `PageRef`, `Contributor`, `Revision`, `PageRevisionHit`, `PageRevisionError`, `PageRevisionRecord` and `MultistreamRange` are now `Schema`s as well as types. The types are unchanged apart from `isMinor`. Encoded, an absent field is `null`, so persist a record with `Schema.encodeSync(Dumps.PageRevisionRecord)` rather than spreading it.

**Reconciliation**

- `WikidataCandidate`: `label`, `description` are `Option`s.
- `normaliseLabelQuery`, `normaliseQid`, `normalisePropertyId`, `normaliseExternalIdValue`, `sanitiseCandidateText`, `normaliseTimeValue`, `normaliseCommonsImage` and each `ExternalIdAuthority.iri` return `Option`.
- `sanitiseCandidateText` takes an optional `string`, and `normaliseTimeValue` and `normaliseCommonsImage` take `string`, where all three took `unknown`. Decode a value you hold as `unknown` before calling them.
- `WikidataLookup.enrich` succeeds with `Option<WikidataFacts>`.
- The stored fact shapes (`WikidataFact`, `DateFact.precision` / `calendar`) still use `null`: they are JSON you persist.

**Wikidata**

- `parseItemId`, `parsePropertyId`, `parseLexemeId` and `parseEntityId` return `Option` of the branded id.
- `decodeEntity`, `normaliseItem`, `normaliseStatement` and `normaliseSnak` return `Option`.
- `normaliseDataValue` takes the datatype as `Option<string>`.
- Model fields that are now `Option`s:
  - `WikidataItem.type`, `Statement.id`, `Reference.hash` and each snak's `datatype`.
  - The datavalue members' metadata:
    - `WikibaseEntityIdValue.entityType`.
    - `TimeValue`'s `precision`, `calendarModel`, `timezone`, `before` and `after`.
    - `GlobeCoordinateValue`'s `latitude`, `longitude`, `altitude`, `precision` and `globe`.
    - `QuantityValue`'s `unit`, `upperBound` and `lowerBound`.
    - `MonolingualTextValue.language` and `UnknownValue.type`.
  - `SearchHit`'s `label`, `description`, `matchType` and `matchText`.
- `getEntities` still resolves to a record keyed by id, so absence there is still "no key".
- The entity reader takes parsed JSON rather than `unknown`:
  - `decodeEntity(raw: Schema.Json)`.
  - `normaliseItem`, `normaliseStatement`, `normaliseSnak` and `normaliseDataValue` take a `Schema.JsonObject`.
  - The id parsers take a `string`.
  - Decode a value you hold as `unknown` first, for example with `Schema.decodeUnknownOption(Schema.Json)`.
- `WbGetEntitiesResponse.entities` holds each entity as parsed JSON. An entity with a container of the wrong kind now yields a best-effort item, as a dump line does, rather than failing the whole response.

**Wikitext**

- `paramName`, `getParam` and `redirectTarget` return `Option<string>`.
- A `TemplateRenderer`'s `param(key)` returns `Option<string>`: `param(1) ?? ""` becomes `Option.getOrElse(param(1), () => "")`.
- AST fields that are now `Option`s, always present (no longer `undefined`):
  - `Param.name`: `None` for a positional parameter.
  - `Argument.default`.
  - `ExternalLink.label`.
  - `Tag.rawContent` and `Tag.closeRaw`.
  - `TableCaption.attrs` and `TableCell.attrs`.
  - `TableRow.open`: `None` for an implicit row.

  Code that builds nodes by hand passes `Option.none()` or `Option.some(…)`. `serialize(parse(s)) === s` still holds.

- Optional members of the options objects (`ParseOptions.offset`, `CitationsOptions.names`, `InfoboxesOptions.names`, `RedirectTargetOptions.aliases`, `StripToTextOptions.templates` / `templateFallback` / `hiddenLinkPrefixes`) are `?: T`, no longer `?: T | undefined`: omit the key instead of passing `undefined`.
