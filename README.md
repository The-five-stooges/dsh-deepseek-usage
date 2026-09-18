# dsh-deepseek-usage

A DSH web plugin that puts your **DeepSeek account balance in the sidebar footer, above the
Settings row**, with a refresh button. Clicking the row opens a popover with the balance card,
locally aggregated usage charts, a per-model breakdown table, and a link to
`platform.deepseek.com/usage`.

Everything renders inside the shell's own theme tokens, so light and dark both work.

| In the sidebar footer | In the popover |
| --- | --- |
| One row: `DeepSeek 余额 ¥85.66` + refresh. Collapsed to the 56px rail it degrades to the icon, with the number in its tooltip. | Balance card (total / topped-up / granted / currency / availability / data time / source), a daily-token line chart and a daily-estimated-cost bar chart over a 7/30-day window, a per-model table, and an "open the usage page" button. |

## What it shows, and where the numbers come from

| Figure | Source | Authoritative? |
| --- | --- | --- |
| Balance | `GET https://api.deepseek.com/user/balance`, server-side, cached 60 s | yes — this is the official endpoint |
| Usage / cost | aggregated from this machine's DSH session logs (`assistant/message` and `assistant/attempt` usage), priced with the official peak/off-peak rate card | **no — it is a local estimate** |

The usage side is deliberately labelled an estimate, and the panel states its scope, because
DeepSeek publishes **no usage API**: `api.deepseek.com` exposes exactly one account endpoint
(`/user/balance`), and the platform's own usage endpoints require a browser login token rather
than an API key. The measurements behind that claim are in
[`docs/usage-data-sources.md`](docs/usage-data-sources.md).

Two consequences worth knowing before you install it:

- **The estimate only covers this machine's DSH session logs** (all workspaces on this
  machine). Usage billed to the same account from another PC, the web UI, or any other tool is
  invisible here, so the figures can be lower than the platform's bill. This is stated on the
  panel itself. Measured example: a day whose session logs only began at 15:05 local estimated
  ¥5.02 against a ¥13.60 platform bill, while a fully-logged day estimated ¥30.55 against
  ¥31.28.
- **Your API key never reaches the browser.** The key is resolved per operation through the
  host's credential store and used only in an `Authorization` header to `api.deepseek.com`.
  The client bundle contains no key material and no upstream origin (asserted by
  `tests/ui-row.test.mjs`).

## Install

```sh
dsh plugin add github:<your-owner>/dsh-deepseek-usage
```

Then restart the host process once (the host half is composed at startup) and reload the page.
The plugin declares `dsh.bundle`, so it is installable with `dsh plugin add`.

If your registry/storefront offers a prebuilt tarball, that skips the build-approval step. A
prebuilt `.tgz` is attached to this repository's releases:

```
https://github.com/<owner>/dsh-deepseek-usage/releases/latest/download/dsh-deepseek-usage.tgz
```

Requires a `DEEPSEEK_API_KEY` in the harness credential store (or the launch environment). With
no key the row renders an explicit "not configured" state instead of failing.

### Optional config

```yaml
- id: dsh-deepseek-usage
  config:
    timeoutMs: 10000   # upstream balance request timeout (default 10000)
    ttlMs: 60000       # successful-snapshot cache TTL (default 60000; force=1 bypasses)
```

## HTTP surface

Both routes are served by the host half on the session's own origin:

| Route | Success | Failure |
| --- | --- | --- |
| `GET /api/dsh-deepseek-usage/balance[?force=1]` | `{ ok:true, currency, totalBalance, grantedBalance, toppedUpBalance, isAvailable, fetchedAt, cached }` | `{ ok:false, error:{ code, message, httpStatus? } }` with a real status |
| `GET /api/dsh-deepseek-usage/usage[?days=N]` | `{ ok:true, requestedDays, days, generatedAt, truncated, totals }` | same envelope |
| `GET /api/dsh-deepseek-usage/health` (alias `/healthz`) | plugin name, version, ledger availability | — |

`tests/contract.test.mjs` is the single source of truth for those shapes; changing a response
means changing it.

## Known limitations

- The usage estimate misses anything not routed through this machine's DSH session logs (see
  above) — this is the main reason it can differ from the platform bill.
- The plugin cannot embed `platform.deepseek.com/usage`: the page sends
  `Content-Security-Policy: frame-ancestors 'none'`, so the popover links out instead.
- The bar chart shows an estimated cost derived from the published rate card; the platform's
  invoice remains authoritative.
- Engine floor: `dsh >= 0.1.5-rc.1`.

## Development

See [`DEVELOPMENT.md`](DEVELOPMENT.md) for the architecture, the frozen internal contracts, how
the browser bundle is composed from `src/client/*.mjs`, the verification documents, and how to
run the suite (222 tests).

```
lib/       generated browser half + host entry
src/host/  balance reader, session-log ledger, routes, cordis plugin
src/client/ row, service, chart, modal — composed into lib/client.js
tests/     contract, host, and UI suites
tools/     the real-browser layout probe the UI suite drives
docs/      verification records and measured design notes
```

```sh
node --test                              # full suite
node scripts/compose-client.mjs --check  # is lib/client.js in sync with src/client?
```

## License

MIT — see [LICENSE](LICENSE). Not affiliated with DeepSeek.
