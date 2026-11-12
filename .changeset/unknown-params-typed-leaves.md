---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** typed parameters for the response helpers, and typed leaves in the remaining response schemas (#224).

Response-schema leaves that a normaliser reads as a string, number or boolean are now `Core.lenientField(Schema.String | Schema.Number | Schema.Boolean)` instead of `Schema.optional(Schema.Unknown)`. A value of the wrong kind is dropped at decode, as it is for the schemas already converted. Decoding a real response behaves as before.

- `Action.WikitextResponse`, `Action.PageMetadataResponse`, `Action.SearchResponse` and `Action.ParseResponse`: page ids, revision ids, lengths and word counts are `number`; titles, timestamps, content models, languages, snippets, section lines and anchors and the `"*"` text are `string`. A section's `hLevel` is `number`, and a numeric string still decodes to one.
- `Rest.PageMetadataResponse` and `Rest.RevisionMetadataResponse`: ids and `size` are `number`, `minor` is `boolean`, and keys, titles, timestamps, content models and license URLs are `string`.

The `Type`s of those schemas narrow from `unknown`, so code that builds them by hand must now pass the typed values.

Helper signatures that took `unknown` now take the type their callers hold:

| Helper                                 | Before                   | After                    |
| -------------------------------------- | ------------------------ | ------------------------ |
| `Core.sanitiseText`                    | `(value: unknown)`       | `(value?: string)`       |
| `Core.toNonNegativeInt`                | `(value: unknown, max?)` | `(value?: number, max?)` |
| `Core.detectMaxlagSignal`              | `(body: unknown)`        | `(body: Schema.Json)`    |
| `Reconciliation.sanitiseCandidateText` | `(value: unknown)`       | `(value?: string)`       |
| `Reconciliation.normaliseTimeValue`    | `(raw: unknown)`         | `(raw: string)`          |
| `Reconciliation.normaliseCommonsImage` | `(raw: unknown)`         | `(raw: string)`          |

Their returns are unchanged. A value you hold as `unknown` must be decoded with a schema before it reaches them.

**Wikidata:** the entity reader takes parsed JSON instead of `unknown` (option (B) on #224).

- `decodeEntity` takes `Schema.Json`.
- `normaliseItem`, `normaliseStatement`, `normaliseSnak` and `normaliseDataValue` take `Schema.JsonObject`.
- `parseItemId`, `parsePropertyId`, `parseLexemeId` and `parseEntityId` take `string`.
- `WbGetEntitiesResponse` keeps each entity as `Schema.Json`, read by the same defensive reader as a dump line. A wrongly shaped container inside one entity now degrades that entity instead of failing the response.
- `Dumps` parses each entity line with `Schema.fromJsonString(Schema.Json)`. That costs about 11 µs per 4.5 KB line, and the hand reader itself is unchanged.
