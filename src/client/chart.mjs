/**
 * dsh-deepseek-usage — zero-dependency SVG chart geometry + interaction
 * (browser half, T6; interaction layer T16).
 *
 * The DATA half of this module is PURE: no DOM, no React, no network, no clock,
 * no third-party charting library (the popover must add no runtime dependency).
 * Those functions turn the host's frozen `/usage` envelope into numbers and then
 * into the exact geometry an SVG renderer needs — `points`, `linePath`,
 * `areaPath`, `bars`, `yTicks`, `xTicks` — and, since T16, into the interaction
 * model the renderer consumes:
 *
 *   - {@link hitTest} / {@link buildHitTargets} / {@link plotBoxOf}: screen
 *     coordinate → day index, with every edge and gap case defined below;
 *   - {@link tooltipModel} / {@link tooltipLines} / {@link tooltipRowText}:
 *     one day → per-model input/cacheRead/output tokens + the local cost
 *     estimate, plus the date and the "platform bill is authoritative" note;
 *   - {@link activeAttributes} / {@link hitTargetAttributes} /
 *     {@link keyboardIndex} / {@link tooltipPlacement} / {@link CHART_INTERACTION_CSS}:
 *     the DOM contract (markers, focus, placement, styles).
 *
 * `modal.mjs` owns the DOM. The ONLY DOM-touching export here is
 * {@link attachChartInteraction}, an optional binder that takes the document and
 * the SVG root as arguments (so importing this module still needs no DOM and no
 * jsdom) and wires pointer + keyboard events to the pure functions above.
 *
 * HIT-TEST RULES (frozen by tests; a chart must never feel arbitrary):
 *   - `column` (default, used by both the line and the bar view): every x inside
 *     the plot box belongs to exactly ONE day — the plot is split into `count`
 *     equal columns, so the gap between bars belongs to the bar whose column it
 *     is, and the leftmost/rightmost columns own the box edges;
 *   - outside the plot box (`x < left`, `x > right`, `y < top`, `y > baseY`) →
 *     `null`, which is what hides the tooltip when the pointer leaves the plot;
 *   - `bar`: only the bar's own rect counts; a gap resolves to the nearest bar
 *     within `gapTolerance` (default `0` ⇒ gaps hit nothing);
 *   - `point`: nearest marker within `radius` (default {@link HIT_RADIUS});
 *   - empty data (`count === 0`) → always `null`; a single point still hits;
 *     an all-zero series still hits (the caller can then show "no usage").
 *
 * Data contract (frozen by the host route, see `src/host/routes.mjs` and
 * `src/host/ledger.mjs#chartSeries`):
 *
 *   { ok:true, requestedDays, days:[{ date, models:[{ model, inputTokens,
 *     cacheReadTokens, outputTokens, estimatedCostCny }] }], generatedAt,
 *     truncated, totals }
 *
 * `days` is ALWAYS an array (zero-filled, ascending, ending today), so the chart
 * must still degrade correctly for `[]` (no logs at all) and for a series whose
 * values are all zero (window without usage) — those are two different empty
 * states and the tests pin both.
 *
 * COMPOSITION NOTE: inlined verbatim into `lib/client.js`; keep `export ` at line
 * starts and sibling imports on ONE line in the exact `import ... from "./x.mjs";`
 * form (the composer drops those lines because it flattens every `src/client/*`
 * module into one closure). `tests/ui-modal.test.mjs` proves the inlined copy has
 * not drifted.
 *
 * @module dsh-deepseek-usage/client/chart
 */

import { currencySymbol, formatAmount, formatCompactNumber } from "./format.mjs";

/** SVG namespace for every element the popover creates. */
export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The currency the host's estimated cost is denominated in.
 *
 * The English pricing page quotes USD and the Chinese one quotes CNY for the same
 * models — with DIFFERENT numbers — and the account this plugin reports on is billed
 * in CNY (its balance payload carries CNY, and the host's `PRICE_TABLE_SOURCE.currency`
 * is `CNY` too). The symbol comes from `format.mjs`'s own table rather than a literal
 * here, so the one place that knows "CNY is ¥" stays the one place.
 */
export const COST_CURRENCY = "CNY";

/** The cost currency's symbol, e.g. `¥`; falls back to `CNY ` when unknown. */
const COST_SYMBOL = currencySymbol(COST_CURRENCY) ?? `${COST_CURRENCY} `;

/** The two chart views; the values are the host's own field names. */
export const CHART_METRICS = Object.freeze({
  tokens: "totalTokens",
  cost: "estimatedCostCny",
});

/** Default drawing box (CSS pixels); the popover passes the measured one. */
export const DEFAULT_CHART_SIZE = Object.freeze({ width: 640, height: 220 });

/** Default inner margins: left/bottom leave room for the axis labels. */
export const CHART_PADDING = Object.freeze({ top: 12, right: 14, bottom: 26, left: 56 });

/** Number of horizontal grid lines (including both ends). */
export const Y_TICK_COUNT = 5;

/** A bar never grows wider than this, however few days the window has. */
export const MAX_BAR_WIDTH = 26;

/** …and never narrower than this, so a long window stays visible. */
export const MIN_BAR_WIDTH = 1;

/** The host's placeholder model id for a message that carried no model name. */
export const UNKNOWN_MODEL = "unknown";

/**
 * Coerce one host field to a usable non-negative count. Anything unusable
 * (missing, `NaN`, `Infinity`, a string, a negative number) becomes `0`, because
 * a chart must never print `NaN` or a negative bar.
 * @param value - the raw field.
 * @returns a finite number `>= 0`.
 */
export function toCount(value) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric;
}

/**
 * Coerce a size/padding option to a finite positive number.
 * @param value - the raw option.
 * @param fallback - used when the option is unusable.
 * @returns the usable value.
 */
export function toPositive(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Round to two decimals — the precision every SVG attribute is written with, so
 * the geometry is deterministic and comparable without asserting pixels.
 * @param value - the raw coordinate.
 * @returns the rounded coordinate (never `-0`).
 */
export function round2(value) {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Clamp to `[0, 1]`.
 * @param value - the raw ratio.
 * @returns the clamped ratio.
 */
export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * The host's `payload.days` as an array, whatever the payload looks like.
 * @param payload - the `/usage` envelope body.
 * @returns the day buckets (possibly empty).
 */
export function daysOf(payload) {
  if (payload === null || payload === undefined || typeof payload !== "object") return [];
  return Array.isArray(payload.days) ? payload.days : [];
}

/**
 * The host's `day.models` as an array.
 * @param day - one day bucket.
 * @returns the model buckets (possibly empty).
 */
export function modelsOf(day) {
  if (day === null || day === undefined || typeof day !== "object") return [];
  return Array.isArray(day.models) ? day.models : [];
}

/** The field name the host used before the price list moved to CNY. */
const LEGACY_COST_FIELD = "estimatedCostUsd";

/**
 * A model bucket's estimated cost, tolerating the legacy field name.
 *
 * The host renamed its cost field from `estimatedCostUsd` to `estimatedCostCny` when the
 * price list moved from the English page's dollars to the Chinese page's yuan. A browser
 * half can be loaded against a host that is still serving the old name (the bundle is
 * fetched per page load, the host process is not), and reading only the new name would
 * silently report every day as ¥0 in that window. The value's MEANING is the same
 * quantity either way — the digits were always the local estimate — so accepting both
 * names is a name-compatibility shim, not a currency conversion.
 *
 * @param model - one `/usage` model bucket.
 * @returns the cost (0 when neither field is present).
 */
export function costOf(model) {
  if (model === null || model === undefined || typeof model !== "object") return 0;
  if (model[CHART_METRICS.cost] !== undefined) return toCount(model[CHART_METRICS.cost]);
  return toCount(model[LEGACY_COST_FIELD]);
}

/**
 * Translate a chart metric name into the field the host actually sends, so a caller can
 * name the metric with the project's own vocabulary and still read an older payload.
 * @param metric - a {@link CHART_METRICS} value.
 * @returns the field name to read.
 */
function fieldFor(metric) {
  return metric === CHART_METRICS.cost ? CHART_METRICS.cost : metric;
}

/**
 * Project one `/usage` payload onto the chart's point shape — exactly one
 * `{ label, value }` per day bucket, ascending, mirroring the host's own
 * `chartSeries` so browser and host agree on what a series means.
 * @param payload - the `/usage` envelope body.
 * @param metric - `"totalTokens"`, `"inputTokens"`, `"cacheReadTokens"`,
 *   `"outputTokens"` or `"estimatedCostCny"`.
 * @returns the series (never `null`, possibly empty).
 */
export function projectSeries(payload, metric = CHART_METRICS.tokens) {
  const days = daysOf(payload);
  return days.map((day) => {
    let value = 0;
    for (const model of modelsOf(day)) {
      if (model === null || model === undefined || typeof model !== "object") continue;
      if (metric === CHART_METRICS.tokens) {
        value += toCount(model.inputTokens) + toCount(model.cacheReadTokens) + toCount(model.outputTokens);
      } else if (metric === CHART_METRICS.cost) {
        value += costOf(model);
      } else {
        value += toCount(model[fieldFor(metric)]);
      }
    }
    const label = day !== null && day !== undefined && typeof day.date === "string" ? day.date : "";
    // Cost is a fraction of a cent: keep the host's 12-decimal rounding so the
    // browser never sums to a different number than the host reported.
    return { label, value: metric === CHART_METRICS.cost ? Math.round(value * 1e12) / 1e12 : value };
  });
}

/**
 * A "nice" axis maximum at or above `value`: `1/2/5/10 × 10^n`, so tick labels
 * read as round numbers instead of echoing the raw maximum.
 * @param value - the largest value in the series.
 * @returns the axis maximum (`0` when the whole series is zero).
 */
export function niceCeil(value) {
  const numeric = toCount(value);
  if (numeric <= 0) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(numeric)));
  const normalized = numeric / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Format a value for a tick label or the model table.
 *
 * The cost branch prints the {@link COST_CURRENCY} symbol (`¥`), matching what the
 * platform's own bill uses; it used to hardcode `$` while the host's price table was
 * the English page's dollar list.
 *
 * @param value - the raw value.
 * @param metric - a {@link CHART_METRICS} value.
 * @returns the label text.
 */
export function formatMetricValue(value, metric = CHART_METRICS.tokens) {
  const numeric = toCount(value);
  if (metric === CHART_METRICS.cost) {
    if (numeric === 0) return `${COST_SYMBOL}0`;
    if (numeric >= 1) return `${COST_SYMBOL}${formatAmount(numeric, 2)}`;
    if (numeric >= 0.01) return `${COST_SYMBOL}${formatAmount(numeric, 3)}`;
    // Below a cent trailing zeros hide the magnitude: "¥0.00042" reads better
    // than "¥0.000".
    const fixed = numeric.toFixed(6).replace(/0+$/, "");
    return `${COST_SYMBOL}${fixed.endsWith(".") ? `${fixed}0` : fixed}`;
  }
  return formatCompactNumber(numeric);
}

/**
 * Build the complete geometry for one chart view.
 *
 * Degradations (all pinned by `tests/ui-modal.test.mjs`):
 *  - `series` empty          → `isEmpty: true`, empty paths, no bars;
 *  - all values zero         → `hasValues: false`, flat line on the baseline,
 *                              zero-height bars, axis maximum `0`;
 *  - exactly one point       → `isSingle: true`, the point is centred (a line
 *                              needs two);
 *  - huge values (`1e12`)    → finite coordinates, no `NaN`/`Infinity`.
 *
 * @param series - `[{ label, value }]` from {@link projectSeries}.
 * @param options - `{ width, height, padding, metric }` overrides.
 * @returns the geometry model consumed by the SVG renderer.
 */
export function buildChartGeometry(series, options = {}) {
  const width = toPositive(options.width, DEFAULT_CHART_SIZE.width);
  const height = toPositive(options.height, DEFAULT_CHART_SIZE.height);
  const given = options.padding !== null && options.padding !== undefined && typeof options.padding === "object" ? options.padding : {};
  const padding = {
    top: toPositive(given.top, CHART_PADDING.top),
    right: toPositive(given.right, CHART_PADDING.right),
    bottom: toPositive(given.bottom, CHART_PADDING.bottom),
    left: toPositive(given.left, CHART_PADDING.left),
  };
  // A box too small to hold the padding must still produce a drawable plot area.
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const baseY = round2(padding.top + plotHeight);

  const points = (Array.isArray(series) ? series : [])
    .filter((point) => point !== null && point !== undefined && typeof point === "object")
    .map((point, index) => ({
      label: typeof point.label === "string" ? point.label : String(index),
      value: toCount(point.value),
    }));

  const maxValue = niceCeil(points.reduce((max, point) => (point.value > max ? point.value : max), 0));
  const count = points.length;
  // A single point cannot define a scale, so it sits in the middle of the plot.
  const xFor = (index) =>
    count <= 1 ? padding.left + plotWidth / 2 : padding.left + (plotWidth * index) / (count - 1);
  // With an all-zero series the axis maximum is 0: everything sits on the
  // baseline instead of dividing by zero.
  const yFor = (value) =>
    maxValue <= 0 ? padding.top + plotHeight : padding.top + plotHeight - clamp01(value / maxValue) * plotHeight;

  const plotted = points.map((point, index) => ({
    index,
    label: point.label,
    value: point.value,
    x: round2(xFor(index)),
    y: round2(yFor(point.value)),
  }));
  const linePath =
    plotted.length === 0
      ? ""
      : plotted.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
  const first = plotted.length === 0 ? null : plotted[0];
  const last = plotted.length === 0 ? null : plotted[plotted.length - 1];
  const areaPath = plotted.length === 0 ? "" : `${linePath} L${last.x},${baseY} L${first.x},${baseY} Z`;

  const slot = plotWidth / Math.max(1, count);
  const barWidth = round2(Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, slot * 0.6)));
  const bars = plotted.map((point) => ({
    index: point.index,
    label: point.label,
    value: point.value,
    x: round2(padding.left + slot * point.index + (slot - barWidth) / 2),
    y: point.y,
    width: barWidth,
    height: round2(Math.max(0, baseY - point.y)),
  }));

  const yTicks = [];
  for (let step = 0; step < Y_TICK_COUNT; step += 1) {
    const ratio = step / (Y_TICK_COUNT - 1);
    yTicks.push({
      value: maxValue * ratio,
      y: round2(padding.top + plotHeight - plotHeight * ratio),
      label: formatMetricValue(maxValue * ratio, options.metric),
    });
  }
  // Only every `stride`-th x label is drawn: 30 date labels would overlap, and
  // the axis is a scale, not a data dump.
  const stride = count <= 1 ? 1 : Math.max(1, Math.ceil(count / 8));
  const xTicks = plotted
    .filter((point) => point.index % stride === 0 || point.index === count - 1)
    .map((point) => ({ index: point.index, x: point.x, label: point.label }));

  return {
    width,
    height,
    padding,
    plotWidth,
    plotHeight,
    baseY,
    maxValue,
    points: plotted,
    linePath,
    areaPath,
    bars,
    yTicks,
    xTicks,
    count,
    isEmpty: count === 0,
    isSingle: count === 1,
    hasValues: plotted.some((point) => point.value > 0),
  };
}

/**
 * Summarize a `/usage` payload for the model table and the panel header: one row
 * per model (descending by tokens) plus the window totals.
 * @param payload - the `/usage` envelope body.
 * @returns `{ models, totals, activeDays, windowDays, unknownModelTokens }`.
 */
export function summarizeUsage(payload) {
  const days = daysOf(payload);
  const byModel = new Map();
  let activeDays = 0;
  for (const day of days) {
    let dayTokens = 0;
    for (const model of modelsOf(day)) {
      if (model === null || model === undefined || typeof model !== "object") continue;
      const id = typeof model.model === "string" && model.model !== "" ? model.model : UNKNOWN_MODEL;
      const entry =
        byModel.get(id) ??
        { model: id, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostCny: 0, days: 0 };
      const input = toCount(model.inputTokens);
      const cacheRead = toCount(model.cacheReadTokens);
      const output = toCount(model.outputTokens);
      entry.inputTokens += input;
      entry.cacheReadTokens += cacheRead;
      entry.outputTokens += output;
      entry.totalTokens += input + cacheRead + output;
      entry.estimatedCostCny = Math.round((entry.estimatedCostCny + costOf(model)) * 1e12) / 1e12;
      entry.days += 1;
      dayTokens += input + cacheRead + output;
      byModel.set(id, entry);
    }
    if (dayTokens > 0) activeDays += 1;
  }
  const models = [...byModel.values()].sort((left, right) =>
    right.totalTokens === left.totalTokens ? left.model.localeCompare(right.model) : right.totalTokens - left.totalTokens,
  );
  const totals = models.reduce(
    (sum, entry) => ({
      inputTokens: sum.inputTokens + entry.inputTokens,
      cacheReadTokens: sum.cacheReadTokens + entry.cacheReadTokens,
      outputTokens: sum.outputTokens + entry.outputTokens,
      totalTokens: sum.totalTokens + entry.totalTokens,
      estimatedCostCny: Math.round((sum.estimatedCostCny + entry.estimatedCostCny) * 1e12) / 1e12,
    }),
    { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostCny: 0 },
  );
  return {
    models,
    totals,
    activeDays,
    windowDays: days.length,
    unknownModelTokens: models.reduce((sum, entry) => (entry.model === UNKNOWN_MODEL ? sum + entry.totalTokens : sum), 0),
  };
}

/* ==================================================================== *
 * Interaction layer (T16): hit testing, active state, tooltip content
 * ==================================================================== */

/** How a pointer position maps onto a day. See the module header for the rules. */
export const HIT_MODES = Object.freeze({
  column: "column",
  bar: "bar",
  point: "point",
});

/** Default hover radius in px for {@link HIT_MODES.point}. */
export const HIT_RADIUS = 16;

/** Tooltip copy; every string can be overridden through `options.labels`. */
export const TOOLTIP_LABELS = Object.freeze({
  input: "输入",
  cacheRead: "缓存读",
  output: "输出",
  cost: "费用",
  total: "合计",
  none: "当日无用量记录",
});

/** The cost figure is a local estimate; the platform bill stays authoritative. */
export const TOOLTIP_NOTE = "本地估算，平台账单为权威";

/** Footer hint: the keyboard path reaches the same tooltip as the pointer. */
export const TOOLTIP_HINT = "←/→ 切换日期 · Esc 关闭";

/**
 * The attribute/class vocabulary shared by the binder and the renderer. Using
 * one frozen table keeps the highlight assertable (`data-active="true"`,
 * `aria-selected="true"`) without either side guessing at names.
 */
export const CHART_INTERACTION = Object.freeze({
  rootAttr: "data-dsh-usage-chart",
  hitLayerClass: "dsh-deepseek-usage-hit-layer",
  hitClass: "dsh-deepseek-usage-hit",
  activeClass: "dsh-deepseek-usage-active-marker",
  tooltipClass: "dsh-deepseek-usage-tooltip",
  tooltipTitleClass: "dsh-deepseek-usage-tooltip-title",
  tooltipRowClass: "dsh-deepseek-usage-tooltip-row",
  tooltipModelClass: "dsh-deepseek-usage-tooltip-model",
  tooltipBlockClass: "dsh-deepseek-usage-tooltip-block",
  tooltipNameClass: "dsh-deepseek-usage-tooltip-name",
  tooltipValueClass: "dsh-deepseek-usage-tooltip-value",
  tooltipNoteClass: "dsh-deepseek-usage-tooltip-note",
  styleId: "dsh-deepseek-usage-chart-interaction",
  activeAttr: "data-active",
  indexAttr: "data-day-index",
  hiddenAttr: "hidden",
  tooltipAttr: "data-dsh-usage-tooltip",
  tooltipFixedAttr: "data-dsh-usage-tooltip-fixed",
});

/**
 * The tooltip's `min-width` in CSS pixels, mirrored here because the viewport clamp
 * has to tell "this bubble has been laid out" from "this box is not about the
 * tooltip". Keep the two in step with {@link CHART_INTERACTION_CSS}.
 */
export const TOOLTIP_MIN_WIDTH = 150;

/**
 * Interaction stylesheet. Exported as TEXT (never injected here) so this module
 * keeps its no-DOM contract: the popover appends it to the stylesheet it already
 * owns.
 *
 * The gate that governs the popover's CSS applies here too:
 *  - EVERY `--dsw-*` name below is one the shipped shell really defines (its theme
 *    bundle resolves them; 356 `--dsw-*` names were enumerated from the live page) —
 *    `--dsw-alias-bg-layer-3`, `--dsw-alias-label-primary/secondary/tertiary`,
 *    `--dsw-alias-border-l3`, `--dsw-alias-brand-primary`,
 *    `--dsw-alias-interactive-bg-hover`, `--dsw-elevation-stroke-color`,
 *    `--dsw-font-xs-13` (a `font:` shorthand token, not a font-size);
 *  - there is NO color literal anywhere — not even a `var(--token, #fallback)`
 *    fallback. `transparent` / `none` / `currentColor` are keywords and are used
 *    for exactly that reason.
 *
 * WHY THE TOOLTIP PAINTS ON A LAYER, NOT ON `--dsw-alias-tooltip-bg` (measured in a
 * real browser AND against the shell's own theme bundle, 2026-09-17): the shell's
 * `--dsw-alias-tooltip-bg` is an INVERTED tooltip (`#2c2c2e` in light, `#43454a` in
 * dark) meant to carry light text, and the shell exposes no inverted text token this
 * stylesheet may use. Pairing it with `--dsw-alias-label-primary` (= `#0f1115` in the
 * light theme) produced black-on-dark-grey: 1.36:1, which is the user's report
 * ("tooltip背景和文字颜色黑灰不好区分") and is unreadable. Painting the bubble on
 * `--dsw-alias-bg-layer-3` instead — the layer the shell's own elevated surfaces use —
 * measures 18.90:1 (light) / 11.57:1 (dark) for `--dsw-alias-label-primary`, 5.80:1 /
 * 8.03:1 for `--dsw-alias-label-secondary`. The `note` moved to `label-secondary` so it
 * clears body-text contrast, while the one-line keyboard `hint` keeps `label-tertiary`
 * (3.71:1 light) because nothing else may read as dimmer than it. `--dsw-alias-border-l1`
 * was dropped: it is a 10 %-alpha hairline that is invisible against the layer.
 */
export const CHART_INTERACTION_CSS = [
  ".dsh-deepseek-usage-hit{fill:transparent;stroke:none;pointer-events:all}",
  ".dsh-deepseek-usage-hit[data-active='true']{fill:var(--dsw-alias-interactive-bg-hover);opacity:.45}",
  ".dsh-deepseek-usage-active-marker{fill:currentColor;stroke:none;pointer-events:none}",
  ".dsh-deepseek-usage-active-marker[data-active='true']{fill:var(--dsw-alias-brand-primary)}",
  ".dsh-deepseek-usage-chart:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
  ".dsh-deepseek-usage-tooltip{position:absolute;z-index:10000;pointer-events:none;box-sizing:border-box;",
  "min-width:150px;max-width:280px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l3);",
  "border-radius:10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);",
  "box-shadow:0 4px 16px var(--dsw-elevation-stroke-color);font:var(--dsw-font-xs-13)}",
  ".dsh-deepseek-usage-tooltip[data-dsh-usage-tooltip-fixed]{position:fixed}",
  ".dsh-deepseek-usage-tooltip[hidden]{display:none}",
  ".dsh-deepseek-usage-tooltip-title{font-weight:600}",
  ".dsh-deepseek-usage-tooltip-row{display:flex;justify-content:space-between;gap:14px;margin-top:3px}",
  // One model per block, one metric per line: a label column and a right-aligned
  // number column, so 输入/输出/费用 never wrap into each other.
  ".dsh-deepseek-usage-tooltip-block{margin-top:6px}",
  ".dsh-deepseek-usage-tooltip-name{font-weight:600;color:var(--dsw-alias-label-primary);",
  "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dsh-deepseek-usage-tooltip-model{color:var(--dsw-alias-label-secondary);flex:none;white-space:nowrap}",
  ".dsh-deepseek-usage-tooltip-value{flex:1 1 auto;text-align:right;font-variant-numeric:tabular-nums}",
  ".dsh-deepseek-usage-tooltip-note{margin-top:4px;color:var(--dsw-alias-label-secondary)}",
  ".dsh-deepseek-usage-tooltip-hint{margin-top:2px;color:var(--dsw-alias-label-secondary)}",
].join("");

/**
 * The plot box (the area the data is drawn into) of one geometry model.
 * @param geometry - a {@link buildChartGeometry} model.
 * @returns `{ left, top, right, bottom, width, height }`, rounded to 2 decimals.
 */
export function plotBoxOf(geometry) {
  const source = geometry !== null && geometry !== undefined && typeof geometry === "object" ? geometry : {};
  const padding = source.padding !== null && source.padding !== undefined && typeof source.padding === "object" ? source.padding : CHART_PADDING;
  const left = toPositive(padding.left, CHART_PADDING.left);
  const top = toPositive(padding.top, CHART_PADDING.top);
  const width = toPositive(source.plotWidth, 1);
  const height = toPositive(source.plotHeight, 1);
  return {
    left: round2(left),
    top: round2(top),
    right: round2(left + width),
    bottom: round2(top + height),
    width: round2(width),
    height: round2(height),
  };
}

/**
 * One hit target per day: the full-height column rect the renderer attaches
 * (invisible, `pointer-events:all`) plus the visible marker geometry.
 * @param geometry - a {@link buildChartGeometry} model.
 * @param options - `{ mode }`.
 * @returns the targets, ascending by day (empty for empty data).
 */
export function buildHitTargets(geometry, options = {}) {
  const source = geometry !== null && geometry !== undefined && typeof geometry === "object" ? geometry : {};
  const points = Array.isArray(source.points) ? source.points : [];
  const bars = Array.isArray(source.bars) ? source.bars : [];
  const box = plotBoxOf(source);
  const mode = options.mode ?? HIT_MODES.column;
  const count = points.length;
  if (count === 0) return [];
  const slot = box.width / count;
  // Column edges are SHARED between neighbours (each column's right edge is the
  // next one's left edge, and the last one lands exactly on the plot edge) so the
  // rounded geometry can never leave an unhittable sliver between two columns.
  const columnLeft = (index) => round2(box.left + slot * index);
  const columnRight = (index) => (index === count - 1 ? box.right : round2(box.left + slot * (index + 1)));
  return points.map((point, index) => {
    const bar = bars[index] !== null && bars[index] !== undefined && typeof bars[index] === "object" ? bars[index] : null;
    const left = columnLeft(index);
    const right = columnRight(index);
    return {
      index,
      label: typeof point.label === "string" ? point.label : String(index),
      value: toCount(point.value),
      mode,
      x: left,
      y: box.top,
      width: round2(Math.max(0, right - left)),
      height: box.height,
      markerX: round2(point.x),
      markerY: round2(point.y),
      markerWidth: bar === null ? 0 : round2(bar.width),
      markerHeight: bar === null ? 0 : round2(bar.height),
      barX: bar === null ? null : round2(bar.x),
      barWidth: bar === null ? null : round2(bar.width),
      point,
      bar,
    };
  });
}

/**
 * Describe one resolved hit — the shape {@link hitTest} returns.
 * @param target - a {@link buildHitTargets} entry.
 * @param mode - the hit mode that resolved it.
 * @param distance - distance from the pointer to the marker.
 * @param box - the plot box the hit was resolved in.
 * @returns the hit object.
 */
function describeHit(target, mode, distance, box) {
  return {
    index: target.index,
    label: target.label,
    value: target.value,
    mode,
    distance: round2(distance),
    x: target.markerX,
    y: target.markerY,
    columnX: target.x,
    columnWidth: target.width,
    markerX: target.markerX,
    markerY: target.markerY,
    markerWidth: target.markerWidth,
    markerHeight: target.markerHeight,
    barX: target.barX,
    barWidth: target.barWidth,
    plotBox: box,
  };
}

/**
 * Map a pointer position onto one day. See the module header for the frozen
 * rules on edges, gaps, empty data, single points and all-zero series.
 * @param geometry - a {@link buildChartGeometry} model.
 * @param x - pointer x in the SVG's own coordinate system.
 * @param y - pointer y in the SVG's own coordinate system.
 * @param options - `{ mode, radius, gapTolerance }`.
 * @returns the hit (see {@link hitTest}) or `null` when nothing is hit.
 */
export function hitTest(geometry, x, y, options = {}) {
  const source = geometry !== null && geometry !== undefined && typeof geometry === "object" ? geometry : {};
  const mode = options.mode ?? HIT_MODES.column;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const box = plotBoxOf(source);
  const targets = buildHitTargets(source, { mode });
  if (targets.length === 0) return null;
  // Outside the plot box the tooltip must hide — including the axis gutter.
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
  if (mode === HIT_MODES.point) {
    const radius = toPositive(options.radius, HIT_RADIUS);
    let best = null;
    for (const target of targets) {
      const dx = target.markerX - x;
      const dy = target.markerY - y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > radius) continue;
      if (best === null || distance < best.distance) best = { target, distance };
    }
    return best === null ? null : describeHit(best.target, mode, best.distance, box);
  }
  if (mode === HIT_MODES.bar) {
    const tolerance =
      typeof options.gapTolerance === "number" && Number.isFinite(options.gapTolerance) && options.gapTolerance > 0
        ? options.gapTolerance
        : 0;
    let nearest = null;
    for (const target of targets) {
      if (target.barX === null) continue;
      // Distance to the bar's RECT (0 inside it), so `gapTolerance` reads as "how
      // far past the bar's edge still counts as that bar".
      const right = target.barX + target.barWidth;
      const distance = x < target.barX ? target.barX - x : x > right ? x - right : 0;
      if (distance === 0) return describeHit(target, mode, 0, box);
      if (distance <= tolerance && (nearest === null || distance < nearest.distance)) nearest = { target, distance };
    }
    return nearest === null ? null : describeHit(nearest.target, mode, nearest.distance, box);
  }
  // column: the plot is split into `count` equal columns, so there is no gap to
  // fall through — the last column also absorbs the right-edge rounding.
  const last = targets[targets.length - 1];
  for (const target of targets) {
    if (x >= target.x && (x < target.x + target.width || target === last)) {
      return describeHit(target, mode, Math.abs(target.markerX - x), box);
    }
  }
  return null;
}

/**
 * The day index a key press moves to — the keyboard path to the SAME tooltip the
 * pointer opens.
 * @param geometry - a {@link buildChartGeometry} model.
 * @param current - the active index (`null` when nothing is active yet).
 * @param key - a `KeyboardEvent.key` value.
 * @returns the next index, or `null` for "no day" (Escape, empty data).
 */
export function keyboardIndex(geometry, current, key) {
  const source = geometry !== null && geometry !== undefined && typeof geometry === "object" ? geometry : {};
  const count = Array.isArray(source.points) ? source.points.length : 0;
  if (count === 0) return null;
  const start = typeof current === "number" && Number.isInteger(current) && current >= 0 && current < count ? current : null;
  const clamp = (value) => (value < 0 ? 0 : value > count - 1 ? count - 1 : value);
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      return start === null ? 0 : clamp(start - 1);
    case "ArrowRight":
    case "ArrowDown":
      return start === null ? 0 : clamp(start + 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageUp":
      return start === null ? 0 : clamp(start - 7);
    case "PageDown":
      return start === null ? count - 1 : clamp(start + 7);
    case "Escape":
      return null;
    default:
      return start;
  }
}

/**
 * The active-state attribute pair every highlighted element shares.
 * @param isActive - whether this element is the active day.
 * @returns `{ "data-active", "aria-selected" }` with string values.
 */
export function activeAttributes(isActive) {
  const active = isActive === true;
  return {
    [CHART_INTERACTION.activeAttr]: active ? "true" : "false",
    "aria-selected": active ? "true" : "false",
  };
}

/**
 * The attribute set for one invisible hit rect.
 * @param target - a {@link buildHitTargets} entry (or a bare index).
 * @param activeIndex - the currently active index (`null` when hidden).
 * @param options - `{ focusable }` to make the rect itself tabbable.
 * @returns the attribute map.
 */
export function hitTargetAttributes(target, activeIndex, options = {}) {
  const isTargetObject = target !== null && target !== undefined && typeof target === "object";
  const index = isTargetObject ? target.index : target;
  const label = isTargetObject && typeof target.label === "string" ? target.label : "";
  const active = typeof activeIndex === "number" && index === activeIndex;
  return {
    class: CHART_INTERACTION.hitClass,
    [CHART_INTERACTION.indexAttr]: String(index),
    "data-day-label": label,
    ...activeAttributes(active),
    ...(options.focusable === true ? { tabindex: "0", role: "button", "aria-label": label } : {}),
  };
}

/**
 * Round a cost to the host's 12-decimal precision.
 * @param value - the raw cost.
 * @returns the rounded cost.
 */
function roundCost(value) {
  return Math.round(toCount(value) * 1e12) / 1e12;
}

/**
 * Exact, grouped token count — a tooltip has room for "12,340" and the exact
 * number is what a user reconciling a bill wants, unlike the axis's "12.3k".
 * @param value - the raw token count.
 * @returns the grouped text.
 */
function formatTokenCountText(value) {
  return formatAmount(toCount(value), 0);
}

/**
 * Build one tooltip row (one model on one day) with numbers AND the formatted
 * text the DOM paints, so both are assertable.
 * @param model - one `/usage` model bucket.
 * @returns the row.
 */
function tooltipRowOf(model) {
  const input = toCount(model.inputTokens);
  const cacheRead = toCount(model.cacheReadTokens);
  const output = toCount(model.outputTokens);
  const estimate = roundCost(costOf(model));
  return {
    model: typeof model.model === "string" && model.model !== "" ? model.model : UNKNOWN_MODEL,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    outputTokens: output,
    totalTokens: input + cacheRead + output,
    estimatedCostCny: estimate,
    inputText: formatTokenCountText(input),
    cacheReadText: formatTokenCountText(cacheRead),
    outputText: formatTokenCountText(output),
    totalText: formatTokenCountText(input + cacheRead + output),
    costText: formatMetricValue(estimate, CHART_METRICS.cost),
  };
}

/**
 * The value cell of one tooltip row: every per-model field the acceptance names.
 * @param row - a row from {@link tooltipModel}.
 * @param labels - the copy (defaults to {@link TOOLTIP_LABELS}).
 * @returns the text.
 */
export function tooltipRowText(row, labels = TOOLTIP_LABELS) {
  return tooltipFields(row, labels)
    .map((field) => `${field.value} ${field.label}`)
    .join(" · ");
}

/**
 * One labelled figure of a tooltip row, as `{ key, label, value }`.
 *
 * The DOM paints these one per LINE (the user's request: 输入一行、输出一行), while
 * {@link tooltipRowText} joins the same list for the plain-text form — so the layout
 * and the text are produced from one source and cannot drift apart.
 *
 * @param row - a row from {@link tooltipModel}.
 * @param labels - the copy (defaults to {@link TOOLTIP_LABELS}).
 * @returns the fields, in reading order.
 */
export function tooltipFields(row, labels = TOOLTIP_LABELS) {
  const copy = labels !== null && labels !== undefined && typeof labels === "object" ? { ...TOOLTIP_LABELS, ...labels } : TOOLTIP_LABELS;
  return [
    { key: "input", label: copy.input, value: row.inputText },
    { key: "cacheRead", label: copy.cacheRead, value: row.cacheReadText },
    { key: "output", label: copy.output, value: row.outputText },
    { key: "cost", label: copy.cost, value: row.costText },
  ];
}

/**
 * The totals cell of a multi-model tooltip, as one line.
 * @param totals - `tooltipModel(payload).totals`.
 * @param labels - the copy.
 * @returns the text.
 */
export function tooltipTotalText(totals, labels = TOOLTIP_LABELS) {
  return tooltipTotalFields(totals, labels)
    .map((field) => `${field.value} ${field.label}`)
    .join(" · ");
}

/**
 * The same fields for a totals cell — it adds the row's own 合计 so a multi-model
 * day can be read without adding the lines up by hand.
 * @param totals - `tooltipModel(payload).totals`.
 * @param labels - the copy.
 * @returns the fields, in reading order.
 */
export function tooltipTotalFields(totals, labels = TOOLTIP_LABELS) {
  const copy = labels !== null && labels !== undefined && typeof labels === "object" ? { ...TOOLTIP_LABELS, ...labels } : TOOLTIP_LABELS;
  return [
    { key: "input", label: copy.input, value: totals.inputText },
    { key: "cacheRead", label: copy.cacheRead, value: totals.cacheReadText },
    { key: "output", label: copy.output, value: totals.outputText },
    { key: "total", label: copy.total, value: totals.totalText },
    { key: "cost", label: copy.cost, value: totals.costText },
  ];
}

/**
 * Build the tooltip content for one day of one `/usage` payload.
 *
 * `days` is always an array (zero-filled by the host), so a day with no usage
 * yields a model with `hasUsage: false` and the `none` copy instead of `null` —
 * the popover can still say "that day had nothing". `null` is reserved for a day
 * reference that does not exist in the payload.
 *
 * @param payload - the `/usage` envelope body.
 * @param dayRef - a day index (number) or a `YYYY-MM-DD` date (string, matched
 *   from the newest end so a duplicated label resolves to the latest day).
 * @param options - `{ labels }` overrides.
 * @returns the tooltip model, or `null` when the day cannot be resolved.
 */
export function tooltipModel(payload, dayRef, options = {}) {
  const days = daysOf(payload);
  const requestedDays =
    payload !== null && payload !== undefined && typeof payload === "object" && Number.isInteger(payload.requestedDays)
      ? payload.requestedDays
      : days.length;
  let index = -1;
  if (typeof dayRef === "number" && Number.isInteger(dayRef)) index = dayRef;
  else if (typeof dayRef === "string" && dayRef !== "") {
    for (let cursor = days.length - 1; cursor >= 0; cursor -= 1) {
      if (days[cursor] !== null && typeof days[cursor] === "object" && days[cursor].date === dayRef) {
        index = cursor;
        break;
      }
    }
  } else if (dayRef !== null && dayRef !== undefined && typeof dayRef === "object" && typeof dayRef.date === "string") {
    return tooltipModel(payload, dayRef.date, options);
  }
  if (!Number.isInteger(index) || index < 0 || index >= days.length) return null;
  const day = days[index];
  const models = modelsOf(day)
    .filter((entry) => entry !== null && entry !== undefined && typeof entry === "object")
    .map(tooltipRowOf)
    .sort((left, right) =>
      right.totalTokens === left.totalTokens ? left.model.localeCompare(right.model) : right.totalTokens - left.totalTokens,
    );
  const totals = models.reduce(
    (sum, row) => ({
      inputTokens: sum.inputTokens + row.inputTokens,
      cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      totalTokens: sum.totalTokens + row.totalTokens,
      estimatedCostCny: roundCost(sum.estimatedCostCny + row.estimatedCostCny),
    }),
    { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostCny: 0 },
  );
  totals.inputText = formatTokenCountText(totals.inputTokens);
  totals.cacheReadText = formatTokenCountText(totals.cacheReadTokens);
  totals.outputText = formatTokenCountText(totals.outputTokens);
  totals.totalText = formatTokenCountText(totals.totalTokens);
  totals.costText = formatMetricValue(totals.estimatedCostCny, CHART_METRICS.cost);
  const date = day !== null && day !== undefined && typeof day.date === "string" ? day.date : "";
  return {
    index,
    date: date === "" ? `第 ${index + 1} 天` : date,
    requestedDays,
    models,
    totals,
    hasUsage: totals.totalTokens > 0 || totals.estimatedCostCny > 0,
    isEmptyDay: models.length === 0,
    note: TOOLTIP_NOTE,
    hint: TOOLTIP_HINT,
  };
}

/**
 * The tooltip as plain text lines — the same content the DOM shows, in a form a
 * test (or an `aria-label`) can assert without any DOM.
 * @param model - a {@link tooltipModel} result.
 * @param labels - the copy.
 * @returns the lines (empty for `null`).
 */
export function tooltipLines(model, labels = TOOLTIP_LABELS) {
  if (model === null || model === undefined || typeof model !== "object") return [];
  const copy = labels !== null && typeof labels === "object" ? { ...TOOLTIP_LABELS, ...labels } : TOOLTIP_LABELS;
  const lines = [model.date];
  if (!model.hasUsage) lines.push(copy.none);
  for (const row of model.models) lines.push(`${row.model}: ${tooltipRowText(row, copy)}`);
  if (model.models.length > 1) lines.push(tooltipTotalText(model.totals, copy));
  lines.push(model.note);
  return lines;
}

/**
 * Where the tooltip goes, relative to the chart container. The anchor is clamped
 * into `[edge, containerWidth - edge]` so a day at either end of the axis never
 * pushes the bubble out of the panel; the side flips below the anchor when the
 * marker sits too close to the plot's top to fit a bubble above it.
 * @param geometry - a {@link buildChartGeometry} model.
 * @param hit - a {@link hitTest} result (or any object with `markerX`/`markerY`).
 * @param options - `{ offset, edge, flipThreshold, rightLimit }`.
 * @returns `{ left, top, side, transform, anchorX, anchorY }` in CSS pixels.
 */
export function tooltipPlacement(geometry, hit, options = {}) {
  const source = geometry !== null && geometry !== undefined && typeof geometry === "object" ? geometry : {};
  const box = plotBoxOf(source);
  const anchorSource = hit !== null && hit !== undefined && typeof hit === "object" ? hit : {};
  const anchorX = Number.isFinite(anchorSource.markerX) ? anchorSource.markerX : box.left;
  const anchorY = Number.isFinite(anchorSource.markerY) ? anchorSource.markerY : box.bottom;
  const offset = toPositive(options.offset, 12);
  const edge = toPositive(options.edge, 8);
  const flipThreshold = toPositive(options.flipThreshold, 28);
  const rightLimit = toPositive(options.rightLimit, toPositive(source.width, box.right));
  const side = anchorY - offset - flipThreshold < box.top ? "bottom" : "top";
  return {
    left: round2(Math.max(edge, Math.min(anchorX, Math.max(edge, rightLimit - edge)))),
    top: round2(side === "top" ? anchorY - offset : anchorY + offset),
    side,
    transform: side === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
    anchorX: round2(anchorX),
    anchorY: round2(anchorY),
  };
}

/**
 * One point inside an SVG in its OWN user coordinate system, for the current
 * rendered layout. The SVG scales its user space to the layout box (via `viewBox`
 * or the width/height attributes), so a user-space coordinate is NOT a CSS pixel:
 * the live popover measured `viewBox="0 0 640 220"` inside a 672×231 box, i.e. a
 * scale of 1.05 — 5 % of every position, enough to put the tooltip on the wrong day.
 *
 * `getScreenCTM()` is the only correct translation, and it accounts for the layout
 * box, the viewBox scale, any ancestor transform and the scroll position at once.
 *
 * @param svg - the SVG root (a real one; the doubles used by the suite have no
 *   `getScreenCTM` and take the caller's fallback instead).
 * @param x - x in CSS pixels relative to the viewport.
 * @param y - y in CSS pixels relative to the viewport.
 * @returns `{ x, y }` in user units, or `undefined` when the matrix is unavailable.
 */
function userPointOf(svg, x, y) {
  if (typeof svg?.getScreenCTM === "function") {
    const matrix = svg.getScreenCTM();
    const inverse = matrix !== null && matrix !== undefined && typeof matrix.inverse === "function" ? matrix.inverse() : null;
    if (inverse !== null) {
      // `SVGPoint` is the universally implemented spelling; `DOMPoint` is the
      // modern one. Both understand `matrixTransform`.
      let point = null;
      if (typeof svg.ownerSVGElement?.createSVGPoint === "function") point = svg.ownerSVGElement.createSVGPoint();
      else if (typeof svg.createSVGPoint === "function") point = svg.createSVGPoint();
      else if (typeof DOMPoint === "function") point = new DOMPoint(x, y);
      if (point !== null && typeof point.matrixTransform === "function") {
        if (point.x !== x || point.y !== y) {
          point.x = x;
          point.y = y;
        }
        const mapped = point.matrixTransform(inverse);
        if (Number.isFinite(mapped?.x) && Number.isFinite(mapped?.y)) return { x: mapped.x, y: mapped.y };
      }
    }
  }
  // Fallback: the layout box, which is exact while the box matches the viewBox.
  if (typeof svg?.getBoundingClientRect === "function") {
    const rect = svg.getBoundingClientRect();
    if (Number.isFinite(rect?.left) && Number.isFinite(rect?.top)) return { x: x - rect.left, y: y - rect.top };
  }
  return undefined;
}

/**
 * One point in the SVG's user units, expressed in CSS pixels relative to the
 * viewport — the inverse of {@link userPointOf}, used to place a `position:fixed`
 * tooltip (fixed placement is immune to whatever ancestor happens to be the
 * containing block, which is what broke the previous absolute placement).
 *
 * @param svg - the SVG root.
 * @param x - x in user units.
 * @param y - y in user units.
 * @returns `{ x, y }` in viewport pixels, or `undefined` when it cannot be resolved.
 */
function clientPointOf(svg, x, y) {
  if (typeof svg?.getScreenCTM === "function") {
    const matrix = svg.getScreenCTM();
    if (matrix !== null && matrix !== undefined && typeof matrix.transformPoint === "function") {
      const mapped = matrix.transformPoint({ x, y });
      if (Number.isFinite(mapped?.x) && Number.isFinite(mapped?.y)) return { x: mapped.x, y: mapped.y };
    }
    // A plain object is not a DOMPoint in every engine; build a real one when we can.
    if (matrix !== null && matrix !== undefined && typeof DOMPoint === "function") {
      const mapped = new DOMPoint(x, y).matrixTransform(matrix);
      if (Number.isFinite(mapped?.x) && Number.isFinite(mapped?.y)) return { x: mapped.x, y: mapped.y };
    }
  }
  // Fallback: assume user units ARE CSS pixels inside the layout box (true whenever
  // the viewBox matches the box, which is the shape the suite's charts have).
  if (typeof svg?.getBoundingClientRect === "function") {
    const rect = svg.getBoundingClientRect();
    if (Number.isFinite(rect?.left) && Number.isFinite(rect?.top)) return { x: rect.left + x, y: rect.top + y };
  }
  return undefined;
}

/**
 * Wire pointer + keyboard interaction onto one rendered chart.
 *
 * This is the module's only DOM-touching export, and the document arrives as an
 * ARGUMENT — importing `chart.mjs` still needs no DOM and no jsdom, which is why
 * the interaction model above is testable in plain node. The popover calls this
 * once per chart and then `update(state)` whenever the geometry changes (for
 * example after the 7/30-day switch), which is what re-binds the hit targets.
 *
 * Behaviour:
 *  - the pointer hit-tests through {@link hitTest} and opens the DOM tooltip
 *    built from {@link tooltipModel} (never a `<title>` only — the tooltip is a
 *    real element so it is stylable, readable and assertable);
 *  - the active day is marked on the hit rect AND on a marker element owned by
 *    this binder (`data-active="true"` + `aria-selected="true"`), so the
 *    highlight survives renderers whose dots/bars are not tagged;
 *  - `pointerleave`/`pointercancel` (and `blur`, and `Escape`) hide it;
 *  - the SVG root becomes focusable (`tabindex="0"`, `role="group"`, label with
 *    the keyboard hint), and `←/→/Home/End/PageUp/PageDown` walk the SAME tooltip.
 *
 * @param options - `{ doc, svg, root, getState, measure, mode, labels, namespace, ariaLabel, radius, gapTolerance, offset, focusable }`.
 * @param options.doc - the document (required).
 * @param options.svg - the chart's SVG root (required).
 * @param options.root - the positioned container that hosts the tooltip (defaults to `svg.parentNode`).
 * @param options.getState - `() => ({ geometry, payload })` read on every event.
 * @returns a handle: `{ update, show, hide, destroy, getActiveIndex, isVisible }`.
 */
export function attachChartInteraction(options = {}) {
  const doc = options.doc;
  const svg = options.svg;
  if (doc === null || doc === undefined || typeof doc.createElementNS !== "function" || typeof doc.createElement !== "function") {
    throw new TypeError("attachChartInteraction requires a document via options.doc");
  }
  if (svg === null || svg === undefined || typeof svg.appendChild !== "function") {
    throw new TypeError("attachChartInteraction requires the chart's SVG root via options.svg");
  }
  const namespace = typeof options.namespace === "string" ? options.namespace : SVG_NAMESPACE;
  const mode = options.mode ?? HIT_MODES.column;
  const labels = options.labels !== null && options.labels !== undefined && typeof options.labels === "object" ? options.labels : {};
  const readState =
    typeof options.getState === "function" ? options.getState : () => ({ geometry: options.geometry, payload: options.payload });
  const measure =
    typeof options.measure === "function"
      ? options.measure
      : () => {
          const rect = typeof svg.getBoundingClientRect === "function" ? svg.getBoundingClientRect() : null;
          return { left: Number.isFinite(rect?.left) ? rect.left : 0, top: Number.isFinite(rect?.top) ? rect.top : 0 };
        };
  const host = options.root ?? svg.parentNode ?? svg;
  const ariaLabel =
    typeof options.ariaLabel === "string" ? options.ariaLabel : `每日用量图表：方向键切换日期（${TOOLTIP_HINT}）`;
  let state = readState() !== null && typeof readState() === "object" ? readState() : {};
  // Which marker element highlights the active day: a dot for the line view (the
  // default) or a rect over the bar for the cost view. The metric toggle switches
  // it through `update({ marker })` without re-attaching the listeners.
  let marker = options.marker === "bar" ? "bar" : "dot";
  let activeIndex = null;
  let visible = false;
  let disposed = false;
  let rects = [];
  let markers = [];

  /**
   * Create one namespaced SVG element.
   * @param tag - SVG tag name.
   * @param attrs - attribute map (values are stringified).
   * @returns the element.
   */
  function makeSvg(tag, attrs) {
    const element = doc.createElementNS(namespace, tag);
    for (const [name, value] of Object.entries(attrs ?? {})) element.setAttribute(name, String(value));
    return element;
  }

  /**
   * Create one HTML element with an optional class and text.
   * @param tag - HTML tag name.
   * @param className - class attribute (omitted when empty).
   * @param text - text content (omitted when empty).
   * @returns the element.
   */
  function makeElement(tag, className, text) {
    const element = doc.createElement(tag);
    if (typeof className === "string" && className !== "") element.setAttribute("class", className);
    if (typeof text === "string" && text !== "") element.textContent = text;
    return element;
  }

  /**
   * Detach one element without assuming the optional `remove()`.
   * @param element - the element to detach.
   */
  function detach(element) {
    if (typeof element.remove === "function") element.remove();
    else if (element.parentNode !== null && element.parentNode !== undefined && typeof element.parentNode.removeChild === "function") {
      element.parentNode.removeChild(element);
    }
  }

  /**
   * Show/hide one element.
   * @param element - the element.
   * @param hidden - whether it must be hidden.
   */
  function setHidden(element, hidden) {
    if (hidden === true) {
      if (typeof element.setAttribute === "function") element.setAttribute(CHART_INTERACTION.hiddenAttr, "hidden");
      element.hidden = true;
    } else {
      if (typeof element.removeAttribute === "function") element.removeAttribute(CHART_INTERACTION.hiddenAttr);
      element.hidden = false;
    }
  }

  const root = svg;
  const existingClass = typeof root.getAttribute === "function" ? root.getAttribute("class") : null;
  if (typeof existingClass === "string" && existingClass.includes("dsh-deepseek-usage-chart")) {
    // keep the renderer's own classes untouched
  } else if (typeof existingClass === "string" && existingClass !== "") {
    root.setAttribute("class", `${existingClass} dsh-deepseek-usage-chart`);
  } else {
    root.setAttribute("class", "dsh-deepseek-usage-chart");
  }
  root.setAttribute(CHART_INTERACTION.rootAttr, "1");
  root.setAttribute("tabindex", "0");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", ariaLabel);

  const hitLayer = makeSvg("g", { class: CHART_INTERACTION.hitLayerClass });
  const markerLayer = makeSvg("g", { class: CHART_INTERACTION.activeClass, "aria-hidden": "true" });
  const tooltip = makeElement("div", CHART_INTERACTION.tooltipClass);
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute(CHART_INTERACTION.hiddenAttr, "hidden");
  tooltip.setAttribute(CHART_INTERACTION.tooltipAttr, "1");
  tooltip.hidden = true;
  const title = makeElement("div", CHART_INTERACTION.tooltipTitleClass);
  const body = makeElement("div", null);
  const note = makeElement("div", CHART_INTERACTION.tooltipNoteClass, TOOLTIP_NOTE);
  const hint = makeElement("div", "dsh-deepseek-usage-tooltip-hint", TOOLTIP_HINT);
  tooltip.appendChild(title);
  tooltip.appendChild(body);
  tooltip.appendChild(note);
  tooltip.appendChild(hint);
  svg.appendChild(hitLayer);
  svg.appendChild(markerLayer);

  /**
   * Where the tooltip is attached.
   *
   * `position:fixed` coordinates are relative to the VIEWPORT, so the bubble must not
   * sit inside a transformed/filtered ancestor — any such ancestor becomes the
   * containing block for a fixed box in Chrome. The popover overlay uses
   * `backdrop-filter`, so the only place with no such ancestor is `document.body`.
   * Measured defect this fixes: with the tooltip left in `svg.parentNode`, its
   * containing block was the `position:fixed` overlay while `left`/`top` were SVG user
   * units, and the live bubble rendered at (340, 74) for a pointer at (865, 603) —
   * the top-left corner of the screen.
   *
   * Falls back to the host container (`position:absolute`, user units) when there is
   * no real document element to measure against, which is what keeps the in-process
   * DOM doubles working.
   */
  const svgRect = typeof svg.getBoundingClientRect === "function" ? svg.getBoundingClientRect() : null;
  const docBody = doc !== null && doc !== undefined ? doc.body : null;
  const fixed =
    svgRect !== null &&
    svgRect !== undefined &&
    Number.isFinite(svgRect.width) &&
    Number.isFinite(svgRect.height) &&
    svgRect.width > 0 &&
    svgRect.height > 0 &&
    docBody !== null &&
    docBody !== undefined &&
    typeof docBody.appendChild === "function";
  if (fixed) {
    tooltip.setAttribute(CHART_INTERACTION.tooltipFixedAttr, "1");
    docBody.appendChild(tooltip);
  } else {
    host.appendChild(tooltip);
  }

  /**
   * The current geometry's hit targets.
   * @returns the targets (empty when there is no geometry).
   */
  function currentTargets() {
    return buildHitTargets(state?.geometry, { mode });
  }

  /**
   * Append one `label … value` line — one metric per line, which is the layout the
   * user asked for ("输入一行、输出一行") and the reason a long day no longer packs
   * four figures into a single wrapped sentence.
   * @param parent - the element to append to.
   * @param label - the field label.
   * @param value - the formatted figure.
   * @returns the appended line.
   */
  function appendField(parent, label, value) {
    const line = makeElement("div", CHART_INTERACTION.tooltipRowClass);
    line.appendChild(makeElement("span", CHART_INTERACTION.tooltipModelClass, label));
    line.appendChild(makeElement("span", CHART_INTERACTION.tooltipValueClass, value));
    parent.appendChild(line);
    return line;
  }

  /**
   * Repaint the tooltip DOM from one model: date, then one block per model with one
   * line per metric, then the totals block when several models shared the day.
   * @param model - a {@link tooltipModel} result.
   */
  function paint(model) {
    title.textContent = model.date;
    while (body.firstChild !== null && body.firstChild !== undefined) body.removeChild(body.firstChild);
    for (const row of model.models) {
      const block = makeElement("div", CHART_INTERACTION.tooltipBlockClass);
      block.setAttribute("data-model", row.model);
      block.appendChild(makeElement("div", CHART_INTERACTION.tooltipNameClass, row.model));
      for (const field of tooltipFields(row, labels)) {
        const line = appendField(block, field.label, field.value);
        line.setAttribute("data-field", field.key);
      }
      body.appendChild(block);
    }
    if (!model.hasUsage) {
      body.appendChild(makeElement("div", CHART_INTERACTION.tooltipRowClass, labels.none ?? TOOLTIP_LABELS.none));
    } else if (model.models.length > 1) {
      const block = makeElement("div", CHART_INTERACTION.tooltipBlockClass);
      block.setAttribute("data-totals", "1");
      block.appendChild(makeElement("div", CHART_INTERACTION.tooltipNameClass, labels.total ?? TOOLTIP_LABELS.total));
      for (const field of tooltipTotalFields(model.totals, labels)) {
        const line = appendField(block, field.label, field.value);
        line.setAttribute("data-field", field.key);
      }
      body.appendChild(block);
    }
    tooltip.setAttribute(CHART_INTERACTION.indexAttr, String(model.index));
    tooltip.setAttribute("data-day-label", model.date);
  }

  /** Rebuild the hit rects and the active marker for the current state. */
  function render() {
    if (disposed) return;
    if (typeof svg.contains === "function" && !svg.contains(hitLayer)) svg.appendChild(hitLayer);
    if (typeof svg.contains === "function" && !svg.contains(markerLayer)) svg.appendChild(markerLayer);
    for (const rect of rects) detach(rect);
    for (const marker of markers) detach(marker);
    rects = [];
    markers = [];
    for (const target of currentTargets()) {
      const rect = makeSvg("rect", {
        ...hitTargetAttributes(target, activeIndex, { focusable: options.focusable === true }),
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height,
        fill: "transparent",
        "pointer-events": "all",
      });
      hitLayer.appendChild(rect);
      rects.push(rect);
      if (activeIndex !== target.index) continue;
      // The highlight is owned by this binder: it exists even when the renderer's
      // own dots/bars carry no day index.
      const useBar = marker === "bar" && target.barX !== null;
      const markerEl = useBar
        ? makeSvg("rect", {
            ...activeAttributes(true),
            class: CHART_INTERACTION.activeClass,
            [CHART_INTERACTION.indexAttr]: target.index,
            x: target.barX,
            y: target.markerY,
            width: target.barWidth,
            height: target.markerHeight,
            fill: "currentColor",
          })
        : makeSvg("circle", {
            ...activeAttributes(true),
            class: CHART_INTERACTION.activeClass,
            [CHART_INTERACTION.indexAttr]: target.index,
            cx: target.markerX,
            cy: target.markerY,
            r: toPositive(options.markerRadius, 4),
            fill: "currentColor",
          });
      markerLayer.appendChild(markerEl);
      markers.push(markerEl);
    }
    // Best effort: tag renderer-owned elements that already carry a day index.
    if (typeof svg.querySelectorAll === "function") {
      for (const node of svg.querySelectorAll(`[${CHART_INTERACTION.indexAttr}]`)) {
        if (rects.includes(node) || markers.includes(node)) continue;
        const index = Number(typeof node.getAttribute === "function" ? node.getAttribute(CHART_INTERACTION.indexAttr) : Number.NaN);
        const isActive = activeIndex !== null && index === activeIndex;
        node.setAttribute(CHART_INTERACTION.activeAttr, isActive ? "true" : "false");
        node.setAttribute("aria-selected", isActive ? "true" : "false");
      }
    }
  }

  /**
   * Place the tooltip, `position:absolute` inside the host, from user units.
   *
   * This is the pre-existing path and stays the fallback: it is correct only while
   * the host happens to be the containing block at the SVG's user-space origin.
   * @param target - the active hit target (user units).
   */
  function placeAtHost(target) {
    const placement = tooltipPlacement(state?.geometry, { markerX: target.markerX, markerY: target.markerY }, {
      offset: options.offset,
    });
    if (tooltip.style !== null && tooltip.style !== undefined) {
      tooltip.style.left = `${placement.left}px`;
      tooltip.style.top = `${placement.top}px`;
      tooltip.style.transform = placement.transform;
    }
    tooltip.setAttribute("data-side", placement.side);
  }

  /**
   * Place the tooltip at the marker in VIEWPORT pixels.
   *
   * The marker is a user-space coordinate, so it is translated through the SVG's
   * screen CTM first — that is what makes the bubble follow the pointer exactly,
   * including the viewBox scale and the panel's scroll. The bubble is then clamped
   * into the viewport so a day at either end of the axis cannot push it off screen.
   *
   * The clamp only involves the bubble's width once the element has really been laid
   * out (`min-width:150px` guarantees a width or none at all): a measurement taken
   * before layout would be a number about a different box, and centring on it would
   * move the bubble off the pointer — the very defect this function exists to fix.
   * @param target - the active hit target (user units).
   * @returns true when it was placed (false falls back to {@link placeAtHost}).
   */
  function placeAtViewport(target) {
    const anchor = clientPointOf(svg, target.markerX, target.markerY);
    if (anchor === undefined) return false;
    const box = plotBoxOf(state?.geometry);
    const topLeft = clientPointOf(svg, box.left, box.top);
    const bottomRight = clientPointOf(svg, box.right, box.bottom);
    if (topLeft === undefined || bottomRight === undefined) return false;
    const offset = toPositive(options.offset, 12);
    const edge = toPositive(options.edge, 8);
    const flipThreshold = toPositive(options.flipThreshold, 28);
    const side = anchor.y - offset - flipThreshold < topLeft.y ? "bottom" : "top";
    const margin = 8;
    // Clamp against the viewport when one is measurable (every real browser has
    // `innerWidth`); otherwise against the plot's own right edge, which is a LOCAL
    // bound. The SVG's screen box is deliberately NOT used here: it is in viewport
    // coordinates, so mixing it with a local bound would shift the bubble.
    const viewportWidth = Number.isFinite(globalThis.innerWidth) ? globalThis.innerWidth : bottomRight.x + edge;
    const measured = typeof tooltip.getBoundingClientRect === "function" ? tooltip.getBoundingClientRect()?.width : 0;
    const width = Number.isFinite(measured) && measured >= TOOLTIP_MIN_WIDTH ? measured : 0;
    const half = width / 2;
    const lowest = Math.min(bottomRight.x, viewportWidth - margin) - edge;
    const clamped = Math.max(edge, Math.min(anchor.x, Math.max(edge, lowest)));
    const left = half > 0 ? Math.max(margin + half, Math.min(clamped, viewportWidth - margin - half)) : clamped;
    if (tooltip.style !== null && tooltip.style !== undefined) {
      tooltip.style.left = `${round2(left)}px`;
      tooltip.style.top = `${round2(side === "top" ? anchor.y - offset : anchor.y + offset)}px`;
      tooltip.style.transform = side === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)";
    }
    tooltip.setAttribute("data-side", side);
    return true;
  }

  /**
   * Position the tooltip next to the active marker.
   * @param target - the active hit target.
   */
  function place(target) {
    if (fixed && placeAtViewport(target)) return;
    placeAtHost(target);
  }

  /**
   * Open the tooltip for one day index.
   * @param index - the day index (clamped into range).
   * @returns the shown index, or `null`.
   */
  function show(index) {
    if (disposed) return null;
    const targets = currentTargets();
    if (targets.length === 0) {
      hide();
      return null;
    }
    const clamped = index < 0 ? 0 : index > targets.length - 1 ? targets.length - 1 : index;
    const model = tooltipModel(state?.payload, clamped, { labels });
    if (model === null) {
      hide();
      return null;
    }
    activeIndex = clamped;
    visible = true;
    paint(model);
    render();
    place(targets[clamped]);
    setHidden(tooltip, false);
    return clamped;
  }

  /** Close the tooltip and clear the highlight. */
  function hide() {
    if (disposed) return;
    activeIndex = null;
    visible = false;
    setHidden(tooltip, true);
    render();
  }

  /**
   * Pointer position in the SVG's own user coordinate system.
   *
   * The screen CTM is preferred because `clientX/clientY` are viewport pixels while
   * the hit targets are user units, and those differ by the viewBox scale (measured
   * at 1.05 in the live popover). `measure()` stays as the fallback for hosts whose
   * SVG double has no CTM, and `offsetX/offsetY` — which is relative to the EVENT
   * TARGET (an inner `<rect>`, not the SVG) and therefore the wrong origin — is the
   * last resort only.
   * @param event - a pointer event.
   * @returns `{ x, y }`, or `null` when the event carries no coordinates.
   */
  function localPoint(event) {
    if (event === null || event === undefined) return null;
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      const mapped = userPointOf(svg, event.clientX, event.clientY);
      if (mapped !== undefined) return { x: round2(mapped.x), y: round2(mapped.y) };
      const origin = measure() ?? {};
      const left = Number.isFinite(origin.left) ? origin.left : 0;
      const top = Number.isFinite(origin.top) ? origin.top : 0;
      return { x: round2(event.clientX - left), y: round2(event.clientY - top) };
    }
    if (Number.isFinite(event.offsetX) && Number.isFinite(event.offsetY)) {
      return { x: round2(event.offsetX), y: round2(event.offsetY) };
    }
    return null;
  }

  /** Pointer moved over the chart. */
  function onPointerMove(event) {
    const point = localPoint(event);
    if (point === null) return;
    const hit = hitTest(state?.geometry, point.x, point.y, { mode, radius: options.radius, gapTolerance: options.gapTolerance });
    if (hit === null) hide();
    else show(hit.index);
  }

  /** Pointer left the chart. */
  function onPointerLeave() {
    hide();
  }

  /** Keyboard navigation over the same tooltip. */
  function onKeyDown(event) {
    if (event === null || event === undefined) return;
    const key = typeof event.key === "string" ? event.key : "";
    const next = keyboardIndex(state?.geometry, activeIndex, key);
    if (key === "Escape") {
      hide();
      return;
    }
    if (next === null) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    show(next);
  }

  /** Focus opens the tooltip so the keyboard path reaches the same content. */
  function onFocus() {
    if (activeIndex === null) show(0);
  }

  const listeners = [
    [svg, "pointermove", onPointerMove],
    [svg, "pointerleave", onPointerLeave],
    [svg, "pointercancel", onPointerLeave],
    [svg, "mouseleave", onPointerLeave],
    [svg, "keydown", onKeyDown],
    [svg, "focus", onFocus],
    [svg, "blur", onPointerLeave],
  ];
  for (const [target, type, handler] of listeners) {
    if (typeof target.addEventListener === "function") target.addEventListener(type, handler);
  }
  render();

  return {
    /**
     * Adopt new state (geometry/payload) after a re-render — the 7/30-day switch
     * path: the hit targets are rebuilt, so indices keep matching the new window.
     * @param next - `{ geometry, payload }` (partial updates merge).
     * @returns the active index after the update.
     */
    update(next) {
      if (disposed) return activeIndex;
      if (next !== null && next !== undefined && typeof next === "object" && ("geometry" in next || "payload" in next || "marker" in next)) {
        if (next.marker === "bar" || next.marker === "dot") marker = next.marker;
        state = { ...state, ...next };
      } else {
        const read = readState();
        if (read !== null && typeof read === "object") state = read;
      }
      const count = currentTargets().length;
      if (activeIndex !== null && (count === 0 || activeIndex > count - 1)) activeIndex = null;
      if (activeIndex === null) {
        visible = false;
        setHidden(tooltip, true);
        render();
        return null;
      }
      return show(activeIndex);
    },
    /** Open the tooltip for one day index (also the public keyboard entry). */
    show,
    /** Close the tooltip and clear the highlight. */
    hide,
    /** The active day index (`null` when nothing is highlighted). */
    getActiveIndex() {
      return activeIndex;
    },
    /** Whether the tooltip is currently visible. */
    isVisible() {
      return visible;
    },
    /** Unbind every listener and remove the layers this binder created. */
    destroy() {
      if (disposed) return;
      disposed = true;
      for (const [target, type, handler] of listeners) {
        if (typeof target.removeEventListener === "function") target.removeEventListener(type, handler);
      }
      for (const rect of rects) detach(rect);
      for (const marker of markers) detach(marker);
      rects = [];
      markers = [];
      detach(hitLayer);
      detach(markerLayer);
      detach(tooltip);
      activeIndex = null;
      visible = false;
    },
  };
}
