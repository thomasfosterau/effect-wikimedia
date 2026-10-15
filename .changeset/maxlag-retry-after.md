---
"@thomasfosterau/effect-wikimedia": patch
---

`Core.WikimediaClient` now honours the `Retry-After` header on the Action API's `maxlag` error body, as it already did on a `429` or `503`. MediaWiki sends `Retry-After` set to the larger of the request's `maxlag` parameter and 5 seconds; the client used to ignore it and retry after `Core.DEFAULT_MAXLAG_SECONDS` (5), sooner than asked whenever the request's `maxlagSeconds` was above 5. Callers with the default `maxlagSeconds` (5) were not affected. `RateLimited.retryAfterSeconds` for a `maxlag` body is now the header's value when it is a number of seconds, and still 5 when the header is absent or an HTTP date. Each wait stays capped by `RetryOptions.maxDelaySeconds` (30 by default). The doc comments on `Core.detectMaxlagSignal` and `Core.RateLimited`, which said the header is not sent, are corrected, and `Core.DEFAULT_MAXLAG_SECONDS` now says it is also the fallback wait.
