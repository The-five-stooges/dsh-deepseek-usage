# T10 独立复核：浏览器半合并质量门（t5 余额行 + t6 弹层/图表，经典脚本形态）

- 复核者：`reviewer-foundation`（t10，attempt 1 / `b3154bbe-fcc5-428c-97bf-f922432b1197`）
- 被复核：`t6`（reviewedTaskId）+ `t5`（依赖一并纳入）
- 复核时间：2026-09-17 20:41–20:52 ｜ 只读；本文件是本次复核唯一写入路径（探针/快照均在 `%TEMP%`）
- 解释器：`C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe`（v24.13.1）
- **裁决：verdict = pass**。形态（经典脚本）、装配（真的内联了）、槽位与交互、弹层行为、零新增依赖、两条红线全部由我独立复现；t5 的 4 条与 t6 的 4 条验收标准逐条有证据。仅 1 条 low（README 文案）与 3 条 info。

---

## 1. 冻结的 revision

| 文件 | sha256 (16) | mtime | 大小 |
|---|---|---|---|
| `lib/client.js`（生成物） | `AFCC782AC5AD1BA5` | 20:37:06 | 128,254 B |
| `src/client/format.mjs` | `A2640F8A9E386DBE` | 20:10:43 | 8,585 B |
| `src/client/service.mjs` | `9FC0EBEFE4893E44` | 20:24:40 | 15,612 B |
| `src/client/row.mjs` | `45F901DC7D035C27` | 20:21:59 | 21,052 B |
| `src/client/index.mjs` | `A97359A39940DF7F` | 20:25:21 | 10,187 B |
| `src/client/chart.mjs` | `A909DB8852B8A35C` | 20:25:43 | 14,241 B |
| `src/client/modal.mjs` | `B8AC779C912FBF6D` | 20:36:51 | 55,222 B |
| `tests/ui-row.test.mjs` | `3710631EA96AB81F` | 20:32:16 | 59,356 B |
| `tests/ui-modal.test.mjs` | `1B476DA22361B3B6` | 20:37:00 | 83,149 B |

`lib/client.js` 是**生成物且在我的复核窗口内被重组合多次**（58,107 → 126,702 → 128,017 → 128,254 B）。我按 `AFCC782A` 复核，并在 **45 秒间隔两次采样**确认该 revision 稳定（hash 未变）。**§2 的套件、§3 的探针、§4/§5 的行号全部对应这一 revision。**

## 2. 两条 verify（我自己跑）

| 命令 | exit | 结果 |
|---|---|---|
| `node --test tests/ui-row.test.mjs` | 0 | **tests 44 / pass 44 / fail 0 / cancelled 0 / skipped 0** |
| `node --test tests/ui-modal.test.mjs` | 0 | **tests 51 / pass 51 / fail 0 / cancelled 0 / skipped 0** |

## 3. 我的独立探针（`%TEMP%\t9-probe\t10-ui-probe.mjs`，8 项全 PASS）

```
INFO  lib/client.js revision sha256=afcc782ac5ad1ba5 bytes=128254 textLength=126935
PASS  1 classic-script form: parses via node:vm Script, no import/export statement, no import.meta, no relative require() | 3026 lines
PASS  2 factory returns the composed client face (no 'browser half is not composed') | apply=function name="dsh-deepseek-usage" keys=name,inject,apply,setModalOpener,getModalOpener
PASS  2b external require specifiers used by the bundle | react,@deepseek-ai/dsh-client-ui-primitives
PASS  3 assembly: all 6 src/client modules inlined into the slot | format.mjs:inlined service.mjs:inlined row.mjs:inlined index.mjs:inlined chart.mjs:inlined modal.mjs:inlined
PASS  4 slot/interaction surface present in code AND tests | slot name in bundle; slot name in sources; slot name asserted in ui-row tests; stopPropagation in bundle; stopPropagation asserted in ui-row tests; four states; collapsed rail branch
PASS  5 modal behaviours present in code AND tests | inert applied to #root; Escape closes; overlay/backdrop click closes; card shows fetch time; card shows cached state; window switch 7/30 days; empty degradation; SVG built by hand
PASS  6 zero new dependencies | src imports: ./format.mjs,./service.mjs,./row.mjs,./chart.mjs | package deps: react | library names in code: none | prose-only mentions: 4
PASS  7 red lines | platform refs: platform.deepseek.com/usage | new-window: yes | iframe: no | api.deepseek.com in code: no | key material in code: no
```

方法说明（为什么这些不是"读文件"式结论）：

- **经典脚本性是"求值"出来的**：`new vm.Script(bundle)` 成功即证明无 ESM `import`/`export`、无 `import.meta`、无顶层 `await`（任一存在都会 SyntaxError）；另用去注释源码扫行首 `import|export` 语句（0 命中）与**相对 `require()`**（0 命中——`/plugins` 路由只服务已登记 URL，相对模块名不可能被解析）。文件里出现的 `./x.mjs` 字样只有 3 处，全在**注释**中（`L24/L1431/L1807` 的组合作业说明）。
- **装配是"跑"出来的**：在 VM 里注册 `__ModuleLoader__` → 取 `factory` → 用一个**会记录每次 require 的 stub** 调用它：**没有抛 `browser half is not composed`**，且同步返回 `{name:"dsh-deepseek-usage", inject, apply, setModalOpener, getModalOpener}`；同时确认**无 loader 时仍大声抛错**。
- **内联是逐模块比对出来的**：把 `src/client/*.mjs` 按文档的合成规则（去行首 `export`、丢单行兄弟 import）处理后做**空白归一化子串匹配**，六个模块体全部命中 bundle。空壳槽（`var createClientHalf;` 未赋值）会立刻因 `browser half is not composed` 抛出而失败——本次未出现。
- **红线只扫可执行代码**：块注释与整行注释先剔除再匹配（否则 `no d3/mermaid` 这类"声明没有依赖"的注释会造成假阳——第一次扫就撞上了，已修正）。

## 4. t5 的 4 条验收（契约原文逐条）

| # | 标准 | 结论 | 证据（我的复核） |
|---|---|---|---|
| A1 | 槽位注册到 `sidebar.footer.action`，渲染位置在设置行上方 | **pass** | `src/client/row.mjs:36` `export const ROW_SLOT = "sidebar.footer.action"`（`:4-8` 注释给出座位出处）；测试 `ui-row.test.mjs:723` 断言该常量、`:741` 断言侧边栏运行时源码里 `renderSlot("sidebar.footer.action"` 出现在 settings **之前**；bundle 内同样命中该槽名。侧边栏真实渲染顺序我在 T8 复核中已独立确认（`dsh-client-ui-sidebar/lib/client.js:293-298`：`sidebar.footer.action` 槽紧邻 `settingsArea` 之前） |
| A2 | 刷新按钮不触发弹层（有测试或明确代码断言） | **pass** | 代码：`row.mjs` `refreshClickHandler(onRefresh)` 第一件事就是 `event.stopPropagation()`（仅在存在时调用，随后才 `onRefresh()`）；测试：`ui-row.test.mjs:845` `assert.equal(record.stopPropagation, 1, "stopPropagation is required: an un-stopped click also opens the popover")` |
| A3 | 四态（加载中/正常/未配置/错误）各有独立分支且错误态可重试 | **pass** | `row.mjs` 有 `loading / ready / unconfigured / error` 四态（`ROW_STATES`）与分别的渲染分支（`:291-320`），错误态携带重试文案（`:244` `text("row.retry")`）；探针在源码与 bundle 两处都命中四态标识；ui-row 44 条全绿覆盖这些分支 |
| A4 | 折叠态渲染图标 + Tooltip；浏览器半不含 API key 读取或 `api.deepseek.com` 直连 | **pass** | `row.mjs:20` 明写 `wide === false`（56px 轨道）降级为「图标 + Tooltip」，四种视图各自构造 `tooltip` 文本（`:211/:227/:244/:258`）、`wrapWithTooltip`（`:267`），测试用 Tooltip stand-in（`:299`）；红线见 §6 |

## 5. t6 的 4 条验收（契约原文逐条）

| # | 标准 | 结论 | 证据 |
|---|---|---|---|
| A1 | 弹层打开后余额卡展示真实数据字段，并标注数据时间与是否来自缓存 | **pass** | `modal.mjs` 卡片行从宿主响应取 `totalBalance/toppedUpBalance/grantedBalance/isAvailable`（`:431-435`，`:429` 以 `isAvailable` 决定语气），并各有「数据时间」「来自宿主缓存」文案（`:114` `"card.fetchedAt": "数据时间"`、`:117` `"card.cached": "来自宿主缓存"`、`:414` 说明用宿主的 `fetchedAt/cached`） |
| A2 | 折线/柱状两个图表由宿主 usage 数据渲染，7/30 天切换生效，空数据有降级渲染 | **pass** | `chart.mjs` 输出 `points/linePath/areaPath/bars/yTicks/xTicks`（`:7`、`:248`、`:254`）；空序列与"全零"是**两种不同**的降级（`:19`、`:198-200`：空 → `isEmpty`、无柱；全零 → 轴上限 0、零高柱）；7/30 切换在 modal 断言集中的 `window switch 7/30 days` 项命中（探针 §5）并由 ui-modal 51 条覆盖 |
| A3 | 平台入口用新窗口打开，代码中无 iframe 嵌入 | **pass** | `modal.mjs:840-841` `target: "_blank"` + `rel: "noopener noreferrer"`；`:887` `host.open(url, "_blank", "noopener,noreferrer")`；探针在**可执行代码**里搜 `<iframe` / `createElement("iframe")` / `frame-ancestors` 全部 0 命中，而 `platform.deepseek.com/usage` 存在 |
| A4 | ESC 与遮罩点击可关闭，打开时 `#root` 置 inert；无新增运行时依赖 | **pass** | `inert`、`Escape`、遮罩点击三者在 `modal.mjs` 与 `ui-modal.test.mjs` 两处都命中（探针 §5）；依赖面见 §6 |

## 6. 零新增依赖 + 依赖面是真的可用（不是"看起来没依赖"）

- 源码 `src/client/*.mjs` 的 import 只有：兄弟模块 `./format.mjs`、`./service.mjs`、`./row.mjs`、`./chart.mjs`，以及 `react`。**无 d3 / mermaid / chart.js / victory / recharts / d3-* 等任何图表库**（可执行代码 0 命中；bundle 里 4 处 `d3|mermaid` 字样全在注释里，语义是"本模块不依赖它们"）。
- `package.json` 的依赖面只有 `react`（peer）；本次浏览器半交付**没有引入任何新依赖**。
- 组装后的 bundle 只 `require` 两个符号：`react` 与 `@deepseek-ai/dsh-client-ui-primitives`。我**从外壳 bundle 里抠出真实的种子表**验证这两个符号确实被预置：

  ```
  function by(){return{react:…, "react/jsx-runtime":…, "react-dom":…, "react-dom/client":…,
    "@deepseek-ai/cordis":…, "@deepseek-ai/dsh-client-store":…, "@deepseek-ai/dsh-client-ui-slots":…,
    "@deepseek-ai/dsh-client-ui-primitives":…, "@deepseek-ai/dsh-client-ui-dockkit":…}}
        —— dsh-web-frontend/dist/assets/index-BKQ_L1z6.js @553121，由 staticModules 传入模块系统
  ```

  runtime 里另有 **37 个官方客户端 bundle** 用完全相同的写法 `require("@deepseek-ai/dsh-client-ui-primitives")`——即这个 require 面是外壳背书的生产模式，不是本插件自创。

## 7. 边界（独立实测）

| 检查 | 结果 |
|---|---|
| `runtime\` 零写入 | ✅ 递归 28,735 条目，**mtime ≥ 2026-09-17 的 0 条**，最新 = `2026-09-16 14:43:54` |
| `profiles\` | ⚠️ 已不再是零写入：**20:40:32-41** 有一次装载动作（`profiles\web-desktop\node_modules\dsh-deepseek-usage` 出现为 **Junction** → 插件目录；`package.json` 的 `dependencies` 增 `dsh-deepseek-usage=link:…`、`dsh.profile.bundles` 末尾增 `dsh-deepseek-usage`；`pnpm-lock.yaml`/`.pnpm-workspace-state-v1.json`/`.bin` 由 pnpm 重写；`cordis.yml` 被幂等重写）。这是**装载步骤**（T7/队长侧），非浏览器半所为；关键点：经该 Junction 读到的 `lib/client.js` hash = **AFCC782A**，与我复核的 revision **完全相同**（即 profile 会服务的正是我验过的这一版） |
| 宿主未重启 | ✅ `dsh.exe` PID 9476（16:05:51）、:3080 的 `node.exe` PID 25720（16:40:34）均未变；因此浏览器半在用户当前会话里**尚未激活**（profile bundle 是启动期合成的） |
| 包内状态 | ✅ 包内无 `.ledger-cache`；`files = lib,src,cordis.patch.yml,README.md,docs`（不含 `node_modules`）；依赖面只有 `react` |

## 8. Findings

- **U1（low）· README 的合成规则仍缺"兄弟 import 被丢弃"这一句**：`README.md:110-122` 写的是 「`import ... from 'x'` → `const ... = require('x')`」，但实际（且必须）的规则是：**兄弟模块 import 直接删除、由同一闭包内的内联声明承接；只有外壳种子模块（react / `@deepseek-ai/dsh-client-ui-primitives`）才走 `require`**。t5 已在报告里请队长补这句。影响：不改变当前交付物的正确性（我验过 bundle 里 0 个相对 require），但**下一个按 README 字面重组 `lib/client.js` 的人会写出 `require("./service.mjs")`**，而 `/plugins` 路由不服务该 URL、模块表里也没有它 → 浏览器侧运行时 `require` 抛错。requiredFix：在 README 的装配小节补 2–3 句（兄弟 import 丢弃 + 种子模块清单 + 「重组后必须重跑 ui-row/ui-modal 的漂移守卫」）。
- **U2（info）· `lib/client.js` 是可再生产物**：复核窗口内被重组合 4 次；我冻结在 `AFCC782A` 并确认 45 秒内稳定。若 T7 之前再次重组，形态与装配两条结论需重跑——探针在 `%TEMP%\t9-probe\t10-ui-probe.mjs`，一条命令即可（它会打印它实际读到的 sha256）。
- **U3（info）· `dsh-client-ui-slots` 的真相**：它虽不是包行（t8-F4），但确实是外壳的**种子服务符号**（见 §6 的种子表）。所以 inject 里的旧写法并非"凭空捏造"，只是它作为 **package 行**不存在——t11 的文档表述（inject 为信息性提示、槽以运行时实测为准）与事实一致，无需改。
- **U4（info）· 装载已发生但宿主未重启**：20:40 的装载把本插件写进了用户活动 profile 的 bundles/dependencies（见 §7）。浏览器半要生效仍需宿主重启（启动期合成 profile bundle），**仅刷新页面不会加载**。这是 T7/队长的处置对象，不是浏览器半的缺陷；如实记录以免后续把"页面刷新后没出现"误判为 UI 缺陷。

## 9. 裁决摘要

- **pass**：经典脚本形态（真求值验证）、装配确已发生（6 个源模块逐字内联、factory 返回完整客户端面、无 loader 仍大声失败）、`sidebar.footer.action` 槽位与 `stopPropagation` 在**代码与测试两处**成立、四态与折叠态分支齐备、弹层（inert / ESC / 遮罩 / 数据时间与缓存态 / 7-30 切换 / 空数据降级）、零断新依赖（且 require 面经外壳种子表验证真实可用）、两条红线（无 iframe 必新窗口；无 key 材料、无 `api.deepseek.com`）全部通过；t5 的 4 条与 t6 的 4 条验收标准逐条有独立证据；两条 verify 在我机器上 exit 0（44/44、51/51）。
- 唯一建议动作是 **U1（README 补 3 句合成规则）**；U2–U4 为流程提醒。渲染细节/文案无阻塞项。
