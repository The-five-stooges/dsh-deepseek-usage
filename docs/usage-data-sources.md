# Where usage numbers come from — and why they cannot come from the API

Measured 2026-09-18. Every claim below is a probe result, not an assumption. Reproducing
scripts: `tools/cdp/probe-official-usage-api.mjs`, `probe-platform-auth.mjs`,
`enumerate-platform-api.mjs` (in the session workspace, not in this package).

## The question this answers

The popover shows an estimated cost next to a real balance. Users reasonably ask why the
usage numbers are computed locally instead of read from DeepSeek. The answer is that
**DeepSeek publishes no usage API at all** — so this document exists to stop the next
investigator from re-deriving that.

## 1. `api.deepseek.com` has exactly one billing endpoint

With a real API key (`<DSH_HOME>/.credentials.yaml`, `refs.DEEPSEEK_API_KEY`):

| endpoint | result |
| --- | --- |
| `GET /user/balance` | **200** `{"is_available":bool,"balance_infos":[…]}` |
| `GET /v1/user/balance` | **200** (same shape) |
| `GET /user/usage` · `/user/billing` · `/user/consumption` · `/user/statistics` · `/user/info` · `/usage` | 404 |
| `GET /dashboard/billing/usage` · `/dashboard/billing/subscription` | 404 (no OpenAI-shaped surface) |

`https://api-docs.deepseek.com/api/deepseek-api` is the OpenAPI index and lists no usage
endpoint either. **Balance is the only account figure an API key can read** — which is exactly
what `src/host/balance.mjs` uses, and why `src/host/ledger.mjs` must aggregate session logs.

## 2. The platform's own usage endpoints need a LOGIN TOKEN, not the API key

The usage page is served anonymously as a ~2.8 KB shell; its bundle
(`fe-static.deepseek.com/platform/static/main.<hash>.js`, ~2.5 MB) references 26 `/api/v0/*`
paths. The usage ones:

```
GET /api/v0/usage/by_api_key/amount    ← the official token usage
GET /api/v0/usage/by_api_key/cost      ← the official cost
GET /api/v0/usage/export
```

Their auth behaviour, measured:

| request | response |
| --- | --- |
| no `Authorization` | `200 {"code":40002,"msg":"Missing Token"}` |
| `Authorization: Bearer <API KEY>` | `200 {"code":40003,"msg":"Authorization Failed (invalid token)"}` |
| `api-key:` / `x-api-key:` header | `40002 Missing Token` |
| `POST` / `PUT` | `405 Method Not Allowed` (GET only) |

The token is the **platform session** token: the SPA keeps it in `localStorage.userToken`
(`{"value":null,…}` when logged out) and carries the session in a cookie. No API-key
exchange exists, and the host process cannot reach a browser session.

## 3. What that means for this plugin

- The host half **cannot** read official usage. The estimate stays.
- The only route to official numbers is the user's own logged-in browser: an extension
  injected into `platform.deepseek.com` could call those endpoints same-origin (the cookie
  rides along, so there is no CORS problem) and post the result back to a plugin route. That
  was offered and declined on 2026-09-18.
- Because the estimate is local, its **scope is part of the interface** — `usage.scope` in
  `src/client/modal.mjs` states that it covers only this machine's DSH session logs. Measured
  evidence for why that sentence matters:

  | day | sessions | settlements | estimate | platform | ratio |
  | --- | --- | --- | --- | --- | --- |
  | 2026-09-16 | 3 | 248 | ¥5.02 | ¥13.60 | ×2.71 |
  | 2026-09-17 | 12 | 2,365 | ¥30.55 | ¥31.28 | ×1.02 |

  2026-09-16 has **no session log before 07:05Z (15:05 Beijing)**, so anything billed to the
  account earlier that day — another PC, the web UI, a tool calling the API directly — is
  invisible here. The 09-17 gap is the same effect, much smaller because that day's logs are
  nearly complete. Both are coverage, not pricing: the price table matches the Chinese pricing
  page line by line, every 09-16 settlement falls inside a peak window (so a window bug could
  only make the estimate *higher*), `cacheWriteTokens` is 0 throughout, `reasoningTokens` is a
  subset of `outputTokens`, and UTC vs Beijing day boundaries give byte-identical results.

## 4. Related fix found while investigating

The incremental index was keyed only on each log's `mtimeMs + size`, so it knew when a LOG
changed and nothing about when the PRICES changed: a re-priced table kept serving the old
basis until every session log happened to be touched. `priceDigest()` in `src/host/ledger.mjs`
now folds a fingerprint of the price list into the index, so a price change invalidates every
cached cost.

The same module's `defaultCacheDir()` also used to resolve to
`<DSH_HOME>/plugins/dsh-deepseek-usage/.ledger-cache` — which IS the package directory when
the plugin is installed where the loader expects it. It now matches
`plugin.mjs#defaultLedgerCacheDir` (`<DSH_HOME>/storages/<plugin>/ledger-cache`, OS temp when
`DSH_HOME` is unset).
