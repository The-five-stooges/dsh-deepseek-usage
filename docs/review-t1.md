# T8 独立复核：T1 骨架形态与冻结契约自洽性

- 复核者：`reviewer-foundation`（t8，attempt 1 / `98792dbe-344a-4f59-bb4f-89610f44d953`）
- 被复核任务：`t1`（implementation，attempt 1 / `97a52734-c36f-4524-aaa7-8ba96e41e97b`，交付者 `host-balance`）
- 复核时间：2026-09-17 19:53–20:0x
- 被复核根目录：`C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home\plugins\dsh-deepseek-usage`
- 复核方式：**只读**。所有结论均为本复核者独立执行命令/读代码所得，未修改任何实现文件；本文件是本次复核唯一写入路径。
- 裁决：**verdict = needs_revision**（findings F1/F2 中等，F3–F7 低；详见 §6）。契约**形状**（字段集/`days` 裁决/错误码闭集/入口形态/Junction 解析）全部通过，可继续实现；阻塞点是**契约中缺失的 HTTP 状态码策略**与 **`docs/load-path.md` 关于 `--dump-config` 只读的失实表述**。

---

## 1. 三条 verify 的独立重跑（不采信 T1 自述）

| 命令 | 解释器 | 结果 | 与 T1 自述一致？ |
|---|---|---|---|
| `node --check lib/index.js` | portable v24.13.1 | exit=0，无输出 | ✅ |
| `node --check lib/client.js` | portable v24.13.1 | exit=0，无输出 | ✅ |
| `node --test tests/contract.test.mjs` | portable v24.13.1 | `# tests 10 / # pass 9 / # fail 0 / # cancelled 0 / # skipped 1 / # todo 0 / duration_ms 182.7`，exit=0 | ✅ 9 pass / 0 fail / 1 skipped |
| `node --test tests/contract.test.mjs` | PATH v22.11.0 | `# tests 10 / # pass 9 / # fail 0 / # skipped 1 / duration_ms 252.7`，exit=0 | ✅（T1 声称两版皆过，已复现） |

skip 项为 opt-in 活体检查 `contract: live endpoints (opt-in via DSH_DEEPSEEK_USAGE_BASE_URL)`，`t.skip` 输出 `set DSH_DEEPSEEK_USAGE_BASE_URL (e.g. http://127.0.0.1:3080) to check a live host`（`tests/contract.test.mjs:448-453`）。

---

## 2. T1 四条验收标准的逐条核对（证据为命令输出或行号）

### A1 `package.json` 含 `dsh.bundle.patch` 与 `dsh.client`（platform=web），`cordis.patch.yml` 存在且被 patch 字段指向 — **pass**

- `package.json:12-28`：`dsh.bundle.patch = "./cordis.patch.yml"`；`dsh.client = { platform: "web", inject: [4 项] }`；`dsh.engines.dsh = ">=0.1.5-rc.1"`（实装 `@deepseek-ai/dsh` 版本 = `0.1.5-rc.1`，满足该范围）。
- `cordis.patch.yml` 存在（13 行，`insert: [{id: dsh-deepseek-usage, name: dsh-deepseek-usage}]`）。
- **用 runtime 真实 loader 代码独立复算**（只读 import `@deepseek-ai/dsh-app-boot`）：

  ```
  dsh.bundle.patch = ./cordis.patch.yml | file exists = true
  patch-list length = 1 | insert row = [{"id":"dsh-deepseek-usage","name":"dsh-deepseek-usage"}]
  composed = [{"id":"dsh-deepseek-usage","name":"dsh-deepseek-usage"}]
  ```

  与 T1 自述的 `loadOverlayPatches`/`composeEntries` 输出逐字一致；`dsh.bundle.patch` 确为 loader 读取的字段（`dsh-app-boot/lib/index.js:850` 解析、`:852` 缺失即抛 `declares no dsh.bundle`）。
- 注：`dsh.client.inject` 的取值有一条形态问题，见 **F4**（不改变 A1 结论：字段与 `platform` 均正确）。

### A2 宿主入口与浏览器入口都是薄装配层，`node --check` 通过 — **pass**

- `lib/index.js`（55 行）：唯一 import 是 `../src/host/plugin.mjs`（:22），随后校验 `{ name?, inject?, apply(ctx, config) }` 形状（:26-37）、转发 `apply`（:51-53）。无业务逻辑。
- `lib/client.js`（71 行）：仅经典脚本信封——`window.__ModuleLoader__.load({id, factory})`（:59-70），实现留在顶部 `createClientHalf` 槽（:50）。无业务逻辑。
- 两条 `--check` 在本机 v24 与 v22 均 exit=0（§1）。
- **独立行为验证（VM，未落盘）**：把 `lib/client.js` 原文放进 `node:vm` 执行：

  ```
  case1 no-loader -> throws: dsh-deepseek-usage: window.__ModuleLoader__ is missing — this bundle must be loaded through the DSH web shell
  case2 registered id: dsh-deepseek-usage | factory type: function
  case2 un-composed factory -> throws: dsh-deepseek-usage: browser half is not composed — inline src/client/index.mjs into the createClientHalf slot of lib/client.js (see docs/load-path.md)
  ```

  即「未装配 → 大声抛错并指名缺失文件」为**可复现行为**，不是注释里的承诺。
- 复核时 `src/host/plugin.mjs` 已由 T2 落地，实测 `lib/index.js` 可正常装载并满足 T1 冻结的装配契约：
  `lib/index.js: name="dsh-deepseek-usage" | apply=function | inject=[] | default.apply=function`。

### A3 `tests/contract.test.mjs` 用 `node:test` 冻结两端点响应形状与折线数据形状，`node --test` 通过 — **pass**

- 9 个测试全绿（§1）。冻结项（行号）：
  - 路由族与 `?days=N` 校验：`:31`、`:48-51`、`:263-270`、`:326-336`（`0/366/7.5/abc/空串` 全部抛错，重复参数 `["-1"]` 抛 `single query value`）。
  - `/balance` 形状：`:95-108`（`currency` 三字母、三个余额数值、`isAvailable`/`cached` 布尔、`fetchedAt` ISO；反漂移断言 `:342-362`）。
  - `/usage` 形状与零填充窗口：`:114-131`（`days.length === requestedDays`、日期升序）；反漂移断言 `:369-397`。
  - `totals` = 逐日逐模型之和：`:158-181`（含 `estimatedCostUsd` 1e-6 容差）。
  - 折线形状：`:213-255`（每天恰好 `{ label, value }`、`label=YYYY-MM-DD` 升序、`value` 非负有限），5 个指标共用同一日期轴 `:409-425`。
  - 错误形状与**闭集错误码**：`:34-46`（9 个码）、`:189-203`、`:427-441`；并把「响应里不得出现 `sk-` 密钥材料」写成断言（`:199`、`:443-446`）。
- 与宿主「API key 全程留在宿主」硬约束一致：契约层就有反密钥泄漏断言，下游 t5/t6 可直接依赖。

### A4 `docs/load-path.md` 记录经实测确认的装载路径结论（含命令与真实输出） — **pass（1 处失实表述见 F2）**

本复核者抽查并**独立复现**了该文档的关键论断与引用行号：

| 文档论断 | 复核结果 |
|---|---|
| `bin.js` 末尾 `if (import.meta.main) await runCli();`，v22 上静默空跑（§1.1） | ✅ 文件末行逐字一致；`node v22.11.0 <bin.js> plugin --help` 实测 **0 字节输出、exit=0** |
| `plugin-Ddi42qoW.js:46-78` `reconcilePlugins` | ✅ `function reconcilePlugins` 在 `:46`，`writeProfileManifest(profileDir, after)` 在 `:77` |
| `dsh-app-boot/lib/index.js:807-832 resolveBundleDir`、`:849-860` 缺 `dsh.bundle` 抛错 | ✅ `packageDirFromAnchor` `:807`、`resolveBundleDir` `:826-832`、`declares no dsh.bundle` `:852` |
| 浏览器半以经典脚本 `<script src>` 加载、`factory` 同步（§3） | ✅ `dsh-client-modules/lib/types/client/manifest.d.ts:147/152/156`（“Closure factory holding the whole bundle body”）、`:164`、`:257`；实际注册全局名确认为 `window.__ModuleLoader__`（`dsh-client-modules/lib/index.js:390`） |
| `%DSH_HOME%\plugins` 不被 loader 扫描，是解析孤岛（§2/§4） | ✅ 结论 + 复现：runtime 内 `"plugins"` 命中全是 URL 路由（`/plugins/events`、`/plugins/??…`），**没有任何代码读取 `home/plugins` 文件系统路径**；从插件目录 `import('@deepseek-ai/dsh-credentials')` 在补 Junction 前为 `ERR_MODULE_NOT_FOUND` |
| 插件位置解析到 runtime 安装的前提是 `node_modules` 链接（§4 A 案） | ✅ 链接落地后（§3）全部可解析 |
| `--dump-config` 是**只读**诊断，「不写入任何文件」（§1.3） | ❌ **失实**，见 **F2** |

---

## 3. Junction 解析路径（真实环境复现）

`<pkg>\node_modules` 已由 t2 落地：`LinkType=Junction`，`Target=C:\Users\Administrator\AppData\Local\DSH-Portable\runtime\node_modules`（创建于 2026-09-17 19:52:51）。

从插件目录实测（portable node v24.13.1）：

```
ESM  import('@deepseek-ai/dsh-credentials')      -> OK，9 exports，credentialRef=function  ✅
ESM  import('@deepseek-ai/dsh-llm')              -> OK，62 exports                        ✅
CJS  createRequire(<pkg>/lib/index.js).resolve('@deepseek-ai/dsh-credentials')
                                                 -> runtime\node_modules\@deepseek-ai\dsh-credentials\lib\index.js ✅
CJS  ...resolve('@deepseek-ai/dsh-llm')          -> runtime\node_modules\@deepseek-ai\dsh-llm\lib\index.js ✅
CJS  ...resolve('@deepseek-ai/dsh-host-webserver')-> runtime\node_modules\@deepseek-ai\dsh-host-webserver\lib\index.js ✅
CJS  ...resolve('cordis')                        -> FAIL MODULE_NOT_FOUND                 ⚠️ 见 F6
CJS  ...resolve('react')                         -> FAIL MODULE_NOT_FOUND                 正常（浏览器半的 React 来自 factory 的 require）
```

结论：**T2/T3 需要的官方包解析路径成立**；计划 §6.1 中「`cordis` 也能解析」的说法不可复现（F6）。

---

## 4. 形态约束（`lib/client.js`）

- ESM 语法扫描：行首 `import`/`export` 匹配数 **0**（唯一命中是注释里 `export default` 的文字说明，`lib/client.js:41`）。
- 以**经典脚本**语义解析通过：`new (require('node:vm').Script)(src)` 无抛出（ESM 语法在此必然 SyntaxError）。
- 信封正确：`window.__ModuleLoader__.load({ id: "dsh-deepseek-usage", factory })`，`factory` 同步返回 `createClientHalf(require)` 的产物（`:59-70`）。
- 未装配失败为「大声抛错」：VM 两条路径均复现（§A2），且错误文本指名 `src/client/index.mjs` 与 `docs/load-path.md`。
- 与真实加载器一致：注册全局名、`factory(require) → exports` 同步契约、`/plugins` 只服务登记 URL 三条均有 runtime 源码佐证（§A4 表）。

---

## 5. 边界纪律

| 检查项 | 结论 | 证据 |
|---|---|---|
| `runtime\` 零写入 | ✅ **成立**（且比验收口径更强） | 递归扫描 28,735 个条目：**mtime ≥ 2026-09-17 的条目 = 0**；最新 = `2026-09-16 14:43:54`（`node_modules\zod-to-json-schema\dist\types\parsers`）。⚠️ 验收文案写的常数「2026/9/16 8:28」不准确（F3） |
| 宿主进程未重启 | ✅ | `dsh.exe` PID **9476** 创建于 **2026-09-17 16:05:51**（launcher）；:3080 的监听者实为 **PID 25720** `node.exe …\@deepseek-ai\dsh\lib\bin.js --profile web-desktop --no-open --port 3080`，创建于 **16:40:34** —— 两者都早于 T1 的首个产物（19:43:57），全程未重启 |
| `profiles\` 零写入 | ⚠️ **不能这样断言** | 用户活动 profile 未被改动（见下），但 `profiles\web-desktop\cordis.yml` mtime = **19:39:56**，与 T1 自述的 `--dump-config` 运行时间吻合；`profiles\web\*` 于 19:40:53/54 被初始化（见 F2、F8） |
| 活动 profile 未被污染 | ✅ | `profiles\web-desktop\package.json`(16:39:49)/`cordis.patch.yml`(16:02:14)/`pnpm-lock.yaml`(16:39:49) 均早于 T1 产物；`dsh.profile.bundles` 不含 `dsh-deepseek-usage`；`profiles\web-desktop\node_modules\dsh-deepseek-usage` **不存在** → 尚未装载，符合「装载归 T6/T7」 |
| 包内无越界文件 | ✅ | 根目录仅 T1 的 7 个文件 + `docs/lib/tests`；`src\`（t2/t3 新交付）与 `node_modules` Junction 属下游按计划新增，非 T1 越界。无残留探针文件 |
| `node_modules` 未写入 `files` | ✅ | `package.json:32-38` = `["lib","src","cordis.patch.yml","README.md","docs"]`（Junction 不进包；`tests` 亦未列入，私有包可接受） |

---

## 6. Findings

### F1 — medium：契约缺 HTTP 状态码策略；活体检查隐式要求 200，生态先例相反

- 位置：`tests/contract.test.mjs:259`（唯一的状态码声明，且只是注释）vs `:454-463`（活体断言）；`README.md:41`。
- 事实：
  - 契约里唯一明说的状态码是 normalizeDays 的注释：`Producers turn a throw into 400 { ok:false, error:{ code:"bad_request" } }`。
  - 但 opt-in 活体检查在**解析 body 之前**就断言 `balanceResponse.status === 200`，随后才允许 `balance.ok === false`（`:455-458`）；`/usage?days=7` 同断言（`:461`）。即**隐式**要求「除非法 `?days=` 外，失败也返回 HTTP 200 + JSON body」。
  - README `:41` 只说失败体形状「统一为 `{ok:false,error:{code,message}}`」，**完全未规定 HTTP 状态**；`docs/load-path.md` 不涉及。
  - 生态先例两向冲突：宿主侧 `dsh-better-sidebar/lib/index.js:672-701` 用真实 `404/400`；客户端侧 `@linxin666/dsh-client-ui-skill-explorer/lib/client.js:71` 先判 `!response.ok` 抛错、不看契约里的 `code`。
- 影响（正是本复核要防的）：T2 若把 `no_api_key`/`upstream_error` 映射成 503、`rate_limited` 映射成 429（很自然，且有宿主先例），**默认 9/9 全绿**，但 T7 一旦按活体模式开跑就失败；T5 若照抄 skill-explorer 的 `!response.ok` 分支，会把契约闭集错误码降级成「HTTP 5xx」，`code` 闭集在客户端被绕过。四路并行实现按同一契约分叉的典型风险。
- requiredFix：在**单一事实来源**（`tests/contract.test.mjs` 文件头）与 `README.md:41` 各加一句显式裁决，例如：「两个端点在任何失败情形下都返回 **HTTP 200 + JSON body**；唯一例外是非法 `?days=` → `400 bad_request`。客户端必须先解析 body 再判 `ok`，不得依赖 `res.ok`。」随后 T2/T5/T7 按此对齐（若队长改为「失败用 4xx/5xx」，则须同步改活体断言 `:455/:461` 与 README）。

### F2 — medium：`load-path.md` 关于 `--dump-config` 只读的表述失实；「profiles/ 零写入」无法按字面背书

- 位置：`docs/load-path.md:114`（含 `:118` 语境）。
- 事实（代码 + 文件系统双向证据）：
  - `dsh/lib/dump-config-lFgMwK8i.js:25` → `prepareProfile(profile, !defaultOnly, fromDefaultProfile)`；
  - `dsh/lib/profile-boot-Dk-7KqJc.js:206-211` 的 `prepareProfile` **无条件**执行 `writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)`（其 docstring `:191-199` 明确「The root is **always** rewritten」）；
  - 观测：`profiles\web-desktop\cordis.yml` mtime = **2026-09-17 19:39:56**（内容仍是标准 `[]` 根模板，语义不变），时点与 T1 文档自述的 `--dump-config` 运行（§1.3，输出 18393 字节）吻合；
  - 另：`profiles\web\` 的 `cordis.yml`(19:40:53)、空 `node_modules`、`.dsh-module-fallback`(19:40:54) 也是同类 profile 初始化产物（归属见 F8）。
- 影响：没有功能损害（内容幂等、未动 `bundles`/`dependencies`/`cordis.patch.yml`、未装载本插件），但 (a) T1 的文档把一条**会写盘**的诊断命令标为「不写入任何文件」，(b) 本任务验收项「确认 runtime/ 与 profiles/ 零写入」按字面**不成立**，T7/复核若照抄会得出错误结论。
- requiredFix：把 `docs/load-path.md:114` 改为「`--dump-config` 会幂等重写 `<profile>\cordis.yml`（profile 根配置，内容不变），并会为缺失 profile 建脚手架；**不写 runtime、不改 bundles/dependencies**」；同时把边界口径改写为「runtime 零写入；profiles 未新增/修改 bundle 列表、依赖或 `cordis.patch.yml`」。

### F3 — low：验收常数错误（runtime 最新 mtime 不是 2026-09-16 8:28）

- 事实：runtime 最新 mtime = **2026-09-16 14:43:54**；≥ 2026-09-17 的条目 0 个。
- requiredFix：把验收/报告文案的常数改为 `2026-09-16 14:43:54`（实质要求「零写入」已超额满足，不需要改代码）。

### F4 — low：`dsh.client.inject` 两个 id 永远无法成为客户端图行（静默跳过的空边）

- 位置：`package.json:21-26`（该列表由 t1 任务陈述指定，非实现者臆造）。
- 事实：
  - `@deepseek-ai/dsh-client-ui-slots` 在本 runtime **不存在**（`Test-Path` false；`import` → `ERR_MODULE_NOT_FOUND`；官方 62 个带 `dsh.client` 的包中无一声明它，也无包提供该行）。
  - `@deepseek-ai/dsh-host-webserver` 是**宿主包**（`package.json` 无 `dsh.client` 声明），不可能出现在客户端 wire 里；其能力应由宿主半经 `ctx.webServer` 取得，而非客户端 inject 边。
  - 加载器对未知名**静默跳过**：`dsh-client-modules/lib/client.js:265-268`（`const dependency = this.graphRows.get(packageName); if (dependency !== void 0) …`）→ 不会崩，但这条「先到」顺序边不存在。
  - 生态同类写法存在（`dsh-better-sidebar` 的 inject 同样含 `@deepseek-ai/dsh-client-ui-slots`），故非致命。
- requiredFix：二选一——(a) 把 `@deepseek-ai/dsh-host-webserver` 删除、`@deepseek-ai/dsh-client-ui-slots` 换成真实行（侧边栏槽由 `@deepseek-ai/dsh-client-ui-sidebar` 声明：`sidebar.footer.action` 见其 `lib/client.js:296,399`；已在列表中），或补 `@deepseek-ai/dsh-client-ui-renderer`；(b) 保留但在 `package.json`/README 注明「inject 为信息性顺序提示，未知名会被加载器静默跳过」。**不阻塞**，但 T5/T6 不应据此认为会拿到 `dsh-client-ui-slots` 服务/包。

### F5 — low：文档里的任务号与团队任务表不一致

- 位置：`README.md:6`（「完整文档…由 T6 补齐」）、`:70`（「T4/T5（或 T6）」）、`docs/load-path.md:174,192-193,254,270`、`lib/index.js:7`、`lib/client.js:19`。
- 事实：这些号沿用**计划文档 §4 的编号**（T4/T5=浏览器半、T6=装载与切换、T7=测试与验收、T8=文档），而团队任务表已重编号为 t5/t6=浏览器半、t7=端到端验收与文档、t8=本次复核。README 的「完整文档由 T6 补齐」在两套编号下都不指向文档任务。
- 影响：纯可读性/协作歧义，无功能影响。
- requiredFix：改用阶段名（如「浏览器半任务」「验收任务」）或补一行「本文件沿用计划编号」的对照注。

### F6 — low：`cordis` 经 Junction 不可解析（计划 §6.1 的说法不可复现）

- 事实：从插件目录 `import('cordis')` → `ERR_MODULE_NOT_FOUND`；`createRequire(<pkg>/lib/index.js).resolve('cordis')` → `MODULE_NOT_FOUND`。可解析的只有 `@deepseek-ai/*`（已实测 credentials/llm/host-webserver）。
- 影响：若 T2 的 `src/host/plugin.mjs` `import "cordis"`（例如为了 `Service` 基类或类型），装载期会直接抛错。当前 T2 交付的 `plugin.mjs` **未**导入 cordis（实测 `lib/index.js` 装载成功，`name/apply/inject` 形状正确），故暂无实际损害。
- requiredFix：`docs/load-path.md` §4 的解析清单里显式补一条「`cordis`、`react` 经该 Junction 仍不可解析」；队长同步修正计划 §6.1 的表述。

### F7 — low：README 未列举图表指标名与若干约束，实现者必须读测试文件

- 事实：`CHART_METRICS = [totalTokens, inputTokens, cacheReadTokens, outputTokens, estimatedCostUsd]`（`tests/contract.test.mjs:54-60`，其中 `totalTokens = input + cacheRead + output`，见 `:218-223`）、`?days` 范围 `[1,365]`/缺省 30（`:48-51`）、数值类型（不许官方小数字符串）、ISO-8601 UTC、`truncated` 语义在 README/load-path 中均无描述。
- requiredFix：README 契约段补 3–4 行（指标名 + days 范围/缺省 + 数值/时刻格式 + `truncated` 的含义），或明确写「以上细节以 `tests/contract.test.mjs` 为准」。不阻塞。

### F8 — info：窗口内 `profiles/` 还有非 T1 的写入（供队长参考）

- `profiles\web\cordis.yml`(19:40:53) + 空 `node_modules` + `.dsh-module-fallback`(19:40:54)：一次针对 **`web` profile** 的初始化/boot 痕迹，T1 文档只记录过 `--profile web-desktop`，归属未定（当时无其它长驻进程；当前只有 PID 9476/25720 与本次复核的子进程）。
- `@furongjun1999/dsh-memory` 自身状态持续写入（最新 19:52:39），来自活动宿主内的该插件，与本任务无关。
- 对本次裁决无实质影响：`profiles/` 下**没有任何** `dsh-deepseek-usage` 引用（bundles/依赖/node_modules 全无），用户活动 profile 未被污染。

---

## 7. 契约自洽性矩阵（本复核重点）

| 项 | `tests/contract.test.mjs`（单一事实来源） | `README.md` | `docs/load-path.md` | 结论 |
|---|---|---|---|---|
| `days` 恒为数组 / 窗口用 `requestedDays` 回显 | `:14-18`（“`days` is never a number”）、`:118-131` | `:42-45`（明确裁决 + 零填充 `days.length === requestedDays`） | 不涉及 payload | ✅ 一致，无矛盾、无歧义 |
| balance 字段集 | `:99-106`：`ok,currency,totalBalance,grantedBalance,toppedUpBalance,isAvailable,fetchedAt,cached` | `:38` 逐字相同 | 不涉及 | ✅ 无遗漏/无命名漂移 |
| usage 字段集 | `:117-164`：`ok,requestedDays,generatedAt,truncated,days[{date,models[{model,inputTokens,cacheReadTokens,outputTokens,estimatedCostUsd}]}],totals{inputTokens,cacheReadTokens,outputTokens,estimatedCostUsd}` | `:39` 逐字相同 | 不涉及 | ✅ 无遗漏/无命名漂移 |
| 错误码闭集 | `:34-46` 9 码；`:195` `ERROR_CODES.includes()` 强制闭集；`:427-441` 含未知码反例 | `:41`「取自契约里冻结的闭集」（未枚举） | 不涉及 | ✅ 闭集成立；README 未枚举属可接受（已声明测试为单一事实来源），建议见 F7 |
| 折线数据形状 | `:213-255`、`:399-425`（每天一个 `{label,value}`、升序、5 指标同轴） | `:44-45`（每天一个点、补 0、升序） | 不涉及 | ✅ 一致；指标名清单缺于 README（F7） |
| 失败响应形状 | `:189-203`（`{ok:false,error:{code,message}}` + 无 `sk-` 泄漏） | `:41` | 不涉及 | ✅ 一致 |
| HTTP 状态码策略 | 仅注释 `:259`（400/bad_request）+ 活体隐式 `:455/:461`（200） | 未规定 | 未规定 | ❌ **缺口，见 F1** |
| 端点清单 | `:11-12` 冻结 balance/usage 两个 | `:36-39` 同两行 | 不涉及 | ✅ 一致（计划 §3.2 提到的 `health` 未进契约：可视为契约外附加路由，建议 T2/T4 不对外承诺其形状） |

另外，契约与文档在**装配契约**上也自洽：`README.md:50-52`/`docs/load-path.md:166-171` 与 `lib/index.js:26-37`、`lib/client.js:52-70` 描述同一套 `{name,inject?,apply}` 与 `createClientHalf(require)` 规则，且已被 t2 的实际交付验证可装载（§A2 末）。

---

## 8. 复现清单（供队长/verifier 复核本复核）

```powershell
$node = "C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe"
$pkg  = "C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home\plugins\dsh-deepseek-usage"
cd $pkg
& $node --check lib/index.js; & $node --check lib/client.js; & $node --test tests/contract.test.mjs
# Junction 解析（需已存在 <pkg>\node_modules → runtime\node_modules）
& $node --input-type=module -e "console.log(Object.keys(await import('@deepseek-ai/dsh-credentials')).length, typeof (await import('@deepseek-ai/dsh-credentials')).credentialRef, Object.keys(await import('@deepseek-ai/dsh-llm')).length)"
# runtime 零写入（应为 0 与新值 2026-09-16T14:43:54）
$rt = "C:\Users\Administrator\AppData\Local\DSH-Portable\runtime"
$a = Get-ChildItem -Recurse -Force $rt; $a.Count; ($a | ? LastWriteTime -ge [datetime]'2026-09-17').Count
($a | Sort-Object LastWriteTime -Desc | Select -First 1).LastWriteTime
```

---

## 9. 裁决摘要

- **verdict = needs_revision**：影响下游正确性的缺口是 **F1（HTTP 状态码策略缺失，T2/T5/T7 会分叉）**；另一条必须纠正的是 **F2（`--dump-config` 会写 `<profile>\cordis.yml`，「profiles 零写入」按字面不成立；文档失实）**。两项都只需文档/契约注释级别的修正，**不需要改动骨架代码、不需要重做入口形态**。
- **已放行部分**：契约字段集与 `days`/`requestedDays` 裁决、错误码闭集、`{label,value}` 折线形状、`lib/index.js`/`lib/client.js` 的薄装配与经典脚本形态、Junction 下 `@deepseek-ai/*` 解析（含 `credentialRef`）、runtime 零写入、宿主未重启、包内无越界文件与 `files` 不含 `node_modules` —— 全部通过且证据可复现，**T2/T3/T5/T6 可以继续按其实现**（F4/F7 建议顺手采纳）。
- **下游提醒**：T4/T5/T6 需要在 runtime 实例上装载时，注意 F2 的写盘行为与 F6 的 `cordis` 不可解析；弹层与余额行不得依赖 `@deepseek-ai/dsh-client-ui-slots` 这个不存在的行。
