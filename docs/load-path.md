# 装载路径实测结论（骨架阶段）

> **文档编号说明**：本文件沿用**计划文档**（`.agents/plans/deepseek-balance-plugin.md` §4）的阶段编号
> T1–T9；**团队任务表**用的是 t1–t12（小写）。对照关系：T1≈t1、T2≈t2、T3≈t3、T4≈t4/t11、T5≈t5、
> T6≈t6、T7≈t7、T9≈t11。下文若同时出现两种写法，指的是同一阶段。


日期：2026-09-17 · 执行者：`host-balance`（T1）· 状态：**已实测**，除显式标注「推断」外均为命令回显

- `DSH_HOME` = `C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home`（已确认进程环境变量）
- runtime = `C:\Users\Administrator\AppData\Local\DSH-Portable\runtime`
- portable Node = `C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe`（**v24.13.1**）
- PATH 上的 `node` = **v22.11.0**（fnm 提供）
- 活动 profile = `web-desktop`；宿主进程 PID 9476（启动于 2026/9/17 16:05:51）**本任务未重启**，端口 3080 未触碰

---

## 0. 结论速览

| # | 结论 | 证据 |
|---|---|---|
| 1 | 装载入口是 `dsh plugin --profile <name> <pnpm args…>`，它是**纯 pnpm 转发器**，没有自己的子命令与 `--help` | §1.2 的真实输出是 pnpm 自己的帮助 |
| 2 | 成功安装后 `dsh.profile.bundles`会**自动**追加本插件名，无需手工编辑 | `plugin-Ddi42qoW.js:46-78` `reconcilePlugins` |
| 3 | bundle 必须在 profile 的 `node_modules` 解析路径上（或 dsh 安装内），**`%DSH_HOME%\plugins` 不被 loader 扫描** | `dsh-app-boot/lib/index.js:807-832` `resolveBundleDir` |
| 4 | 包必须声明 `dsh.bundle.patch`，否则 profile 装载时**直接抛错** | `dsh-app-boot/lib/index.js:849-860` |
| 5 | CLI 必须用 portable Node v24 或 launcher 启动；用 PATH 上的 v22.11.0 跑 `bin.js` 会**静默无输出、退出码 0** | §1.1 |
| 6 | 浏览器半 `lib/client.js` 必须是**经典脚本**（自注册 `window.__ModuleLoader__.load`），不能是 ESM | §3 |
| 7 | `/plugins` 路由只服务已登记的 bundle URL，**不服务包内任意源文件** → 无法靠运行时 `import()` 读 `src/client/*.mjs` | `dsh-client-modules/lib/index.js:857-871` |
| 8 | 放在 `%DSH_HOME%\plugins\` 的包**解析不到任何裸包名**（含 `@deepseek-ai/*`）：宿主半只能 import `node:*`，官方能力一律走 `ctx` 服务，或补一次 `node_modules` 链接 | §5 的锚点实测（**t2 已建 Junction；建后 `@deepseek-ai/*` 可解析，`cordis`/`react` 仍不可解析**） |

---

## 1. 尝试过的命令与真实输出

### 1.1 PATH 上的 `node` 会静默吞掉 CLI（重要）

```
PS> node --version
v22.11.0
PS> node C:\Users\...\DSH-Portable\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile web-desktop --help
PS> (无任何输出)
EXIT=0
```

用 `cmd /c ... > file 2>&1` 落盘复核：**文件 0 字节、退出码 0**。

原因（读代码确认）：`runtime\node_modules\@deepseek-ai\dsh\lib\bin.js` 末尾是

```js
if (import.meta.main) await runCli();
```

`import.meta.main` 是 Node **≥24** 才有的 API；在 v22.11.0 上恒为 `undefined`，`runCli()` 从不执行，于是进程什么都不做、退出 0。这不是「帮助输出落到 pnpm」——那是下一节的现象。

> 操作要求：T6/T7 调用 CLI 时必须用 `C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe`（或 launcher/Electron 自带的调用方式），不要依赖 PATH 上的 `node`。

### 1.2 portable Node v24：`--help` 被原样转给 pnpm

```
PS> $n = "C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe"
PS> & $n ...\dsh\lib\bin.js plugin --profile web-desktop --help
Version 10.34.4
Usage: pnpm [command] [flags]
       pnpm [ -h | --help | -v | --version ]

These are common pnpm commands used in various situations...  (pnpm 自己的帮助全文, 2310 字节)
EXIT=0
```

```
PS> & $n ...\dsh\lib\bin.js plugin --help
error: required option '--profile <name>' not specified
EXIT=1
```

即 `dsh plugin` **没有**自己的 `--help`：`--profile` 之后的一切都转发给 pnpm。真实的「子命令」就是 pnpm 的 `add / remove / update / list / why / link`。

补充（读取实现，`plugin-Ddi42qoW.js`）：

- `runPlugin(profile, args)` → `spawnSync("pnpm", args, { cwd: resolvedProfileDir, shell: win32 })`；
- 相对路径 spec 会被 `anchorPathSpec` 重写为「相对**调用者 cwd** 的绝对路径」（因为 pnpm 的 cwd 是 profile 目录，否则 `add .` 会把 profile 自己链进去）。**绝对路径 spec 原样透传**；
- pnpm 退出码即 CLI 退出码；成功后才做 bundle 列表对账。

`pnpm` 可用性实测：

```
PS> pnpm --version
10.34.4
PS> (Get-Command pnpm).Source
C:\Users\Administrator\AppData\Roaming\fnm\node-versions\v22.11.0\installation\pnpm.ps1
```

### 1.3 profile 现状与配置合成（只读）

`launcher\home\profiles\web-desktop\package.json` 当前 `dsh.profile.bundles`：

```
@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dshmarket, dsh-better-sidebar,
dsh-context, @furongjun1999/dsh-memory, @vectorize-io/hindsight-coding-agents,
@linxin666/dsh-remote-web-ui, @linxin666/dsh-client-ui-skill-explorer,
@nanmicoder/dsh-agent-teams, @liustack/modsearch, dsh-find-plugin, dsh-sidebar-qa
```

```
PS> & $n ...\dsh\lib\bin.js --profile web-desktop --dump-config   # 18393 字节, EXIT=0
# == @deepseek-ai/dsh-base
- id: timer
  ...
# == dshmarket
# == dsh-better-sidebar
# == dsh-context
# == @furongjun1999/dsh-memory, patched by ...\profiles\web-desktop\cordis.patch.yml
...
# == dsh-sidebar-qa
- id: sidebar-qa
  name: dsh-sidebar-qa
```

每个第三方包在合成树里就是一层 `# == <包名>` + 它 `cordis.patch.yml` 里的 `insert` 行。

**`--dump-config` 的写入行为（t11 读实现复核，纠正早期「只读、不写任何文件」的表述）**：
`--dump-config` 会**幂等重写 `<profile>\cordis.yml`**（profile 根配置，内容恒为固定模板 `[]`，语义不变），
并为**缺失**的 profile 建脚手架（`loadProfile` → `initProfile`）；它**不写 runtime、不改
`dsh.profile.bundles`/`dependencies`/`cordis.patch.yml`**。证据：
`runtime\node_modules\@deepseek-ai\dsh\lib\profile-boot-Dk-7KqJc.js:206-211`
（`prepareProfile` 末尾无条件 `writeFileSync(join(profile.dir, "cordis.yml"), PROFILE_ROOT_CONFIG)`），
入口见 `dump-config-lFgMwK8i.js:25`；实测吻合：`profiles\web-desktop\cordis.yml` 的 mtime 与本次
`--dump-config` 运行时间一致，内容仍是标准根模板。

### 1.4 未执行的命令（有意）与边界口径

- **没有**运行 `dsh plugin --profile web-desktop add …`：它会写 `profiles/web-desktop/package.json` + `node_modules` + lockfile，而 `profiles/` 属 T1 的 out-of-scope（装载归装载任务）。
- **没有**重启宿主（PID 9476 保持 2026/9/17 16:05:51 的启动时间）。
- **没有**改动 `runtime\` 下任何文件（只读源码 + 运行 CLI）。

**边界口径（统一表述，取代早期过强的「profiles 零写入」）**：

- `runtime\`：**零写入**。复核（t11 重测）：全树（含目录）最新 mtime = **2026-09-16 14:43:54**
  （`node_modules\zod-to-json-schema\dist\types\parsers`），mtime ≥ 2026-09-17 的条目 **0 个**。
  （早期报告写的 `2026/9/16 8:28` 是「只看文件、不含目录」的口径，不准确，以此处为准。）
- `profiles\`：**未新增或修改 bundle 列表、依赖、`cordis.patch.yml`**。唯一被碰过的 profile 文件是
  `<profile>\cordis.yml` 这类根配置模板（由 `--dump-config` 幂等重写，内容不变，见上）。

---

## 2. loader 到底怎么解析 bundle（读实现）

`runtime\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js`：

```js
function resolveBundleDir(binName, packageName, installAnchor, profileDir) {
  for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
    const dir = packageDirFromAnchor(anchor, packageName);   // createRequire(anchor).resolve.paths(name)
    if (dir !== void 0) return dir;
  }
  throw new Error(`${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh
    installation or ${profileDir}; run 'dsh plugin --profile <name> install' if its dependency is not installed`);
}
```

```js
const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch;
if (declared === void 0) throw new Error(`... profile bundle ${name} declares no dsh.bundle in its package.json`);
```

由此得到两条硬约束：

1. `dsh.profile.bundles` 里写的是**包名**，解析走 Node 的 `node_modules` 查找顺序（锚点：dsh 安装 → profile 目录）。写路径进去是无效的。
2. **`%DSH_HOME%\plugins\` 不是 loader 的搜索目录**：`dsh-home-paths` 只定义 home 本身，整个 runtime 里没有任何代码读取 `home/plugins`。这个目录只是「本插件的作者态落点」，必须通过 profile 的依赖把自己链接进 `profiles\web-desktop\node_modules\`。

---

## 3. 浏览器半的装配约束（关键发现）

以下三条互相咬合，决定了 `lib/client.js` 的形态：

| 事实 | 出处 |
|---|---|
| bundle 以**经典脚本**加载：`<script src="/plugins/<id>/client.js">`，无 `type=module` | `dsh-host-webserver/lib/index.js:34-37` `case "script-src"` |
| 注册表要求 `factory` **同步**返回 exports（`factory(require) → exports`，首次 import 时物化并缓存） | `dsh-client-modules/lib/types/client/manifest.d.ts:147-157`「Closure factory holding the whole bundle body」 |
| 默认加载钩子就是 same-origin classic `<script src>` | 同上 `:164`、`:257` |
| `/plugins` 路由只在**已登记的 URL 表**里查（combo URL / `<id>/client.js` / `.map`），其余 404 | `dsh-client-modules/lib/index.js:857-871` `bundleResource` |

推论：**`lib/client.js` 不能包含 ESM `import`/`export`**（经典脚本会抛 SyntaxError），也无法在运行时 `import('/plugins/<id>/src/client/index.mjs')`——该源码文件不在被服务的 URL 表里。

因此 T1 交付的 `lib/client.js` 是**经典脚本信封**：只做 `window.__ModuleLoader__.load({ id, factory })` 注册，并把实现放在文件顶部一个显式的装配槽里：

```js
var createClientHalf;
loader.load({ id: ID, factory(require) {
  if (typeof createClientHalf !== "function") throw new Error(ID + ": browser half is not composed — inline src/client/index.mjs ...");
  return createClientHalf(require);
}});
```

装配规则（写入 `README.md`，T4/T5 执行，一处改动）：

```js
var createClientHalf = (function () {
  // src/client/index.mjs 的模块体；`export default` → `return`，
  // `import` 行 → `require(...)` 调用（React/槽服务都从 factory 的 require 取）
})();
```

未装配时**故意大声失败**（console 报「browser half is not composed」并指名缺失文件），不静默渲染空白。若队长决定改派 `lib/client.js` 的所有权给 T4/T5，信封形态对该决定无阻塞：直接内联即可。

> 备选方案（需队长裁决，T1 未实施）：给宿主半加一条只读静态路由把 `src/client/index.mjs` 暴露成 URL，再用同步 XHR + `new Function` 装配。它把服务端路由写进了 T2/T3 的交付物（`src/host/routes.mjs`），并通过 `eval` 破坏 bundle 纯净性，故不推荐。

---

## 4. 裸包名解析：`home\plugins\` 是解析孤岛（决定性约束）

宿主半（T2/T3/T4）会想 `import { credentialRef } from "@deepseek-ai/dsh-credentials"`。**在当前选定的
`%DSH_HOME%\plugins\` 位置上，这会失败。** 用 `createRequire(anchor).resolve()` 对三种锚点各测一次
（只读，不写盘）：

```
home\plugins\dsh-deepseek-usage\lib\index.js
  | @deepseek-ai/dsh-credentials -> FAIL MODULE_NOT_FOUND | react -> FAIL MODULE_NOT_FOUND
home\profiles\web-desktop\plugins\dsh-deepseek-usage\lib\index.js
  | @deepseek-ai/dsh-credentials -> runtime\node_modules\@deepseek-ai\dsh-credentials\lib\index.js | react -> FAIL
home\profiles\web-desktop\node_modules\dsh-deepseek-usage\lib\index.js
  | @deepseek-ai/dsh-credentials -> runtime\node_modules\@deepseek-ai\dsh-credentials\lib\index.js | react -> FAIL
```

直接 `import()` 的实测（在插件目录下放探针文件，测完即删）同样三条全部 `ERR_MODULE_NOT_FOUND`。

**Junction 生效后的解析清单（t2 实测，t11 复核并补全）**：建好 `$pkg\node_modules` → `$runtime\node_modules` 后：

| 裸包名 | 经该 Junction | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-credentials` | ✅ 可解析（`credentialRef` = function） | 宿主半取明文 key 的唯一入口 |
| `@deepseek-ai/dsh-host-webserver` | ✅ 可解析 | 只用于类型/服务语义；宿主半仍走 `ctx.webServer` |
| `@deepseek-ai/dsh-llm` | ✅ 可解析 | — |
| **`cordis`** | ❌ **仍不可解析** | runtime 里只有 `@deepseek-ai/cordis`；宿主半**不要** `import "cordis"`，Cordis 对象一律走 `ctx` |
| **`react`** | ❌ **仍不可解析** | 浏览器半的 `require("react")` 由客户端模块表提供，与 Node 解析无关 |

> 给宿主半（余额/台账/装配）的规则：**只 import `node:*` 与 `@deepseek-ai/*`**。`cordis`、`react` 以及任何
> 第三方裸包名都不要出现；需要框架对象时从 `ctx` 取（`ctx.credentials`、`ctx.webServer`、`ctx.logger`…）。


两个结论：

1. **profile 目录树内**（`profiles\web-desktop\...` 任意位置）的包，`@deepseek-ai/*` 能解析到 runtime 的安装
   ——DSH 用 `$DSH_HOME\profiles\node_modules` 镜像 + profile 内 `.dsh-module-fallback` 代理来保证这件事
   （`dsh-app-boot` `healProfilesModuleFallback` / `ensureModuleProxy`）。
2. **`%DSH_HOME%\plugins\` 不在任何一条覆盖链上**，所以那里是解析孤岛。（`react` 三处都解析不到是正常的：
   浏览器半的 `require("react")` 由客户端模块表提供，与 Node 解析无关。）

### 对本插件的处置（队长裁决已落地：A；下面三案保留为决策记录）

> **裁决**：采纳 **A（Junction）**，已由 t2 在本机创建 `$pkg\node_modules` → `$runtime\node_modules`。
> 随后实测 `@deepseek-ai/dsh-credentials`（`credentialRef`）、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-llm` 均可解析；
> **`react` 与 `cordis` 仍不可解析**，故宿主半不要 `import "cordis"`，Cordis 对象一律走 `ctx`。
> 后续 T4/T7 无需再讨论 A/B/C，只需保证 Junction 存在（幂等判据见根 `README.md`「装载前置」一节）。

- **A（推荐，保持计划里的位置）**：给插件目录补一次链接，让官方包可见：
  ```powershell
  New-Item -ItemType Junction -Path "$pkg\node_modules" -Target "$runtime\node_modules"
  ```
  之后 `@deepseek-ai/*` 从插件目录可解析，且不动 `runtime\` 与 `profiles\`。
- **B（零附加动作）**：宿主半只 import `node:*`，官方对象一律从 `ctx` 取（`ctx.credentials`、
  `ctx.webServer`…）。生态里的既有插件正是这么写的（`@linxin666/dsh-client-ui-skill-explorer\lib\index.js`
  只 import `node:os|path|fs|crypto`）。注意：`credentialRef()` 本身是 `dsh-credentials` 的导出，
  若必须用它，就得走 A 或 C。
- **C**：把包放到 profile 目录树内（如 `profiles\web-desktop\plugins\dsh-deepseek-usage`）再 `link:`。
  代价是偏离计划里「`%DSH_HOME%\plugins\` 作为插件落点」的约定。

> T1 未实施 A/B/C 中的任何一项：三者都会写入本任务 in-scope 之外的位置（插件目录下的 `node_modules\` 或 `profiles\`），
> 需要队长裁决。**这是 T2/T4 开工前必须先定的事**：`src/host/plugin.mjs` 一旦 import 官方包而在启动时抛
> `ERR_MODULE_NOT_FOUND`，T7 的装载验证会直接失败。

---

## 5. 推荐装载路径（T6 执行）

### 5.1 首选：`dsh plugin … add link:<绝对路径>`

```powershell
$node = "C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe"
$bin  = "C:\Users\Administrator\AppData\Local\DSH-Portable\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js"
$pkg  = "C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home\plugins\dsh-deepseek-usage"
& $node $bin plugin --profile web-desktop add "link:$pkg"
```

预期行为（按实现推导，T6 需实测复核并回填本节）：

1. pnpm 在 `profiles\web-desktop\` 下执行 `pnpm add link:C:\...\dsh-deepseek-usage`；
2. `package.json` 出现 `"dsh-deepseek-usage": "link:..."`，`node_modules\dsh-deepseek-usage` 成为指向该目录的链接；
3. 因为该包声明了 `dsh.bundle.patch`，`reconcilePlugins` 把 `dsh-deepseek-usage` **追加到 `dsh.profile.bundles` 末尾**（无需手改）；
4. 重启宿主（T6，用户已授权时）→ 宿主半激活；浏览器刷新 → 客户端半加载。

> 前置：若宿主半需要 import 官方包，先按 §4 的 A 案补 `node_modules` 链接，否则第 4 步会在启动期抛
> `ERR_MODULE_NOT_FOUND`。

卸载/回滚：`dsh plugin --profile web-desktop remove dsh-deepseek-usage`（会自动从 bundles 列表移除）；或先在 `cordis.patch.yml` 的行上 `disabled: true` 做免卸载停用。

### 5.2 退化路线：手工写 profile（T6 用，T1 未执行）

若 pnpm 不可用/安装失败，等价手工步骤：

1. `profiles\web-desktop\package.json` 的 `dependencies` 增加
   `"dsh-deepseek-usage": "link:../../plugins/dsh-deepseek-usage"`（**必须是包名 key**，值用 `link:`/`file:` 指向本目录）；
2. 同一文件的 `dsh.profile.bundles` 数组**追加字符串** `"dsh-deepseek-usage"`（不能写路径，见 §2）；
3. 在 profile 目录跑一次 `pnpm install` 生成链接；
4. 重启宿主 + 刷新页面。

### 5.3 生效与验证

- 宿主半需要**重启进程**才加载（profile bundle 层是启动期合成的）；客户端半在页面刷新后加载。
- T6 启动的是**验证用实例**（独立端口/独立 DSH_HOME），不动 PID 9476 / 3080 上用户正在使用的实例。
- 契约自检（无需宿主）：

  ```powershell
  cd $pkg; node --check lib/index.js; node --check lib/client.js; node --test tests/contract.test.mjs
  ```

  T1 实测：`node --check` 两条均 `EXIT=0`；契约测试 = **12 项：11 pass / 0 fail / 1 skipped**（跳过项是 opt-in 的
  活体端点检查，设 `DSH_DEEPSEEK_USAGE_BASE_URL` 即启用）。**t11 复跑（便携 Node v24.13.1）同为此计数**。

- 活体检查（`assertLiveEnvelope`）已按状态码裁决重写，t11 用三个本机 stub 宿主实测过：
  - stub 返回 `503 no_api_key` + `503 ledger_unavailable`（**未配置 key 的宿主**）→ **12 pass / 0 fail**，
    诊断行 `live /balance → degraded 503 no_api_key`、`live /usage → degraded 503 ledger_unavailable`
    —— 即「合规降级态不算失败」，T7 不会因此判 A 项失败。
  - stub 返回健康数据（200 `ok:true`）→ **12 pass / 0 fail**，诊断行 `live /balance → 200 ok:true`。
  - stub 返回**伪装成 200 的失败**（200 + `ok:false`）→ **1 fail**，报错为
    `live /balance: HTTP 200 must carry an ok:true envelope, not a silent failure`（守卫有齿）。

- 骨架是否真的「可被 loader 识别」，T1 直接用 **runtime 里真实的 loader 代码**验证过（只读，不装载 profile）：

  ```
  $ node <probe>.mjs      # import dsh-app-boot 的 loadOverlayPatches / composeEntries
  { "type": "module", "patchField": "./cordis.patch.yml", "patchExists": true,
    "rootExport": "./lib/index.js", "rootExists": true,
    "clientExport": "./lib/client.js", "clientExists": true,
    "clientPlatform": "web", "clientInject": [ … 4 项 … ] }
  patch-list length: 1
  insert rows: [{"id":"dsh-deepseek-usage","name":"dsh-deepseek-usage"}]
  composed:   [{"id":"dsh-deepseek-usage","name":"dsh-deepseek-usage"}]
  host entry import (expected loud failure): ERR_MODULE_NOT_FOUND —
    Cannot find module ...\src\host\plugin.mjs imported from ...\lib\index.js
  ```

  即：bundle patch 能被真实解析器读成一行正确的 plugin row；宿主入口在 `src/host/plugin.mjs` 尚未交付时
  **大声失败并指名缺失文件**（T2 交付该文件后即可装载）。
