# T9 独立复核：宿主半合并质量门（t2 余额/路由 + t3 台账聚合 + t4 装配）

- 复核者：`reviewer-foundation`（t9，attempt 1 / `b0ad0f1f-0b1d-4b5d-8c85-724921b591e9`）
- 被复核：`t2`（attempt 1）、`t3`（attempt 1）、`t4`（attempt 1）
- 复核时间：2026-09-17 20:2x–20:4x ｜ 只读；本文件是本次复核唯一写入路径
- 解释器：`C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe`（v24.13.1，宿主自身 Node）
- **裁决：verdict = pass**。三条 verify 与 integration 套件在我机器上全绿；五类错误分支可区分且结构化；聚合结果与我**自己手算**的求和逐字段一致；峰谷计价被真正断言（1.506 vs 0.753，恰为 2 倍）；两条路由在同一插件实例上真实并发服务；哨兵密钥在响应体/日志/URL 中均不出现；runtime 与 profiles 零写入。仅有 low 级观察项（§7），不阻塞。

> **重要前提：复核期间文件仍在被队友改动。** 我第一遍读到的是 `routes.mjs` 20:12:41 版；随后 `routes.mjs`(20:25:25)、`tests/host-integration.test.mjs`(20:26:38)、`tests/ui-row.test.mjs`(20:26:15) 又更新。**§1 的复跑与 §4 的探针均针对下列 revision 重跑**；任何此后的编辑都会使本裁决失效，请以 hash 为准。

---

## 1. 被验证的 revision（sha256 前 16 位 + mtime）

| 文件 | sha256 | mtime |
|---|---|---|
| `src/host/balance.mjs` | `346E83F939F56966` | 20:16:18 |
| `src/host/ledger.mjs` | `796B508CE5C55EA5` | 20:03:34 |
| `src/host/routes.mjs` | `2B2C70CADE03EC6E` | 20:25:25 |
| `src/host/plugin.mjs` | `357F275397C8F864` | 20:12:53 |
| `lib/index.js` | `833ACDF6D22458D0` | 19:44:07 |
| `tests/contract.test.mjs` | `33003B976555A574` | 20:16:38 |
| `tests/host-balance.test.mjs` | `DF4AD2D15E70CCCB` | 20:08:44 |
| `tests/host-ledger.test.mjs` | `50AFB5C7319EB3ED` | 20:04:07 |
| `tests/host-integration.test.mjs` | `6AB434DF941C04B4` | 20:26:38 |
| `package.json` | `66771A687F829F86` | 20:22:02 |

## 2. 三个套件（+integration）在本机复跑 — 成员自述不作数

| 套件 | exit | tests | pass | fail | skipped |
|---|---|---|---|---|---|
| `tests/contract.test.mjs` | 0 | 12 | 11 | 0 | 1（opt-in 活体检查） |
| `tests/host-balance.test.mjs` | 0 | 40 | 40 | 0 | 0 |
| `tests/host-ledger.test.mjs` | 0 | 17 | 17 | 0 | 0 |
| `tests/host-integration.test.mjs`（t4 验收项，额外跑） | 0 | 26 | 26 | 0 | 0 |
| 全量 `node --test`（自动发现，含 t5 的 `ui-row.test.mjs`） | 0 | 139 | 138 | 0 | 1 |

注：`node --test tests/`（带目录参数）在本机 Node 24 上会把 `tests` 当模块解析并报 `MODULE_NOT_FOUND`——**这是我的调用错误，不是产品缺陷**；正确用法是 `node --test`（自动发现）或逐文件指定。t4 自述的「135 tests / 134 pass」是当时的文件集合，现在为 139（t5 的用例已加入）。

## 3. t2 的 4 条验收标准

| # | 标准 | 结论 | 我自己的证据（非成员自述） |
|---|---|---|---|
| 1 | 未配置 key / 非 2xx / 超时 / 缺 `balance_infos` 各自返回**可区分**的结构化错误 | **pass** | 我的探针 §4.A 用自造 fake 逐一驱动：`no_api_key`(503，且 **0 次上游调用**)、`unauthorized`(401/403→502)、`rate_limited`(429→502)、`upstream_error`(500/503/418→502)、`timeout`(真实 abort 定时器→504)、`network_error`(抛出→502)、`bad_response`(7 种不可用 200 body→502)。共观测到 **7 个不同 code**，且每个 code 经 `statusForErrorCode` 映射到互不相同的语义状态（无一为 200）。测试文件亦对同一矩阵有断言（`host-balance.test.mjs:312-334,343-368,385-417,780-840`） |
| 2 | 响应体与错误消息中都不出现 API key（哨兵断言） | **pass** | 哨兵 `sk-T9PROBE-9f3a2b7c1d4e`：我的探针在上游 401/404/500/非 JSON/抛出**以及凭证 provider 抛错**（值未知，只能按形状脱敏）的所有路径上断言 `body`/`log`/`URL` 均不含哨兵；真实 HTTP 上 `/balance`+`/usage`+`/health` 三响应体亦不含。Authorization 头**确实**带 `Bearer <key>`（安全路径未被"为了不泄漏而干脆不发送"偷掉） |
| 3 | 60s TTL 生效 + `force=1` 绕过，均有断言 | **pass** | 我的探针：同 key 连续 2 次 → 第 2 次 `cached:true` 且上游仅 1 次调用；`force:true` → `cached:false` 且上游 2 次。HTTP 层 `?force=1` 同样生效 |
| 4 | 路由注册到 `/balance` 与 `/health` 且带 loopback 信任围栏 | **pass** | 我的探针在同一插件实例上观察到 **4 条注册**（balance/health/usage/bare `/health` 别名）；真实 socket 实测：`Host: evil.example` → **403** `{error:"forbidden: loopback-only"}`、`Sec-Fetch-Site: cross-site` → 403、`POST` → 405、`HEAD` → 200 且空体；`X-Forwarded-For` 未被采信（`routes.mjs:137-156` 只信 socket 地址） |

## 4. t3 的 4 条验收标准

| # | 标准 | 结论 | 证据 |
|---|---|---|---|
| 1 | 对合成 fixture 的聚合与逐条手工求和一致（空目录/坏行/缺 usage/跨天均有断言） | **pass** | **我自己**构造 fixture（单帧 / 跨帧断行 / 非 zstd 垃圾 / 过旧 mtime 共 4 类日志）并**自己手算**期望值：逐日逐模型 `inputTokens/cacheReadTokens/outputTokens` **精确相等**，`estimatedCostUsd` 与手算差 < 1e-12（硬锚点：(360+36+288+45+60)/1e6、0.005324+0.002662、0.00001956）；窗口外的那次调用（777/777）**确实未进入** totals；坏行 `malformedLines=1`、缺 usage 事件被跳过、缺时间事件经会话头回落（`missingTime=1`）。committed 测试另有独立 `manualTotals`（`host-ledger.test.mjs:202-213`）交叉求和（它复用模块的 `estimateCallCostUsd`，我的探针用自写字面值，因此两者互补） |
| 2 | 峰/非峰按每次调用实际时辰判定，有专门测试断言 | **pass** | 我的探针：同一 1M/1M/1M token 在周四 02:00Z（峰值）与 12:00Z（非峰）分别得 **1.506 / 0.753**，恰为 2 倍，数值与我的手算式一致；committed 测试 `host-ledger.test.mjs:496-533` 断言同样的精确值（含 v4-pro 5.324/2.662）与「同一天两笔不同价之和」；我的 fixture 里同一天的峰值笔与非峰笔也确实分别计价后相加 |
| 3 | mtime+size 增量缓存生效：二次调用不重复解压，有断言 | **pass** | 我的探针：二次调用 `filesFromCache=2 / filesRead=0` 且 totals 不变；追加内容后该文件 `filesRead=1` 且增量（+7/+9）准确落入 totals；`index.json` 落在我指定的**外部** cacheDir |
| 4 | 解析失败的行被跳过并计数上报，不抛异常不静默 | **pass** | 坏行 → `malformedLines`；非 zstd 文件 → `filesUnreadable=1` 且计入 `unreadableFiles`；过旧文件 → `filesSkippedOld=1`；三者都不抛、都不静默。torn frame 语义另有 committed 用例（`:665-736`） |

## 5. t4 的 5 条验收标准

| # | 标准 | 结论 | 证据 |
|---|---|---|---|
| 1 | `/usage` 注册并返回 T1 契约形状 | **pass** | 我的探针：真实 HTTP 200，顶层键**恰为** `["days","generatedAt","ok","requestedDays","totals","truncated"]`（宿主侧 `ledger`/`priceSource`/`estimated` 不上线，白名单重建见 `routes.mjs:284-298`）；`?days` 非法 8 种形态（`abc/0/366/7.5/空串/-1/1e3/%207`）→ **400 bad_request**，边界 `1/30/365` → 200；重复参数 `?days=3&days=4` → **400**（`rawUsageDays` 走 `getAll`，`routes.mjs:87-88,423-427`，与契约 `normalizeDays` 的 `single query value` 语义一致） |
| 2 | `/usage` 输出与 t3 模块对同一 fixture 的输出逐字段一致 | **pass** | 我的探针在同一 fixture 上分别取 `routes.usageEnvelope(aggregateUsage(...))` 与 HTTP 响应，`totals` 与 `days` **deepEqual 全等** |
| 3 | 装配后 `/balance` 与 `/usage` 同时可用；`node --test tests/` 全绿 | **pass** | 我的探针：**一个** `createHostPlugin()` 实例注册 4 条路由，`Promise.all` **并发**请求 `/balance`+`/usage`+`/health` 全部 200；`/usage` 期间上游余额接口调用次数仍为 1（无串扰）；`node --test` 全量 139/138/0/1 绿（§2） |
| 4 | 装配层显式传入外部 cacheDir；冷跑后包内无 `.ledger-cache`，且不进 `files` | **pass** | `<pkg>\.ledger-cache` **不存在**；`package.json.files` 与 `node_modules`/cache 路径无关（`files: lib,src,cordis.patch.yml,README.md,docs`，`package.json:32-38`）；我的探针指定外部 cacheDir 后 `index.json` 落在该外部目录 |
| 5 | Node 无 zstd 时返回契约形状 + `available:false`，routes 映射为闭集码；装载期不抛 SyntaxError | **pass** | 我的探针注入 `available:false` 的 payload → `/usage` **503** `ledger_unavailable`；注入抛错的 reader → **500** `internal`（body 不含哨兵）。committed 另有子进程复跑 Node 22 降级路径的用例（`host-integration.test.mjs:1071+`）；`ledger.mjs:54` 用 namespace import，Node 22 可正常装载 |

## 6. 我的独立探针（16 项，全部 PASS；探针与 fixture 都在 `%TEMP%`，未写入包内）

```
A1 no_api_key (503), zero upstream calls
A2 provider-throw no_api_key, sentinel scrubbed from body and log
A3 upstream 401/403/429/500/503/418 -> unauthorized|rate_limited|upstream_error (502)
A4 real abort timer -> timeout (504), settles instead of hanging
A5 network_error (502), sentinel scrubbed from body and log
A6 7 unusable-200 bodies -> bad_response (502), all distinct from upstream codes
A7 success envelope + TTL hit (1 upstream call) + force bypass (2 calls)
A8 closed code set: 10 codes, unknown -> 500, balanceFailure rejects drift
B1 ledger aggregate == my hand sum (per day/model tokens + 12-decimal cost), bad line counted,
   out-of-window excluded, 4 file classes accounted
B2 same tokens in/out of peak differ by exactly 2x (1.506 vs 0.753)
B3 mtime+size index: 2 files from cache / 0 re-read, then the grown log re-read
C1 /balance + /usage + /health answered concurrently over real HTTP; usage totals == ledger totals
C2 ?days= malformed -> 400 bad_request (8 forms), 1/30/365 -> 200
C3 loopback fence 403 (bad Host + cross-site), POST 405, HEAD 200 empty body
C4 degraded mounts: no key 503, reader throw 500 internal (no key in body), missing zstd 503 ledger_unavailable
D1 13 import specifiers checked (only node:*, ./local, @deepseek-ai/dsh-credentials), files[] clean, cache external
```

其中两点值得单独强调：

- **A4 是对 t2 修掉的 `unref()` 回归的独立把关**：`timeoutMs=60` 时上游只挂在 abort 信号上，探针**确实**拿到 `timeout`(504) 并在 60ms 量级返回；若定时器仍被 unref，Node 会在事件循环排空时结束进程（t2 描述的 Node 22 静默 `cancelled` 现象），探针会挂死而不是通过。
- **D1 的不变量检查覆盖 `src/host` 全部 import 说明符**：`@deepseek-ai/dsh-credentials`（经 Junction，官方包）、`node:crypto/fs/os/path/zlib`、`./balance.mjs|./ledger.mjs|./routes.mjs`。**没有 React、没有任何浏览器侧包**，宿主半的解析范围如 T1 的约束所述。

## 7. Findings（全部 low，不阻塞）

- **L1（low）· `ledger.mjs` 自带的默认 cacheDir 落在包内**：`ledger.mjs:545-548` 的 `defaultCacheDir()` = `<DSH_HOME>/plugins/dsh-deepseek-usage/.ledger-cache`（**包内**），而装配层 `plugin.mjs:59-66` 传入的是外部的 `<DSH_HOME>/storages/dsh-deepseek-usage/ledger-cache`。当前**不构成违规**（我实测包内无 `.ledger-cache`，装配永远显式传参），但任何将来直接 `aggregateUsage()` 而忘记 `cacheDir` 的调用点会把可变状态写进安装树。建议：把 `defaultCacheDir()` 也指向 `storages/`，或让它抛错要求显式传入。
- **L2（low）· `force` 的重复参数语义未定义**：`?force=1&force=0` → `force=true`（`searchParams.get` 取第一个）。`days` 已按契约收敛为「重复即 400」（`rawUsageDays`），`force` 没有对应处理，契约也未规定。影响可忽略（幂等开关），建议要么同样收敛、要么在注释里写明「first-wins 是有意的」。
- **L3（low）· `/usage` 不上线 `estimated`/`priceSource`**：这是 t4 明确的设计取舍（白名单防泄漏，我确认顶层键恰为 6 个），但线上数据因此没有「这是估算值」的机器可读标记；计划 §7 要求 UI 标注「估算值 / 本地估算，平台账单为权威」，需由 T6 在弹层里静态标注。建议在 README 的契约段写一句，避免 T6 误以为可以从 payload 取该标记。
- **L4（info）· 复核期间仍有人改宿主半**：`routes.mjs` 20:25:25、`tests/host-integration.test.mjs` 20:26:38 在我复核中途变更（重复 `?days=` 的收紧就是这次变更之一，我已在变更后重跑）。宿主半的冻结应以 §1 的 hash 为准；T7 端到端验收前请再确认 hash 未变。
- **L5（info）· 契约注解与实现现已一致**：`tests/contract.test.mjs` 已把 10 个闭集码与 `statusForErrorCode` 表纳入断言（`:495-604`），活体检查也改为按真实状态码校验（`:534-544`）——t8 曾提出的 F1（状态码策略缺失）与 F4（inject 名单含不存在的包）**均已落地修复**（`package.json:21-27` 的 inject 已改为 locale/renderer/sidebar，并附说明注释）。

## 8. 安全与边界（独立实测，非读测试文件）

| 检查 | 结果 |
|---|---|
| 哨兵密钥是否出现在响应体 | **否**：`/balance`（成功/各类失败）、`/usage`、`/health`、403/405 体、`internal` 兜底体全部不含 `sk-T9PROBE-…`；provider 抛错路径也按形状脱敏（`scrubSecretShapes`） |
| 哨兵是否出现在日志 | **否**：我捕获了全部 `logger.warn` 行并逐条断言 |
| 密钥是否进 URL | **否**：断言上游调用 URL 不含密钥；密钥只在 `authorization: Bearer …` 头（`balance.mjs:356-360`） |
| `node_modules` Junction 是否进 `files` | **否**：`files` 不含 `node_modules`、不含任何 cache 路径（`package.json:32-38`）；包内无 `.ledger-cache` |
| `runtime\` 零写入 | **是**：递归 28,735 条目，mtime ≥ 2026-09-17 的 **0** 条，最新仍是 `2026-09-16 14:43:54` |
| `profiles\` 零写入 | **是（就本工作流而言）**：与插件相关的引用 0 处（`web-desktop\package.json` 的 bundles 不含本插件、`node_modules\dsh-deepseek-usage` 不存在）；除 `@furongjun1999/dsh-memory` 自身状态外，最新写入是 19:40:54（早于宿主半 20:0x 起的工作） |
| 宿主进程未重启 | **是**：`dsh.exe` PID 9476 创建于 16:05:51；:3080 的 `node.exe` PID 25720 创建于 16:40:34 |
| `src/host` 越界 import | **无**：13 个说明符全部是 `node:*` / `./本地` / `@deepseek-ai/dsh-credentials`；无 React、无浏览器侧包 |

## 9. 裁决摘要

- **pass**：t2 的 4 条、t3 的 4 条、t4 的 5 条验收标准逐条有我自己复跑/自造 fixture 的证据支撑；三条 verify 命令 exit 0；五类降级（无 key / 429 / 超时 / 缺 `balance_infos` / 未知模型）各自给出**可区分、结构化**的结果（未知模型不是错误，而是定价 0 + 计入 `unknownModelUsages` 的显式降级）；聚合与手算一致；峰谷计价被真实断言；双路由同实例并发可用；无密钥泄漏；边界干净。
- 唯一需要下游注意的是 **L4（hash 冻结）** 与 **L3（估算标记需 T6 静态标注）**；L1/L2 建议在 T6/T7 顺手处理，不影响放行。
- 本裁决**不覆盖** t5（浏览器半）与其后的 T7 端到端验收；也不覆盖真实卸载/装载路径（`dsh plugin add`）——那是 T7 的范围。
