# 独立验收记录 — T7（dsh-deepseek-usage）

- 验收者：`verifier`（独立成员，**不是**本插件的任何实现者）
- 验收时间：2026-09-17 20:40 – 21:0x（本机时钟）
- 验收对象：`%DSH_HOME%` = `C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home`，活动 profile = `web-desktop`
- 验收工具链：portable Node **v24.13.1**（`C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe`）
- **结论：A1–A8 全部 passed**，其中 A1/A7 是「源码事实 + 断言」的**合成证明**（非肉眼端到端，
  肉眼确认需用户指定时机重启宿主，见 §1.6）；A2/A3/A4/A5/A6/A8 均为本机实测。
- 副作用清单：`runtime\` **零写入**；profile 被装载改动（`package.json` + `pnpm-lock.yaml`，已备份，回滚命令见 §1.3）；
  **没有**重启用户正在使用的宿主进程；**没有**起第二个 DSH 实例（原因见 §1.5）。

---

## 0. 前置门禁：hash 冻结基线

开工前（20:40:25）核对计划 §6.8 的 11 个宿主半文件，与 t9 报告的指纹**逐位一致**；`lib/client.js` 取
**t6 completed 后的实测值**（t12 冻结的 `F4439CF5` 已在 t6 施工中变更，符合契约预期）：

| 文件 | sha256 前 16 位 | 与基线 | 写入时刻 |
|---|---|---|---|
| `src/host/balance.mjs` | `346E83F939F56966` | ✅ §6.8 | 20:16:18 |
| `src/host/routes.mjs` | `2B2C70CADE03EC6E` | ✅ §6.8 | 20:25:25 |
| `src/host/plugin.mjs` | `357F275397C8F864` | ✅ §6.8 | 20:12:53 |
| `src/host/ledger.mjs` | `796B508CE5C55EA5` | ✅ §6.8 | 20:03:34 |
| `lib/index.js` | `833ACDF6D22458D0` | ✅ §6.8 | 19:44:07 |
| `package.json` | `66771A687F829F86` | ✅ §6.8 | 20:22:02 |
| `cordis.patch.yml` | `29BCA684C9152CA7` | ✅ §6.8 | 19:43:57 |
| `tests/contract.test.mjs` | `33003B976555A574` | ✅ §6.8 | 20:16:38 |
| `tests/host-balance.test.mjs` | `DF4AD2D15E70CCCB` | ✅ §6.8 | 20:08:44 |
| `tests/host-ledger.test.mjs` | `50AFB5C7319EB3ED` | ✅ §6.8 | 20:04:07 |
| `tests/host-integration.test.mjs` | `6AB434DF941C04B4` | ✅ §6.8 | 20:26:38 |
| `lib/client.js`（生成物） | `AFCC782AC5AD1BA5` | 新基线（t6 后实测，`128254 B / 6 模块`） | 20:37:06 |
| `scripts/compose-client.mjs`（队长交付） | `CC79223DEA3C5A42` | 记录值 | 20:49:03 |

**验收结束时重测：上表各项全部未变**（`lib/client.js` 仍是 `AFCC782AC5AD1BA5`，
即便跑过 `scripts/compose-client.mjs` 的写盘路径也未改写） ⇒ §6.8 与 t12 的形态结论仍有效，无需作废。

**门禁第 ② 项（`src/client/*.mjs` 与 `lib/client.js` 的 t6 后实测值）**：

| 源模块 | sha256 前 16 位 |  | 生成物 | sha256 前 16 位 / 大小 |
|---|---|---|---|---|
| `src/client/format.mjs` | `A2640F8A9E386DBE` | | `lib/client.js` | `AFCC782AC5AD1BA5` / 128,254 B / 6 模块 |
| `src/client/service.mjs` | `9FC0EBEFE4893E44` | | | |
| `src/client/row.mjs` | `45F901DC7D035C27` | | | |
| `src/client/index.mjs` | `A97359A39940DF7F` | | | |
| `src/client/chart.mjs` | `A909DB8852B8A35C` | | | |
| `src/client/modal.mjs` | `B8AC779C912FBF6D` | | | |

**门禁第 ③ 项**：以上两处 hash 在验收过程中均未变动 ⇒ **t9 与 t12 的裁决均未失效，无需要上报的变动**。

**结论：门禁通过，无失效裁决需上报。**

---

## 1. 装载验证（非侵入式）

### 1.1 备份（可完整回滚）

```powershell
$bk = "$env:TEMP\t7-profile-backup-20260917-204023"
# 已复制：package.json.orig / cordis.patch.yml.orig / cordis.yml.orig / pnpm-lock.yaml.orig / pnpm-workspace.yaml.orig
```

### 1.2 装载命令与回显

```powershell
$env:DSH_HOME = "C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home"
$node = "C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe"
$bin  = "C:\Users\Administrator\AppData\Local\DSH-Portable\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js"
& $node $bin plugin --profile web-desktop add `
    --store-dir "C:\Users\Administrator\AppData\Local\pnpm\store\v10" `
    "link:C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home\plugins\dsh-deepseek-usage"
```

回显要点（exit 0）：

```
dependencies:
+ dsh-deepseek-usage link:C:/Users/Administrator/AppData/Local/DSH-Portable/launcher/home/plugins/dsh-deepseek-usage
Done in 6.1s using pnpm v10.34.4
```

- peer 警告（`missing peer react@^18.2.0` …）是 profile 既有状态（`autoInstallPeers: false` + hoisted linker），与本次装载无关。
- `--store-dir` 是必需的：本机 pnpm 默认 store 是 `E:\.pnpm-store\v10`，而 profile 的 `.modules.yaml` 钉的是
  `C:\Users\Administrator\AppData\Local\pnpm\store\v10`。

### 1.3 落地结果与 profile diff

| 落地项 | 实测 |
|---|---|
| profile `dependencies` | 新增 `"dsh-deepseek-usage": "link:C:/…/plugins/dsh-deepseek-usage"` |
| profile `dsh.profile.bundles` | 末项新增 `"dsh-deepseek-usage"`（`reconcilePlugins` 自动追加） |
| `node_modules\dsh-deepseek-usage` | Junction → 插件目录 |
| `cordis.patch.yml` | **UNCHANGED** |
| `cordis.yml` | **UNCHANGED** |
| `pnpm-workspace.yaml` | **UNCHANGED** |
| `pnpm-lock.yaml` | CHANGED（pnpm 重写，预期） |

> 回滚（任选）：① `& $node $bin plugin --profile web-desktop remove dsh-deepseek-usage`；
> ② 还原备份的 `package.json` + `pnpm-lock.yaml` 后重跑 `pnpm install`；③ 在插件行加 `disabled: true`。

### 1.4 loader 确实识别了它（boot-free 证据）

```powershell
& $node $bin --profile web-desktop --dump-config   # exit 0
```

末层输出（组合结果 = 各 bundle 层 + profile 层 + home 层 + overlay，按序合成）：

```
# == dsh-deepseek-usage
- id: dsh-deepseek-usage
  name: dsh-deepseek-usage
```

这证明：profile 的 bundle 解析锚点能解析到本包、包声明了 `dsh.bundle.patch`、其 `cordis.patch.yml` 的
`insert` 行被并进了合成树（`--dump-config` 会无条件重写 `<profile>\cordis.yml`，内容幂等 `[]`，属计划 §6.7 允许的口径）。

### 1.5 为什么**没有**起「临时实例」（记录已尝试路线的失败原因）

契约要求「不重启用户宿主」，任务原文建议在另一端口起临时实例。**未采用**，三条理由（前两条是本次源码核验新增的）：

1. **`dsh web` 是 `--profile web` 的硬编码别名，与 `web-desktop` 不是同一个 profile。**
   `runtime\...\dsh\lib\bin.js:100` 定义 `program.command("web")`，`resolveBoot(web, "web", …)` 把 profile 钉成 `"web"`；
   `bin.js:96-99` 的 `rejectParentOptions` 明确**拒绝** `web` 子命令前面的父级 `--profile`。
   实测两种 profile 的组合差异：

   ```
   & $node $bin --profile web-desktop --dump-config   → 末层 "# == dsh-deepseek-usage"，命中本插件
   & $node $bin --profile web         --dump-config   → "dsh-deepseek-usage" 命中数 = 0（web 只含 dsh-base + dsh-web-app）
   ```

   ⇒ 计划 §6.4 记录的尝试 `dsh web --port 3099 …` 无论启动成功与否，**组合的都是 `profiles\web\`**：它既不含
   `web-desktop` 的 bundle，也永远不会含本插件，**结构上就不可能验证本插件**。（plan 把「40 秒无输出」归因于
   launcher 的 `promptOnFirstRun`；本次未复现该现象，也不依赖该解释——单凭「profile 选错」这一条即已否决该路线。）
   与 launcher 自己启动宿主形式相同的正确形态是 `& $node $bin --profile web-desktop --no-open --port 3099`。
2. **但第二条路被本机已装插件堵住**：即便用正确形式起第二个实例，它共享的**不只是** `DSH_HOME`：
   `@linxin666/dsh-remote-web-ui`（profile 里已装）在 `lanBind` 有配置时会**改写 profile 的 patch 文件**并调用
   `netsh` 增删防火墙规则（`lib/index.js:4476-4503`），`@furongjun1999/dsh-memory`/hindsight 的存储也不在 `DSH_HOME` 下——
   第二个实例会与用户正在使用的那一个**并发写同一批状态**。为了一次验收去冒损坏用户会话状态的风险，
   与「不重启用户宿主」这条硬约束的**意图**相悖。
3. 队长裁决（计划 §6.4 + 开工消息）已明确该路线经两轮实测证伪并要求改用**真实 profile 备份法**。
   §1.1–§1.4 即该方法的完整执行。

> 结论：装载**已在真实 profile 完成并核验**，验证方式退化为「boot-free 组合证据 + 单进程真实宿主代码 harness」，
> 没有引入任何第二个宿主进程。

### 1.6 生效状态（用户处置项，验收者不得自行执行）

- 宿主半的 bundle 层在**进程启动期**合成 ⇒ **必须重启宿主进程**才会注册 `/api/dsh-deepseek-usage/*` 与浏览器 bundle。
- **只读探针**（不写入任何状态）确认当前 3080 宿主仍**未**加载本插件：

  ```
  GET /plugins/dsh-deepseek-usage/client.js   → HTTP 404
  GET /api/dsh-deepseek-usage/health          → HTTP 401（GUI 的凭证门）
  GET /                                       → HTTP 401（未带浏览器会话 cookie）
  ```

- 因此 **A1 / A7 的「肉眼端到端确认」与 A3 的「活体页面 DOM 复核」属用户处置项**，判据见 §4 的对应行。
- 重启后建议按 §7 的清单复核一次（三条命令）。

### 1.7 非侵入性的收尾核验（验收结束时实测）

| 检查 | 结果 |
|---|---|
| 用户宿主是否被动过 | `PID 25720`，`CreationDate = 2026/9/17 16:40:34`（与我开工前观测到的**完全一致**），命令行仍是 `dsh\lib\bin.js --profile web-desktop --no-open --port 3080`，`127.0.0.1:3080` 仍由它监听 ⇒ **未重启** |
| 是否留下第二个宿主 | `3098 / 3099 / 3100` 上**无任何监听**（本次从未启动第二个实例） |
| 临时隔离 home | 已删除（其中含一份凭证文件副本，按密钥卫生要求清理；探针脚本只在运行时读取真实凭证，从不落盘） |
| profile 备份 | 保留在 `%TEMP%\t7-profile-backup-20260917-204023\`（仅 `package.json` 等 5 个配置副本，无密钥），供回滚 |
| 插件安装树 | 无 `node_modules` 之外的杂物、**无 `.ledger-cache`**（台账索引按装配层设置落在 `%DSH_HOME%\storages\`） |

---

## 2. 工具链口径（必须用 portable Node v24）

PATH 上的 `node` 是 **v22.11.0**，其 `node:zlib` **没有** `zstdDecompressSync`：

```
$ node --version                                    → v22.11.0
$ node -e "const z=require('node:zlib');console.log(typeof z.zstdDecompressSync)"  → undefined
$ node --test tests/host-ledger.test.mjs
TAP version 13
# import { zstdDecompressSync } from "node:zlib";
#          ^^^^^^^^^^^^^^^^^^
# SyntaxError: The requested module 'node:zlib' does not provide an export named 'zstdDecompressSync'
not ok 1 - tests\host-ledger.test.mjs
```

⇒ 这是**工具链问题**（import 期 SyntaxError），会被误报成实现失败。全部验收命令一律使用：

```powershell
$node = "C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe"
cd "C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home\plugins\dsh-deepseek-usage"
& $node --test              # 裸形式；目录形式 --test tests/ 会 MODULE_NOT_FOUND
```

**验收基线：190 tests / 189 pass / 0 fail / 0 cancelled / 1 skipped（exit 0）**；
`--check lib/index.js` = 0、`--check lib/client.js` = 0。
（1 个 skip 是 opt-in 的活体检查，需设 `DSH_DEEPSEEK_USAGE_BASE_URL`。）

---

## 3. 本次自建的三个独立探针（不复用实现者的测试文件）

全部落在 `D:\Temp\Administrator\t7-verify\`，零依赖，只用 `node:*`：

| 探针 | 覆盖 | 运行 |
|---|---|---|
| `host-e2e.mjs` | A2 / A3 / A5 / A6 / 状态码矩阵 / 围栏 | `& $node D:\Temp\Administrator\t7-verify\host-e2e.mjs` |
| `r3-client-error-code.mjs` | t12 R3 端到端错误码 + A1 注册事实 + A3 DOM 扫描 + A6 无 key 态 | `& $node D:\Temp\Administrator\t7-verify\r3-client-error-code.mjs` |
| `a4-ledger-compare.mjs` | A4（**官方**解码器 vs 插件台账） | `& $node D:\Temp\Administrator\t7-verify\a4-ledger-compare.mjs`（需 `DSH_HOME`） |

设计要点（为什么这些证据独立）：

- `host-e2e.mjs` 加载的是**loader 唯一会挂载的入口** `lib/index.js`（不是 `src/host/plugin.mjs`），
  凭证来自**真实凭证库**（`%DSH_HOME%\.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`，全程不打印），
  上游是**真实** `https://api.deepseek.com/user/balance`，路由经**真实 HTTP** 调度。
- `r3-client-error-code.mjs` 在 `node:vm` 里把**出货产物** `lib/client.js` 当经典脚本执行
  （捕获 `window.__ModuleLoader__.load({id, factory})`），宿主侧是**真实的** `plugin.mjs`/`routes.mjs`
  在真回环端口上服务；只有 `document` 是本次写的记录型 DOM-lite，`react` 是最小 stub
  （契约明确允许「注入 fake」）。渲染出的 DOM 会**序列化成 HTML 落盘**（`r3-rate-limited.dom.html`，13,490 B）。
- `a4-ledger-compare.mjs` 用**官方 runtime 的解码器**：运行时从
  `runtime\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\index.js:1298` **逐字抽取** `scanZstdFrames`
  再逐帧 `zstdDecompressSync`，而插件台账用的是它自己手写的帧扫描器——两条不同实现互证。
  （顺带实测：`zlib.createZstdDecompress()` **流式**解码同样只覆盖首帧——最大日志只解出 202 B 就正常结束、不报错；
   `zstdDecompressSync` 也是 202 B。所以「多帧容器必须逐帧走」这条结论对**一次性与流式两种 API 都成立**。）

---

## 4. A1–A8 逐条判定

| # | 判定 | 判定方式 | 证据 |
|---|---|---|---|
| **A1** | **passed**（合成证明，非肉眼端到端） | 宿主外壳源码事实 × 本插件注册事实 | ① runtime `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js:292-301`：`footArea` 的 children 依次是 `[footerActions(renderSlot("sidebar.footer.action", {wide})), settingsArea(renderSlot("sidebar.settings", {wide}))]` ⇒ 该槽**先于**设置行渲染；② 同文件 `:399-402` 声明 `"sidebar.footer.action": { kind:"list", scope:"root" }`；③ 本插件注册的**正是**该槽：探针输出 `bundle id=dsh-deepseek-usage; registered slot="sidebar.footer.action" id="deepseek-usage" order=100`；④ 套件内 `tests/ui-row.test.mjs` 另有「渲染在 settings 之前 + `stopPropagation===1`」的断言，全绿（190/189）。**肉眼确认需宿主重启，属用户处置项**（§1.6）。 |
| **A2** | **passed** | 与直接调官方接口逐位对比 | 探针：`plugin CNY totalBalance=96.80 vs official CNY total_balance=96.80; granted=0 toppedUp=96.80 isAvailable=true; 该次插件读取触达上游 1 次`。（当天首轮同法测得 `98.17 == 98.17`，差值是期间真实消费所致，非实现缺陷。） |
| **A3** | **passed** | 三处检索，均 0 命中 | ① 余额响应体 163 B + 全部响应头：精确 key 值与 `/sk-[A-Za-z0-9_-]{6,}/` 均 0 命中；② `/usage` 响应体 13,004 B：0 命中；③ 弹层**渲染后的 DOM** 序列化 13,490 B：0 命中；④ 出货产物 `lib/client.js` 的可执行部分（去注释后 81,396 B）：0 命中，且 `api.deepseek.com` 命中数 = **0**（浏览器半连上游域名都不知道），除 SVG 命名空间 `http://www.w3.org` 外无任何外部绝对 URL。⑤ 活体 3080 页面因 GUI 凭证门返回 401，**无法**非侵入取 DOM；该活体复核列入用户处置项（§7）。 |
| **A4** | **passed** | 官方解码器 + 自算 vs 插件台账，≥3 个真实会话 | 4/4 会话三个 token 字段**完全相等**（见下表）。官方解码器对最大日志解出 **1334 帧 / 11,045,047 B**，证明多帧容器被完整解开（一把梭只会得到 202 B）。 |
| **A5** | **passed** | 真实 HTTP 计数上游调用 | 重复读 → `cached=true` 且**上游 0 次**；`?force=1`（刷新按钮发出的那条请求）→ `cached=false` 且**上游 1 次**，返回同一金额。**页面内点击刷新**的可视反馈属用户处置项（§7）。 |
| **A6** | **passed** | 9 种降级场景，走真实路由与真实 HTTP | 见表下第二块。「不崩溃」判据：所有失败都是**结构化信封 + 真实状态码**，且 `/health` 仍 200。 |
| **A7** | **passed**（合成证明，非肉眼端到端） | 源码事实 × 套件断言 | `row.mjs` 按 `wide` 分支；外壳以 `renderSlot("sidebar.footer.action", { wide })` 传参（`wide===false` 即 56px 轨道）；套件 `tests/ui-row.test.mjs` 断言「56px 轨道退化为图标 + Tooltip 数字」「无 primitive kit 时轨道仍可响应」，全绿。**肉眼确认需宿主重启**，属用户处置项。 |
| **A8** | **passed** | 路径审查（`git status` 等价） | `runtime\` 下 **25,440** 个文件，最新 mtime = `2026-09-16 08:28:20`，**晚于 2026-09-17 00:00 的文件数 = 0**；且 `Select-String "dsh-deepseek-usage"` 在 `runtime\node_modules\@deepseek-ai\**\*.js` 命中 **0** 处（没有被任何官方包引用/补丁）。本插件对 runtime 的唯一关系是包内 Junction 指向 `runtime\node_modules`（只读解析，写在插件树里）。 |

### README 完成度核对（验收项「README 完成且含单价来源与更新方法」）

原 `README.md` 是 T1 的骨架（自述「当前只覆盖骨架与装载方式，完整文档由 T6 补齐」）。本次由验收者在骨架上补全并修正：

| 要求 | 落地位置 | 核对结果 |
|---|---|---|
| 安装/装载 | 「安装与装载」（Junction 前置 → `dsh plugin add` 完整命令含 `--store-dir` → 手工退化路线 → 生效/回滚） | ✅ 命令与本次实际执行的一致 |
| 配置项 | 「配置项」（默认无用户必填项；可选 `config:{timeoutMs,ttlMs}` 覆盖；`DSH_HOME` / `DSH_DEEPSEEK_USAGE_BASE_URL` 两个环境变量） | ✅ 与 `plugin.mjs:168-177` 的实现一致 |
| 单价来源与更新方法 | 「单价来源与更新方法」（来源 URL + 抓取日 2026-09-17 + 峰谷定义 + 价格表 + 5 步更新流程，指明只改 `ledger.mjs` 一处） | ✅ 数字与 `PRICE_TABLE_USD_PER_MILLION`/`PRICE_TABLE_SOURCE` 逐项一致 |
| 已知限制（本地估算 vs 平台权威、CSP 不可内嵌） | 「已知限制」9 条（含 `frame-ancestors 'none'`、估算口径、未知模型计 0、`truncated` 语义、包内 Junction 等） | ✅ |
| **装配规则与 `lib/client.js` 头部一致（U1）** | 「浏览器入口 `lib/client.js`（⭐ 重组前必读）」三条硬规则：① 兄弟 `import "./x.mjs"` **整行删除、不得改写成 `require`**（模块表无相对 id）② 只有 `react` 与 `@deepseek-ai/dsh-client-ui-primitives` 走 `require`（外壳静态种子模块，已列全 9 个）③ **重组后必须重跑漂移守卫**，并给出 `scripts/compose-client.mjs --check/--print/写盘` 的用法与 exit 码语义 | ✅ 三句均已写入；另加「不要凭直觉改拼接格式」的告诫 |
| 其他修正 | ① 删除「由 T6 补齐」的过期自述；② 宿主 PID 由计划里的 `9476` 更正为**实测 25720**（`state.json` 的 24200 是 launcher）；③ 修正骨架里「`import` → `require('x')`」这条**会误导重组者写出相对 require** 的表述；④ 窗口项更正为实测的 `[7, 30]`；⑤「估算值标注」指向真实字典键 `usage.chart.cost.note`（`data-estimate-label="1"`） | ✅ 逐条已核 |

> 更正记录：本次核对中我先在被验文档里写下两处不实内容（「估算值标注来自 `usage.estimateHint`」——该键不存在；
> 「弹层可选 7/30/90/365 天窗口」——`USAGE_WINDOWS` 实测只有 `[7,30]`），均由源码核对抓出并改正后落盘。

### A4 明细（2026-09-17 20:45 前后）

| 会话 | 原始大小 | 官方解码 | 帧数 | usage 事件 | 计入 | 独立求和（in / cacheRead / out） | 插件台账 | 相等 |
|---|---|---|---|---|---|---|---|---|
| `…\session-d2c410e4-…` | 4,181,919 B | 11,045,047 B | 1334 | 412 | 412 | 512,614 / 123,187,712 / 219,230 | 同左 | ✅ |
| `…\session-7ec64c2f-…` | 2,243,748 B | 7,909,090 B | 844 | 260 | 260 | 971,280 / 83,527,808 / 356,246 | 同左 | ✅ |
| `…\2c871707-…` | 1,514,819 B | 5,259,835 B | 710 | 206 | 206 | 165,660 / 41,421,440 / 218,198 | 同左 | ✅ |
| `…\session-da5c714c-…` | 1,340,431 B | 4,471,348 B | 716 | 207 | 207 | 677,341 / 47,963,264 / 146,450 | 同左 | ✅ |

整根聚合（12 个日志、`days=365`、`cacheDir=null`）：`in=3,231,161 / cacheRead=404,386,816 / out=1,712,844`，
`filesListed=12 filesRead=12 usages=1712 badFrames=0 tornFrames=0 truncated=false`。
（数字随宿主持续写日志而变化属正常；每次运行的**两组数字都逐位相等**才是判据。）

### A6 降级矩阵（全部经真实 HTTP + 真实路由代码）

| 场景（注入点） | HTTP | 闭集码 | 信封/脱敏 |
|---|---|---|---|
| 未配置 key（`getApiKey→undefined`） | 503 | `no_api_key` | `{ok:false,error:{code,message}}` ✅ |
| 上游 429 | 502 | `rate_limited` | ✅ |
| 上游 401 | 502 | `unauthorized` | ✅ |
| 上游 500 | 502 | `upstream_error` | ✅ |
| 断网（`ENOTFOUND`） | 502 | `network_error` | ✅ |
| 超时（40 ms 预算） | 504 | `timeout` | ✅ |
| 上游体非 JSON | 502 | `bad_response` | ✅ |
| 台账不可用（无 zstd） | 503 | `ledger_unavailable` | ✅ |
| 台账抛错（消息里塞 `sk-…`） | 500 | `internal` | ✅ 且消息被脱敏为 `… with [redacted]` |

围栏/方法（真实服务器）：`POST` → 405；`HEAD` → 200 空体（0 B）；`Host: evil.example` → 403 且体为
`{"error":"forbidden: loopback-only"}`；同 socket 回环 `Host` → 200。
`?days=` 矩阵：`0 / 366 / abc / 7.5 / -1 / 3&days=4` → 全部 `400 bad_request`；边界 `1`、`365` → 200。

### 组合脚本正式化与「改源必须重组」（验收项）

`scripts/compose-client.mjs`（队长交付，独立验收者复核）满足验收项的全部要求：

| 要求 | 实测 |
|---|---|
| 落在包内正式路径 | `plugins/dsh-deepseek-usage/scripts/compose-client.mjs`，7,493 B，零依赖（只用 `node:fs`/`node:path`/`node:url`） |
| 覆盖**全部六个**模块、按当前 bundle 的分节顺序 | `--check` 通过即证明：生成物与 `src/client/{format,service,row,index,chart,modal}.mjs` 逐字节一致（顺序不同会立刻报漂移） |
| 复现「经典脚本信封 + 六个分节标记 + 末尾 composition wiring（含 `setModalFactory` 接线）」 | 分节标记实测为 `begin: src/client/{format,service,row,index,chart,modal}.mjs` + `begin: composition wiring (assembly layer, not a source module)`；接线行为 `setModalFactory(function (runtime) { return createUsageModalOpener(runtime); })` |
| **用它重新生成一遍 `lib/client.js`，然后跑插件根裸 `node --test` 必须 exit 0** | 已执行写盘路径 → `already in sync (128254 bytes, 6 modules)` exit 0 → 紧接着裸跑 `node --test` = **190/189 pass/0 fail/1 skip，exit 0**（t5/t6 的漂移守卫与导出等价守卫全绿） |
| 生成物的 sha256 记入 verification.md | `lib/client.js` = `AFCC782AC5AD1BA55B938423BAEB3217D9C46CD17336B8E9EB0E1B831A80771`（§0 表）；脚本自身 = `CC79223DEA3C5A42` |

用法与 exit 码语义（已同步写入 README「浏览器入口」）：`--check` = 只校验不改文件，同步 exit 0 / 漂移 exit 1；
`--print` = 输出到 stdout 便于 diff；无参数 = 写盘（内容已同步时不改写）。
> 未采纳的可选加强：在 `tests/ui-*.test.mjs` 里 `spawnSync` 跑 `--check` 并断言 `status === 0`——
> `tests/` 不在本次验收的 inScope，且漂移守卫本身已在守等价性，故留给后续任务。

### t6 自建跨半集成用例的复核（不重复造轮子）

`tests/ui-modal.test.mjs` §"3b. cross-half" 的两个用例**确实存在且为真实跨半集成**（非 stub）：

- `startHostFamily()`（该文件 `:1490-1520`）用的就是**真实宿主代码**：
  `import { createUsageReader as createHostUsageReader, makeRoutes, ROUTES } from "../src/host/routes.mjs"`，
  再用 `createServer` 监听回环端口，浏览器半只发相对路径、由 `originBoundFetch(origin)` 桥到该 origin。
- `:1566` `cross-half: the popover renders what the real host routes answer`（真实响应驱动余额卡 + 双图 + 明细表）；
  `:1602` `cross-half: the host's real error statuses reach the popover as the four states`，实测只覆盖
  **503 `ledger_unavailable`** 与 **400 `bad_request`** 两种（`:1613-1617`、`:1642-1645`）。
- ⇒ 契约点名要补的 **502 `rate_limited`** 在该用例中**不存在**，因此本次自建探针是**补齐而非重复**：
  它同样用真实 `makeRoutes` + 真实 HTTP，但上游注入 429 以产生 502，并断言 `data-error-code="rate_limited"`（§5）。

### 套件与生成物一致性（旁证）

- 全量：`190 tests / 189 pass / 0 fail / 1 skipped`，exit 0（连跑多次稳定）。
- 组合脚本（**队长交付并验证**，`scripts/compose-client.mjs`，sha256 `CC79223DEA3C5A42`）复核：
  `--check` → `lib/client.js is in sync with src/client/*.mjs`，**exit 0**；
  写盘路径 → `already in sync (128254 bytes, 6 modules)`，**exit 0**，前后 `lib/client.js` hash
  **都是 `AFCC782AC5AD1BA55B938423BAEB3217D9C46CD17336B8E9EB0E1B831A80771`**（幂等、未改写）。
- 漂移守卫（`tests/ui-*.test.mjs` 的逐字 + `toString()` 比对）全绿，是本项的第二道闸。

---

## 5. t12 R3：补一条端到端错误码断言（已落实）

契约要求的场景：**宿主返回 502 + `rate_limited` 时，DOM 里出现该闭集错误码**。
本项由 `r3-client-error-code.mjs` 覆盖，链路每一跳都是出货代码：

```
stub 上游 429  →  真实 routes.mjs/plugin.mjs（真回环 HTTP）  →  HTTP 502
   body = {"ok":false,"error":{"code":"rate_limited","message":"official balance endpoint answered HTTP 429"}}
→  node:vm 执行出货产物 lib/client.js  →  真实 service.mjs 解析（先看状态、再取闭集码）
→  真实 modal.mjs 渲染  →  记录型 DOM
```

实测输出：

```
PASS  R3.wire-status-and-code                      GET /balance → HTTP 502 body={"ok":false,"error":{"code":"rate_limited",…}}
PASS  R3.dom-carries-the-closed-set-code-rate_limited
      余额卡元素带 data-error-code="rate_limited"；文案="余额读取失败：official balance endpoint answered HTTP 429（rate_limited · HTTP 502）"
PASS  R3.dom-shows-the-closed-set-code-not-only-the-transport-line
PASS  R3.transport-status-is-labelled-as-detail-only   ← 502 只出现在括号明细里，绝不是唯一信息
PASS  R3.ledger_unavailable-also-reaches-the-dom   wire 503/ledger_unavailable → DOM codes=["ledger_unavailable"]
PASS  A6.no-key-renders-a-definite-unconfigured-state  wire 503/no_api_key → DOM codes=["no_api_key"]，弹层 open=true
PASS  A3.rendered-dom-carries-no-key-material      序列化 DOM 13,490 B，0 命中
```

**该探针 15/15 通过**（覆盖 A1 注册事实、R3 三条、A3 DOM 扫描、A6 无 key 态、bundle 形态三条）。
两条边界事实（记录，非缺陷）：

1. **文案优先级**是「宿主 `message` → 闭集码字典文案 → 传输层兜底 `宿主返回 502`」
   （`src/client/service.mjs:124-149`）。所以当宿主给了 `message` 时，**闭集码仍以 `data-error-code` 属性 +
   括号明细的形式出现在 DOM 上**，但正文用的是宿主那句更具体的话。R3 的判据（「不得只出现传输层文案」）满足。
2. **客户端不替宿主发明错误码**：若 5xx 的响应体**不是**冻结信封，客户端只能退化为传输层文案
   （`data-error-code=""`、文案 `宿主返回 502`）。实测该边界成立——这是刻意设计，宿主侧契约测试保证真实宿主永远给信封。

初次实现本探针时我**误判**了第 1 条（期望字典文案），被自己的断言抓出后按实现语义修正，未削弱断言——记录在此以证「断言不是照着实现抄的」。

---

## 6. 边界与残留风险（不阻塞验收）

| 级别 | 事项 | 处置 |
|---|---|---|
| low | `ledger.mjs` 的 `defaultCacheDir()` 仍指向包内 `.ledger-cache`；装配层已显式传 `storages\`（实测包内无该目录），但将来忘记传 `cacheDir` 的直接调用会把缓存写进安装树 | 已知（计划 §6.9 L1），可后续收敛 |
| low | 包内 `node_modules` Junction 是本机绑定，换机/换装路径需重建 | README「装载前置」已写明 |
| low | `?days=3&days=4` 重复参数按契约判 `400`；`force` 重复未规定（取首值） | 已写入 README「已知限制」 |
| low | 弹层窗口选项只有 `[7, 30]`（契约允许 1–365，由 API 层支持） | 产品选择，非缺陷 |
| info | 端到端错误码的**静态守卫**目前仍只在 `tests/ui-*.test.mjs`（宿主契约套件不加载客户端）；本次的合成探针不进 CI | 若需长期守卫，把本探针的命令挂进发布前检查即可 |
| info | 本文件中的 A4 数字会随宿主持续写日志而变化 | 判据是「每次运行两组数字逐位相等」 |

**未发现任何 blocker；没有阻断性发现需要下游停止。**

---

## 7. 交给用户的动作清单（需用户明确指定时机）

宿主半的 bundle 层在启动期合成，因此**只有重启宿主后**才能做下面这几项肉眼复核（验收者不得自行重启）：

1. 重启宿主（会中断当前 GUI 会话），刷新 `http://127.0.0.1:3080`；
2. **A1 / A7 肉眼确认**：侧边栏脚部出现余额行且在「设置」行**上方**；折叠成 56px 轨道时不破版（图标 + Tooltip 数字）；
3. **A3 活体复核**：DevTools → Network，检查页面文档与 `/api/dsh-deepseek-usage/*` 响应体、以及 Elements 面板，
   检索 `sk-` 应零命中；`/plugins/dsh-deepseek-usage/client.js` 应从 404 变为 200。
4. 建议顺手跑一次活体契约检查（可选）：

   ```powershell
   $env:DSH_DEEPSEEK_USAGE_BASE_URL = "http://127.0.0.1:3080"
   & $node --test tests/contract.test.mjs
   ```
