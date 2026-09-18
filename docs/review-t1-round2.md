# T12 独立复核（round 2）：T1 骨架/冻结契约 + t11 修复项

- 复核者：`reviewer-foundation`（t12，attempt 1 / `2a8b719d-8c8a-4d38-ae09-dfa16490cf50`）
- 被复核：`t11`（repair-round-2）；复核对象仍是 T1 的骨架与冻结契约（t8 的延续）
- 复核时间：2026-09-17 20:31–20:40 ｜ 只读；本文件是本次复核唯一写入路径（探针/fixture 均建在 `%TEMP%`）
- 解释器：`C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe`（v24.13.1）
- **裁决：verdict = pass**。t8 的 F1–F7 全部关闭且由我独立复现；t11 的 11 项修复逐条落地；T1 的 4 条验收标准在**变更后 revision**上重新核对通过；三条 verify 全绿。仅 3 条 low/info 观察项（§7）。

---

## 1. 冻结的 revision（后续任何编辑都会使本裁决失效）

| 文件 | sha256 (16) | mtime | 大小 |
|---|---|---|---|
| `lib/client.js` | `F4439CF56A19BE1D` | 20:34:13 | 128,017 B |
| `lib/index.js` | `833ACDF6D22458D0` | 19:44:07 | 2,247 B |
| `src/host/balance.mjs` | `346E83F939F56966` | 20:16:18 | 18,148 B |
| `src/host/routes.mjs` | `2B2C70CADE03EC6E` | 20:25:25 | 18,037 B |
| `tests/contract.test.mjs` | `33003B976555A574` | 20:16:38 | 26,993 B |
| `README.md` | `CB11A9A7A38D4091` | 20:21:25 | 11,802 B |
| `docs/load-path.md` | `B2E03C2BB48C364E` | 20:22:26 | 20,297 B |
| `package.json` | `66771A687F829F86` | 20:22:02 | 1,600 B |
| `cordis.patch.yml` | `29BCA684C9152CA7` | 19:43:57 | 604 B |

⚠️ `lib/client.js` 在本次复核期间被 t5 连续改动（20:26:21 58,107 B → 20:33 126,702 B → 20:34:13 128,017 B）。我对 **F4439CF5** 这一版做了 §3 的形态复核；见 §7-R1。

## 2. 三条 verify（我自己跑，不采信自述）

| 命令 | exit | 结果 |
|---|---|---|
| `node --check lib/index.js` | 0 | 无诊断输出 |
| `node --check lib/client.js` | 0 | 无诊断输出 |
| `node --test tests/contract.test.mjs` | 0 | **tests 12 / pass 11 / fail 0 / cancelled 0 / skipped 1 / todo 0**（skip 为 opt-in 活体检查；与 t11 自述的 12/11/0/1 一致） |

## 3. T1 四条验收标准（逐条核对，证据在我机器上产生）

| # | 标准 | 结论 | 证据 |
|---|---|---|---|
| A1 | `package.json` 含 `dsh.bundle.patch` 与 `dsh.client(platform=web)`，`cordis.patch.yml` 存在且被 patch 字段指向 | **pass** | `package.json:12-27`（`bundle.patch=./cordis.patch.yml`、`client.platform="web"`）；用 runtime 真实 loader 复算（T8 方法）得 `composed = [{id:"dsh-deepseek-usage",name:"dsh-deepseek-usage"}]`；`inject` 现为 3 个**真实存在**的客户端行（locale/renderer/sidebar），见 §5-F4 |
| A2 | 两个入口都是薄装配层，`node --check` 通过 | **pass** | `lib/index.js` exit 0；`lib/client.js` exit 0；`lib/index.js` 装载后 `name="dsh-deepseek-usage" / apply=function`（§4-4）；`lib/client.js` 形态见下方 A3/**§4** 的 VM 实测 |
| A3 | `contract.test.mjs` 用 `node:test` 冻结两端点形状 + 折线形状，`node --test` 通过 | **pass** | 12/11/0/1 exit 0；冻结项：balance 8 字段（`:161-174`）、usage 形状与零填充（`:180+`）、`{label,value}` 折线、`totals`=逐日逐模型之和、**10 码闭集**（`:72-86`）、**状态表**（`:92-103`）、实现/契约双向守卫（`:549-567`）、活体判定 `assertLiveEnvelope`（`:531-547`） |
| A4 | `load-path.md` 记录经实测确认的装载路径结论（含命令与真实输出） | **pass** | T8 抽查过的引用行仍准确；t11 新增/修正的内容与我的独立实测一致：§0 行 8（Junction 后 `@deepseek-ai/*` 可解析、`cordis`/`react` 仍不可）、`:121-128`（`--dump-config` 会幂等重写 `<profile>\cordis.yml`，引用 `dump-config-lFgMwK8i.js:25` + `profile-boot-Dk-7KqJc.js:206-211`）、`:138-142`（runtime 零写入 + 常数更正为 **2026-09-16 14:43:54**，并说明早期 8:28 口径不准）、`:235/:254`（`cordis`/`react` 不可解析）、`:322-323`（活体 stub 结果） |

## 4. 我的独立探针（round-2，7 项，全部 PASS）

```
1a closed set is 10 codes and implementation == contract (both directions, compared by my own extraction)
1b balanceFailure() now builds envelopes for ledger_unavailable/internal (the t11 drift is closed)
1c the 503 ruling appears in balance.mjs, its ERROR_STATUS and README
2  lib/client.js: 0 ESM statements, parses as a classic script, registers id via __ModuleLoader__.load
3a live check against MY 503 stub host: 12 tests / 12 pass / 0 fail / 0 skipped (no false red for a keyless host)
3b live check against MY disguised-200 stub host: exactly 1 fail with the 'silent failure' message
4  junction: dsh-credentials 9 exports (credentialRef=function) + dsh-llm 62 exports; lib/index.js forwards apply()
```

要点：

- **1a 的独立性**：我没有调用契约的守卫用例，而是**自己用正则从 `tests/contract.test.mjs` 文本里抽出** `ERROR_CODES`/`ERROR_STATUS`，再与 `src/host/balance.mjs` 的导出双向 `deepEqual`：两侧都是同一组 10 码、同一张状态表。闭集漂移（t11 第 4 条）**确已闭环**。
- **1b**：`balanceFailure("ledger_unavailable", …)` 与 `balanceFailure("internal", …)` 现在**返回信封**而非抛错（旧实现正是抛错被吞成 500 internal）；`statusForErrorCode`：`ledger_unavailable=503 / internal=500 / bad_request=400`。
- **2**：我把 `lib/client.js` 原文放进 `node:vm` 以**经典脚本**语义解析通过；剥掉注释后行首 `import|export` 命中 **0**；`__ModuleLoader__.load` 注册 `id="dsh-deepseek-usage"`；**无 loader 时大声抛错**；用宽松 stub `require` 调 factory，**同步**返回 `{name:"dsh-deepseek-usage", inject, apply, setModalOpener, getModalOpener}`（t5 的内联实现已装配，不再抛 `browser half is not composed`）。
- **3a/3b**：我自己起 stub 宿主跑**真实的契约套件**（子进程，env 指向 stub）——503 `no_api_key` + 503 `ledger_unavailable` 的**合规降级宿主 12 pass / 0 fail / 0 skip**（诊断行 `degraded 503 …`），伪装成 200 的失败宿主**恰好 1 fail**（`HTTP 200 must carry an ok:true envelope, not a silent failure`）。即 T8 担心的「未配置 key 的宿主会让 T7 判 A 项失败」与「静默 200 混过去」两个方向**都被真正堵住**。
- **4**：经 `<pkg>\node_modules` Junction（`LinkType=Junction` → `runtime\node_modules`）：`@deepseek-ai/dsh-credentials` 9 exports 且 `credentialRef=function`、`@deepseek-ai/dsh-llm` 62 exports；另在**包目录 cwd 下用 ESM 裸导入**同样成功。

## 5. 契约自洽性矩阵（round 2）

| 项 | 契约（单一事实来源） | README | load-path.md | 结论 |
|---|---|---|---|---|
| `days` 数组 / `requestedDays` 回显 | `:14-18`、`:180+`（`days.length===requestedDays`、升序、零填充） | `:65-68` 同判 | 不涉及 payload | ✅ 一致，无矛盾 |
| balance 字段集 | `:161-174`：`ok,currency,totalBalance,grantedBalance,toppedUpBalance,isAvailable,fetchedAt,cached` | `:38` 逐字相同 | 不涉及 | ✅ 无遗漏/无漂移 |
| usage 字段集 | `ok,requestedDays,generatedAt,truncated,days[{date,models[{model,inputTokens,cacheReadTokens,outputTokens,estimatedCostUsd}]}],totals{…}` | `:39` 逐字相同 | 不涉及 | ✅ 无遗漏/无漂移 |
| 错误码闭集 | `:72-86` **10 码**，`:261` 强制 `includes`，`:549-567` 与会话实现双向 `deepEqual` | `:41`「闭集（10 个）」 | 不涉及 | ✅ 闭合；F1 缺口已补 |
| HTTP 状态码策略 | `:92-103` 表 + `:531-547` 活体判定（200→`ok:true`；已知码→真实状态 + code 必须映射回该状态） | `:43-63` 同表 + 判据 +「T7 注意：503 是合规降级态」 | `:322-323` 实测结果 | ✅ **t8-F1 完全关闭**（四处口径一致） |
| 图表指标/窗口/格式/`truncated` | `:119-126`（5 指标）、`:114-117`（`[1,365]`，缺省 30）、`:132-146`（ISO） | `:70-77` 补齐 4 条细节 | — | ✅ **t8-F7 关闭** |
| inject 真实性 | — | `:124-141` 全节：`dsh-client-ui-slots` 不存在、`dsh-host-webserver` 已移除、`sidebar.footer.action` 声明方、inject 只是信息性提示、T5/T6 不得依赖 | `:29` 一致 | ✅ **t8-F4 关闭**；`package.json` 另有 `"// inject"` 说明键 |
| 文档编号 | — | `:81-82` T1–T9 ↔ t1–t12 对照表 | `:3` 同 | ✅ **t8-F5 关闭** |
| `cordis`/`react` 解析 | 宿主半只 import `node:*` 与 `@deepseek-ai/*`（实测） | `:87-90` | `:235`、`:254` | ✅ **t8-F6 关闭** |
| `--dump-config` 写入行为 | — | — | `:121-128` 纠正文 + 代码引用 | ✅ **t8-F2 关闭** |
| runtime 最新 mtime 常数 | — | — | `:138-142` 更正为 `2026-09-16 14:43:54` 并说明旧口径错因 | ✅ **t8-F3 关闭**（我实测同值） |

## 6. 边界（独立实测）

| 检查 | 结果 |
|---|---|
| `runtime\` 零写入 | ✅ 递归 28,735 条目，**mtime ≥ 2026-09-17 的 0 条**，最新 = `2026-09-16 14:43:54`（与文档更正后的常数一致） |
| `profiles\` 零写入（本工作流口径） | ✅ 递归含 0 个引用本插件的路径；`web-desktop\package.json` 的 `bundles` 不含本插件；`profiles\web-desktop\node_modules\dsh-deepseek-usage` 不存在；除 `@furongjun1999/dsh-memory` 自身状态外，最新写入仍是 19:40:54（早于本工作流） |
| 宿主未重启 | ✅ `dsh.exe` PID 9476（16:05:51）、:3080 的 `node.exe` PID 25720（16:40:34）均未变 |
| 包内状态/发布面 | ✅ 包内无 `.ledger-cache`；`node_modules` 为 Junction；`files = lib,src,cordis.patch.yml,README.md,docs`（不含 `node_modules`） |

## 7. Findings（3 条，全部 low/info，不阻塞）

- **R1（info）· `lib/client.js` 仍在被 t5 改写**：我的复核窗口内它变了两次（58,107 → 126,702 → 128,017 B）。本报告的形态结论（无 ESM、经典脚本可解析、信封/大声失败/已装配）对应 `F4439CF5`。**T7 端到端验收前请确认该文件 hash 未再变**；若已变，需重跑「无 ESM + 经典脚本解析」这一条（一条命令即可）。
- **R2（low）· 验收文案里的旧常数仍在**：t12/t8 的 acceptance 原文写「runtime 最新 mtime 不晚于 2026-09-16 8:28」，实测与文档更正后均为 **2026-09-16 14:43:54**。文档已改，但**任务契约文本**没改，下一轮复核还会重新推导。建议队长把该条改写为「runtime 零写入（mtime ≥ 执行日 的条目数 = 0）」这种不依赖具体时间戳的判据。
- **R3（low）· 「客户端先看状态再解析」这条规则只有 T5 的测试在守**：README `:60-63` 要求客户端按 HTTP 状态 + 闭集码处理，不得只依赖 `res.ok`；我在 t5 的实现里确认符合（`src/client/service.mjs:127` 读 `error.code`、`:326` 读 `response.status`，弹层把 code 写进 `data-error-code`）——但宿主的契约套件**无法**证明浏览器侧真的按这条规则渲染（它不加载客户端）。建议 T7 增加一条端到端断言：让宿主返回 `502 rate_limited`，检查 DOM 出现该闭集码（而非「HTTP 502」）。

## 8. 裁决摘要

- **pass**：T1 的 4 条验收标准在 `§1` 的 revision 上全部通过；t11 的修复项我逐条独立复现（闭集 10 码双向一致、`ledger_unavailable`/`internal` 可建信封、503 在实现/契约/README 三处一致、活体检查对合规降级 12/12 且对伪装 200 精确 1 fail、`--dump-config` 写入行为据实改写、mtime 常数更正、inject 名单与说明、编号对照、README 契约段补全）；Junction 解析、经典脚本形态、边界纪律均无回归。
- 下游可安全按其实现/验收；唯一流程性提醒是 **R1 的 hash 冻结**与 **R3 的端到端补充断言**。
