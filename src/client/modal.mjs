/**
 * dsh-deepseek-usage — the balance/usage popover (browser half, T6).
 *
 * Opens a self-drawn, fixed-position overlay appended to `document.body` (never
 * into the settings shell), with three blocks:
 *
 *   1. the account balance card — real numbers from `/api/dsh-deepseek-usage/balance`
 *      plus the snapshot's data time and whether it came from the host cache;
 *   2. the LOCAL usage charts — a hand-written SVG line chart (daily tokens) and
 *      bar chart (daily estimated cost) fed by `/api/dsh-deepseek-usage/usage?days=N`,
 *      with a 7/30-day switch and a per-model table;
 *   3. the platform entry — a new-window link to the platform usage page. The page
 *      answers `Content-Security-Policy: frame-ancestors 'none'`, so framing it is a
 *      guaranteed blank frame; this module therefore contains no iframe at all (the
 *      tests assert that), and the URL stays bare because the deep-link parameters
 *      are not proven to be parsed.
 *
 * Behaviour contract: ESC and a backdrop click close it, `#root` is set `inert`
 * while it is open (restored on close), focus is trapped inside the dialog and
 * returned to the element that opened it, and nothing here adds a runtime
 * dependency (no d3, no mermaid, no React, no second transport).
 *
 * TRANSPORT: there is exactly ONE path to the host routes and it is
 * `service.mjs` — `service.read({force})` for the card and `service.readUsage({days})`
 * for the charts, both already normalized to the four states and never rejecting.
 * This module owns no `fetch` call, so the "relative path + same-origin + no
 * credential header" invariants stay provable in one place.
 *
 * WIRING: `createUsageModalOpener(runtime)` is published from the composition layer
 * via `setModalFactory((runtime) => createUsageModalOpener(runtime))`. A FACTORY is
 * required (not a direct `setModalOpener` call): the bundle is a classic script, so
 * at evaluation time `factory(require)` has not run yet and React / the service do
 * not exist. The factory runs inside `apply(ctx)`, receives
 * `{ React, primitives, icons, Tooltip, service, text, slot }`, and returns the
 * `(view) => handle` opener the row's `resolveModal` seat calls with
 * `{ snapshot, wide, service }`.
 *
 * COMPOSITION NOTE: inlined verbatim into `lib/client.js`; keep `export ` at line
 * starts and sibling imports on ONE line in the exact `import ... from "./x.mjs";`
 * form (the composer drops those lines because every `src/client/*` module lands in
 * one closure). `tests/ui-modal.test.mjs` proves the inlined copy has not drifted
 * and drives the composed classic script end to end.
 *
 * @module dsh-deepseek-usage/client/modal
 */

import { EMPTY_VALUE, formatClock, formatMoney, formatRelativeTime, makeTextLookup, normalizeCurrency } from "./format.mjs";
import { messageForCode } from "./service.mjs";
import { CHART_INTERACTION_CSS, CHART_METRICS, SVG_NAMESPACE, UNKNOWN_MODEL, attachChartInteraction, buildChartGeometry, formatMetricValue, projectSeries, summarizeUsage } from "./chart.mjs";

/** Plugin-scoped id shared by the overlay, its styles and its data attributes. */
export const MODAL_ID = "deepseek-usage";

/** `data-plugin-css` id of the injected popover stylesheet (dedupe key). */
export const MODAL_STYLE_ID = "dsh-deepseek-usage-modal";

/**
 * Where the platform's usage page lives. Bare on purpose: an unsupported deep-link
 * parameter must not be invented (the SPA's parsing is unverified), and the page
 * itself redirects into its login flow when signed out.
 */
export const PLATFORM_USAGE_URL = "https://platform.deepseek.com/usage";

/** The usage windows the popover offers, in days (T6 acceptance: 7/30). */
export const USAGE_WINDOWS = Object.freeze([7, 30]);

/** Window selected when the popover opens (matches the host's own default). */
export const DEFAULT_USAGE_DAYS = 30;

/** Smallest/largest window the host route accepts (`routes.mjs` USAGE_DAYS_MIN/MAX). */
export const USAGE_DAYS_MIN = 1;
export const USAGE_DAYS_MAX = 365;

/** The shell mount point that gets `inert` while the dialog is open. */
export const MODAL_ROOT_ID = "root";

/** The four states the popover renders (the service's states, reused verbatim). */
export const MODAL_STATES = Object.freeze({
  loading: "loading",
  ready: "ready",
  unconfigured: "unconfigured",
  error: "error",
});

/**
 * Every `data-*` hook the popover paints, so handlers and tests share one source.
 *
 * NOTE on `chart`: it is deliberately NOT `data-dsh-usage-chart`. The chart interaction
 * binder owns that name — it writes `"1"` into it when it takes an SVG root over
 * (`CHART_INTERACTION.rootAttr` in `chart.mjs`), so a renderer that reused the name
 * would have its own marker erased the moment the charts were wired (that is exactly
 * what the first wired build did: both charts were rendered, but neither could be found
 * afterwards). Two owners, two names.
 */
export const MODAL_ATTR = Object.freeze({
  overlay: "data-dsh-usage-modal",
  panel: "data-dsh-usage-modal-panel",
  close: "data-dsh-usage-close",
  days: "data-dsh-usage-days",
  refresh: "data-dsh-usage-modal-refresh",
  usageRetry: "data-dsh-usage-usage-retry",
  platform: "data-dsh-usage-platform",
  chart: "data-dsh-usage-chart-kind",
  models: "data-dsh-usage-models",
  balance: "data-dsh-usage-balance",
  usage: "data-dsh-usage-usage",
  focusKey: "data-dsh-usage-focus",
});

/** Built-in (Simplified-Chinese) copy. A locale seat passed by the shell wins. */
export const MODAL_DICTIONARY = Object.freeze({
  "modal.title": "DeepSeek 余额与用量",
  "modal.close": "关闭",
  "modal.close.hint": "按 ESC 或点击遮罩也可关闭",
  "card.title": "账户余额",
  "card.total": "总余额",
  "card.toppedUp": "充值余额",
  "card.granted": "赠送余额",
  "card.currency": "币种",
  "card.availability": "账户状态",
  "card.available": "可用",
  "card.unavailable": "不可用（余额不足或账户受限）",
  "card.fetchedAt": "数据时间",
  "card.source": "数据来源",
  "card.live": "刚刚从官方接口读取",
  "card.cached": "来自宿主缓存",
  "card.refresh": "刷新余额",
  "card.pending": "正在读取余额…",
  "card.retry": "重试",
  "card.loadFailed": "余额读取失败",
  "card.noService": "宿主服务未提供余额读取器",
  "card.hint": "余额来自宿主侧官方接口；API key 始终留在宿主，不进入浏览器。",
  "usage.title": "本地用量（DSH 会话日志聚合）",
  "usage.window": "近 {n} 天",
  "usage.pending": "正在聚合本地会话日志…",
  "usage.loadFailed": "本地用量读取失败",
  "usage.retry": "重试",
  "usage.noService": "宿主服务未提供 /usage 读取器",
  "usage.truncated": "聚合超过时限，数据可能不完整",
  "usage.generatedAt": "生成于",
  "usage.chart.tokens": "每日 Token 总量（折线）",
  "usage.chart.cost": "每日估算费用（柱状）",
  // The unit belongs in the copy: the estimate is denominated in CNY (the host's
  // price table is the Chinese pricing page and the account is billed in CNY), and
  // this note is the only place the axis's 元 figures are explained. It also states the
  // SCOPE, which is what makes the difference from the platform's bill explicable at all:
  // only this machine's DSH session logs are read, so anything billed to the same account
  // from elsewhere is invisible here (measured: a day whose logs started at 15:05 local
  // estimated ¥5.02 against a ¥13.60 platform bill).
  "usage.chart.cost.note": "估算值：本地聚合 token × 官方峰谷单价（人民币元，非平台账单，不含本机 DSH 会话日志之外的消耗）",
  "usage.chart.empty": "该窗口内没有会话记录",
  "usage.chart.zero": "该窗口内有 {n} 天记录，但没有可统计的 token",
  "usage.chart.single": "窗口内只有一天有记录（单点不连线）",
  "usage.totals": "窗口合计",
  "usage.table.model": "模型",
  "usage.table.input": "输入（未缓存）",
  "usage.table.cache": "缓存命中",
  "usage.table.output": "输出",
  "usage.table.total": "合计",
  "usage.table.cost": "估算费用（元）",
  "usage.table.empty": "窗口内没有按模型的数据",
  "usage.unknownModel": "未知模型",
  "usage.note": "本地估算（按 DSH 会话记录聚合 + 官方峰谷单价），平台账单为权威。统计范围仅限本机 DSH 会话日志：同一账号在其它电脑、网页版或其它工具产生的消耗不在此列，因此这里的数字可能低于平台账单。",
  "usage.scope": "统计范围：仅本机 DSH 会话日志（本机所有工作区）；同一账号在其它电脑、网页版或用其它工具直连 API 的消耗不含在内，所以本页数字可能小于平台账单。以官方账单为准。",
  "platform.open": "在 platform.deepseek.com 打开用量页",
  "platform.newWindow": "新窗口打开",
});

/**
 * Text lookup bound to this popover's dictionary.
 * @param t - optional locale seat (the shell's `text`, whose keys are the ROW's;
 *   unknown keys fall back to this dictionary).
 * @returns the `text(key)` lookup (never throws).
 */
export function modalText(t) {
  return makeTextLookup(t, MODAL_DICTIONARY);
}

/**
 * Popover stylesheet. Injected once from the browser half because this package has
 * no CSS build step. No `url(...)`, no `@import`, no external origin: the panel must
 * not fetch anything to look right.
 *
 * TOKEN POLICY: every colour here is a shell THEME TOKEN whose name the shell itself
 * uses, and no colour is a literal — so the popover follows the active theme. The
 * vocabulary is verified against the shell's compiled stylesheet and the contrast of
 * each pairing against the shell's theme in `tests/ui-modal.test.mjs` (that suite also
 * pins the mapping of the three names an earlier revision got wrong, and holds the
 * list of names that must never come back).
 *
 *   background  --dsw-alias-bg-layer-2   the layer the shell's own dialog paints
 *                                        (`_dialog_w1urq_22`, dsh-web-frontend CSS)
 *   stroke      --dsw-alias-border-l2    section/table dividers
 *               --dsw-alias-border-l3    outlined controls (the shell's `.outline`)
 *   accent      --dsw-alias-brand-primary  chart stroke/dot/area, focus ring
 *   buttons     --dsw-alias-button-primary-fill + --dsw-alias-label-primary-foreground
 *                                        (primary CTA, as in the shell's `.primary`),
 *                                        --dsw-alias-button-primary-hover,
 *                                        --dsw-alias-button-ghost-active-fill (ghost)
 *   text        ONLY --dsw-alias-label-primary / -secondary / -tertiary: the state and
 *                                        brand colours are non-text accents (dots,
 *                                        borders) because they measure below 4.5:1 on
 *                                        the light panel while the label tokens do not.
 *
 * Geometry (radius, spacing, heights) is deliberately literal: those are not theme
 * values, and the shell has no spacing tokens.
 */
export const MODAL_CSS = [
  ".dsh-deepseek-usage-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;",
  "justify-content:center;padding:16px;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1);",
  "backdrop-filter:var(--dsw-mask-blur)}",
  ".dsh-deepseek-usage-panel{display:flex;flex-direction:column;box-sizing:border-box;",
  "width:min(720px,100%);max-height:min(84vh,760px);overflow:auto;padding:18px 20px 16px;border:0;",
  "border-radius:20px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);",
  "box-shadow:var(--dsw-elevation-prominent);",
  "font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);",
  "font-size:13px;line-height:20px}",
  ".dsh-deepseek-usage-panel:focus{outline:none}",
  ".dsh-deepseek-usage-head{display:flex;align-items:flex-start;gap:10px;padding-bottom:12px;",
  "border-bottom:1px solid var(--dsw-alias-border-l2)}",
  ".dsh-deepseek-usage-title{margin:0;font-size:15px;line-height:22px;font-weight:600;flex:1 1 auto}",
  ".dsh-deepseek-usage-sub{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
  ".dsh-deepseek-usage-close{flex:none;display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;",
  "border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;",
  "line-height:1}",
  ".dsh-deepseek-usage-close:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".dsh-deepseek-usage-close:focus-visible,.dsh-deepseek-usage-tab:focus-visible,",
  ".dsh-deepseek-usage-retry:focus-visible,.dsh-deepseek-usage-platform:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);",
  "outline-offset:1px}",
  ".dsh-deepseek-usage-section{margin-top:16px}",
  ".dsh-deepseek-usage-section+.dsh-deepseek-usage-section{border-top:1px solid var(--dsw-alias-border-l2);",
  "padding-top:16px}",
  ".dsh-deepseek-usage-section-title{margin:0 0 10px;font-size:13px;line-height:20px;font-weight:600}",
  ".dsh-deepseek-usage-rows{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0}",
  ".dsh-deepseek-usage-rows dt{color:var(--dsw-alias-label-secondary)}",
  ".dsh-deepseek-usage-rows dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}",
  ".dsh-deepseek-usage-rows dd[data-emphasis='1']{font-size:16px;font-weight:600;line-height:22px}",
  ".dsh-deepseek-usage-rows dd[data-tone='warn']{color:var(--dsw-alias-label-primary)}",
  ".dsh-deepseek-usage-rows dd[data-tone='warn']:before{content:'';display:inline-block;width:6px;height:6px;",
  "margin-right:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);vertical-align:middle}",
  ".dsh-deepseek-usage-rows dd[data-tone='muted']{color:var(--dsw-alias-label-tertiary)}",
  ".dsh-deepseek-usage-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 10px}",
  ".dsh-deepseek-usage-tab{display:inline-flex;align-items:center;height:26px;padding:0 10px;",
  "border:.5px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);",
  "cursor:pointer;font-size:12px;line-height:18px}",
  ".dsh-deepseek-usage-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".dsh-deepseek-usage-tab[aria-pressed='true']{border-color:var(--dsw-alias-border-l3);",
  "background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary)}",
  ".dsh-deepseek-usage-badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;",
  "border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);font-size:11px;line-height:16px;",
  "color:var(--dsw-alias-label-secondary)}",
  ".dsh-deepseek-usage-badge[data-tone='warn']{color:var(--dsw-alias-label-primary)}",
  ".dsh-deepseek-usage-badge[data-tone='warn']:before{content:'';display:inline-block;width:6px;height:6px;",
  "border-radius:50%;background:var(--dsw-alias-state-warn-primary)}",
  ".dsh-deepseek-usage-spacer{flex:1 1 auto}",
  ".dsh-deepseek-usage-error{margin:0;padding-left:8px;border-left:2px solid var(--dsw-alias-state-error-primary);",
  "color:var(--dsw-alias-label-primary);word-break:break-word}",
  ".dsh-deepseek-usage-note{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}",
  // The scope statement is the one line that explains why this page can be lower than the
  // platform's bill, so it is set apart rather than buried in the notes.
  ".dsh-deepseek-usage-scope{margin:8px 0 0;padding:6px 8px;border-left:2px solid var(--dsw-alias-border-l3);",
  "color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}",
  ".dsh-deepseek-usage-pending{margin:0;color:var(--dsw-alias-label-tertiary)}",
  ".dsh-deepseek-usage-retry{display:inline-flex;align-items:center;height:28px;padding:0 10px;",
  "border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:transparent;",
  "color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;line-height:18px}",
  ".dsh-deepseek-usage-retry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
  ".dsh-deepseek-usage-retry:disabled{opacity:.4;cursor:not-allowed}",
  ".dsh-deepseek-usage-figure{margin:12px 0 0}",
  ".dsh-deepseek-usage-figcaption{margin:0 0 4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
  ".dsh-deepseek-usage-chart{display:block;width:100%;height:auto;overflow:visible}",
  ".dsh-deepseek-usage-grid{stroke:var(--dsw-alias-border-l2);stroke-width:1}",
  ".dsh-deepseek-usage-axis{fill:var(--dsw-alias-label-secondary);font-size:10px}",
  ".dsh-deepseek-usage-area{fill:var(--dsw-alias-brand-primary);opacity:.12;stroke:none}",
  ".dsh-deepseek-usage-line{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:2;",
  "stroke-linejoin:round;stroke-linecap:round}",
  ".dsh-deepseek-usage-dot{fill:var(--dsw-alias-brand-primary);stroke:none}",
  ".dsh-deepseek-usage-bar{fill:var(--dsw-alias-brand-primary);opacity:.85;stroke:none}",
  ".dsh-deepseek-usage-table{width:100%;margin-top:10px;border-collapse:collapse;font-size:12px;",
  "font-variant-numeric:tabular-nums}",
  ".dsh-deepseek-usage-table th,.dsh-deepseek-usage-table td{padding:4px 8px;text-align:right;white-space:nowrap;",
  "border-bottom:1px solid var(--dsw-alias-border-l2)}",
  ".dsh-deepseek-usage-table th:first-child,.dsh-deepseek-usage-table td:first-child{text-align:left}",
  ".dsh-deepseek-usage-table thead th{color:var(--dsw-alias-label-secondary);font-weight:500}",
  ".dsh-deepseek-usage-table tbody td{color:var(--dsw-alias-label-primary)}",
  ".dsh-deepseek-usage-table tfoot td{border-top:1px solid var(--dsw-alias-border-l3);border-bottom:0;font-weight:600}",
  ".dsh-deepseek-usage-foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:16px;padding-top:14px;",
  "border-top:1px solid var(--dsw-alias-border-l2)}",
  ".dsh-deepseek-usage-platform{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;border:0;",
  "border-radius:18px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);",
  "text-decoration:none;font-size:13px;cursor:pointer}",
  ".dsh-deepseek-usage-platform:hover{background:var(--dsw-alias-button-primary-hover)}",
].join("");

/**
 * The complete stylesheet the popover injects: its own rules first, then the chart
 * interaction's (hover hit layer, active marker, tooltip).
 *
 * `CHART_INTERACTION_CSS` is appended — never interleaved and never reordered — so the
 * chart-owned rules cannot silently shadow or be shadowed by the popover's, and so the
 * token gates in `tests/ui-modal.test.mjs` can check ONE string that is exactly what
 * the document receives. The interaction module stays DOM-free (it exports CSS as text)
 * and the popover remains the single injection point.
 */
export const MODAL_STYLE_TEXT = `${MODAL_CSS}${CHART_INTERACTION_CSS}`;

/* ------------------------------------------------------------------ *
 * DOM helpers (plain DOM on purpose: the popover must work without
 * React, and a portal would need react-dom in the bundle's table)
 * ------------------------------------------------------------------ */

/**
 * Create one element with attributes, listeners and children in a single call.
 * @param doc - the owning document.
 * @param tag - tag name.
 * @param init - `{ cls, text, attrs, on, children }`.
 * @returns the element.
 */
function el(doc, tag, init = {}) {
  const node = doc.createElement(tag);
  if (typeof init.cls === "string" && init.cls !== "") node.setAttribute("class", init.cls);
  const attrs = init.attrs !== null && init.attrs !== undefined && typeof init.attrs === "object" ? init.attrs : {};
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(name, value === true ? "" : String(value));
  }
  if (typeof init.text === "string") node.textContent = init.text;
  for (const child of Array.isArray(init.children) ? init.children : []) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child);
  }
  const handlers = init.on !== null && init.on !== undefined && typeof init.on === "object" ? init.on : {};
  for (const [type, handler] of Object.entries(handlers)) {
    if (typeof handler === "function") node.addEventListener(type, handler);
  }
  return node;
}

/**
 * Same as {@link el}, but in the SVG namespace.
 * @param doc - the owning document.
 * @param tag - SVG tag name.
 * @param init - see {@link el} (`on` handlers are not attached here).
 * @returns the SVG element.
 */
function svgEl(doc, tag, init = {}) {
  const node = doc.createElementNS(SVG_NAMESPACE, tag);
  if (typeof init.cls === "string" && init.cls !== "") node.setAttribute("class", init.cls);
  const attrs = init.attrs !== null && init.attrs !== undefined && typeof init.attrs === "object" ? init.attrs : {};
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(name, value === true ? "" : String(value));
  }
  if (typeof init.text === "string") node.textContent = init.text;
  for (const child of Array.isArray(init.children) ? init.children : []) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child);
  }
  return node;
}

/**
 * Inject the popover stylesheet once per document.
 * @param doc - the owning document (absent in node, where this is a no-op).
 * @returns true when a new `<style>` was appended.
 */
export function ensureModalStyles(doc) {
  if (doc === undefined || doc === null || typeof doc.createElement !== "function") return false;
  const selector = `style[data-plugin-css="${MODAL_STYLE_ID}"]`;
  if (typeof doc.querySelector === "function" && doc.querySelector(selector) !== null) return false;
  const style = doc.createElement("style");
  style.setAttribute("data-plugin-css", MODAL_STYLE_ID);
  style.textContent = MODAL_STYLE_TEXT;
  const host = doc.head ?? doc.body ?? doc.documentElement;
  if (host === undefined || host === null || typeof host.appendChild !== "function") return false;
  host.appendChild(style);
  return true;
}

/**
 * Collect the focusable elements inside a subtree, in document order. Written by
 * walking the tree instead of with a `:not([disabled])` selector, so it works on
 * the minimal DOM the tests provide and does not depend on a shell's selector
 * engine.
 * @param root - the subtree root.
 * @returns the focusable elements.
 */
export function collectFocusable(root) {
  const found = [];
  const tags = ["a", "button", "input", "select", "textarea"];
  const visit = (node) => {
    if (node === null || node === undefined || typeof node !== "object") return;
    const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : "";
    const attrs = typeof node.getAttribute === "function" ? node : null;
    const disabled = attrs !== null && (node.getAttribute("disabled") !== null || node.disabled === true);
    const hidden = attrs !== null && node.getAttribute("hidden") !== null;
    const negativeTab = attrs !== null && node.getAttribute("tabindex") === "-1";
    const isLinkWithHref = tag === "a" && attrs !== null && node.getAttribute("href") !== null;
    const focusable =
      !disabled &&
      !hidden &&
      !negativeTab &&
      ((tags.includes(tag) && (tag !== "a" || isLinkWithHref)) || (attrs !== null && node.getAttribute("tabindex") !== null));
    if (focusable && typeof node.focus === "function") found.push(node);
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child);
  };
  visit(root);
  return found;
}

/**
 * Set (or clear) the `inert` attribute on the shell's mount point, so the app behind
 * the dialog cannot be tabbed into while the dialog is open.
 *
 * The return value carries the state that was there BEFORE the call: a caller that
 * may share the app with another overlay must restore with
 * {@link restoreRootInert} instead of blindly clearing, or it would un-inert a
 * shell that was already inert for someone else's dialog.
 *
 * @param doc - the owning document.
 * @param inert - true to inert, false to clear.
 * @param rootId - the mount point id (defaults to {@link MODAL_ROOT_ID}).
 * @returns `{ applied, previous }`.
 */
export function setRootInert(doc, inert, rootId = MODAL_ROOT_ID) {
  if (doc === undefined || doc === null || typeof doc.getElementById !== "function") return { applied: false, previous: undefined };
  const root = doc.getElementById(rootId);
  if (root === null || root === undefined) return { applied: false, previous: undefined };
  const previous = root.inert === true || (typeof root.getAttribute === "function" && root.getAttribute("inert") !== null);
  if (inert === true) {
    root.inert = true;
    if (typeof root.setAttribute === "function") root.setAttribute("inert", "");
  } else {
    root.inert = false;
    if (typeof root.removeAttribute === "function") root.removeAttribute("inert");
  }
  return { applied: true, previous };
}

/**
 * Undo a {@link setRootInert} call, honouring what was there before it: a root that
 * was ALREADY inert (another overlay owns it) keeps its `inert` state.
 * @param doc - the owning document.
 * @param state - the value {@link setRootInert} returned when the dialog opened.
 * @param rootId - the mount point id (defaults to {@link MODAL_ROOT_ID}).
 * @returns true when the attribute was cleared.
 */
export function restoreRootInert(doc, state, rootId = MODAL_ROOT_ID) {
  const recorded = state !== null && state !== undefined && typeof state === "object" ? state : {};
  if (recorded.applied !== true) return false;
  if (recorded.previous === true) return false;
  setRootInert(doc, false, rootId);
  return true;
}

/**
 * Clamp a window size into the host route's accepted range.
 * @param days - the requested window.
 * @returns an integer day count.
 */
export function normalizeDays(days) {
  const numeric = typeof days === "number" ? days : Number.parseInt(days, 10);
  if (!Number.isFinite(numeric)) return DEFAULT_USAGE_DAYS;
  const truncated = Math.trunc(numeric);
  if (truncated < USAGE_DAYS_MIN) return USAGE_DAYS_MIN;
  if (truncated > USAGE_DAYS_MAX) return USAGE_DAYS_MAX;
  return truncated;
}

/* ------------------------------------------------------------------ *
 * View models (pure: every branch is asserted without touching the DOM)
 * ------------------------------------------------------------------ */

/**
 * One `{ label, value }` row of the balance card.
 * @param label - the row's label.
 * @param value - the row's value.
 * @param flags - `{ emphasis, tone }`.
 * @returns the row.
 */
function cardRow(label, value, flags = {}) {
  return { label, value, emphasis: flags.emphasis === true, tone: typeof flags.tone === "string" ? flags.tone : "" };
}

/**
 * Turn a normalized balance snapshot into the card's rows, or into its error /
 * pending copy. Uses the host's `fetchedAt` and `cached` fields for the data time
 * and the "came from cache" marker (T6 acceptance).
 * @param snapshot - the service result (or the row's current state).
 * @param text - the `text(key)` lookup.
 * @param nowMs - the caller's clock.
 * @returns `{ state, tone, headline, rows, error, pending }`.
 */
export function describeBalanceCard(snapshot, text, nowMs = Date.now()) {
  const at = snapshot !== null && snapshot !== undefined && typeof snapshot === "object" ? snapshot : {};
  const state = typeof at.state === "string" ? at.state : MODAL_STATES.loading;
  const base = { state, headline: text("card.title"), rows: [], error: null, pending: false };
  if (state === MODAL_STATES.ready) {
    const currency = normalizeCurrency(at.currency);
    return {
      ...base,
      tone: at.isAvailable === true ? "ok" : "warn",
      rows: [
        cardRow(text("card.total"), formatMoney(at.totalBalance, at.currency), { emphasis: true }),
        cardRow(text("card.toppedUp"), formatMoney(at.toppedUpBalance, at.currency)),
        cardRow(text("card.granted"), formatMoney(at.grantedBalance, at.currency)),
        cardRow(text("card.currency"), currency === null ? EMPTY_VALUE : currency),
        cardRow(text("card.availability"), at.isAvailable === true ? text("card.available") : text("card.unavailable"), {
          tone: at.isAvailable === true ? "" : "warn",
        }),
        cardRow(
          text("card.fetchedAt"),
          at.fetchedAt === null || at.fetchedAt === undefined ? EMPTY_VALUE : `${formatClock(at.fetchedAt)}（${formatRelativeTime(at.fetchedAt, nowMs)}）`,
        ),
        cardRow(text("card.source"), at.cached === true ? text("card.cached") : text("card.live"), { tone: at.cached === true ? "muted" : "" }),
      ],
    };
  }
  if (state === MODAL_STATES.unconfigured || state === MODAL_STATES.error) {
    const code = typeof at.code === "string" && at.code !== "" ? at.code : null;
    const message = typeof at.message === "string" && at.message !== "" ? at.message : messageForCode(code);
    return {
      ...base,
      tone: "warn",
      error: {
        code,
        message,
        httpStatus: Number.isInteger(at.httpStatus) ? at.httpStatus : null,
        detail: code === null ? "" : `${code}${Number.isInteger(at.httpStatus) ? ` · HTTP ${at.httpStatus}` : ""}`,
      },
    };
  }
  return { ...base, tone: "muted", pending: true };
}

/**
 * Turn a normalized usage snapshot into the panel's heading, charts, table and
 * empty/error copy.
 * @param snapshot - the service's `readUsage` result.
 * @param text - the `text(key)` lookup.
 * @param nowMs - the caller's clock.
 * @returns `{ state, tone, headline, summary, generatedAt, truncated, error, charts }`.
 */
export function describeUsagePanel(snapshot, text, nowMs = Date.now()) {
  const at = snapshot !== null && snapshot !== undefined && typeof snapshot === "object" ? snapshot : {};
  const state = typeof at.state === "string" ? at.state : MODAL_STATES.loading;
  const base = {
    state,
    tone: "muted",
    headline: text("usage.title"),
    summary: null,
    generatedAt: null,
    generatedAge: null,
    truncated: false,
    error: null,
    charts: null,
    payload: null,
    days: Number.isInteger(at.requestedDays) ? at.requestedDays : null,
  };
  if (state === MODAL_STATES.ready) {
    const summary = summarizeUsage(at);
    return {
      ...base,
      tone: at.truncated === true ? "warn" : "ok",
      summary,
      generatedAt: typeof at.generatedAt === "string" ? at.generatedAt : null,
      generatedAge: formatRelativeTime(at.generatedAt, nowMs),
      truncated: at.truncated === true,
      // The raw envelope travels with the view model so the chart interaction can show
      // per-model detail for the hovered day without a second read.
      payload: at.payload !== null && at.payload !== undefined && typeof at.payload === "object" ? at.payload : at,
      charts: {
        tokens: buildChartGeometry(projectSeries(at, CHART_METRICS.tokens), { metric: CHART_METRICS.tokens }),
        cost: buildChartGeometry(projectSeries(at, CHART_METRICS.cost), { metric: CHART_METRICS.cost }),
      },
    };
  }
  if (state === MODAL_STATES.unconfigured || state === MODAL_STATES.error) {
    const code = typeof at.code === "string" && at.code !== "" ? at.code : null;
    const message = typeof at.message === "string" && at.message !== "" ? at.message : messageForCode(code);
    return {
      ...base,
      tone: "warn",
      error: {
        code,
        message,
        httpStatus: Number.isInteger(at.httpStatus) ? at.httpStatus : null,
        detail: code === null ? "" : `${code}${Number.isInteger(at.httpStatus) ? ` · HTTP ${at.httpStatus}` : ""}`,
      },
    };
  }
  return base;
}

/**
 * The complete popover view model.
 * @param state - `{ balance, usage, days }`.
 * @param text - the `text(key)` lookup.
 * @param nowMs - the caller's clock.
 * @returns the model consumed by {@link renderModalPanel}.
 */
export function describeModalModel(state, text, nowMs = Date.now()) {
  const given = state !== null && state !== undefined && typeof state === "object" ? state : {};
  return {
    id: MODAL_ID,
    days: normalizeDays(given.days),
    balance: describeBalanceCard(given.balance, text, nowMs),
    usage: describeUsagePanel(given.usage, text, nowMs),
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * `YYYY-MM-DD` → `MM-DD` for the x axis (the full day stays in the table/model).
 * @param label - the day label the host produced.
 * @returns the short label.
 */
export function shortDayLabel(label) {
  return typeof label === "string" && label.length >= 10 ? label.slice(5) : String(label ?? "");
}

/**
 * Render one SVG chart (line for tokens, bars for cost) from chart geometry.
 * @param doc - the owning document.
 * @param kind - `"tokens"` or `"cost"`.
 * @param geometry - a {@link buildChartGeometry} model.
 * @returns the `<svg>` element.
 */
export function renderChartSvg(doc, kind, geometry) {
  const children = [];
  for (const tick of geometry.yTicks) {
    children.push(
      svgEl(doc, "line", {
        cls: "dsh-deepseek-usage-grid",
        attrs: { x1: geometry.padding.left, y1: tick.y, x2: geometry.padding.left + geometry.plotWidth, y2: tick.y },
      }),
    );
    children.push(
      svgEl(doc, "text", {
        cls: "dsh-deepseek-usage-axis",
        attrs: { x: geometry.padding.left - 8, y: tick.y + 4, "text-anchor": "end" },
        text: tick.label,
      }),
    );
  }
  for (const tick of geometry.xTicks) {
    children.push(
      svgEl(doc, "text", {
        cls: "dsh-deepseek-usage-axis",
        attrs: { x: tick.x, y: geometry.height - 6, "text-anchor": "middle" },
        text: shortDayLabel(tick.label),
      }),
    );
  }
  if (kind === "tokens") {
    if (geometry.areaPath !== "") children.push(svgEl(doc, "path", { cls: "dsh-deepseek-usage-area", attrs: { d: geometry.areaPath } }));
    if (geometry.linePath !== "") children.push(svgEl(doc, "path", { cls: "dsh-deepseek-usage-line", attrs: { d: geometry.linePath } }));
    // Dots matter most when there is exactly one day: a single point has no line to
    // show, so the popover renders the marker instead of an empty frame.
    for (const point of geometry.points) {
      children.push(svgEl(doc, "circle", { cls: "dsh-deepseek-usage-dot", attrs: { cx: point.x, cy: point.y, r: geometry.count > 60 ? 1.4 : 2.4 } }));
    }
  } else {
    for (const bar of geometry.bars) {
      children.push(svgEl(doc, "rect", { cls: "dsh-deepseek-usage-bar", attrs: { x: bar.x, y: bar.y, width: bar.width, height: bar.height, rx: 1 } }));
    }
  }
  return svgEl(doc, "svg", {
    cls: "dsh-deepseek-usage-chart",
    attrs: { viewBox: `0 0 ${geometry.width} ${geometry.height}`, height: geometry.height, role: "img", [MODAL_ATTR.chart]: kind },
    children,
  });
}

/**
 * Bind the chart interaction to the two rendered charts (hover hit targets, active
 * marker, tooltip, keyboard). `chart.mjs` exports the binder as a pure function of an
 * SVG plus a state reader — it has no way to know when the popover renders, so the
 * popover is the caller. Without this call the feature exists in the bundle and is
 * never used (the failure mode this project already hit once: a module that is present
 * but never wired).
 *
 * Called on EVERY render: the panel is rebuilt on the 7/30-day switch, so a fresh bind
 * is what keeps the hit targets aligned with the new window; `update()` then normalizes
 * the binder's state to the same geometry/payload (the documented re-render path).
 * Every handle is pushed into `registry` so the caller can `destroy()` the previous set
 * before replacing the panel — otherwise each switch would leave another set of
 * listeners and tooltips behind.
 *
 * @param doc - the owning document.
 * @param panel - the rendered panel.
 * @param model - the `describeModalModel` result (carries `usage.charts` and `usage.payload`).
 * @param registry - optional array collecting the handles.
 * @returns the attached handles (empty when no chart is rendered).
 */
export function attachChartInteractions(doc, panel, model, registry) {
  const usage = model !== null && model !== undefined && typeof model === "object" ? model.usage : null;
  const charts = usage !== null && usage !== undefined && typeof usage === "object" ? usage.charts : null;
  if (charts === null || charts === undefined || typeof panel?.querySelector !== "function") return [];
  const payload = usage.payload !== null && usage.payload !== undefined ? usage.payload : null;
  const collected = Array.isArray(registry) ? registry : null;
  const attached = [];
  for (const [kind, geometry] of [
    ["tokens", charts.tokens],
    ["cost", charts.cost],
  ]) {
    const svg = panel.querySelector(`[${MODAL_ATTR.chart}="${kind}"]`);
    if (svg === null || svg === undefined) continue;
    const figure = svg.parentNode === null || svg.parentNode === undefined ? panel : svg.parentNode;
    const marker = kind === "cost" ? "bar" : "dot";
    const chart = attachChartInteraction({
      doc,
      svg,
      root: figure,
      getState: () => ({ geometry, payload }),
      marker,
    });
    chart.update({ geometry, payload, marker });
    attached.push(chart);
    if (collected !== null) collected.push(chart);
  }
  return attached;
}

/**
 * Render the model table (one row per model plus a totals row).
 * @param doc - the owning document.
 * @param text - the `text(key)` lookup.
 * @param summary - a {@link summarizeUsage} result.
 * @returns the `<table>` element.
 */
export function renderModelTable(doc, text, summary) {
  const headers = [
    text("usage.table.model"),
    text("usage.table.input"),
    text("usage.table.cache"),
    text("usage.table.output"),
    text("usage.table.total"),
    text("usage.table.cost"),
  ];
  const head = el(doc, "tr", { children: headers.map((label) => el(doc, "th", { attrs: { scope: "col" }, text: label })) });
  const body = summary.models.map((entry) =>
    el(doc, "tr", {
      attrs: { "data-model": entry.model },
      children: [
        el(doc, "td", { text: entry.model === UNKNOWN_MODEL ? text("usage.unknownModel") : entry.model }),
        el(doc, "td", { text: formatMetricValue(entry.inputTokens, CHART_METRICS.tokens) }),
        el(doc, "td", { text: formatMetricValue(entry.cacheReadTokens, CHART_METRICS.tokens) }),
        el(doc, "td", { text: formatMetricValue(entry.outputTokens, CHART_METRICS.tokens) }),
        el(doc, "td", { text: formatMetricValue(entry.totalTokens, CHART_METRICS.tokens) }),
        el(doc, "td", { text: formatMetricValue(entry.estimatedCostCny, CHART_METRICS.cost) }),
      ],
    }),
  );
  if (body.length === 0) {
    body.push(el(doc, "tr", { children: [el(doc, "td", { attrs: { colspan: 6 }, text: text("usage.table.empty") })] }));
  }
  const totals = el(doc, "tr", {
    children: [
      el(doc, "td", { text: text("usage.totals") }),
      el(doc, "td", { text: formatMetricValue(summary.totals.inputTokens, CHART_METRICS.tokens) }),
      el(doc, "td", { text: formatMetricValue(summary.totals.cacheReadTokens, CHART_METRICS.tokens) }),
      el(doc, "td", { text: formatMetricValue(summary.totals.outputTokens, CHART_METRICS.tokens) }),
      el(doc, "td", { text: formatMetricValue(summary.totals.totalTokens, CHART_METRICS.tokens) }),
      el(doc, "td", { text: formatMetricValue(summary.totals.estimatedCostCny, CHART_METRICS.cost) }),
    ],
  });
  return el(doc, "table", {
    cls: "dsh-deepseek-usage-table",
    attrs: { [MODAL_ATTR.models]: MODAL_ID },
    children: [el(doc, "thead", { children: [head] }), el(doc, "tbody", { children: body }), el(doc, "tfoot", { children: [totals] })],
  });
}

/**
 * Render the whole dialog panel for one model. Pure DOM construction: every value
 * comes from the model and every interaction goes through `handlers`, which makes
 * the structure assertable without a browser.
 * @param doc - the owning document.
 * @param model - a {@link describeModalModel} result.
 * @param handlers - `{ onClose, onRefreshBalance, onRetryUsage, onSelectDays, onPlatform }`
 *   (a missing handler disables its control rather than failing).
 * @param text - the `text(key)` lookup.
 * @returns the panel element (role=dialog).
 */
export function renderModalPanel(doc, model, handlers = {}, text = modalText(undefined)) {
  const children = [];
  children.push(
    el(doc, "div", {
      cls: "dsh-deepseek-usage-head",
      children: [
        el(doc, "div", {
          children: [
            el(doc, "h2", { cls: "dsh-deepseek-usage-title", attrs: { id: `dsh-deepseek-usage-title-${model.id}` }, text: text("modal.title") }),
            el(doc, "p", { cls: "dsh-deepseek-usage-sub", text: text("modal.close.hint") }),
          ],
        }),
        el(doc, "button", {
          cls: "dsh-deepseek-usage-close",
          attrs: {
            type: "button",
            [MODAL_ATTR.close]: MODAL_ID,
            "aria-label": text("modal.close"),
            title: text("modal.close"),
            [MODAL_ATTR.focusKey]: "close",
          },
          text: "✕",
          on: { click: () => handlers.onClose?.() },
        }),
      ],
    }),
  );

  // --- balance card -------------------------------------------------
  const card = el(doc, "section", { attrs: { [MODAL_ATTR.balance]: MODAL_ID } });
  card.appendChild(el(doc, "h3", { cls: "dsh-deepseek-usage-section-title", text: model.balance.headline }));
  if (model.balance.pending === true) {
    card.appendChild(el(doc, "p", { cls: "dsh-deepseek-usage-pending", text: text("card.pending") }));
  } else if (model.balance.error !== null) {
    card.appendChild(
      el(doc, "p", {
        cls: "dsh-deepseek-usage-error",
        attrs: { "data-error-code": model.balance.error.code ?? "" },
        text: `${text("card.loadFailed")}：${model.balance.error.message}${model.balance.error.detail === "" ? "" : `（${model.balance.error.detail}）`}`,
      }),
    );
  } else {
    card.appendChild(
      el(doc, "dl", {
        cls: "dsh-deepseek-usage-rows",
        children: model.balance.rows.flatMap((row) => [
          el(doc, "dt", { text: row.label }),
          el(doc, "dd", { text: row.value, attrs: { "data-emphasis": row.emphasis ? "1" : "0", "data-tone": row.tone } }),
        ]),
      }),
    );
  }
  const cardTools = el(doc, "div", { cls: "dsh-deepseek-usage-toolbar" });
  cardTools.appendChild(
    el(doc, "button", {
      cls: "dsh-deepseek-usage-retry",
      attrs: {
        type: "button",
        [MODAL_ATTR.refresh]: MODAL_ID,
        [MODAL_ATTR.focusKey]: "refresh-balance",
        disabled: model.balance.pending === true || typeof handlers.onRefreshBalance !== "function",
      },
      text: model.balance.error === null ? text("card.refresh") : text("card.retry"),
      on: typeof handlers.onRefreshBalance === "function" ? { click: () => handlers.onRefreshBalance() } : {},
    }),
  );
  cardTools.appendChild(el(doc, "span", { cls: "dsh-deepseek-usage-spacer" }));
  card.appendChild(cardTools);
  card.appendChild(el(doc, "p", { cls: "dsh-deepseek-usage-note", text: text("card.hint") }));
  children.push(card);

  // --- local usage charts -------------------------------------------
  const usage = el(doc, "section", { attrs: { [MODAL_ATTR.usage]: MODAL_ID } });
  usage.appendChild(el(doc, "h3", { cls: "dsh-deepseek-usage-section-title", text: model.usage.headline }));
  const toolbar = el(doc, "div", { cls: "dsh-deepseek-usage-toolbar" });
  for (const window of USAGE_WINDOWS) {
    toolbar.appendChild(
      el(doc, "button", {
        cls: "dsh-deepseek-usage-tab",
        attrs: {
          type: "button",
          [MODAL_ATTR.days]: String(window),
          [MODAL_ATTR.focusKey]: `days-${window}`,
          "aria-pressed": model.days === window ? "true" : "false",
        },
        text: text("usage.window").replace("{n}", String(window)),
        on: { click: () => handlers.onSelectDays?.(window) },
      }),
    );
  }
  if (model.usage.truncated === true) {
    toolbar.appendChild(el(doc, "span", { cls: "dsh-deepseek-usage-badge", attrs: { "data-tone": "warn" }, text: text("usage.truncated") }));
  }
  if (model.usage.generatedAt !== null) {
    const age = typeof model.usage.generatedAge === "string" && model.usage.generatedAge !== EMPTY_VALUE ? `（${model.usage.generatedAge}）` : "";
    toolbar.appendChild(
      el(doc, "span", { cls: "dsh-deepseek-usage-badge", text: `${text("usage.generatedAt")} ${formatClock(model.usage.generatedAt)}${age}` }),
    );
  }
  usage.appendChild(toolbar);

  if (model.usage.state === MODAL_STATES.loading) {
    usage.appendChild(el(doc, "p", { cls: "dsh-deepseek-usage-pending", text: text("usage.pending") }));
  } else if (model.usage.error !== null) {
    usage.appendChild(
      el(doc, "p", {
        cls: "dsh-deepseek-usage-error",
        attrs: { "data-error-code": model.usage.error.code ?? "" },
        text: `${text("usage.loadFailed")}：${model.usage.error.message}${model.usage.error.detail === "" ? "" : `（${model.usage.error.detail}）`}`,
      }),
    );
  } else {
    const tokens = model.usage.charts.tokens;
    const cost = model.usage.charts.cost;
    if (tokens.isEmpty === true) {
      usage.appendChild(el(doc, "p", { cls: "dsh-deepseek-usage-pending", text: text("usage.chart.empty") }));
    } else if (tokens.hasValues === false) {
      usage.appendChild(el(doc, "p", { cls: "dsh-deepseek-usage-pending", text: text("usage.chart.zero").replace("{n}", String(tokens.count)) }));
    }
    if (tokens.isSingle === true) {
      usage.appendChild(el(doc, "p", { cls: "dsh-deepseek-usage-note", text: text("usage.chart.single") }));
    }
    // Both views are rendered side by side: the line shows the daily token total and
    // the bars show the daily estimated cost, so neither hides behind a control the
    // user has to discover. The cost view carries a STATIC estimate label: the frozen
    // `/usage` envelope whitelists only six fields (no `estimated`/`priceSource`), so
    // the "this is an estimate" statement must not depend on data.
    for (const [kind, geometry] of [
      ["tokens", tokens],
      ["cost", cost],
    ]) {
      const figure = el(doc, "figure", {
        cls: "dsh-deepseek-usage-figure",
        children: [
          el(doc, "figcaption", {
            cls: "dsh-deepseek-usage-figcaption",
            text: kind === "tokens" ? text("usage.chart.tokens") : text("usage.chart.cost"),
          }),
        ],
      });
      if (kind === "cost") {
        figure.appendChild(el(doc, "p", { cls: "dsh-deepseek-usage-note", attrs: { "data-estimate-label": "1" }, text: text("usage.chart.cost.note") }));
      }
      figure.appendChild(renderChartSvg(doc, kind, geometry));
      usage.appendChild(figure);
    }
    usage.appendChild(renderModelTable(doc, text, model.usage.summary));
    // The scope line sits with the figures it qualifies, not buried in the footer: it is
    // the honest answer to "why is this lower than my platform bill".
    usage.appendChild(el(doc, "p", { cls: "dsh-deepseek-usage-scope", attrs: { "data-usage-scope": "1" }, text: text("usage.scope") }));
    usage.appendChild(el(doc, "p", { cls: "dsh-deepseek-usage-note", text: text("usage.note") }));
  }
  if (model.usage.error !== null) {
    usage.appendChild(
      el(doc, "div", {
        cls: "dsh-deepseek-usage-toolbar",
        children: [
          el(doc, "button", {
            cls: "dsh-deepseek-usage-retry",
            attrs: {
              type: "button",
              [MODAL_ATTR.usageRetry]: MODAL_ID,
              [MODAL_ATTR.focusKey]: "refresh-usage",
              disabled: typeof handlers.onRetryUsage !== "function",
            },
            text: text("usage.retry"),
            on: typeof handlers.onRetryUsage === "function" ? { click: () => handlers.onRetryUsage() } : {},
          }),
        ],
      }),
    );
  }
  children.push(usage);

  // --- platform entry (new window; never a frame) --------------------
  const foot = el(doc, "div", { cls: "dsh-deepseek-usage-foot" });
  foot.appendChild(
    el(doc, "a", {
      cls: "dsh-deepseek-usage-platform",
      attrs: {
        href: PLATFORM_USAGE_URL,
        target: "_blank",
        rel: "noopener noreferrer",
        [MODAL_ATTR.platform]: MODAL_ID,
        [MODAL_ATTR.focusKey]: "platform",
      },
      text: `${text("platform.open")} ↗`,
      on: {
        click: (event) => {
          event?.preventDefault?.();
          handlers.onPlatform?.();
        },
      },
    }),
  );
  foot.appendChild(el(doc, "span", { cls: "dsh-deepseek-usage-sub", text: text("platform.newWindow") }));
  children.push(foot);

  return el(doc, "div", {
    cls: "dsh-deepseek-usage-panel",
    attrs: {
      [MODAL_ATTR.panel]: MODAL_ID,
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": `dsh-deepseek-usage-title-${model.id}`,
      tabindex: "-1",
    },
    children,
  });
}

/* ------------------------------------------------------------------ *
 * Behaviour
 * ------------------------------------------------------------------ */

/**
 * Open the platform usage page in a NEW WINDOW. The page answers
 * `Content-Security-Policy: frame-ancestors 'none'`, so a frame could never render
 * it — neither this module nor the plan contains one. When signed out the platform
 * redirects into its own login flow, which is the expected behaviour.
 * @param win - the window to open from (defaults to the global one).
 * @param url - the target (defaults to {@link PLATFORM_USAGE_URL}); the URL stays
 *   bare because the deep-link parameters are not proven to be parsed.
 * @returns true when `window.open` was called.
 */
export function openPlatformUsage(win, url = PLATFORM_USAGE_URL) {
  const host = win ?? (typeof window === "undefined" ? undefined : window);
  if (host === null || host === undefined || typeof host.open !== "function") return false;
  host.open(url, "_blank", "noopener,noreferrer");
  return true;
}

/**
 * Resolve the ambient browser globals without assuming they exist (the same module
 * is imported by plain node in the tests).
 * @param deps - `{ document, window }` overrides.
 * @returns `{ doc, win }` (either may be `undefined`).
 */
function resolveGlobals(deps = {}) {
  const doc = deps.document ?? (typeof document === "undefined" ? undefined : document);
  const win = deps.window ?? (typeof window === "undefined" ? doc?.defaultView ?? undefined : window);
  return { doc, win };
}

/**
 * Build the popover opener the row's `resolveModal` seat calls — the function the
 * composition layer publishes through `setModalFactory`.
 *
 * The argument is the activation-time runtime
 * (`{ React, primitives, icons, Tooltip, service, text, slot }`); this popover is
 * plain DOM, so it consumes `service` (both reads) and `text` (the shell's locale
 * seat) and ignores React. Every collaborator can be overridden, which keeps the
 * module testable without a browser.
 *
 * @param runtime - the runtime, or `{ document, window, service, readUsage, text, now, inert, platformUrl }`.
 * @returns `(view) => handle`, where `view` is the row's `{ snapshot, wide, service }`.
 */
export function createUsageModalOpener(runtime = {}) {
  const given = runtime !== null && runtime !== undefined && typeof runtime === "object" ? runtime : {};
  const seat = typeof given.text === "function" ? given.text : undefined;
  return function openDeepseekUsageModal(view) {
    return openUsageModal(view, {
      document: given.document,
      window: given.window,
      now: given.now,
      inert: given.inert,
      platformUrl: given.platformUrl,
      service: given.service,
      readUsage: typeof given.readUsage === "function" ? given.readUsage : undefined,
      text: modalText(seat),
    });
  };
}

/** The currently open popover handle, so a second open can close the first properly. */
let liveHandle;

/**
 * Open the popover and return its handle.
 *
 * @param view - `{ snapshot, wide, service, days }` from the row (all optional).
 * @param deps - `{ document, window, service, readUsage, text, now, inert, platformUrl }`.
 * @returns `{ isOpen, element, days, close, refresh, setDays }`. With no DOM the
 *   handle is inert (`isOpen: false`) instead of throwing, so a non-browser caller
 *   cannot crash the row.
 */
export function openUsageModal(view = {}, deps = {}) {
  const given = view !== null && view !== undefined && typeof view === "object" ? view : {};
  const { doc, win } = resolveGlobals(deps);
  const text = typeof deps.text === "function" ? deps.text : modalText(undefined);
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  if (doc === undefined || doc === null || typeof doc.createElement !== "function" || typeof doc.body?.appendChild !== "function") {
    return { isOpen: false, element: null, days: normalizeDays(given.days), close() {}, refresh() {}, setDays() {} };
  }
  const service = given.service ?? deps.service;
  const platformUrl = typeof deps.platformUrl === "string" && deps.platformUrl !== "" ? deps.platformUrl : PLATFORM_USAGE_URL;
  const serviceRead = service !== null && service !== undefined && typeof service.read === "function" ? (request) => service.read(request) : null;
  const readUsage =
    typeof deps.readUsage === "function"
      ? deps.readUsage
      : service !== null && service !== undefined && typeof service.readUsage === "function"
        ? (request) => service.readUsage(request)
        : null;
  ensureModalStyles(doc);

  // Single instance: an already-open popover is closed before the new one mounts, so a
  // second click on the row cannot stack two overlays (and cannot leave `#root` inert
  // forever). Closing the previous HANDLE — rather than just removing its element —
  // is what restores `inert` and focus. The element sweep stays as a fallback for an
  // overlay left behind by something that did not go through this module.
  if (liveHandle !== null && liveHandle !== undefined && typeof liveHandle.close === "function") {
    try {
      liveHandle.close();
    } catch {
      /* a broken previous handle must not block the new dialog */
    }
    liveHandle = null;
  }
  const stale = typeof doc.querySelector === "function" ? doc.querySelector(`[${MODAL_ATTR.overlay}]`) : null;
  if (stale !== null && stale !== undefined && typeof stale.remove === "function") stale.remove();

  const previousFocus = doc.activeElement ?? null;
  const inertState = deps.inert === false ? { applied: false } : setRootInert(doc, true);

  let state = {
    days: normalizeDays(given.days),
    balance:
      given.snapshot !== null && given.snapshot !== undefined && typeof given.snapshot === "object"
        ? given.snapshot
        : serviceRead === null
          ? { state: MODAL_STATES.error, code: "internal", message: text("card.noService") }
          : { state: MODAL_STATES.loading },
    usage: readUsage === null ? { state: MODAL_STATES.error, code: "internal", message: text("usage.noService") } : { state: MODAL_STATES.loading },
  };
  let closed = false;
  /** Chart-interaction handles of the current render (see render()). */
  const liveCharts = [];

  const overlay = el(doc, "div", { cls: "dsh-deepseek-usage-overlay", attrs: { [MODAL_ATTR.overlay]: MODAL_ID, "data-plugin": MODAL_ID } });

  const handle = {
    isOpen: true,
    element: overlay,
    get days() {
      return state.days;
    },
    close,
    refresh,
    setDays,
    state() {
      return state;
    },
  };

  /**
   * Re-render the panel, preserving keyboard focus across the rebuild (a window
   * switch and a balance refresh both rebuild the tree).
   * @param focusKey - optional `data-dsh-usage-focus` value to focus afterwards.
   */
  function render(focusKey = null) {
    if (closed === true) return;
    const key =
      focusKey ??
      (doc.activeElement !== null && doc.activeElement !== undefined && typeof doc.activeElement.getAttribute === "function"
        ? doc.activeElement.getAttribute(MODAL_ATTR.focusKey)
        : null);
    // Drop the previous charts' listeners/tooltips before their elements are replaced.
    for (const chart of liveCharts) {
      try {
        chart.destroy();
      } catch {
        /* a broken handle must not block the re-render */
      }
    }
    liveCharts.length = 0;
    const model = describeModalModel(state, text, now());
    const panel = renderModalPanel(doc, model, handlers, text);
    while (overlay.children !== undefined && overlay.children.length > 0) overlay.removeChild(overlay.children[0]);
    overlay.appendChild(panel);
    // Wire the chart interaction to the freshly rendered SVGs (no-op when the usage
    // block has no charts) — see attachChartInteractions for why this lives here.
    attachChartInteractions(doc, panel, model, liveCharts);
    const target =
      key === null || key === undefined || typeof panel.querySelector !== "function"
        ? panel
        : panel.querySelector(`[${MODAL_ATTR.focusKey}="${key}"]`) ?? panel;
    if (typeof target.focus === "function") target.focus();
  }

  /** Contain one failure so a broken read can never blank the dialog. */
  function failureState(error, fallbackKey) {
    const detail = error instanceof Error && error.message !== "" ? error.message : String(error);
    return { state: MODAL_STATES.error, code: "internal", message: `${text(fallbackKey)}（${detail}）` };
  }

  const handlers = {
    onClose() {
      close();
    },
    onRefreshBalance:
      serviceRead === null
        ? undefined
        : function onRefreshBalance() {
            state = { ...state, balance: { ...state.balance, state: MODAL_STATES.loading } };
            render("refresh-balance");
            let pending;
            try {
              pending = serviceRead({ force: true });
            } catch (error) {
              state = { ...state, balance: failureState(error, "card.loadFailed") };
              render("refresh-balance");
              return;
            }
            Promise.resolve(pending).then(
              (result) => {
                if (closed === true) return;
                state = { ...state, balance: result !== null && typeof result === "object" ? result : failureState(new Error("宿主返回了空结果"), "card.loadFailed") };
                render("refresh-balance");
              },
              (error) => {
                if (closed === true) return;
                state = { ...state, balance: failureState(error, "card.loadFailed") };
                render("refresh-balance");
              },
            );
          },
    onRetryUsage:
      readUsage === null
        ? undefined
        : function onRetryUsage() {
            state = { ...state, usage: { state: MODAL_STATES.loading } };
            render("refresh-usage");
            loadUsage();
          },
    onSelectDays(days) {
      state = { ...state, days: normalizeDays(days), usage: readUsage === null ? state.usage : { state: MODAL_STATES.loading } };
      render(`days-${state.days}`);
      loadUsage();
    },
    onPlatform() {
      openPlatformUsage(win, platformUrl);
    },
  };

  function loadBalance() {
    if (serviceRead === null) return;
    let pending;
    try {
      pending = serviceRead({});
    } catch (error) {
      // A synchronously throwing service must not take the click handler (or the
      // caller's render) down with it.
      state = { ...state, balance: failureState(error, "card.loadFailed") };
      render();
      return;
    }
    Promise.resolve(pending).then(
      (result) => {
        if (closed === true) return;
        state = { ...state, balance: result !== null && typeof result === "object" ? result : failureState(new Error("宿主返回了空结果"), "card.loadFailed") };
        render();
      },
      (error) => {
        if (closed === true) return;
        state = { ...state, balance: failureState(error, "card.loadFailed") };
        render();
      },
    );
  }

  function loadUsage() {
    if (readUsage === null) return;
    const days = state.days;
    let pending;
    try {
      pending = readUsage({ days });
    } catch (error) {
      state = { ...state, usage: failureState(error, "usage.loadFailed") };
      render();
      return;
    }
    Promise.resolve(pending).then(
      (result) => {
        if (closed === true || state.days !== days) return;
        state = { ...state, usage: result !== null && typeof result === "object" ? result : failureState(new Error("宿主返回了空结果"), "usage.loadFailed") };
        render();
      },
      (error) => {
        if (closed === true || state.days !== days) return;
        state = { ...state, usage: failureState(error, "usage.loadFailed") };
        render();
      },
    );
  }

  /**
   * Close the popover: drop the listener, unmount the overlay, restore `inert` and
   * hand focus back to whatever opened the dialog. Idempotent.
   */
  function close() {
    if (closed === true) return;
    closed = true;
    handle.isOpen = false;
    if (liveHandle === handle) liveHandle = null;
    for (const chart of liveCharts) {
      try {
        chart.destroy();
      } catch {
        /* a broken handle must not block the close */
      }
    }
    liveCharts.length = 0;
    if (typeof doc.removeEventListener === "function") doc.removeEventListener("keydown", onKeyDown, true);
    if (typeof overlay.remove === "function") overlay.remove();
    else if (overlay.parentNode !== null && overlay.parentNode !== undefined) overlay.parentNode.removeChild(overlay);
    restoreRootInert(doc, inertState);
    if (previousFocus !== null && previousFocus !== undefined && typeof previousFocus.focus === "function" && previousFocus.isConnected !== false) {
      previousFocus.focus();
    }
  }

  /** Refresh the balance (public handle method). */
  function refresh() {
    if (typeof handlers.onRefreshBalance === "function") handlers.onRefreshBalance();
  }

  /**
   * Switch the usage window (public handle method).
   * @param days - the requested window.
   */
  function setDays(days) {
    handlers.onSelectDays(days);
  }

  /**
   * Document-level keys: ESC closes, Tab is trapped inside the dialog. Listening in
   * the CAPTURE phase keeps the shell's own shortcuts from firing while the dialog
   * owns the screen.
   * @param event - the keydown event.
   */
  function onKeyDown(event) {
    if (closed === true || event === null || event === undefined) return;
    if (event.key === "Escape") {
      event.preventDefault?.();
      event.stopPropagation?.();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = overlay.children?.[0];
    if (panel === undefined || panel === null) return;
    const focusable = collectFocusable(panel);
    if (focusable.length === 0) {
      event.preventDefault?.();
      if (typeof panel.focus === "function") panel.focus();
      return;
    }
    const index = focusable.indexOf(doc.activeElement);
    if (event.shiftKey === true) {
      if (index <= 0) {
        event.preventDefault?.();
        focusable[focusable.length - 1].focus();
      }
      return;
    }
    if (index === -1 || index === focusable.length - 1) {
      event.preventDefault?.();
      focusable[0].focus();
    }
  }

  overlay.addEventListener("click", (event) => {
    // Only the backdrop itself closes: a click that bubbled up from the panel (or
    // from the platform link inside it) must not.
    if (event !== null && event !== undefined && event.target === overlay) close();
  });
  if (typeof doc.addEventListener === "function") doc.addEventListener("keydown", onKeyDown, true);
  doc.body.appendChild(overlay);
  render();

  if (serviceRead !== null) loadBalance();
  loadUsage();
  return handle;
}
