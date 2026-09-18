/**
 * dsh-deepseek-usage — the sidebar-footer balance row (browser half).
 *
 * Seat: the list slot `sidebar.footer.action` (declared by
 * `@deepseek-ai/dsh-client-ui-sidebar`). The sidebar shell renders its foot as
 * `footArea = [footerActions(slot), settingsArea(slot)]`
 * (`dsh-client-ui-sidebar/lib/client.js`: `renderSlot("sidebar.footer.action",
 * { wide })` immediately before `renderSlot("sidebar.settings", { wide })`), so an
 * occupant of this slot is structurally ABOVE the Settings row; this module never
 * touches the sidebar shell.
 *
 * Interaction contract:
 *  - the row body opens the popover through an injected opener (T6's
 *    `src/client/modal.mjs`). The opener is OPTIONAL: when it is not composed the
 *    row shows an inline hint and keeps working — it never throws and never
 *    blanks the row (see {@link createBalanceRow}).
 *  - the refresh button lives inside the row, so its click MUST stop propagation
 *    or it would bubble into the row's own click and open the popover
 *    ({@link refreshClickHandler} — asserted in `tests/ui-row.test.mjs`).
 *  - `wide === false` (the 56px rail) degrades to one icon wrapped in a Tooltip
 *    whose text carries the number ({@link renderBalanceRow}), so the rail keeps
 *    its geometry.
 *
 * COMPOSITION NOTE: inlined verbatim into `lib/client.js`; keep `export ` at line
 * starts and sibling imports confined to the other `src/client/*.mjs` modules
 * (the composer drops those lines because it flattens the modules into one
 * closure). `tests/ui-row.test.mjs` proves the inlined copy did not drift.
 *
 * @module dsh-deepseek-usage/client/row
 */

import { EMPTY_VALUE, PENDING_VALUE, formatMoney, formatRelativeTime, makeTextLookup } from "./format.mjs";
import { ROW_STATES } from "./service.mjs";

/** The slot seat this row occupies (declared by the sidebar shell). */
export const ROW_SLOT = "sidebar.footer.action";

/** The row's cell key inside that list slot. */
export const ROW_ID = "deepseek-usage";

/**
 * Position among the slot's entries (ascending; the shipped `cordis-panel` entry
 * registers at the default 0). A positive order keeps the balance row to its
 * right, so the two entries never trade places.
 */
export const ROW_ORDER = 100;

/** Locale namespace this row reads its `t` seat from (unregistered ⇒ zh fallback). */
export const ROW_LOCALE_NAMESPACE = "deepseek-usage";

/** `data-plugin-css` id of the injected row stylesheet (dedupe key). */
export const ROW_STYLE_ID = "dsh-deepseek-usage-row";

/**
 * Row stylesheet. Injected once from the browser half because this package has no
 * CSS build step; every color is a shell THEME TOKEN (no literal, so light and dark
 * both work), verified against the shell's own vocabulary in `tests/ui-row.test.mjs`.
 * No `url(...)`, no `@import`, no external origin.
 *
 * Layout: the slot's contributions are flex ITEMS of the shell's `.footerActions`
 * row, so by default this row shares that row with every other plugin's button
 * (the user's report: "和其他按钮一排"). Measured in the shell itself —
 * `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js`:
 *
 *   - CSS block at line 28 (the package's injected stylesheet):
 *       `.hHd-Xa_settingsArea,.hHd-Xa_footerActions{flex:none;width:100%;min-width:0}`
 *       `.hHd-Xa_footerActions{display:flex}`               ← the contributions' row
 *       `.hHd-Xa_footArea{flex-direction:column;flex:none;display:flex}`
 *       `.hHd-Xa_collapsed .hHd-Xa_footerActions{justify-content:center;width:auto;display:flex}`
 *       `.hHd-Xa_collapsed .hHd-Xa_footArea{align-items:center}`
 *   - DOM at lines 293-301: `footArea > [footerActions(renderSlot "sidebar.footer.action"), settingsArea]`
 *
 * So the fix is not "make the wrapper a block": it is to give this item a FULL flex
 * basis and let the shell's row wrap, which is why `flex:1 0 100%` sits on each of
 * this component's possible roots and the container rule below adds `flex-wrap`.
 *
 * WHY THE CONTAINER RULE MATCHES DESCENDANTS, NOT DIRECT CHILDREN (measured in a real
 * browser, 2026-09-17): an earlier revision scoped the rule with `:has(> …)`, on the
 * assumption that a slot contribution is a DIRECT child of `.footerActions`. It is not.
 * The slot renderer inserts an extra element between them whose computed style is
 * `display:contents` — so our row is still a flex ITEM of `.footerActions` (that is what
 * `display:contents` does), but it is not that container's child, and `:has(> …)` never
 * matched. The rule therefore never applied, `flex-wrap` stayed `nowrap`, and the 100%
 * basis could not move the row to a line of its own: the live DOM showed
 * `.footerActions{display:flex;flex-wrap:nowrap;width:256px}` with our row rendered on
 * the same line as another plugin's chip. Dropping the `>` fixes it without depending on
 * how deep the slot wraps us. The rule re-asserts `width:100%` because the collapsed rail
 * sets `width:auto` — without a definite width the rail's 100% basis would degrade to
 * content size. The rail keeps its centering (`justify-content:center` stays the shell's).
 * Class names are matched by substring (`[class*="footerActions"]`) because the shell's
 * prefix is a build hash (`hHd-Xa_footerActions`).
 */
export const ROW_CSS = [
  ".dsh-deepseek-usage-row{flex:1 0 100%;min-width:0;max-width:100%;display:flex;align-items:center;gap:6px;",
  "box-sizing:border-box;padding:6px 8px;border:0;border-radius:10px;background:transparent;",
  "color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;cursor:pointer;text-align:left}",
  ".dsh-deepseek-usage-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".dsh-deepseek-usage-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
  ".dsh-deepseek-usage-row[data-state='unconfigured'],.dsh-deepseek-usage-row[data-state='error']{",
  "color:var(--dsw-alias-label-secondary)}",
  ".dsh-deepseek-usage-glyph{flex:none;display:inline-grid;place-items:center;width:16px;height:16px}",
  ".dsh-deepseek-usage-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dsh-deepseek-usage-amount{flex:none;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}",
  ".dsh-deepseek-usage-detail{color:var(--dsw-alias-label-tertiary)}",
  ".dsh-deepseek-usage-refresh{flex:none;display:grid;place-items:center;width:28px;height:28px;padding:0;",
  "border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
  ".dsh-deepseek-usage-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
  // The shell dims a disabled button with `opacity` (`.button:disabled{opacity:.4}`)
  // rather than with a colour: `--dsw-alias-label-dimmed` measures 1.26:1 against the
  // light sidebar base, i.e. effectively invisible, so it is not used here.
  ".dsh-deepseek-usage-refresh:disabled{opacity:.5;cursor:default}",
  ".dsh-deepseek-usage-refresh[data-retry='1']{display:inline-flex;align-items:center;gap:4px;width:auto;height:22px;",
  "padding:0 8px;font-size:12px;white-space:nowrap}",
  ".dsh-deepseek-usage-block{flex:1 0 100%;min-width:0;max-width:100%}",
  ".dsh-deepseek-usage-hint{display:block;padding:0 8px 2px;color:var(--dsw-alias-label-tertiary);",
  "font-size:11px;line-height:15px;word-break:break-word}",
  ".dsh-deepseek-usage-rail{flex:1 0 100%;display:flex;align-items:center;justify-content:center}",
  ".dsh-deepseek-usage-rail-button{display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;",
  "border-radius:50%;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}",
  ".dsh-deepseek-usage-rail-button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".dsh-deepseek-usage-rail-button[data-state='unconfigured'],.dsh-deepseek-usage-rail-button[data-state='error']{",
  "color:var(--dsw-alias-label-secondary)}",
  "[class*='footerActions']:has(.dsh-deepseek-usage-row),",
  "[class*='footerActions']:has(.dsh-deepseek-usage-block),",
  "[class*='footerActions']:has(.dsh-deepseek-usage-rail){flex-wrap:wrap;width:100%}",
  ".dsh-deepseek-usage-spin{animation:dsh-deepseek-usage-spin 1s linear infinite}",
  "@keyframes dsh-deepseek-usage-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}",
].join("");

/**
 * The built-in (Simplified-Chinese) copy. The slot's `t` seat wins whenever it
 * resolves a key; `makeTextLookup` implements that precedence.
 */
export const ROW_DICTIONARY = Object.freeze({
  "row.label": "DeepSeek 余额",
  "row.loading": "余额加载中",
  "row.unconfigured": "未配置 API key",
  "row.unconfigured.detail": "在设置页填写 DeepSeek API key",
  "row.error": "余额读取失败",
  "row.refresh": "刷新余额",
  "row.retry": "重试",
  "row.rail.hint": "点击查看用量详情",
  "row.cached": "缓存",
  "row.updated": "更新",
  "row.modalMissing": "用量弹层尚未装配",
  "row.modalMissing.detail": "（src/client/modal.mjs 未内联进 lib/client.js）",
});

/**
 * A text lookup bound to this row's dictionary.
 * @param t - optional locale seat.
 * @returns the `text(key)` lookup (never throws).
 */
export function rowText(t) {
  return makeTextLookup(t, ROW_DICTIONARY);
}

/**
 * Inject the row stylesheet once per document.
 * @param doc - the owning document (absent in node, where this is a no-op).
 * @returns true when a new `<style>` was appended.
 */
export function ensureRowStyles(doc) {
  if (doc === undefined || doc === null || typeof doc.createElement !== "function") return false;
  const selector = `style[data-plugin-css="${ROW_STYLE_ID}"]`;
  if (typeof doc.querySelector === "function" && doc.querySelector(selector) !== null) return false;
  const style = doc.createElement("style");
  style.setAttribute("data-plugin-css", ROW_STYLE_ID);
  style.textContent = ROW_CSS;
  const host = doc.head ?? doc.body ?? doc.documentElement;
  if (host === undefined || host === null || typeof host.appendChild !== "function") return false;
  host.appendChild(style);
  return true;
}

/**
 * Click handler for the refresh button.
 *
 * It stops propagation FIRST and unconditionally: the row body's own handler
 * opens the popover, so an un-stopped click would both refresh and open (the
 * regression this task exists to prevent).
 *
 * @param onRefresh - the refresh action.
 * @returns the DOM event handler.
 */
export function refreshClickHandler(onRefresh) {
  return function handleRefreshClick(event) {
    if (event !== undefined && event !== null && typeof event.stopPropagation === "function") event.stopPropagation();
    if (typeof onRefresh === "function") onRefresh();
  };
}

/**
 * Click handler for the row body (and the rail icon): opens the popover.
 * @param onOpen - the open action.
 * @returns the DOM event handler.
 */
export function rowClickHandler(onOpen) {
  return function handleRowClick() {
    if (typeof onOpen === "function") onOpen();
  };
}

/**
 * Keyboard handler: Enter/Space activate the row like a click.
 * @param onOpen - the open action.
 * @returns the keydown handler.
 */
export function keyActivateHandler(onOpen) {
  return function handleRowKeyDown(event) {
    if (event === undefined || event === null) return;
    const key = event.key;
    if (key !== "Enter" && key !== " " && key !== "Spacebar") return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof onOpen === "function") onOpen();
  };
}

/**
 * Map one row state onto its visible copy and flags — the four states the
 * acceptance criteria name (loading / ready / unconfigured / error), each with
 * its own headline, amount and retry affordance.
 * @param status - a {@link ROW_STATES} value.
 * @param snapshot - the service result that produced the state (absent while loading).
 * @param text - the `text(key)` lookup.
 * @param nowMs - the caller's clock (for the freshness line).
 * @returns the view model consumed by {@link renderBalanceRow}.
 */
export function describeState(status, snapshot, text, nowMs) {
  const at = snapshot !== null && typeof snapshot === "object" ? snapshot : {};
  const at0 = typeof nowMs === "number" ? nowMs : Date.now();
  const label = text("row.label");
  if (status === ROW_STATES.ready) {
    const amountText = formatMoney(at.totalBalance, at.currency);
    const fresh = formatRelativeTime(at.fetchedAt, at0);
    const detail = [fresh === EMPTY_VALUE ? "" : `${fresh}${text("row.updated")}`, at.cached === true ? text("row.cached") : ""]
      .filter((part) => part !== "")
      .join(" · ");
    return {
      status: ROW_STATES.ready,
      tone: "ready",
      headline: label,
      amountText,
      detail,
      tooltip: `${label} ${amountText}${detail === "" ? "" : ` · ${detail}`}`,
      retryLabel: text("row.refresh"),
      busy: false,
      retryable: true,
      refreshable: true,
    };
  }
  if (status === ROW_STATES.unconfigured) {
    const detail = text("row.unconfigured.detail");
    const headline = text("row.unconfigured");
    return {
      status: ROW_STATES.unconfigured,
      tone: "warning",
      headline,
      amountText: EMPTY_VALUE,
      detail,
      tooltip: `${label} · ${headline} · ${detail}`,
      retryLabel: text("row.retry"),
      busy: false,
      retryable: true,
      refreshable: true,
    };
  }
  if (status === ROW_STATES.error) {
    const headline = text("row.error");
    const detail = typeof at.message === "string" && at.message !== "" ? at.message : "";
    const snapshotFresh = detail === "" ? "" : `（${typeof at.code === "string" && at.code !== "" ? `${at.code} · ` : ""}${detail}）`;
    return {
      status: ROW_STATES.error,
      tone: "warning",
      headline,
      amountText: EMPTY_VALUE,
      detail: snapshotFresh,
      tooltip: `${label} · ${headline}${snapshotFresh === "" ? "" : ` ${snapshotFresh}`} · ${text("row.retry")}`,
      retryLabel: text("row.retry"),
      busy: false,
      retryable: true,
      refreshable: true,
    };
  }
  const headline = text("row.loading");
  return {
    status: ROW_STATES.loading,
    tone: "muted",
    headline,
    amountText: PENDING_VALUE,
    detail: "",
    tooltip: `${label} · ${headline}`,
    retryLabel: text("row.refresh"),
    busy: true,
    retryable: false,
    refreshable: false,
  };
}

/**
 * Wrap one element in the shell's Tooltip when the primitive is available, and
 * fall back to the native `title` affordance when it is not.
 * @param deps - row dependencies (`{ React, Tooltip }`).
 * @param label - the tooltip text.
 * @param child - the element to wrap.
 * @returns the (possibly wrapped) element.
 */
export function wrapWithTooltip(deps, label, child) {
  const { React, Tooltip } = deps;
  if (typeof Tooltip !== "function") return child;
  return React.createElement(Tooltip, { label, side: "top", delayMs: 400, children: child });
}

/**
 * Build the row's glyph: the primitive icon when available, a text fallback
 * otherwise (so a shell without `dsh-client-ui-primitives` still renders).
 * @param deps - row dependencies (`{ React, icons }`).
 * @param view - the view model.
 * @param key - React key to carry (the glyph travels inside a children array).
 * @returns a React element.
 */
export function renderGlyph(deps, view, key) {
  const { React, icons = {} } = deps;
  const wrap = (node) => React.createElement("span", { className: "dsh-deepseek-usage-glyph", "aria-hidden": "true", key }, [node]);
  if (view.status === ROW_STATES.loading && typeof icons.loading === "function") {
    return React.createElement("span", { className: "dsh-deepseek-usage-glyph dsh-deepseek-usage-spin", "aria-hidden": "true", key }, [
      React.createElement(icons.loading, { key: "icon", size: 14 }),
    ]);
  }
  if ((view.status === ROW_STATES.error || view.status === ROW_STATES.unconfigured) && typeof icons.warning === "function") {
    return wrap(React.createElement(icons.warning, { key: "icon", size: 14 }));
  }
  if (view.status === ROW_STATES.ready && typeof icons.balance === "function") {
    return wrap(React.createElement(icons.balance, { key: "icon", size: 14 }));
  }
  const fallback = view.status === ROW_STATES.loading ? PENDING_VALUE : view.status === ROW_STATES.ready ? "◈" : "!";
  return React.createElement("span", { className: "dsh-deepseek-usage-glyph", "aria-hidden": "true", key }, fallback);
}

/**
 * Build the refresh button (wide layout). In the two failure states the button
 * carries the visible retry label, so "可重试" is readable without hovering.
 * @param deps - row dependencies (`{ React, icons }`).
 * @param view - the view model (carries `retryLabel`, `busy`, `onRefresh`).
 * @param key - React key to carry.
 * @returns a React element.
 */
export function renderRefreshButton(deps, view, key) {
  const { React, icons = {} } = deps;
  const glyph =
    typeof icons.refresh === "function"
      ? React.createElement(icons.refresh, { key: "icon", size: 14 })
      : React.createElement("span", { "aria-hidden": "true", key: "icon" }, "↻");
  const showLabel = view.status === ROW_STATES.error || view.status === ROW_STATES.unconfigured;
  const children = showLabel ? [glyph, React.createElement("span", { key: "retry" }, view.retryLabel)] : [glyph];
  return React.createElement(
    "button",
    {
      type: "button",
      key,
      className: "dsh-deepseek-usage-refresh",
      "data-dsh-usage-refresh": ROW_ID,
      "data-retry": showLabel ? "1" : "0",
      "aria-label": view.retryLabel,
      title: view.retryLabel,
      disabled: view.busy === true,
      onClick: refreshClickHandler(view.onRefresh),
    },
    children,
  );
}

/**
 * Render the row for one view model. Pure: no hooks, no side effects, so the
 * four states are asserted directly in tests.
 * @param deps - row dependencies (`{ React, Tooltip, icons }`).
 * @param view - the view model from {@link describeState}, plus `wide`/`hint`/`onRefresh`/`onOpen`.
 * @returns a React element.
 */
export function renderBalanceRow(deps, view) {
  const { React } = deps;
  if (view.wide === false) {
    const button = React.createElement(
      "button",
      {
        type: "button",
        className: "dsh-deepseek-usage-rail-button",
        "data-dsh-usage-rail": ROW_ID,
        "data-state": view.status,
        "aria-label": view.tooltip,
        title: view.tooltip,
        onClick: rowClickHandler(view.onOpen),
      },
      renderGlyph(deps, view, undefined),
    );
    return React.createElement("div", { className: "dsh-deepseek-usage-rail" }, wrapWithTooltip(deps, view.tooltip, button));
  }
  const row = React.createElement(
    "div",
    {
      className: "dsh-deepseek-usage-row",
      "data-dsh-usage-row": ROW_ID,
      "data-state": view.status,
      role: "button",
      tabIndex: 0,
      "aria-label": view.tooltip,
      title: view.detail === "" ? view.tooltip : `${view.tooltip}\n${view.detail}`,
      onClick: rowClickHandler(view.onOpen),
      onKeyDown: keyActivateHandler(view.onOpen),
    },
    [
      renderGlyph(deps, view, "glyph"),
      React.createElement("span", { className: "dsh-deepseek-usage-label", key: "label" }, view.headline),
      React.createElement(
        "span",
        { className: "dsh-deepseek-usage-amount", key: "amount", "data-dsh-usage-amount": ROW_ID },
        view.amountText,
      ),
      renderRefreshButton(deps, view, "refresh"),
    ],
  );
  if (typeof view.hint !== "string" || view.hint === "") return row;
  return React.createElement("div", { className: "dsh-deepseek-usage-block" }, [
    row,
    React.createElement("span", { className: "dsh-deepseek-usage-hint", key: "hint" }, view.hint),
  ]);
}

/**
 * Build the `sidebar.footer.action` occupant.
 *
 * The component owns one read lifecycle: an initial read on mount, a forced read
 * on refresh/retry, and a generation guard so a slow first read cannot overwrite
 * a newer one. It never throws: a rejected read, a missing popover opener, and a
 * throwing opener all degrade into visible copy.
 *
 * @param deps - row dependencies.
 * @param deps.React - the shell's React (from the bundle factory's `require`).
 * @param deps.service - the balance service (`src/client/service.mjs`).
 * @param deps.resolveModal - returns the popover opener, or `undefined` when T6's
 *   `src/client/modal.mjs` is not composed into this bundle.
 * @param deps.Tooltip - optional Tooltip primitive.
 * @param deps.icons - optional icon primitives.
 * @param deps.document - optional document used to inject the stylesheet.
 * @param deps.now - optional clock.
 * @returns the React component registered on `sidebar.footer.action`.
 */
export function createBalanceRow(deps) {
  const { React, service, resolveModal, now } = deps;
  ensureRowStyles(deps.document);
  return function BalanceRow(props) {
    const wide = props === null || props === undefined || props.wide !== false;
    const t = props !== null && props !== undefined && typeof props.t === "function" ? props.t : undefined;
    const text = rowText(t);
    const [snapshot, setSnapshot] = React.useState({ state: ROW_STATES.loading });
    const [hint, setHint] = React.useState("");
    const generation = React.useRef(0);
    const load = React.useCallback(function load(force) {
      const ticket = generation.current + 1;
      generation.current = ticket;
      setHint("");
      setSnapshot({ state: ROW_STATES.loading });
      let pending;
      try {
        pending = service.read({ force: force === true });
      } catch (error) {
        // A synchronously throwing service must not take the render (or the click
        // handler) down with it.
        setSnapshot({ state: ROW_STATES.error, code: "internal", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      Promise.resolve(pending).then(
        function onResult(result) {
          if (generation.current !== ticket) return;
          setSnapshot(result !== null && typeof result === "object" ? result : { state: ROW_STATES.error, message: "宿主返回了空结果" });
        },
        function onFailure(error) {
          if (generation.current !== ticket) return;
          setSnapshot({ state: ROW_STATES.error, code: "internal", message: error instanceof Error ? error.message : String(error) });
        },
      );
    }, []);
    React.useEffect(function onMount() {
      load(false);
      return function onUnmount() {
        generation.current += 1;
      };
    }, [load]);
    const status = snapshot !== null && typeof snapshot === "object" && typeof snapshot.state === "string" ? snapshot.state : ROW_STATES.loading;
    const view = describeState(status, snapshot, text, typeof now === "function" ? now() : Date.now());
    view.wide = wide;
    view.hint = hint;
    view.onRefresh = function onRefresh() {
      load(true);
    };
    view.onOpen = function onOpen() {
      const opener = typeof resolveModal === "function" ? resolveModal() : undefined;
      if (typeof opener !== "function") {
        setHint(`${text("row.modalMissing")} ${text("row.modalMissing.detail")}`);
        return;
      }
      try {
        opener({ snapshot, wide, service });
      } catch (error) {
        setHint(`${text("row.modalMissing")} ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    return renderBalanceRow(deps, view);
  };
}
