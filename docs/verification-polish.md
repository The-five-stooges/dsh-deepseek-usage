# T18 独立验收 — 四项用户需求 + 启动冒烟有效性 + 配色 token 全量比对

- 验收者：`verifier`（独立成员，非本轮任何实现者）
- 验收时间：2026-09-17 21:54 – 22:0x（本机时钟）
- 工具链：portable Node **v24.13.1**（`C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe`）
- 对象：`%DSH_HOME%\plugins\dsh-deepseek-usage`
- **裁决：verdict = pass**（六条验收项全部通过；无 needs_revision）
- 副作用：本轮**唯一**的代码写入是验收本身要求的负向注入（`src/host/plugin.mjs` 的 `serviceOf` 临时改回旧写法），**已按字节还原**并复验 hash 与用户修复基线一致（见 §1）；其余只读。`runtime\` 零写入，宿主未重启。

---

## 1. 启动冒烟是否真的会红（本轮最重的一条）

**结论：会红。** 我**自己**做了两次运行（不采信任何成员自述），并附原始输出。

### 1.1 负向注入（把事故写法放回去）

先按字节备份 `src/host/plugin.mjs`（副本 sha256 = `7723B45E01C1FC9057D0B4237AD4E6DCEA01ACDB53F7D2885C269BC287786ED6`），
再把 `serviceOf` 的最后一行改回事故写法：

```js
        // 注入后的 serviceOf（第 91 行）
        return ctx.get(key) ?? ctx[key];
        // 注入后文件 sha256 = 8BDFCD13CD864883DE3C59E6A15B9F883A8A8C4DC1A76DA30DAAE1E10F97A9E7
```

```powershell
cd C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home\plugins\dsh-deepseek-usage
& $node --test tests/host-activate.test.mjs     # → exit 1
```

```
✖ activate: the host half activates inside a real Context with no services provided (5.0161ms)
✖ activate: with webServer arriving later, the ctx.inject fallback registers the same routes (1.092ms)
ℹ tests 6   ℹ pass 4   ℹ fail 2
✖ failing tests:
  Error: cannot get property "webServer" without inject
      at serviceOf (…/src/host/plugin.mjs:91:29)
      at withWebServer (…/src/host/plugin.mjs:118:7)
      at Object.apply [as callback] (…/src/host/plugin.mjs:184:7)
      at Fiber.execute (…/runtime/node_modules/@deepseek-ai/cordis/lib/index.js:1070:28)
      at …/tests/host-activate.test.mjs:117:21
NEGATIVE EXIT=1
```

**与用户实机启动崩溃同栈**（`serviceOf` ← `withWebServer` ← `apply` ← `Fiber.execute`），失败信息就是那句
`cannot get property "webServer" without inject`。⇒ 这条门禁**不是摆设**，事故写法放回去当场红。

### 1.2 还原后（转绿）

```powershell
Copy-Item "$env:TEMP\t18-verify\plugin.mjs.orig" "…\src\host\plugin.mjs"   # 字节还原
RESTORED sha256 = 7723B45E01C1FC9057D0B4237AD4E6DCEA01ACDB53F7D2885C269BC287786ED6
matches 用户修复基线 ? True      byte-identical to backup ? True
& $node --test tests/host-activate.test.mjs     # → exit 0
```

```
✔ the shipped plugin face still matches what the loader mounts
✔ the host half activates inside a real Context with no services provided
✔ the regression tripwire is itself real (a bare read throws, ctx.get does not)
✔ built-in context members are not inject-gated service reads
✔ with webServer already provided, the four routes register on the plugin fiber
✔ with webServer arriving later, the ctx.inject fallback registers the same routes
ℹ tests 6   ℹ pass 6   ℹ fail 0        POSITIVE EXIT=0
```

> 边界声明：这次注入改的是 `src/host/plugin.mjs`（契约把 `src/` 列为 out of scope），但契约同时**明确指示**我
> 「自己把 `serviceOf` 临时改回裸 `ctx[key]` 形式…恢复后再跑确认转绿」。注入与还原都按字节进行，
> 还原后 hash 与用户的修复字节**完全一致**，包内无残留（§5 指纹表可复核）。

---

## 2. 配色 token 全量比对（对着真实清单）

**方法**：从外壳 CSS（`runtime\node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\*.css`）提取全部
`--dsw-*` 名（我去重得 **71** 个，与队长实测一致），把 `row.mjs`/`modal.mjs`/`chart.mjs` **剥掉注释后**引用的
token 与之比对。判定脚本：`D:\Temp\Administrator\t18-verify\probe.mjs`（零依赖）。

```
shell CSS token vocabulary size = 71
  row.mjs:   11 token reference(s) after comment stripping (12 including comments)
  modal.mjs: 47 token reference(s) after comment stripping (56 including comments)
  chart.mjs: 10 token reference(s) after comment stripping (16 including comments)
distinct tokens referenced by the plugin = 21
REFERENCED-BUT-ABSENT-FROM-SHELL = 0 []          ← 硬指标，**零个不存在**
  [info] row.mjs mentions only in comments (not a defect): ["--dsw-alias-label-dimmed"]
```

- **「引用但不存在」= 0**（剥注释后）。队长预告的 `--dsw-alias-label-dimmed` 确实只剩注释散文里那 1 处
  （`row.mjs:99`，解释「该 token 对比度仅 1.26:1，故不用颜色表达」）：**删掉注释后 0 次**，`var()` 用量 0、CSS 声明 0。
  我按「先剥注释再判定」的口径复核，未把它当缺陷。

### 2.1 弹层背景是不是实体不透明（不是回退成未定义）

modal.mjs 的两条背景声明（剥注释后取出）：

```
.dsh-deepseek-usage-overlay{position:fixed;inset:0;z-index:9999;…;background:var(--dsw-alias-bg-mask-1);backdrop-filter:…}
.dsh-deepseek-usage-panel{…;border-radius:20px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);…}
```

从主题包（`@deepseek-ai/dsh-client-ui-theme/lib/client.js`）取到真实值链：

| token | 在外壳 71 项清单内 | 主题里的值 |
|---|---|---|
| `--dsw-alias-bg-mask-1` | ✅ | `#0000003d`（**刻意的半透明遮罩**，只有 overlay 用它） |
| `--dsw-alias-bg-layer-2` | ✅ | `var(--dsw-static-neutral-bluish-00)` ← **实色层**，面板本体 |
| `--dsw-alias-label-primary-foreground` | ✅ | `var(--dsw-static-neutral-bluish-00)` |
| `--dsw-alias-button-primary-fill` | ✅ | `var(--dsw-alias-brand-primary)` |

⇒ **文字所在的面板是 `bg-layer-2` 这一层实色层**（对应外壳自家 dialog 的层），不是未定义回退；
半透明的只有 overlay 的遮罩（这是正确用法：遮罩本来就要透出下层）。两个 token 都在外壳真实清单内，
所以不存在「`var()` 落到未定义 → 背景透明/消失」的路径。

### 2.2 WCAG 交叉核对（**如实标注来源**）

- 我**独立确认**了 token 链与真值来源：`label-primary-foreground→static-neutral-bluish-00`、
  `button-primary-fill→brand-primary`、`label-secondary→#61666b`、`label-tertiary→#81858c`
  （后两项与外壳 CSS 里 `--dsh-boot-label-secondary/-tertiary` 的浅色真值一致）。
- **但我没有独立复算对比度数值** —— 时间受限，采用队长提供的浅色真值：
  主按钮文字 **18.90**、正文 **18.90**、次要 **5.80**、三级 **3.71**。
  ⇒ 这四项均 ≥ 3:1（三级文字 3.71 已达 WCAG 2.1 对非正文文字/图形的最低要求；正文 18.90、次要 5.80 远超 4.5:1）。
  **若需以「独立复算」为准，请把这一条标为「未独立复算、采用队长实测」。**

---

## 3. 四项用户需求逐条判定

| # | 需求 | 判定 | 证据 |
|---|---|---|---|
| ① | **插件行独立成行** | **passed**（机制 + 代码证据；另见下方「未做肉眼截图」声明） | 外壳侧：`sidebar.footer.action` 的贡献是 `.footerActions` 的 flex 子项，而该容器是**横向行**（`row.mjs:60-78` 逐字引用了外壳规则：`.footerActions{flex:none;width:100%;min-width:0}` / `.footerActions{display:flex}` / `.footArea{flex-direction:column;flex:none;display:flex}` / `.collapsed .footerActions{justify-content:center;width:auto}`）。插件侧：本组件所有可能根节点都带 `flex:1 0 100%`（`row.mjs:84 .row{flex:1 0 100%}`、`:104 .block`、`:107 .rail`），容器再加一条 `[class*='footerActions']:has(>.dsh-deepseek-usage-rail){flex-wrap:wrap;width:100%}`（`row.mjs:115`）⇒ **100% flex-basis + 允许换行 = 该行独占一整行**，把设置块挤到下一行；折叠态（`wide===false`）走 `.rail`，同样 `flex:1 0 100%` 且容器 `justify-content:center`，因此 56px 轨道不破版。 |
| ② | **弹层配色可读** | **passed** | 见 §2：引用但不存在的 token **0 个**（这正是上一版不可读的根因——`var()` 落到未定义）；面板背景是 `bg-layer-2` 实色层；正文/次要/三级文字全部映射到真实 token（18.90 / 5.80 / 3.71）。 |
| ③ | **弹层美观度** | **passed（有限口径）** | 可机器核验的部分通过：面板 `width:min(720px,100%)`、`max-height:min(84vh,760px)`、`border-radius:20px`、`padding:18px 20px 16px`、`overflow:auto`、`box-sizing:border-box`；overlay 居中 + `padding:16px` + 遮罩 + `backdrop-filter`；样式串自足（无 `url()`/`@import`/外源），`z-index:9999` 在遮罩层之上。**「好看」本身不是可自动判定的属性，我未做肉眼截图**（原因见下）。 |
| ④ | **图表 hover + tooltip（按天按模型明细）** | **passed** | 直接从 `src/client/chart.mjs` import 纯函数独立验证（§4）：六种命中场景全部正确；tooltip 文案含**日期 + 每个模型的 inputTokens/cacheReadTokens/outputTokens + 估算费用 + 多模型合计 + 「本地估算，平台账单为权威」**。零图表库依赖（§5）。 |

> **未做肉眼/浏览器复核的如实声明**：我**没有**在真实 GUI 里目视确认这四项。原因有两条且都不在我可控范围：
> ① 契约禁止我重启宿主；② 当前在跑的宿主进程 **早于本轮最终源码**（见 §5 的时间线），
> 所以即使打开 `:3080` 看到的也不是最终版本。**①②③④ 的判定因此是「代码 + 纯函数 + token 清单」层面的，
> 不包含端到端目视**；目视确认仍属用户处置项。

---

## 4. tooltip 纯函数独立验证（六种场景 + 文案）

用 `buildChartGeometry(series, {width,height})` 造几何，`plotBoxOf` 得绘图区 `{left:56,top:12,right:306,bottom:114}`，
`hitTest` 逐场景：

| 场景 | 输入 | 实测输出 | 期望 |
|---|---|---|---|
| 范围内（5 列中的第 3 列） | `mid(2)` | `day 2` | ✅ 命中该列 |
| 最左列 | `mid(0)` | `day 0` | ✅ |
| 最右列 | `mid(4)` | `day 4` | ✅ |
| 绘图区左侧之外 | `left-5` | `null` | ✅ 隐藏 |
| 绘图区上方之外 | `top-5` | `null` | ✅ 隐藏 |
| 基线下方 | `bottom+5` | `null` | ✅ 隐藏 |
| 空数据 | `buildChartGeometry([])` | `null` | ✅ 恒隐藏 |
| 单点 | 1 点、取中心 | `day 0` | ✅ 整幅映射到 day 0 |
| 全零系列 | 5 个 0、取第 3 列 | `day 2` | ✅ **仍可命中**（显示「当日无用量」） |

tooltip 文案（`tooltipModel` + `tooltipLines`，双模型日）：

```
| 2026-09-11
| deepseek-flash: 500 输入 · 0 缓存读 · 700 输出 · $0.001
| deepseek-v4-pro: 10 输入 · 20 缓存读 · 30 输出 · $0.020
| 合计 · 510 输入 · 20 缓存读 · 730 输出 · $0.021
| 本地估算，平台账单为权威
```

- ✅ 含**日期**；✅ 每个模型分别给出 **inputTokens / cacheReadTokens / outputTokens** 三个字段（千分位精确数）；
- ✅ 含**估算费用** `$0.001 / $0.020` 与多模型**合计行**；✅ 含「本地估算，平台账单为权威」注记。
- 无用量日（`day="2026-09-12"`）→ `hasUsage=false`、文案 `当日无用量记录` + 日期 + 注记（不显示空行）。
- 可断言性：以上全部由 `chart.mjs` 的**导出纯函数**直接产生，`import` 不需要 DOM（23 个函数导出）。

---

## 5. 生成物一致性与边界纪律

### 5.1 指纹（本轮实测，全部独立计算）

| 对象 | sha256 | 备注 |
|---|---|---|
| `lib/client.js` | `19EE788C0CAC47A7B4F8209C666C8199F3265F00A7CE875778008C91FE4A0FB9` | 177,657 B（与队长/t17 一致） |
| 经 profile Junction 读到的 `…\profiles\web-desktop\node_modules\dsh-deepseek-usage\lib\client.js` | **同一 hash**，同为 177,657 B | ⇒ 服务到的就是插件目录内同一份，不是旧版本 |
| `src/host/plugin.mjs` | `7723B45E01C1FC9057D0B4237AD4E6DCEA01ACDB53F7D2885C269BC287786ED6` | 还原后 = 用户修复字节（§1） |
| `src/client/chart.mjs` | `F010308C0765D23D0C44EE03AA9998347824DAB6DF23DDC7433371BA694464C2` | 与 t16 报告里的 `bff00a7c…` 不同属**预期**（t15 授权改过一行，t17 已确认导出面与逐字节包含均在）；我以**当前**文件为准 |

### 5.2 两条 verify（契约指定）

```
$ node scripts/compose-client.mjs --check     → "lib/client.js is in sync with src/client/*.mjs"   exit=0
$ node --test                                 → 211 tests / 210 pass / 0 fail / 1 skipped        exit=0
```

（1 个 skip = 契约自带的 opt-in 活体检查，需 `DSH_DEEPSEEK_USAGE_BASE_URL`。）

### 5.3 零图表库依赖（含一条我自己的误报更正）

- 二进制/源码里 **`require("./…")` 的兄弟模块引用 = 0**（六个源模块全部内联进同一闭包）。
- 无 d3 / echarts / chart.js / recharts / apexcharts / plotly / highcharts / victory 等依赖。
- **更正**：我的首轮正则（`/echarts/gi`）在 `src/client/*.mjs` 与 bundle 里各报出 1 处 `eCharts` ——
  逐行定位后确认那是 `liveCharts` 里的子串（`liv**eCharts**`），**不是任何图表库**。属我探针的正则假阳性，如实记录。

### 5.4 边界纪律

| 检查 | 实测 |
|---|---|
| `runtime\` 零写入 | 25,440 个文件，最新 mtime = **2026-09-16 08:28:20**，晚于 2026-09-17 00:00 的文件数 = **0** |
| 宿主是否被重启 | **未重启**：`127.0.0.1:3080` 仍由 **PID 32764** 监听，`CreationDate = 2026/9/17 21:24:30` —— 与任务给定的本轮起点（PID 32764 @ 21:24:30）**完全一致** |
| 是否起了第二个实例 | **没有**：3098 / 3099 / 3100 上无任何监听 |
| 本轮写入的文件 | 只有契约 in-scope 的 `docs/verification-polish.md`；另有 §1 说明的临时注入（已字节还原） |

### 5.5 一条必须告知队长的观察（不是本轮缺陷，但影响目视验收的有效性）

宿主进程出生于 **21:24:30**，而本轮最终源码的写入时间是：`row.mjs 21:41:03`、`plugin.mjs 21:42:48`、
`chart.mjs 21:49:39`、`modal.mjs 21:52:07`、`lib/client.js 21:52:24`。
⇒ **当前在跑的那个宿主加载的是 21:24 之前的版本**（宿主半 bundle 层在启动期合成），
所以「打开 :3080 目视四项需求」在**不重启**的前提下看到的**不是**本轮的最终修复。
目视验收必须在**用户指定时机的下一次重启之后**进行；这不是需要修复的缺陷，而是时序事实。

---

## 6. 结论与残留

- **verdict = pass**：六条验收项全部通过（启动冒烟真的会红且还原后转绿；配色引用零个不存在；
  tooltip 六场景 + 文案可断言；生成物与 profile 同一份；边界纪律干净）。
- **残留（都不阻塞）**：
  1. ② ③ 的**目视/near-1:1 视觉判断**未做，且受 §5.5 时序限制，只能在下次重启后由用户确认；
  2. WCAG 数值本身未由我独立复算（采用队长实测，§2.2），token 链与真值来源我已独立核对；
  3. 若希望「重组漂移」在套件里被自动抓住，可后续在 `tests/ui-*.test.mjs` 里 `spawnSync` 跑
     `scripts/compose-client.mjs --check` 并断言 `status === 0`（`tests/` 不在本轮 inScope，未做）。

探针脚本：`D:\Temp\Administrator\t18-verify\probe.mjs`（零依赖，只读）。
