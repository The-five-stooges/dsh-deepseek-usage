# verification-polish-2 — the four on-screen defects, measured

Round 3. The previous round ended green (211 tests) while **four defects were plainly
visible on screen**. That is the headline finding of this document: every gate the
previous round relied on — source regexes, pure-function tests, a token-existence
check — is blind to selector matching, coordinate mapping and colour readability. So
this round's evidence is **measurements taken from the running GUI in a real browser**
(headless Edge 153 driven over the Chrome DevTools Protocol, real `Input.dispatchMouseEvent`
events, `getComputedStyle` + `getBoundingClientRect` on the live elements).

Reproduce with:

```
powershell -File tools/cdp/run-probe.ps1 -ExprFile tools/cdp/probe-verify.expr.js
powershell -File tools/cdp/run-probe.ps1 -ExprFile tools/cdp/probe-final2.expr.js
node tools/visual/row-wrap-probe.mjs --css-file <ROW_CSS dumped to a file>
```

(`tools/cdp/` lives in the session workspace, not in this package; the layout probe in
`tools/visual/` DOES ship here and runs inside `node --test`.)

---

## Defect 1 — "还是没有单独一行"

**Root cause (measured, not inferred).** The container rule was scoped to a *direct
child*: `[class*='footerActions']:has(>.dsh-deepseek-usage-row){flex-wrap:wrap;width:100%}`.
The slot renderer wraps a contribution in an extra element whose computed style is
`display:contents`, so the row is still a flex *item* of `.footerActions` but **not its
child**. `:has(> …)` therefore never matched, `flex-wrap` stayed `nowrap`, and the
`flex:1 0 100%` basis already on the row could not move it to a line of its own.

Live DOM **before** the fix:

```
container  hHd-Xa_footerActions  display=flex  flexWrap=nowrap  width=256
row        w=256  top=810        parentCls=""      (a display:contents wrapper)
wrapper    display=contents      parentCls=hHd-Xa_footerActions
container  directChildren: [""]  hasDirectRow=false     ← the `>` could never match
```

Live DOM **after** (same probe, same session shape):

```
container  hHd-Xa_footerActions  display=flex  flexWrap=wrap  width=256
row        w=256  left=12  top=812  h=40
sibling    fThDlq_entryRow  top=734  w=78
rowOnOwnLine = True             ← the row sits below every other plugin's entry
```

A controlled A/B in the browser isolates the cause (`tools/cdp/probe-wrap.expr.js`,
identical markup, only the selector differs):

| container rule | `flex-wrap` | row `top` | chip `top` | own line |
| --- | --- | --- | --- | --- |
| `:has(> .row)` (old) | `nowrap` | 13 | 13 | **false** |
| `:has(.row)` (new) | `wrap` | 82 | 58 | **true** |

Fix: drop the `>` (row.mjs:126-128). This is also now a **test**, not just a note: the
browser layout probe in `tools/visual/row-wrap-probe.mjs` applies the shipped `ROW_CSS`
to the measured DOM shape, and `ui-row.test.mjs` asserts three things with it — the row
fills its line, **the collapsed rail root does too**, and the **reconstructed old
direct-child rule still fails** (`nowrap`, both elements sharing a top edge). That last
one is the guard that stops the `>` from creeping back in a refactor.

### The collapsed sidebar (56px rail) — verified separately

The expanded and collapsed sidebars mount *different* roots (`-row` vs `-rail`), so the
container rule has to reach both. Measured by clicking the shell's own collapse toggle
(`aria-label="收起侧边栏"`) in a real browser:

| | expanded | collapsed |
| --- | --- | --- |
| sidebar width | 280px | **56px** |
| `.footerActions` | `flex-wrap:wrap`, 256px, `justify-content:normal` | **`flex-wrap:wrap`**, 35px, `justify-content:center` |
| plugin root | `.dsh-deepseek-usage-row` 256×40, `flex-basis:100%` | **`.dsh-deepseek-usage-rail` 36×36**, `flex-basis:100%` |
| rail geometry | — | button 36×36, `border-radius:50%`, centred in the rail |
| other entries on our line | — | **none** (`lineMates: []`) |
| balance reachable | row text `DeepSeek 余额 ¥85.66` | rail button `aria-label`/`title` = `DeepSeek 余额 ¥85.66 · 37 秒前更新 · 缓存` |

So the number is never lost in the collapsed state, which is what the rail's Tooltip
design was for — and the rail does not share a line with any other plugin's entry.

## Defect 2 — "余额应该直接展示"

The amount **was** already rendered in the row (`<span class="dsh-deepseek-usage-amount"
data-dsh-usage-amount="deepseek-usage">`). What the user saw was "余额加载中 …" because a
cold page load has no balance yet, plus a cramped row. Measured now (ready state):

```
row.text   "DeepSeek 余额 ¥85.83"
amount     text="¥85.83"  visible=true  width=39  clipped=false  color=rgb(15,17,21)  (18.9:1)
aria-label "DeepSeek 余额 ¥85.83 · 刚刚更新 · 缓存"
title      ""      ← was duplicating the aria-label text verbatim
```

Fix: the row no longer repeats its accessible name in `title` (a native tooltip that
showed the same string twice, e.g. `…缓存 22 秒前更新 · 缓存`). The balance is plain
text in the row, no hover required.

## Defect 3 — "tooltip 位置不对" + "鼠标移动有偏移"

Two separate causes, both measured.

**(a) Wrong containing block.** The bubble was appended to `svg.parentNode` and given
`left/top` in **SVG user units**, while its containing block was the `position:fixed`
overlay. Measured on the live page before the fix:

```
pointer        (865, 603)
tooltip        left=429.45px top=182px  transform=translate(-89,-108)
rendered at    (340, 74)          ← top-left corner, ~625px from the pointer
offsetParent   DIV.dsh-deepseek-usage-overlay  position:fixed
svg            rect x=448 y=499 w=672 h=231   viewBox="0 0 640 220"  → scale 1.05
```

**(b) User units are not CSS pixels.** `viewBox="0 0 640 220"` is rendered into a
672×231 box, so the live chart scales by **1.05** — and the fallback pointer path
(`event.offsetX/offsetY`) is relative to the **event target** (an inner `<rect>`), not
the SVG.

Fix (`chart.mjs`): translate through `svg.getScreenCTM()` in both directions
(`userPointOf` / `clientPointOf`), attach the bubble to `document.body` and position it
`position:fixed` at the marker's client coordinates, clamped into the viewport. The old
host-anchored placement remains as the fallback for a double without a CTM.

Measured after the fix, on **both** charts, at three x positions each:

| chart | pointer | bubble `left` | Δx from pointer | vertical gap to nearest edge | overlaps pointer |
| --- | --- | --- | --- | --- | --- |
| tokens | 616 | 521 | **6 px** | 32 px | yes |
| tokens | 784 | 686 | **9 px** | 32 px | yes |
| tokens | 986 | 913 | **16 px** | 32 px | yes |
| cost | 650 | — | **1 px** | — | yes |
| cost | 918 | — | **2 px** | — | yes |

with `parent=BODY`, `position=fixed`, `data-dsh-usage-tooltip-fixed=1`, `side=top`, and
the date changing as the pointer moves (`2026-08-24` → `2026-09-01` → `2026-09-12`).

**Not a defect, for the record:** the cost chart reported "no tooltip" until the popover
was scrolled. It is clipped by the panel's own scroll box (`overflow:auto`,
`clientHeight=734`, chart top at 778), and `document.elementFromPoint` at its centre
returned the overlay. After `scrollIntoView` it responds exactly like the tokens chart.
The probe, not the plugin, was at fault.

## Defect 4 — "tooltip 背景和文字颜色黑灰不好区分"

Measured cause: `background:var(--dsw-alias-tooltip-bg)` resolves to **#2c2c2e** in the
light theme (an inverted tooltip meant to carry light text), paired with
`color:var(--dsw-alias-label-primary)` = **#0f1115**.

```
light theme, before:   #0f1115 on #2c2c2e  =  1.36:1     (unreadable)
```

Fix: paint the bubble on `--dsw-alias-bg-layer-3`, border `--dsw-alias-border-l3`,
shadow `--dsw-elevation-stroke-color`; move the note *and* the one-line keyboard hint to
`--dsw-alias-label-secondary`.

Measured on the live bubble (WCAG 2.1 relative luminance, computed in-page):

| theme | bubble bg | border | title / rows | note / hint | min |
| --- | --- | --- | --- | --- | --- |
| light | `rgb(255,255,255)` | `rgba(0,0,0,0.12)` | `rgb(15,17,21)` → **18.90:1** | `rgb(97,102,107)` → **5.80:1** | 5.80 |
| dark (CDP `prefers-color-scheme: dark`) | `rgb(53,54,56)` | `rgba(255,255,255,0.16)` | `rgb(249,250,251)` → **11.57:1** | `rgb(207,211,214)` → **8.03:1** | 8.03 |

Both themes clear 4.5:1 for every line of text in the bubble. The row amount keeps
`rgb(15,17,21)` light / `rgb(249,250,251)` dark (18.90:1 / 13.34:1).

---

## Suite state

```
node --test    →  218 tests, 217 pass, 0 fail, 1 skipped   (verified over two consecutive runs)
node scripts/compose-client.mjs --check  →  in sync
```

The one skip is pre-existing (`contract.test.mjs`, needs `DSH_DEEPSEEK_USAGE_BASE_URL`).
New tests added by this round: **three** real-browser layout measurements (`ui-row`:
expanded row, collapsed rail, and the old-rule A/B), plus the viewport-placement, flip,
fallback and composed-bundle markers (`ui-modal`).

Notes for whoever runs this next:

- The browser tests start Edge three times per run. A failure to *launch* is retried once
  on a different port; if the layout is simply wrong the test fails loudly (never skips).
- A transient `TypeError … getBoundingClientRect of null` was observed once when the
  suite ran fully parallel and a sibling test's Edge was still shutting down. It has not
  reproduced since (two clean full runs), and `--test-concurrency=1 tests/ui-row.test.mjs`
  is green 51/51 if it ever does.
- No Edge processes are left behind after a run.

## What this round does NOT claim

- The rail was verified by **clicking the live toggle and measuring**; no screenshot was
  inspected, so "looks right" is a geometry claim, not a visual judgement.
- Only the **tooltip** and the row were colour-audited; the rest of the popover's palette
  is covered by the existing token-pairing test, not by a fresh live measurement.
- The A/B selector probe uses a fixture DOM that reproduces the measured structure
  (`footerActions > display:contents wrapper > [chip, row]`), not the shell's own markup
  (which cannot be injected into a test page).
- The middle of the popover (balance cards, model table) was not re-verified this round.
- Nothing here changes the host half: `src/host/plugin.mjs` is still
  `7723B45E01C1FC90` (the user's own `serviceOf` fix) and `package.json` is still
  `66771A687F829F86`.
