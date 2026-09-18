# Development notes

This is the maintainer-facing companion to [`README.md`](README.md). It records the
environment this plugin was built and verified against, the frozen internal contracts, and the
verification documents. Paths such as `%DSH_HOME%` and the portable Node location are from the
development machine — substitute your own.

For the public description, install steps and known limitations, read the README instead.

---

DSH Web 插件：在**侧边栏脚部、设置行上方**显示 DeepSeek 账户余额 + 刷新按钮，点击打开弹出层
（余额卡 + 本地用量 SVG 图表 + platform.deepseek.com 外链）。

- 目标环境：`%DSH_HOME%` = `C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home`，
  活动 profile = `web-desktop`，GUI = `http://127.0.0.1:3080`
- **当前状态**：装载已完成并核验（见 [安装与装载](#安装与装载)），**生效待用户指定的宿主重启**
  ——不会由插件、也不会由验收流程自行重启你正在使用的宿主进程。
- 独立验收记录（A1–A8 逐条证据、命令回显、hash 冻结基线）见 [`docs/verification.md`](docs/verification.md)；
  装载路径实测结论见 [`docs/load-path.md`](docs/load-path.md)。

## 你会看到什么

| 位置 | 内容 |
|---|---|
| 侧边栏脚部（设置行**上方**） | 一行余额：`¥98.17` 形式的金额 + 刷新按钮；折叠成 56px 轨道时退化为图标 + Tooltip 数字 |
| 点击该行 → 弹出层 | ① 余额卡（总余额 / 充值余额 / 赠送余额 / 币种 / 账户状态 / 数据时间 / 数据来源）② 本地用量图表（5 个指标 × `7 / 30` 天窗口切换 + 按模型明细表）③ 「在 platform.deepseek.com 打开用量页」按钮（新窗口） |
| 降级态 | 未配置 key → 「未配置」态 + 提示；上游 429/401/5xx、断网、超时、台账不可用 → 明确错误态，绝不空白、不崩溃 |

## 硬约束（决定架构）

1. `platform.deepseek.com/usage` 返回 `Content-Security-Policy: frame-ancestors 'none'`，**无法内嵌** →
   图表改为宿主聚合本地会话日志（zstd，`assistant/message.usage`），弹层只提供平台页外链。
2. **API key 全程留在宿主**：key 只进 `Authorization` 请求头，HTTP 响应里只出现余额数字与聚合后的 token 数；
   浏览器半的可执行代码里既没有密钥、也不含 `api.deepseek.com`（本机实测 0 命中，见 `docs/verification.md` A3）。
3. **`runtime\` 下官方包零改动**：25,440 个文件的最新 mtime 仍是 `2026-09-16 08:28:20`，且没有任何文件提及本插件名；
   验收期间**没有重启**用户正在使用的宿主进程（实际观测为 **PID 25720** 的 `node.exe` 监听 `127.0.0.1:3080`；
   `launcher\state.json` 里记的 `pid: 24200` 是 `dsh.exe` 启动器）。

## 功能规格（冻结值）

| 项 | 值 | 位置 |
|---|---|---|
| 余额接口 | `GET https://api.deepseek.com/user/balance`（唯一会返回余额的官方端点） | `src/host/balance.mjs` |
| 余额缓存 TTL | 60 s（`force=1` 绕过；缓存的是**快照**，凭证每次操作重新解析） | `BALANCE_TTL_MS` |
| 上游超时 | 10 s | `BALANCE_TIMEOUT_MS` |
| 台账数据源 | `<DSH_HOME>\sessions\**\session.v3.jsonl.zstd` 的 `assistant/message` / `assistant/attempt` 事件 | `src/host/ledger.mjs` |
| 台账去重 | 每个 `(turn, step)` 只计一次、**最后一次结算生效**；缺 turn/step 时按事件逐条计 | `foldSessionText` |
| 窗口 | 整数 `[1, 365]` 天，缺省 30；窗口内零填充、日期升序 | `DEFAULT_DAYS` / `MAX_DAYS` |
| 聚合预算 | 15 s；超时返回**部分**结果并置 `truncated: true` | `DEFAULT_BUDGET_MS` |
| 台账索引缓存 | `<DSH_HOME>\storages\dsh-deepseek-usage\ledger-cache\`（按 mtime+size 命中） | `defaultLedgerCacheDir()` |

## 安装与装载

> 完整的命令回显、失败输出与排查见 [`docs/load-path.md`](docs/load-path.md)。

### 0. 前置：包内 `node_modules` Junction（一次性）

本包位于 `%DSH_HOME%\plugins\`，该位置解析不到任何裸包名（实测 `ERR_MODULE_NOT_FOUND`），而宿主半需要
`credentialRef`（`@deepseek-ai/dsh-credentials`）。因此**装载前必须先建一次链接**（幂等）：

```powershell
$pkg = "C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home\plugins\dsh-deepseek-usage"
$rt  = "C:\Users\Administrator\AppData\Local\DSH-Portable\runtime\node_modules"
if (-not (Test-Path "$pkg\node_modules")) { New-Item -ItemType Junction -Path "$pkg\node_modules" -Target $rt }
```

- **不进 git / 不进发布物**：`package.json` 的 `files` 有意不含 `node_modules`；Junction 是**本机绑定**，换机需重建。
- 缺失时的症状：宿主半装载即抛 `Cannot find package '@deepseek-ai/dsh-credentials'`（大声失败，不静默降级）。

### 1. 装载进 profile

**必须用 portable Node v24**（`C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe`）：`dsh/lib/bin.js`
末尾是 `if (import.meta.main)`，该 API 只在 Node ≥ 24 存在；PATH 上的 v22 会**静默无输出、退出码 0**。

`dsh plugin` 是**纯 pnpm 转发器**（没有自己的子命令，`--help` 会打印 pnpm 的帮助）。本机默认 store 是
`E:\.pnpm-store\v10`，而 profile 的 `node_modules\.modules.yaml` 钉的是
`C:\Users\Administrator\AppData\Local\pnpm\store\v10`，**必须显式对齐**：

```powershell
$env:DSH_HOME = "C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home"
$node = "C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe"
$bin  = "C:\Users\Administrator\AppData\Local\DSH-Portable\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js"
& $node $bin plugin --profile web-desktop add `
    --store-dir "C:\Users\Administrator\AppData\Local\pnpm\store\v10" `
    "link:C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home\plugins\dsh-deepseek-usage"
```

等价的手工路线（`dsh plugin` 不可用时）：profile 的 `package.json` 里
`dependencies` 加 `"dsh-deepseek-usage": "link:../../plugins/dsh-deepseek-usage"`、`dsh.profile.bundles`
数组追加**包名**（不能写路径），再在 profile 目录跑一次 `pnpm install`。

成功后 `dsh-deepseek-usage` 会被**自动**追加进 profile 的 `dsh.profile.bundles`（`reconcilePlugins`）。
本机已按上述命令装载完成；可核查的落地结果：

| 落地项 | 值 |
|---|---|
| profile `dependencies` | `"dsh-deepseek-usage": "link:C:/…/plugins/dsh-deepseek-usage"` |
| profile `dsh.profile.bundles` 末项 | `"dsh-deepseek-usage"` |
| `node_modules\dsh-deepseek-usage` | Junction → 本插件目录 |
| 未被改动的 profile 文件 | `cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml` |
| 被改动的 profile 文件 | `package.json`（上述两行）、`pnpm-lock.yaml`（pnpm 重写，预期） |
| loader 是否识别 | `dsh --profile web-desktop --dump-config` 末层出现 `# == dsh-deepseek-usage` + `- id: dsh-deepseek-usage` |

### 2. 生效与回滚

- **生效**：宿主半需**重启宿主进程**（profile bundle 层在启动期合成）；浏览器半刷新页面即可。
  重启会中断当前 GUI 会话，属**用户处置项**，插件不自行执行。
- **回滚**（任选其一）：
  1. `& $node $bin plugin --profile web-desktop remove dsh-deepseek-usage`（会同时从 bundles 移除）；
  2. 在其 `cordis.patch.yml` 的行上加 `disabled: true`（免卸载停用）；
  3. 还原 profile 备份：`package.json`（+ `pnpm-lock.yaml`）恢复到装载前的副本，再跑一次 `pnpm install`。
- 全程不触碰 `runtime\node_modules\@deepseek-ai\*`。

## 配置项

生产路径下**没有**用户必填配置：装载即用，key 由宿主凭证库的 `DEEPSEEK_API_KEY` 提供
（`ctx.credentials.resolve(credentialRef("DEEPSEEK_API_KEY"))`，`resolve` 是唯一能拿到明文值的路径）。
可选的运行时覆盖只有插件行的 `config`（写在 profile 的 `cordis.patch.yml`，或 `%DSH_HOME%\cordis.patch.yml` 家庭层）：

```yaml
- id: dsh-deepseek-usage
  config:
    timeoutMs: 10000   # 上游余额请求超时（默认 10000）
    ttlMs: 60000       # 成功快照缓存 TTL（默认 60000；force=1 绕过）
```

| 环境变量 | 作用 |
|---|---|
| `DSH_HOME` | 决定 `sessions\`（台账数据源）与 `storages\dsh-deepseek-usage\ledger-cache\`（索引）位置 |
| `DSH_DEEPSEEK_USAGE_BASE_URL` | **仅测试用**：给 `tests/contract.test.mjs` 的活体检查指定宿主 origin，不设则跳过该用例 |

## 冻结的 HTTP 契约

`tests/contract.test.mjs` 是**单一事实来源**——改响应形状必须同时改它。

| 端点 | 成功响应 |
|---|---|
| `GET /api/dsh-deepseek-usage/balance[?force=1]` | `{ ok:true, currency, totalBalance, grantedBalance, toppedUpBalance, isAvailable, fetchedAt, cached }` |
| `GET /api/dsh-deepseek-usage/health`（+ 可选别名 `GET /health`） | `{ ok:true, name, version, route, uptimeMs, balanceCache:{warm, ageMs?, expiresInMs?} }` |
| `GET /api/dsh-deepseek-usage/usage?days=N` | `{ ok:true, requestedDays, days:[{date, models:[...]}], generatedAt, truncated, totals:{…} }` |

- 失败响应统一为 `{ ok:false, error:{ code, message } }`（形状不变），`code` 取自契约里冻结的**闭集（10 个）**。
- 围栏：请求必须来自回环地址、`Host` 必须是回环权威、`sec-fetch-site` 不得为 `cross-site`（`X-Forwarded-For` 永不采信）；
  否则 `403`（在解析凭证之前就拒绝）。非 `GET`/`HEAD` → `405`。
- `/usage` 的 `?days=` 必须是**单个**十进制整数且在 `[1,365]`：`0` / `366` / `abc` / `7.5` / `-1` / 重复参数 → `400`。
- `/usage` 的响应体是**白名单重建**：顶层键恰好是
  `["days","generatedAt","ok","requestedDays","totals","truncated"]`；台账诊断（`ledger`）与 `priceSource` **不上线**。

**HTTP 状态码裁决（计划 §6.6）：失败绝不用 200 掩盖。**

| 情形 | 状态码 | 闭集码 |
|---|---|---|
| 成功 | 200 | —（`ok:true`） |
| 非法 `?days=` | 400 | `bad_request` |
| 未配置 key | 503 | `no_api_key` |
| 上游非 2xx（含 429） | 502 | `unauthorized` / `rate_limited` / `upstream_error` |
| 网络失败 | 502 | `network_error` |
| 响应体不可用 | 502 | `bad_response` |
| 超时 | 504 | `timeout` |
| 台账不可用（本机无 zstd 等） | 503 | `ledger_unavailable` |
| 内部错误 | 500 | `internal` |

> `ledger_unavailable` 用 503 而非 502：502 表示「上游给了坏响应」，本机缺解码器属「本机能力当前不可用」。
> 围栏 403 / 方法 405 在信封之外，不属于本表。

**客户端固定流程：先看 HTTP 状态 → 再解析 body 取闭集错误码 → 四态渲染**，不得依赖 `res.ok` 单独判断。
错误文案的优先级是「宿主给的 `message` → 闭集码的字典文案 → 传输层兜底（`宿主返回 502`）」，
所以**只要宿主给出冻结信封，闭集码就一定会出现在 DOM 上**（`data-error-code` 属性 + 括号里的明细），
传输层状态绝不会是唯一信息；宿主没给信封的边界情况见「已知限制」第 6 条。

## 数据来源与口径

### 余额（权威）

`GET https://api.deepseek.com/user/balance`，响应体只有 `is_available` + `balance_infos[]`（每币种一条）。
插件优先取 `CNY` 账户，字段映射：`total_balance`→`totalBalance`、`granted_balance`→`grantedBalance`、
`topped_up_balance`→`toppedUpBalance`。官方 API 文档中**没有**用量/账单查询端点，该接口也不返回任何按天统计。

### 本地用量台账（估算）

DSH 自己已把每次调用的 token 用量折进会话日志：`assistant/message.usage` 带
`inputTokens`（缓存未命中）/ `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`。台账遍历
`<DSH_HOME>\sessions\**\session.v3.jsonl.zstd`，按官方 `dsh-session-persistence-jsonl` 的
**多帧结构算法**（frame 头 + 3 字节 block 头）逐帧解码——**不能**用 `zstdDecompressSync` 一把梭
（它只覆盖首帧）也不能按 magic 暴力搜索定界（压缩数据里会出现巧合 magic）。写入中的截断帧与坏帧只计数不抛错。

### 单价来源与更新方法

**来源**：[`https://api-docs.deepseek.com/quick_start/pricing`](https://api-docs.deepseek.com/quick_start/pricing)，
抓取于 **2026-09-17**。单位 USD / 1,000,000 tokens；**峰值价 = 非峰值价 × 2**；
峰值时段 **01:00–04:00 与 06:00–10:00 UTC，周一至周五**。

| 模型（规范化 id） | 缓存命中 峰/非峰 | 缓存未命中 峰/非峰 | 输出 峰/非峰 |
|---|---|---|---|
| `deepseek-flash` | 0.006 / 0.003 | 0.30 / 0.15 | 1.20 / 0.60 |
| `deepseek-v4-pro` | 0.044 / 0.022 | 1.32 / 0.66 | 3.96 / 1.98 |

会话里的模型名可能是路由标签或 provider id，只做**精确别名映射**（`deepseek-v4-flash`/`deepseek-chat`→flash，
`deepseek-pro`/`deepseek-reasoner`→v4-pro）；认不出的模型计入 `unknownModelUsages` 并**按 0 计价，绝不猜**。

**更新方法**（官方明确保留调价权）：

1. 重新抓取来源页，核对「标准时段 / 优惠时段」两列与峰值时段定义；
2. 只改 `src/host/ledger.mjs` 里的 `PRICE_TABLE_USD_PER_MILLION` 与 `PRICE_TABLE_SOURCE`
   （`fetchedOn` 改成新的抓取日期，`peakWindowsUtc`/`peakMultiplier` 同步核对）——价格只有这一处定义；
3. 跑 `node --test tests/host-ledger.test.mjs`（价格断言、峰谷判定、未知名模型计 0 都在里面）；
4. 弹层里的「估算值」标注与来源链接来自 `src/client/modal.mjs` 的字典（`usage.chart.cost.note`，
   渲染为带 `data-estimate-label="1"` 的静态注记），无需改；
5. 若日后官方改为「按期计价」而非「按调用时辰计价」，`estimateCallCostUsd` 的口径要一起改——**本次实现按调用时刻判定峰谷**，
   这样历史台账才对得上。

## 两个入口的装配契约

> **文档编号说明**：本文与 `docs/load-path.md` 沿用**计划文档**（`.agents/plans/deepseek-balance-plugin.md` §4）
> 的阶段编号 T1–T9；**团队任务表**用 t1–t12。对照：T1≈t1、T2≈t2、T3≈t3、T4≈t4/t11、T5≈t5、T6≈t6、T7≈t7。

### 宿主入口 `lib/index.js`

`src/host/plugin.mjs` 必须 **default-export 一个 cordis 插件对象** `{ name, inject?, apply(ctx, config) }`。
入口只做转发与形状校验；模块缺失或形状不对时**大声抛错**，不静默吞掉。

- 宿主半**只 import `node:*` 与 `@deepseek-ai/*`**；`react`、`cordis` 经包内 Junction 仍不可解析（实测），
  框架对象一律从 `ctx` 取（`ctx.credentials`、`ctx.webServer`、`ctx.logger`）。唯一需要裸包名 import 的官方包是
  `credentialRef`（`@deepseek-ai/dsh-credentials`）。
- `apply(ctx)` **不声明硬 `inject`**，而是等待 `webServer` 服务：没有 web 服务器的 profile（TUI/headless）里本插件**惰性不动作**，
  不会阻断启动。

### 浏览器入口 `lib/client.js`（⭐ 重组前必读）

客户端模块系统以**经典脚本**加载 bundle（`<script src="/plugins/dsh-deepseek-usage/client.js">`，无 `type=module`），
并要求 `factory(require)` **同步**返回 exports ⇒ 该文件里**不能出现 ESM `import`/`export`**。
实现是 `src/client/` 下六个模块**逐字内联**进顶部装配槽的生成物：

```js
var createClientHalf = (function () {
  /* begin: src/client/format.mjs */   …模块体（行首 `export ` / `export default ` 关键字去掉）…
  /* begin: src/client/service.mjs */  …
  /* begin: src/client/row.mjs */      …
  /* begin: src/client/index.mjs */    …index.mjs 的 default export 成为槽的返回值…
  /* begin: src/client/chart.mjs */    …
  /* begin: src/client/modal.mjs */    …
  /* composition wiring */             setModalFactory(function (runtime) { return createUsageModalOpener(runtime); });
  return createClientHalf;
})();
```

**三条硬规则**（`lib/client.js` 头部注释里的同一条规则，这里展开成人话）：

1. **兄弟模块的 `import ... from "./x.mjs"` 行必须整行删除**，不能改写成 `require("./service.mjs")`——
   `/plugins` 只服务已登记的 bundle URL，模块表里**没有** `./service.mjs` 这类相对 id，写成 require 会在浏览器端
   当场抛 `Unknown module`。删除后标识符由同一闭包内的内联声明承接。**当前 bundle 里相对 require 数为 0**。
2. **只有 `react` 与 `@deepseek-ai/dsh-client-ui-primitives` 走 `require(...)`**，因为它们是外壳的**静态种子模块**
   （`dsh-web-frontend` 的 `staticModules`：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
   `@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`）。
   其余内联模块对 React 零 import，React 只从 factory 的 `require` 取——这也让 `src/client/*` 能被 plain node 直接 import 测试。
3. **重组之后必须重跑漂移守卫**：`tests/ui-row.test.mjs` 与 `tests/ui-modal.test.mjs` 会逐字（忽略空白）比对
   `lib/client.js` 与源模块，并逐导出函数比对 `toString()`；不一致时打印
   「`… has drifted from lib/client.js — recompose the browser half`」。**光改 `src/client/` 而不重跑组合脚本，
   浏览器端拿到的仍是旧实现**。

重组脚本是 `scripts/compose-client.mjs`（零依赖，只用 `node:fs`/`node:path`/`node:url`）：

```powershell
$node = "C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe"
cd "C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home\plugins\dsh-deepseek-usage"
& $node scripts/compose-client.mjs --check   # 只校验、不改文件：同步则 exit 0；漂移则 exit 1 并指出分节
& $node scripts/compose-client.mjs --print   # 输出到 stdout（便于 diff），不落盘
& $node scripts/compose-client.mjs           # 写盘（幂等：内容已同步时不改写）
& $node --test                               # 重组后必须仍全绿（漂移守卫是第二道闸）
```

> ⚠️ **不要凭直觉改它的拼接格式**（分节之间的空行、头部注释的边界都很讲究）：任何改动都要先用 `--check` 验证再落盘。

未装配时抛 `browser half is not composed …`（指名 `src/client/index.mjs`），不会静默渲染空白。
`lib/client.js` 是**生成物**：直接手改会被下一次重组合覆盖。

### `dsh.client.inject` 的真实成员

```json
["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-sidebar"]
```

- 原来写的 `@deepseek-ai/dsh-client-ui-slots` **在 runtime 中不存在**（`Test-Path` = False，`--dump-config` 里也没有对应行），已移除。
- 原来的 `@deepseek-ai/dsh-host-webserver` 是**宿主包**（其 package.json 无 `dsh.client` 声明），不该出现在客户端 inject 列表里——已移除。
- 现在三项都是 runtime 中真实存在、且各自声明了 `dsh.client.platform === "web"` 的客户端行。侧边栏槽
  `sidebar.footer.action` 的真实声明方是 `@deepseek-ai/dsh-client-ui-sidebar`。
- ⚠️ **`inject` 只是信息性顺序提示，不是能力声明**：加载器只把它当「谁的 factory 先到」的顺序边，
  **无法解析的 id 会被静默跳过**。所以客户端不得依赖 `inject` 保证槽可用——本插件在 `apply(ctx)` 里显式检查
  `ctx.slots`，缺失时**大声告警并显式降级**，不假定槽已就绪。

## 已知限制

1. **本地估算 ≠ 平台账单**：图表是「按 DSH 会话记录聚合 + 按调用时刻判峰谷」的**估算**，官方账单才是权威。
   弹层内已**静态**标注（`/usage` 白名单不上线 `estimated`/`priceSource`，线上数据没有机器可读的估算标记）。
2. **平台用量页无法内嵌**：`frame-ancestors 'none'`；本插件只提供外链（裸 `https://platform.deepseek.com/usage`）。
3. **未知模型按 0 计价**：会话里出现价格表外的模型时，其 token 计入总量但费用为 0（并计入 `unknownModelUsages`）。
4. **台账只读 `session.v3.jsonl.zstd`**：写入中的截断帧、坏帧只计数（`tornFrames`/`badFrames`）不抛错；
   受聚合预算限制时会置 `truncated: true`，此时总和可能偏小，UI 按「数据不完整」提示。
5. **`days` 重复参数即 400**（`?days=3&days=4`），`force` 未规定重复语义（取首值）。
6. **客户端不能替宿主发明错误码**：若宿主返回 5xx 但响应体不是冻结信封（`{ok:false,error:{code,…}}`），
   客户端只能退化为传输层文案（`宿主返回 502`）、`data-error-code` 为空——这是刻意的边界，
   宿主侧契约测试保证真实宿主永远给信封。
7. **`ledger.mjs` 的 `defaultCacheDir()` 仍指向包内 `<DSH_HOME>\plugins\dsh-deepseek-usage\.ledger-cache`**
   （历史遗留）。装配层已显式改传 `storages/`，所以正常路径不会在安装树里写状态；但将来任何**忘记传 `cacheDir`**
   的直接调用会把缓存写进安装树。
8. **包内 `node_modules` Junction 是本机绑定**，换机/换安装路径需重建（见「装载前置」）。
9. **Junction 依赖 `runtime\node_modules`**：只影响宿主半的 `@deepseek-ai/dsh-credentials` 解析，
   不影响浏览器半（浏览器半的 React/primitive kit 来自外壳）。

## 自检与验收

**必须用 portable Node v24**（PATH 上的 v22.11.0 的 `node:zlib` 没有 `zstdDecompressSync`，
会让 `tests/host-ledger.test.mjs` 在 import 阶段就 `SyntaxError`——那是**工具链问题，不是实现失败**）：

```powershell
$node = "C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe"
cd "C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home\plugins\dsh-deepseek-usage"
& $node --test               # 裸形式：Node 自带发现 tests/*.test.mjs（目录形式 --test tests/ 会 MODULE_NOT_FOUND）
& $node --check lib/index.js
& $node --check lib/client.js
```

基线：**190 tests / 189 pass / 0 fail / 1 skip（exit 0）**；跳过项是 opt-in 的活体检查
（设 `DSH_DEEPSEEK_USAGE_BASE_URL=http://127.0.0.1:3080` 即启用）。两条 `--check` 退出码 0。

独立验收（A1–A8 逐条证据 + 三个自建探针 + hash 冻结基线）见 [`docs/verification.md`](docs/verification.md)。

## 目录结构

```
dsh-deepseek-usage/
  package.json         # type=module；exports "." → lib/index.js、" ./client" → lib/client.js
                       # dsh.bundle.patch → ./cordis.patch.yml；dsh.client{platform:'web', inject:[…]}
  cordis.patch.yml     # insert 一行：id/name 均为 dsh-deepseek-usage
  lib/index.js         # 宿主入口（薄装配）：把 src/host/plugin.mjs 的默认导出装配成 cordis 插件
  lib/client.js        # 浏览器入口（生成物）：经典脚本自注册 __ModuleLoader__，六个源模块逐字内联
  src/host/            # 凭证、官方余额接口、zstd 用量台账、/api/dsh-deepseek-usage/* 路由
  src/client/          # footer 余额行 + 弹层 + 零依赖 SVG 图表
  tests/contract.test.mjs      # 冻结的共享 HTTP 契约（单一事实来源）
  tests/host-*.test.mjs        # 宿主半：余额状态机 / 台账聚合 / 路由与装配
  tests/ui-*.test.mjs          # 浏览器半：余额行 / 弹层（含 lib/client.js 漂移守卫与 node:vm 端到端）
  scripts/compose-client.mjs   # 重组 lib/client.js 的唯一规范入口（--check / --print / 写盘）
  docs/load-path.md            # 装载路径实测结论
  docs/verification.md         # 独立验收记录（A1–A8）
```

