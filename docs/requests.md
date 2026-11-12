# Requests: User-Agent, etiquette and CORS

Every `Action`, `Rest`, `Commons`, `Wikidata` and `Sparql` request goes through `Core.WikimediaClient`, which applies the UA policy, the `maxlag` etiquette and the Action API's `origin=*` (see [Anonymous requests](#anonymous-requests) below), and retries a `429`/`503`/in-body maxlag signal automatically. `Core.wikimediaLayer` is the production layer (over the platform `fetch`); in tests, provide `Core.wikimediaClientLayer` over a stubbed `HttpClient` instead.

## User-Agent

Wikimedia's [User-Agent policy](https://meta.wikimedia.org/wiki/User-Agent_policy) asks every caller to identify itself with contact details, so problem traffic can be raised with its owner rather than blocked. By default every request sets both the `User-Agent` and the `Api-User-Agent` header to `Core.USER_AGENT`, which names only this package (`effect-wikimedia (+https://www.npmjs.com/package/@thomasfosterau/effect-wikimedia)`). Set your own through the `Core.UserAgent` reference, which sets both headers; in Node both are sent verbatim:

```ts
import * as Layer from "effect/Layer";

const userAgent = "my-bot/1.2 (https://example.org/my-bot; bot@example.org) effect-wikimedia";

const program = Action.getWikitext("en.wikipedia.org", "Douglas Adams").pipe(
  Effect.provide(
    Core.wikimediaLayer.pipe(Layer.provideMerge(Layer.succeed(Core.UserAgent, userAgent))),
  ),
);
```

In a browser, the browser decides what happens to `User-Agent`. The Fetch standard lets a page set it, but Chromium-based browsers silently drop it and send their own. Wikimedia's [API etiquette](https://www.mediawiki.org/wiki/API:Etiquette#The_User-Agent_header) asks browser clients to send an `Api-User-Agent` header instead, and browsers send that one as given, so your value still reaches Wikimedia.

The cost is a CORS preflight. `Api-User-Agent` isn't a [CORS-safelisted request header](https://fetch.spec.whatwg.org/#cors-safelisted-request-header), so a browser sends an `OPTIONS` request before a cross-origin request, and Wikimedia's APIs set no `Access-Control-Max-Age`, so the browser caches each preflight for only about 5 seconds. The Action API with `origin=*` (see [Anonymous requests](#anonymous-requests) below) and the REST API allow the header in their preflight responses: both allow the headers in MediaWiki's [`$wgAllowedCorsHeaders`](https://github.com/wikimedia/mediawiki/blob/18d8c1070cde87412919f36e46a8197185534272/includes/MainConfigSchema.php#L12992-L13011), which lists `Api-User-Agent`. WDQS's [nginx config](https://github.com/wikimedia/operations-puppet/blob/1a24a2a3354c4a147ac712d1cfb01879b01611e3/modules/query_service/templates/nginx.erb#L253-L259) lists it too, though no live WDQS preflight has been checked. A browser that honours a script-set `User-Agent` preflights already, because that header isn't safelisted either.

`Dumps.fromHttpRange` sends `User-Agent` only: it's a Node download from the dump host, which serves files rather than an API.

`Core.WikimediaClient` reads the reference once, when its layer is built. `Dumps.fromHttpRange` reads it from the program's context when the stream runs, or takes a `userAgent` option that wins over it. Merging the reference into the layer with `Layer.provideMerge`, as above, reaches both (`Dumps.fromHttpRange` also needs an `HttpClient`, such as `FetchHttpClient.layer`, which `Core.wikimediaLayer` doesn't expose). So does `Effect.provideService(Core.UserAgent, userAgent)` placed outside the `Effect.provide` that builds the layer. `Layer.provide` reaches the client only. A `provideService` the layer build doesn't see reaches the dump download only: one applied inside `Effect.provide(Core.wikimediaLayer)`, or per run on a `ManagedRuntime` made from the layer.

## Anonymous requests

Every Action API (`/w/api.php`) request carries `origin=*`, so a page on another origin can read the response: without an `origin` parameter MediaWiki sends no CORS headers on the Action API. `origin=*` is MediaWiki's anonymous mode, so `Action`, `Commons`, `Wikidata` and `Reconciliation` make anonymous requests. MediaWiki answers as a logged-out user whatever credentials arrive, which is all these read-only surfaces need, and their limits are already the anonymous ones. Two setups lose their credentials:

- an on-wiki gadget or user script on the same origin that relies on the user's session cookies;
- a caller that adds an `Authorization` header (an OAuth token, say) through `HttpClient.mapRequest`.

`Rest` and `Sparql` requests don't carry the parameter, because the REST API and WDQS already send CORS headers without it. A request you build yourself for `Core.WikimediaClient` keeps any `origin` you put in its `params`, sent instead of `*`. If its `params` carry `crossorigin`, it gets no `origin=*`. `crossorigin` is MediaWiki's authenticated-CORS mode, which needs an `Authorization` header; without one, MediaWiki rejects the request. MediaWiki also returns a 403 for a request that carries both `origin` and `crossorigin`, so don't put both in `params`.
