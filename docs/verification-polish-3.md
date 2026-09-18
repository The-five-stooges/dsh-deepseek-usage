# verification-polish-3 — the currency and the tooltip layout

Round 4. Two requests:

1. 图表和最底部的表格上是美元符号 → replace it;
2. 图表上的输入输出等 token 数与文字的排版最好有一定换行（输入一行、输出一行）。

The first one turned out **not** to be a symbol swap. Measured evidence below.

---

## 1. The currency was wrong in the DATA, not just in the symbol

The plugin's price table had been copied from the ENGLISH pricing page, which quotes USD:

```
PRICE_TABLE_USD_PER_MILLION  deepseek-flash  peak { cacheRead: 0.006, cacheMiss: 0.3, output: 1.2 }
PRICE_TABLE_SOURCE           { url: "…/quick_start/pricing", currency: "USD", fetchedOn: "2026-09-17" }
```

The Chinese page (`/zh-cn/quick_start/pricing`, fetched 2026-09-18) quotes **different
numbers** for the same models, in 元:

| | flash 命中 / 未命中 / 输出 | pro 命中 / 未命中 / 输出 |
| --- | --- | --- |
| English page (USD) | 0.003·0.006 / 0.15·0.3 / 0.6·1.2 | 0.022·0.044 / 0.66·1.32 / 1.98·3.96 |
| Chinese page (元) | 0.02·0.04 / 1·2 / 4·8 | 0.15·0.30 / 4.5·9.0 / 13.5·27.0 |

So "just change the symbol" would have printed the dollar numbers as yuan. The peak
windows agree across both pages (Beijing 09:00-12:00 / 14:00-18:00 = UTC 01-04 / 06-10),
which is what confirms both tables describe the same product — only the currency differs.

Measured on the live page before the change:

| model | input (miss) | cache hit | output | total | shown |
| --- | --- | --- | --- | --- | --- |
| deepseek-flash | 3.9M | 755.3M | 2.5M | 761.8M | **$5.35** |
| 窗口合计 | 4M | 755.3M | 2.5M | 761.8M | **$5.36** |

Applying the official yuan list to those same counts gives ≈18 元 — i.e. the old $5.35 was
the *dollar* reading of that usage, and the account (whose balance payload carries CNY and
whose `balance.mjs` prefers CNY, line 231) is billed in yuan.

### What changed

- `PRICE_TABLE_CNY_PER_MILLION` now holds the **Chinese page's yuan prices**, and
  `PRICE_TABLE_SOURCE` records `currency: "CNY"`, the zh-cn URL, `fetchedOn: "2026-09-18"`
  and the Beijing peak windows alongside the UTC ones.
- `estimatedCostUsd` → `estimatedCostCny` (135 identifier replacements across 9 files,
  done by a script with word boundaries so prose in `docs/` was left alone).
- `formatMetricValue` (cost branch) prints the symbol from `format.mjs`'s own
  `currencySymbol()` table via `COST_CURRENCY = "CNY"`, never a literal; `$` is gone.
- The table header reads 估算费用（元） and the chart note 官方峰谷单价（人民币元…）.
- **The incremental index now carries a price fingerprint** (`priceDigest()`), so editing
  the price list invalidates every cached cost. Before this, the index was keyed only on
  each log's `mtimeMs` + `size`: it knew when the *log* changed and nothing about when the
  *prices* changed, so a re-priced run kept serving the old basis until every session log
  happened to be touched. That is a standing hazard for any future price update, and it is
  what would have made this change look like it "did nothing".
- **Name compatibility:** the client reads either `estimatedCostCny` or the legacy
  `estimatedCostUsd` (`costOf()`), because the bundle is fetched per page load while the
  host process keeps running. Without it, a new page against an un-restarted host renders
  an all-zero cost chart. This is a name shim, not a conversion.

### Verified live (problem 1)

| probe | result |
| --- | --- |
| `$` occurrences in the whole panel | **0** |
| `¥` occurrences | **11** |
| cost axis ticks | `¥0 … ` (see the restart note below) |
| table header | `模型 \| 输入（未缓存） \| 缓存命中 \| 输出 \| 合计 \| 估算费用（元）` |
| chart note | `估算值：本地聚合 token × 官方峰谷单价（人民币元，非平台账单）` |
| tooltip cost line, before the host restart | `费用 = ¥4.57`, `¥0.008021`, 合计 `¥4.58` (the legacy shim, correctly priced, not `¥0`) |

### ⚠️ The host must be restarted to finish this

The running host process was started at **08:16:48**; the price table was edited at
**12:29:32**. Node keeps the loaded module in memory, so the live API still answers with
the old field and the old basis:

```
$ curl … /api/dsh-deepseek-usage/usage?days=30
totals fields: cacheReadTokens, estimatedCostUsd, inputTokens, outputTokens
{"…","estimatedCostCny" absent,"estimatedCostUsd":5.47684425}
```

Until the host is restarted, the panel shows **¥4.57 etc. — a yuan sign on the OLD
dollar-basis number.** That is deliberately the lesser evil (the alternative, reading only
the new field, draws ¥0 for every day), but it is not yet correct. After a restart the API
serves `estimatedCostCny` computed from the yuan list, and the figures become real yuan
(≈29.7–59.3 元 for the 30-day window, depending on how much of it fell in peak hours).

## 1b. Reconciled against a real bill (2026-09-17)

The user read **¥31.28** for 2026-09-17 off the platform page. Running the ledger module
with the new yuan table (a direct module call, so no stale host process is involved):

```
2026-09-16  miss=   743,122  hit= 50,428,672  out=  189,083   ¥5.02
2026-09-17  miss= 3,203,918  hit=699,722,240  out=2,326,472   ¥30.55   ← official ¥31.28
2026-09-18  miss=    72,573  hit= 38,501,504  out=   67,067   ¥1.11
30-day totals: { inputTokens: 4,019,613, cacheReadTokens: 788,652,416,
                 outputTokens: 2,582,622, estimatedCostCny: 36.68 }
```

**¥30.55 vs ¥31.28 = 2.3 % low (¥0.73).** Measured precisely on 2026-09-18
(`tools/cdp/reconcile-0917b.mjs` — 2,365 settlements, token counts read through the ledger's
own `usageSampleOf`, so the accounting is identical to the report's):

```
all off-peak : ¥26.5043
actual mix   : ¥30.5493     ← what the report draws
all peak     : ¥53.0085
platform     : ¥31.2800
```

### What the ¥0.73 is NOT — each ruled out by measurement

| hypothesis | measurement | verdict |
| --- | --- | --- |
| **exchange-rate drift** | both sides are already CNY; the table IS the yuan list, and nothing converts USD→CNY anywhere | **impossible** |
| cache-write tokens (3元/M peak — the ledger reads `cacheWriteTokens` but never prices it) | `cacheWriteTokens` = **0** across all 2,365 settlements | no |
| reasoning tokens billed on top of output | `reasoningTokens` = 973,053 and is a **subset** of `outputTokens` (`totalTokens = input + output` on the wire) | no |
| UTC vs Beijing day boundary | both boundaries give **¥30.5493** — identical to the cent | no |
| peak window transcribed wrongly | Beijing 09:00-12:00 / 14:00-18:00 → UTC 01:00-04:00 / 06:00-10:00, exactly as the English page states it in UTC | correct as published |
| a call STARTING inside peak but settling after it | a 0→60 min lookback sweep only reaches ¥30.7512 (residual still ¥0.53), and there is **no** settlement volume within 10 min of any window edge (0 cache-hit tokens on both sides) | cannot explain it |

So the residual is a **2.3 % understatement** with every structural hypothesis excluded. The
remaining explanation is an **attribution/counting difference**: the platform's own
input/output/cache split for that day need not equal what the DSH session logs record.

Settling it needs the platform's three numbers for the day — 输入(缓存命中) / 输入(缓存未命中) /
输出 — from `platform.deepseek.com/usage`. This estimate's own figures for 2026-09-17:

```
cache hit   699,722,240
cache miss    3,203,918
output        2,326,472   (reasoning 973,053 included)
```

If the platform's totals match these, the gap is in the rate application; if they differ, it
is in capture and the ledger's source is what to look at. Left as a known 2.3 % rather than
tuned away with a fudge factor.

What the user saw instead — **¥4.58** for that same day — was the running host process
computing with the OLD table: a host started at 08:16:48 keeps its loaded modules, and the
price table was edited at 12:29:32. That host also still reports the pre-rename field:

```
$ curl … /api/dsh-deepseek-usage/usage?days=30
totals fields: cacheReadTokens, estimatedCostUsd, inputTokens, outputTokens
```

so no amount of reloading the page can fix the figure — **the host has to be restarted.**
(Verified after the fact by calling `aggregateUsage` directly from the new module: same
inputs, ¥30.55, i.e. the discrepancy is entirely "which price table is in memory".)

### How the ledger is decoded (for the next investigator)

Each `session.v3.jsonl.zstd` is a **concatenation of zstd frames**. A single streaming
decompressor reads only the first frame and yields just the `session` header line, which
is why a hand-rolled audit sees zero usage events while the ledger reports thousands —
`zstdDecompressSync` consumes the frames in sequence. Audit through the ledger module, or
decode frame by frame; do not conclude "there is no usage data" from a stream read.

## 1c. A second, unrelated defect found while auditing: the ledger's default cache path

`plugin.mjs#defaultLedgerCacheDir` (the value production actually injects) is correct:
`<DSH_HOME>/storages/<plugin>/ledger-cache`, documented as deliberately outside the
package because a package's `files` manifest is what gets published.

`ledger.mjs#defaultCacheDir` — the fallback for a caller that injects nothing — computed
`<DSH_HOME>/plugins/dsh-deepseek-usage/.ledger-cache`. That looks external, but a plugin
INSTALLED at `<DSH_HOME>/plugins/<name>` **is** that directory, so a bare-ledger host wrote
its index into the installed tree. Measured on this machine:

```
defaultCacheDir({DSH_HOME: '<…>/launcher/home'})
  before:  <…>/launcher/home/plugins/dsh-deepseek-usage/.ledger-cache   ← inside the package
  after:   <…>/launcher/home/storages/dsh-deepseek-usage/ledger-cache
defaultCacheDir({})            before: <homedir>/.dsh/plugins/…/.ledger-cache
                               after:  <os tmp>/dsh-home/storages/dsh-deepseek-usage/ledger-cache
```

Found because a `.ledger-cache` directory appeared **inside the package** during this
round's verification runs; `git status`/`npm pack` would have picked it up. The existing
"cache ruling" tests could not see it: they assert against `plugin.mjs`'s function and use
a temporary home, so the fallback path and the real install layout were both untested. A
new test now pins the two defaults together and asserts the resolved path stays out of the
package **for a plugin installed under `DSH_HOME`**, which is the case that was broken.

## 2. The tooltip stacks one metric per line

`tooltipRowText` used to join every figure into one sentence
(`"3,179,407 输入 · 699,697,920 缓存读 · 2,326,037 输出 · ¥4.57"`), which wrapped wherever
it ran out of room. The DOM now paints a **block per model** and **one line per metric**,
with a label column and a right-aligned number column; the plain-text form is generated
from the same field list (`tooltipFields` / `tooltipTotalFields`), so layout and text
cannot drift.

Measured on the live popover, hovering the busiest day (2026-09-17, 705,252,630 tokens):

```
气泡 178x461   行数=13   块数=3
── deepseek-flash     [input] 输入 = 3,179,407 | [cacheRead] 缓存读 = 699,697,920
                      [output] 输出 = 2,326,037 | [cost] 费用 = ¥4.57
── deepseek-v4-flash  [input] 输入 = 24,511 | [cacheRead] 缓存读 = 24,320
                      [output] 输出 = 435 | [cost] 费用 = ¥0.008021
── 合计               [input] 输入 = 3,203,918 | [cacheRead] 缓存读 = 699,722,240
                      [output] 输出 = 2,326,472 | [total] 合计 = 705,252,630
                      [cost] 费用 = ¥4.58
```

## Suite state

```
node --test  →  221 tests, 220 pass, 0 fail, 1 skipped
node scripts/compose-client.mjs --check  →  in sync
```

New tests this round:

- `pricing: peak windows and weekday rules are exact` — now pins **both** price lists
  number by number, plus `currency: "CNY"` and the Beijing windows;
- `cache: a change to the PRICE LIST invalidates every cached cost` — writes the cache,
  corrupts the stored `prices` digest, and asserts the next run re-decodes (`decodes === 1`)
  and restamps the index;
- `cache ruling: the ledger's OWN default agrees, and survives a plugin installed under
  DSH_HOME` — the defect in §1c;
- `chart: an older host's estimatedCostUsd payload is still priced, not reported as ¥0`;
- `chart: formatMetricValue keeps costs readable below a cent, in CNY` (asserts `¥` and
  that no `$` can appear).

Also repaired while here: the test `http: chart projections are one { label, value } per
day on the frozen axis` hardcoded the fixture's day totals, but the window rolls with the
wall clock — the fixture's fixed dates (2026-09-15..17) fell out of the trailing 7-day
window on 2026-09-18 and the assertion went red for a reason unrelated to any code change.
It now asserts the axis and the totals identity instead, which is what it was named for.

## What this round does NOT claim

- **The live figures are not yet the final ones** — see the restart note above. The code
  is correct and tested; the running host is stale.
- I did not compare the new estimate against a real DeepSeek bill; the claim is only that
  the numbers now come from the Chinese page's yuan list.
- The middle of the popover (balance cards, model table body) was not re-measured this
  round beyond the currency checks above.
- `src/host/plugin.mjs` (`7723B45E01C1FC90`) and `package.json` (`66771A687F829F86`) are
  untouched. Rollback copy of the whole package before this round:
  `D:\Temp\Administrator\dsh-usage-backup-20260918-122357`.
