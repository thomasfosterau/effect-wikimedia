---
"@thomasfosterau/effect-wikimedia": minor
---

**Breaking:** `Core.withMaxlagRetry` (and so every `WikimediaClient` request) no longer retries sooner than the server asks. When a `429`, `503` or `maxlag` response's `Retry-After` is longer than `RetryOptions.maxDelaySeconds`, the request fails with `RateLimited` straight away, with no wait and no retry; before, it slept `maxDelaySeconds` and retried early. A `Retry-After` within the cap is still waited out in full and retried. Callers who relied on a capped wait now see `RateLimited`: raise `maxDelaySeconds` to wait longer.
