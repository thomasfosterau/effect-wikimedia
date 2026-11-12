# Migrating

## 0.9 → 0.10: `Option` for absent values

0.10 replaces `null` and `undefined` with Effect's `Option` wherever this package reports that a value is missing (#224). It is breaking for every surface, but the change is mechanical: each place you checked for `null` or `undefined`, you now match on an `Option`.

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

**Action**

- `getWikitext`, `getPageMetadata` and `parsePage` (and `normaliseWikitext`, `normalisePageMetadata`, `normaliseParse`): `T | null` → `Option<T>`.
- Result fields that are now `Option`s:
  - `WikitextResult`: `pageId`, `revisionId`, `timestamp`.
  - `PageMetadata`: every field except `title`.
  - `SearchResult`: `pageId`, `snippet`, `wordCount`.
  - `ParsedSection`: `level`, `anchor`.
  - `ParsedPage`: `pageId`.
- `SiteinfoResponse` and `MagicWordsResponse` leaves are typed (`number`, `string`) rather than `unknown`. This matters only if you build them by hand.

**Rest**

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
- `WikidataLookup.enrich` succeeds with `Option<WikidataFacts>`.
- The stored fact shapes (`WikidataFact`, `DateFact.precision` / `calendar`) still use `null`: they are JSON you persist.

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
