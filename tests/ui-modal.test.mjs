/**
 * dsh-deepseek-usage — browser-half tests for the popover (T6).
 *
 * What this suite freezes:
 *
 *  1. `chart.mjs` is pure geometry: empty series, one point, an all-zero window and
 *     a 1e12-token day must all produce finite, in-box, monotonic geometry —
 *     asserted as invariants, never as pixels.
 *  2. `modal.mjs`'s view models: the balance card carries the host's data time and
 *     its cache marker; the usage panel carries the 7/30 window, the model table and
 *     the STATIC estimate label (the frozen `/usage` envelope whitelists six fields
 *     and carries no "this is an estimate" flag).
 *  3. `modal.mjs` owns no transport: every read goes through the shipped
 *     `service.mjs` (`read` for the card, `readUsage` for the charts), so the
 *     relative-path / same-origin / no-credential invariants live in one place.
 *  4. its DOM behaviour on a minimal fake DOM (no jsdom, no new dependency): the
 *     overlay mounts on `document.body`, `#root` goes `inert`, ESC and a backdrop
 *     click close, focus is trapped and returned, and the platform entry opens a NEW
 *     WINDOW (there is no iframe anywhere in the browser half).
 *  5. the composed CLASSIC-script bundle: `chart.mjs` + `modal.mjs` are inlined
 *     byte-for-byte, the file still parses as a classic script, and running it
 *     registers the bundle, builds the row, and opens the real popover through the
 *     `setModalFactory` wiring.
 *
 * Run with the portable Node (PATH's v22 produces false reds):
 *   node --test tests/ui-modal.test.mjs
 *
 * @module dsh-deepseek-usage/tests/ui-modal
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  CHART_INTERACTION,
  CHART_INTERACTION_CSS,
  CHART_METRICS,
  COST_CURRENCY,
  DEFAULT_CHART_SIZE,
  MAX_BAR_WIDTH,
  MIN_BAR_WIDTH,
  SVG_NAMESPACE,
  UNKNOWN_MODEL,
  Y_TICK_COUNT,
  buildChartGeometry,
  clamp01,
  costOf,
  formatMetricValue,
  niceCeil,
  projectSeries,
  round2,
  summarizeUsage,
  toCount,
  tooltipModel,
} from "../src/client/chart.mjs";
import {
  DEFAULT_USAGE_DAYS,
  MODAL_ATTR,
  MODAL_CSS,
  MODAL_DICTIONARY,
  MODAL_ID,
  MODAL_ROOT_ID,
  MODAL_STATES,
  MODAL_STYLE_ID,
  MODAL_STYLE_TEXT,
  PLATFORM_USAGE_URL,
  USAGE_DAYS_MAX,
  USAGE_DAYS_MIN,
  USAGE_WINDOWS,
  attachChartInteractions,
  collectFocusable,
  createUsageModalOpener,
  describeBalanceCard,
  describeModalModel,
  describeUsagePanel,
  ensureModalStyles,
  modalText,
  normalizeDays,
  openPlatformUsage,
  openUsageModal,
  renderModalPanel,
  restoreRootInert,
  setRootInert,
  shortDayLabel,
} from "../src/client/modal.mjs";
import * as chartModule from "../src/client/chart.mjs";
import * as modalModule from "../src/client/modal.mjs";
import {
  createBalanceService,
  messageForCode,
  normalizeBalancePayload,
  normalizeFailurePayload,
  normalizeUsagePayload,
} from "../src/client/service.mjs";
import { ROW_ID } from "../src/client/row.mjs";
import { createUsageReader as createHostUsageReader, makeRoutes, ROUTES } from "../src/host/routes.mjs";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE_PATH = join(PACKAGE_ROOT, "lib", "client.js");
const CLIENT_SOURCES = ["format.mjs", "service.mjs", "row.mjs", "index.mjs", "chart.mjs", "modal.mjs"];
const NEW_SOURCES = ["chart.mjs", "modal.mjs"];
const ISO_MS = Date.parse("2026-09-17T20:31:05");
const ISO = new Date(ISO_MS).toISOString();

/**
 * The installed shell — the ONLY authority on which `--dsw-*` names exist and what
 * they resolve to. Same resolution rule the other suites use:
 * `DSH_RUNTIME_ROOT` first, then the portable install on this machine.
 */
const RUNTIME_ROOT = process.env.DSH_RUNTIME_ROOT ?? "C:\\Users\\Administrator\\AppData\\Local\\DSH-Portable\\runtime";
const SHELL_ASSETS = join(RUNTIME_ROOT, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "assets");
const SHELL_THEME = join(RUNTIME_ROOT, "node_modules", "@deepseek-ai", "dsh-client-ui-theme", "lib", "client.js");

/**
 * The tokens this popover is allowed to use, as a fallback for a machine without the
 * installed shell. When the shell IS present the suite asserts this list is a subset of
 * the shell's own vocabulary, so the fallback can never drift into fiction.
 */
const SHELL_TOKEN_FALLBACK = [
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-layer-3",
  "--dsw-alias-bg-mask-1",
  "--dsw-alias-border-l2",
  "--dsw-alias-border-l3",
  "--dsw-alias-brand-primary",
  "--dsw-alias-button-ghost-active-fill",
  "--dsw-alias-button-primary-fill",
  "--dsw-alias-button-primary-hover",
  "--dsw-elevation-prominent",
  "--dsw-elevation-stroke-color",
  "--dsw-font-family",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-primary-foreground",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-warn-primary",
  "--dsw-mask-blur",
];

/** The three names an earlier revision referenced; none of them exists in the shell. */
const DEAD_TOKENS = ["--dsw-alias-bg-elevated", "--dsw-alias-border-secondary", "--dsw-alias-status-warning"];

/**
 * The shell's compiled stylesheet (its own vocabulary: every `--dsw-*` name the shell
 * itself consumes). The asset filename carries a build hash, so it is discovered.
 * @returns the stylesheet text, or `undefined` when the shell is not installed.
 */
function shellStyleSheet() {
  if (!existsSync(SHELL_ASSETS)) return undefined;
  const candidate = readdirSync(SHELL_ASSETS).find((name) => /^index-.*\.css$/.test(name));
  return candidate === undefined ? undefined : readFileSync(join(SHELL_ASSETS, candidate), "utf8");
}

/**
 * The vocabulary of token names the shell consumes.
 * @returns `{ names, source }` — `source` is the stylesheet path, or "fallback".
 */
function shellTokenVocabulary() {
  const css = shellStyleSheet();
  if (css === undefined) return { names: new Set(SHELL_TOKEN_FALLBACK), source: "fallback" };
  return { names: new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((match) => match[0])), source: SHELL_ASSETS };
}

/**
 * Every `--dsw-*` name a CSS string references.
 * @param css - the stylesheet text.
 * @returns the sorted unique names.
 */
function cssTokenNames(css) {
  return [...new Set([...String(css).matchAll(/--dsw-[a-z0-9-]+/g)].map((match) => match[0]))].sort();
}

/**
 * Literal colours in a stylesheet — the thing that breaks the other theme.
 * @param css - the stylesheet text.
 * @returns the sorted unique literals (empty is the only acceptable answer).
 */
function cssColorLiterals(css) {
  return [...new Set([...String(css).matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g)].map((match) => match[0]))].sort();
}

/**
 * Parse the shell's theme bundle into per-theme token maps.
 *
 * The shell writes its palette as `:root{--dsw-static-…}`, `body{--dsw-alias-…}` (light)
 * and `body[data-ds-dark-theme]{--dsw-alias-…}` (dark); values are often
 * `var(--dsw-static-…)`, so lookups resolve the chain.
 * @returns `{ root, light, dark, available }`.
 */
function resolveThemeTokens() {
  if (!existsSync(SHELL_THEME)) return { root: new Map(), light: new Map(), dark: new Map(), available: false };
  const text = readFileSync(SHELL_THEME, "utf8");
  const root = new Map();
  const light = new Map();
  const dark = new Map();
  for (const match of text.matchAll(/([^{}]{0,80})\{([^{}]*--dsw-[^{}]*)\}/g)) {
    const selector = match[1].trim();
    const declarations = new Map();
    for (const decl of match[2].split(";")) {
      const at = decl.indexOf(":");
      if (at === -1) continue;
      const name = decl.slice(0, at).trim();
      if (name.startsWith("--dsw-")) declarations.set(name, decl.slice(at + 1).trim());
    }
    const target = selector.includes("data-ds-dark-theme") ? dark : selector === "body" ? light : root;
    for (const [name, value] of declarations) target.set(name, value);
  }
  return { root, light, dark, available: true };
}

/**
 * Resolve one token inside one theme (following `var()` chains).
 * @param theme - a `{ root, light, dark }` bundle.
 * @param which - `"light"` or `"dark"`.
 * @param name - the token name.
 * @returns the value, or `undefined`.
 */
function resolveTokenValue(theme, which, name) {
  const own = which === "dark" ? theme.dark : theme.light;
  const seen = new Set();
  // Look in the theme's OWN map first: both blocks redefine the `--dsw-static-*` palette,
  // so consulting the dark map while resolving a light value silently mixes themes.
  const lookup = (token) => own.get(token) ?? theme.light.get(token) ?? theme.root.get(token);
  let value = lookup(name);
  while (typeof value === "string" && value.trim().startsWith("var(")) {
    const inner = /var\(\s*(--dsw-[a-z0-9-]+)/.exec(value);
    if (inner === null || seen.has(inner[1])) return undefined;
    seen.add(inner[1]);
    value = lookup(inner[1]);
  }
  return value;
}

/**
 * Parse a CSS colour value into RGBA.
 * @param value - `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`.
 * @returns `{ r, g, b, a }`, or `undefined`.
 */
function parseColor(value) {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(raw);
  if (short !== null) {
    const [r, g, b] = short[1].split("").map((digit) => parseInt(digit + digit, 16));
    return { r, g, b, a: 1 };
  }
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(raw);
  if (long !== null) {
    const int = parseInt(long[1], 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: long[2] === undefined ? 1 : parseInt(long[2], 16) / 255 };
  }
  const fn = /rgba?\(([^)]+)\)/i.exec(raw);
  if (fn !== null) {
    const parts = fn[1].split(",").map((part) => Number(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return undefined;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined || !Number.isFinite(parts[3]) ? 1 : parts[3] };
  }
  return undefined;
}

/** Composite a possibly translucent colour over an opaque background. */
function overColor(fg, bg) {
  return { r: fg.a * fg.r + (1 - fg.a) * bg.r, g: fg.a * fg.g + (1 - fg.a) * bg.g, b: fg.a * fg.b + (1 - fg.a) * bg.b, a: 1 };
}

/** WCAG relative luminance. */
function relativeLuminance(color) {
  const channel = (raw) => {
    const value = raw / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG contrast ratio, compositing translucency first. */
function contrastRatio(fgRaw, bgRaw) {
  const bg = bgRaw.a === 1 ? bgRaw : overColor(bgRaw, { r: 255, g: 255, b: 255, a: 1 });
  const fg = fgRaw.a === 1 ? fgRaw : overColor(fgRaw, bg);
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const BALANCE_BODY = Object.freeze({
  ok: true,
  currency: "CNY",
  totalBalance: 12.3,
  grantedBalance: 2,
  toppedUpBalance: 10.3,
  isAvailable: true,
  fetchedAt: ISO,
  cached: true,
});

/** A two-day, two-model usage envelope, shaped exactly like the host's. */
const USAGE_BODY = Object.freeze({
  ok: true,
  requestedDays: 7,
  days: [
    {
      date: "2026-09-16",
      models: [
        { model: "deepseek-flash", inputTokens: 1000, cacheReadTokens: 4000, outputTokens: 500, estimatedCostCny: 0.0012 },
        { model: "deepseek-v4-pro", inputTokens: 200, cacheReadTokens: 100, outputTokens: 50, estimatedCostCny: 0.02 },
      ],
    },
    {
      date: "2026-09-17",
      models: [{ model: "deepseek-flash", inputTokens: 3000, cacheReadTokens: 100, outputTokens: 700, estimatedCostCny: 0.0042 }],
    },
  ],
  generatedAt: ISO,
  truncated: false,
  totals: { inputTokens: 4200, cacheReadTokens: 4200, outputTokens: 1250, estimatedCostCny: 0.0254 },
});

/** Collapse whitespace: the composed/source equivalence check ignores it. */
function stripWs(text) {
  return String(text).replace(/\s+/g, "");
}

/**
 * Remove `//` and block comments with a small scanner, so the "no transport / no key"
 * assertions talk about the EXECUTABLE half rather than about documentation.
 * @param text - JavaScript source.
 * @returns the source without comments.
 */
function stripJsComments(text) {
  let out = "";
  let index = 0;
  let state = "code";
  let quote = "";
  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        index += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        index += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        state = "string";
        out += ch;
        index += 1;
        continue;
      }
      out += ch;
      index += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      }
      index += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (ch === "\\") {
      out += ch + (next ?? "");
      index += 2;
      continue;
    }
    if (ch === quote) {
      state = "code";
      out += ch;
      index += 1;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/** Resolve after one macrotask turn (promise callbacks have run). */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait for a real-HTTP round trip to settle: poll the condition across macrotask
 * turns instead of guessing a tick count (a fixed count is a flaky test in disguise).
 * @param check - predicate.
 * @param attempts - maximum turns to wait.
 * @returns the final predicate value.
 */
async function waitFor(check, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) return true;
    await tick();
  }
  return check();
}

/* ================================================================== *
 * 0. A minimal DOM, so the popover's real behaviour can be asserted
 *    without adding jsdom (or any other dependency) to the package.
 * ================================================================== */

/**
 * Parse one compound selector: `tag`, `.class`, `#id`, `[attr]`, `[attr="v"]`.
 * @param text - the compound selector.
 * @returns the parsed parts.
 */
function parseCompound(text) {
  const parts = [];
  let rest = text;
  const tag = /^([a-zA-Z][\w-]*)/.exec(rest);
  if (tag !== null) {
    parts.push({ kind: "tag", value: tag[1].toLowerCase() });
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    let match = /^\.([\w-]+)/.exec(rest);
    if (match !== null) {
      parts.push({ kind: "class", value: match[1] });
      rest = rest.slice(match[0].length);
      continue;
    }
    match = /^#([\w-]+)/.exec(rest);
    if (match !== null) {
      parts.push({ kind: "id", value: match[1] });
      rest = rest.slice(match[0].length);
      continue;
    }
    match = /^\[([\w-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]/.exec(rest);
    if (match !== null) {
      // `[a="v"]` / `[a='v']` / `[a=v]` all mean the same attribute value here.
      const raw = match[3] ?? "";
      parts.push({ kind: "attr", name: match[1], op: match[2] ?? null, value: raw.replace(/^["']|["']$/g, "") });
      rest = rest.slice(match[0].length);
      continue;
    }
    throw new Error(`fake-dom: unsupported selector fragment ${JSON.stringify(rest)} of ${JSON.stringify(text)}`);
  }
  return parts;
}

/**
 * Match one element against parsed compound parts.
 * @param node - the element.
 * @param parts - parsed parts.
 * @returns true on a match.
 */
function matchesParts(node, parts) {
  for (const part of parts) {
    if (part.kind === "tag" && node.tagName.toLowerCase() !== part.value) return false;
    if (part.kind === "id" && node.getAttribute("id") !== part.value) return false;
    if (part.kind === "class") {
      const classes = String(node.getAttribute("class") ?? "").split(/\s+/);
      if (!classes.includes(part.value)) return false;
    }
    if (part.kind === "attr") {
      const value = node.getAttribute(part.name);
      if (value === null) return false;
      if (part.op === null) continue;
      if (part.op === "=" && value !== part.value) return false;
      if (part.op === "*=" && !value.includes(part.value)) return false;
      if (part.op === "!=" && value === part.value) return false;
    }
  }
  return true;
}

/**
 * Test a selector (comma list, descendant combinators) against one element.
 * @param node - the element.
 * @param selector - the selector.
 * @returns true on a match.
 */
function matchesSelector(node, selector) {
  return String(selector)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .some((group) => {
      const chain = group.split(/\s+/).map(parseCompound);
      if (!matchesParts(node, chain[chain.length - 1])) return false;
      let cursor = node.parentNode;
      for (let index = chain.length - 2; index >= 0; index -= 1) {
        let found = false;
        while (cursor !== null && cursor !== undefined) {
          if (matchesParts(cursor, chain[index])) {
            found = true;
            cursor = cursor.parentNode;
            break;
          }
          cursor = cursor.parentNode;
        }
        if (!found) return false;
      }
      return true;
    });
}

/**
 * A minimal Document/Element stand-in: attributes, children, listeners with
 * capture/target/bubble dispatch, `querySelector`, `focus`, `inert`.
 * @returns the fake document.
 */
function createFakeDom() {
  let activeElement = null;

  function makeNode(tagName, namespaceURI = null) {
    return {
      tagName: String(tagName).toUpperCase(),
      namespaceURI,
      attributes: {},
      children: [],
      parentNode: null,
      textContent: "",
      listeners: [],
      inert: false,
      disabled: false,
      isConnected: true,
      style: {},
      get id() {
        return this.attributes.id ?? "";
      },
      setAttribute(name, value) {
        this.attributes[String(name)] = String(value);
      },
      getAttribute(name) {
        const key = String(name);
        return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
      },
      removeAttribute(name) {
        delete this.attributes[String(name)];
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, String(name));
      },
      appendChild(child) {
        if (child.parentNode !== null && child.parentNode !== undefined) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      remove() {
        if (this.parentNode !== null && this.parentNode !== undefined) this.parentNode.removeChild(this);
      },
      addEventListener(type, handler, options) {
        if (typeof handler !== "function") return;
        this.listeners.push({ type, handler, capture: options === true || options?.capture === true });
      },
      removeEventListener(type, handler, options) {
        const capture = options === true || options?.capture === true;
        const index = this.listeners.findIndex((entry) => entry.type === type && entry.handler === handler && entry.capture === capture);
        if (index !== -1) this.listeners.splice(index, 1);
      },
      dispatchEvent(event) {
        return dispatch(this, event);
      },
      querySelector(selector) {
        return queryAll(this, selector)[0] ?? null;
      },
      querySelectorAll(selector) {
        return queryAll(this, selector);
      },
      focus() {
        activeElement = this;
      },
      getBoundingClientRect() {
        return { width: 0, height: 0, top: 0, left: 0 };
      },
    };
  }

  function invoke(node, event, phase) {
    for (const entry of [...node.listeners]) {
      if (entry.type !== event.type) continue;
      if (phase === true && entry.capture !== true) continue;
      if (phase === false && entry.capture === true) continue;
      entry.handler(event);
      if (event.__stopped === true) return;
    }
  }

  function dispatch(target, event) {
    const path = [];
    let cursor = target;
    while (cursor !== null && cursor !== undefined) {
      path.push(cursor);
      cursor = cursor.parentNode;
    }
    event.target = event.target ?? target;
    for (let index = path.length - 1; index >= 1; index -= 1) {
      if (event.__stopped === true) break;
      invoke(path[index], event, true);
    }
    if (event.__stopped !== true) invoke(target, event, null);
    for (let index = 1; index < path.length; index += 1) {
      if (event.__stopped === true) break;
      invoke(path[index], event, false);
    }
    return event.defaultPrevented !== true;
  }

  function queryAll(root, selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(root);
    return found;
  }

  const doc = makeNode("#document");
  const html = makeNode("html");
  const head = makeNode("head");
  const body = makeNode("body");
  doc.appendChild(html);
  html.appendChild(head);
  html.appendChild(body);
  doc.documentElement = html;
  doc.head = head;
  doc.body = body;
  doc.nodeType = 9;
  Object.defineProperty(doc, "activeElement", { get: () => activeElement, configurable: true });
  const openCalls = [];
  const win = {
    open(...args) {
      openCalls.push(args);
      return { closed: false };
    },
    location: { href: "" },
  };
  doc.defaultView = win;
  doc.openCalls = () => openCalls;
  doc.createElement = (tag) => makeNode(tag, null);
  doc.createElementNS = (ns, tag) => makeNode(tag, ns);
  doc.getElementById = (id) => queryAll(doc, `[id="${id}"]`)[0] ?? null;
  return doc;
}

/** The visible text of a tree (the fake DOM has no layout, only text). */
function textOf(node) {
  if (node === null || node === undefined || typeof node !== "object") return "";
  if (node.children.length > 0) return node.children.map(textOf).join(" ");
  return String(node.textContent ?? "");
}

/** Build a fake event with the assertion counters the tests need. */
function fakeEvent(type, extra = {}) {
  const record = { preventDefault: 0, stopPropagation: 0 };
  return {
    record,
    event: {
      type,
      defaultPrevented: false,
      __stopped: false,
      preventDefault() {
        record.preventDefault += 1;
        this.defaultPrevented = true;
      },
      stopPropagation() {
        record.stopPropagation += 1;
        this.__stopped = true;
      },
      ...extra,
    },
  };
}

/** A one-shot JSON response stand-in. */
function jsonResponse(status, body) {
  return {
    status,
    async json() {
      if (body === undefined) throw new SyntaxError("Unexpected token < in JSON at position 0");
      return body;
    },
  };
}

/** A fetch spy that records calls and answers from a handler. */
function fetchSpy(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return { calls, fetchImpl };
}

/** A document with a `#root` mount point (the shell's real one). */
function domWithRoot() {
  const doc = createFakeDom();
  const root = doc.createElement("div");
  root.setAttribute("id", MODAL_ROOT_ID);
  doc.body.appendChild(root);
  return { doc, root };
}

/* ================================================================== *
 * 1. chart.mjs — pure geometry
 * ================================================================== */

test("chart: constants are the module's frozen vocabulary", () => {
  assert.equal(CHART_METRICS.tokens, "totalTokens");
  assert.equal(CHART_METRICS.cost, "estimatedCostCny");
  assert.equal(SVG_NAMESPACE, "http://www.w3.org/2000/svg");
  assert.equal(UNKNOWN_MODEL, "unknown", "the host's placeholder model id (ledger.mjs UNKNOWN_MODEL)");
  assert.ok(DEFAULT_CHART_SIZE.width > 0 && DEFAULT_CHART_SIZE.height > 0);
  assert.ok(Y_TICK_COUNT >= 2);
  assert.ok(MIN_BAR_WIDTH > 0 && MAX_BAR_WIDTH >= MIN_BAR_WIDTH);
});

test("chart: toCount refuses junk instead of poisoning the axis", () => {
  assert.equal(toCount(12), 12);
  assert.equal(toCount("12"), 12);
  assert.equal(toCount(0), 0);
  for (const junk of [undefined, null, "", "  ", "abc", NaN, Infinity, -Infinity, -5, {}, [], true, false]) {
    assert.equal(toCount(junk), 0, `expected 0 for ${String(junk)}`);
  }
  assert.equal(toCount(-0), 0);
});

test("chart: clamp01 and round2 are the geometry's safety net", () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(NaN), 0);
  assert.equal(round2(1.006), 1.01);
  assert.equal(round2(1.005), 1, "1.005 is 1.00499999… in binary, so it rounds down: documented, not hidden");
  assert.equal(round2(-0.001), 0, "no -0 in an attribute");
  assert.equal(round2(3), 3);
});

test("chart: projectSeries mirrors the host's chartSeries", () => {
  const series = projectSeries(USAGE_BODY, CHART_METRICS.tokens);
  assert.equal(series.length, 2);
  assert.equal(series[0].label, "2026-09-16");
  assert.equal(series[0].value, 1000 + 4000 + 500 + 200 + 100 + 50);
  assert.deepEqual(series[1], { label: "2026-09-17", value: 3000 + 100 + 700 });
  assert.deepEqual(projectSeries(USAGE_BODY, CHART_METRICS.cost), [
    { label: "2026-09-16", value: 0.0212 },
    { label: "2026-09-17", value: 0.0042 },
  ]);
  assert.deepEqual(projectSeries({ days: [] }, CHART_METRICS.tokens), []);
  assert.deepEqual(projectSeries(undefined, CHART_METRICS.tokens), []);
  assert.deepEqual(projectSeries({ days: "nope" }, CHART_METRICS.tokens), []);
  assert.deepEqual(projectSeries({ days: [null, { date: 7 }] }, CHART_METRICS.tokens), [
    { label: "", value: 0 },
    { label: "", value: 0 },
  ]);
  assert.deepEqual(projectSeries({ days: [{ date: "d", models: [{ inputTokens: 5 }] }] }, "inputTokens"), [{ label: "d", value: 5 }]);
});

test("chart: niceCeil produces round axis maxima at or above the data", () => {
  assert.equal(niceCeil(0), 0);
  assert.equal(niceCeil(1), 1);
  assert.equal(niceCeil(1.5), 2);
  assert.equal(niceCeil(999), 1000);
  assert.equal(niceCeil(1000), 1000);
  assert.equal(niceCeil(1234), 2000);
  assert.equal(niceCeil(4200), 5000);
  assert.equal(niceCeil(1e12), 1e12);
  assert.equal(niceCeil(-4), 0);
  for (const value of [1, 7, 42, 999, 1234, 987654, 4.2e9, 1e12]) {
    const ceil = niceCeil(value);
    assert.ok(ceil >= value, `${ceil} >= ${value}`);
    assert.ok(Number.isFinite(ceil));
  }
});

test("chart: formatMetricValue keeps costs readable below a cent, in CNY", () => {
  assert.equal(formatMetricValue(12345, CHART_METRICS.tokens), "12.3k");
  assert.equal(formatMetricValue(0, CHART_METRICS.tokens), "0");
  // The cost branch must carry the account's own currency (CNY → ¥), NOT a hardcoded
  // `$`: the host's price table is the Chinese pricing page and the balance is CNY, so
  // a dollar sign here contradicts every other figure in the popover.
  assert.equal(COST_CURRENCY, "CNY");
  assert.equal(formatMetricValue(0, CHART_METRICS.cost), "¥0");
  assert.equal(formatMetricValue(1.5, CHART_METRICS.cost), "¥1.50");
  assert.equal(formatMetricValue(0.042, CHART_METRICS.cost), "¥0.042");
  assert.equal(formatMetricValue(0.00042, CHART_METRICS.cost), "¥0.00042");
  assert.equal(formatMetricValue(undefined, CHART_METRICS.cost), "¥0");
  assert.doesNotMatch(formatMetricValue(1.5, CHART_METRICS.cost), /\$/, "no dollar sign anywhere in the cost format");
});

test("chart: an older host's estimatedCostUsd payload is still priced, not reported as ¥0", () => {
  // The bundle and the host process update independently: the browser half is fetched on
  // every page load, the host keeps running. During that window the host can still be
  // sending the pre-rename field, and a client that reads only `estimatedCostCny` would
  // draw an all-zero cost chart with no error at all. The cost MEANING is unchanged, so
  // the client accepts either name.
  const legacy = {
    requestedDays: 1,
    days: [{ date: "2026-09-17", models: [{ model: "deepseek-flash", inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, estimatedCostUsd: 1.25 }] }],
  };
  assert.equal(costOf(legacy.days[0].models[0]), 1.25);
  assert.deepEqual(projectSeries(legacy, CHART_METRICS.cost).map((point) => point.value), [1.25]);
  assert.equal(summarizeUsage(legacy).totals.estimatedCostCny, 1.25);
  assert.equal(tooltipModel(legacy, 0).models[0].costText, "¥1.25");
  // The new name wins when both are present, so a host that sends both is unambiguous.
  assert.equal(costOf({ estimatedCostCny: 2, estimatedCostUsd: 1 }), 2);
  assert.equal(costOf({}), 0);
  assert.equal(costOf(null), 0);
});

test("chart: an empty series degrades to an empty, drawable model", () => {
  const geometry = buildChartGeometry([]);
  assert.equal(geometry.isEmpty, true);
  assert.equal(geometry.count, 0);
  assert.equal(geometry.hasValues, false);
  assert.equal(geometry.isSingle, false);
  assert.deepEqual(geometry.points, []);
  assert.deepEqual(geometry.bars, []);
  assert.equal(geometry.linePath, "");
  assert.equal(geometry.areaPath, "");
  assert.equal(geometry.maxValue, 0);
  assert.equal(geometry.yTicks.length, Y_TICK_COUNT);
  assert.deepEqual(geometry.xTicks, []);
  assert.equal(buildChartGeometry("not an array").isEmpty, true);
  assert.equal(buildChartGeometry([null, undefined, 7]).count, 0, "non-object points are dropped");
});

test("chart: an all-zero window keeps a flat baseline instead of dividing by zero", () => {
  const geometry = buildChartGeometry([
    { label: "2026-09-16", value: 0 },
    { label: "2026-09-17", value: 0 },
  ]);
  assert.equal(geometry.maxValue, 0);
  assert.equal(geometry.hasValues, false);
  assert.equal(geometry.isEmpty, false);
  for (const point of geometry.points) {
    assert.equal(point.y, geometry.baseY, "every point sits on the baseline");
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  }
  for (const bar of geometry.bars) assert.equal(bar.height, 0);
  assert.match(geometry.linePath, /^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/);
  assert.doesNotMatch(geometry.linePath, /NaN|Infinity/);
});

test("chart: a single point is centred and marked as single", () => {
  const geometry = buildChartGeometry([{ label: "2026-09-17", value: 500 }]);
  assert.equal(geometry.isSingle, true);
  assert.equal(geometry.count, 1);
  assert.equal(geometry.points.length, 1);
  const [point] = geometry.points;
  assert.ok(Math.abs(point.x - (geometry.padding.left + geometry.plotWidth / 2)) < 0.01, "a lone point is centred");
  assert.equal(point.y, geometry.padding.top, "the only value is the axis maximum");
  assert.match(geometry.linePath, /^M/);
  assert.doesNotMatch(geometry.linePath, /L/, "a line needs two points");
  assert.equal(geometry.bars.length, 1);
  assert.equal(geometry.xTicks.length, 1);
});

test("chart: geometry stays inside the box, is monotonic in x, and tops out at the axis max", () => {
  const geometry = buildChartGeometry(
    [
      { label: "d1", value: 10 },
      { label: "d2", value: 4000 },
      { label: "d3", value: 0 },
      { label: "d4", value: 250 },
    ],
    { width: 400, height: 160, metric: CHART_METRICS.tokens },
  );
  assert.equal(geometry.points.length, 4);
  assert.equal(geometry.bars.length, 4);
  assert.equal(geometry.maxValue, 5000, "4000 → 5000");
  for (const point of geometry.points) {
    assert.ok(point.x >= geometry.padding.left, `${point.x} >= left padding`);
    assert.ok(point.x <= geometry.padding.left + geometry.plotWidth + 0.01, `${point.x} inside the plot width`);
    assert.ok(point.y >= geometry.padding.top && point.y <= geometry.baseY, `${point.y} inside the plot height`);
  }
  for (let index = 1; index < geometry.points.length; index += 1) {
    assert.ok(geometry.points[index].x > geometry.points[index - 1].x, "x ascends with the day index");
  }
  const peak = geometry.points.reduce((best, point) => (point.value > best.value ? point : best), geometry.points[0]);
  const lowest = geometry.points.find((point) => point.value > 0 && point.value < peak.value);
  assert.ok(peak.y < lowest.y, "a bigger value is drawn higher");
  assert.ok(peak.y >= geometry.padding.top, "…and never above the top grid line");
  assert.equal(
    geometry.points.find((point) => point.value === 0).y,
    geometry.baseY,
    "a zero day sits on the baseline",
  );
  for (const bar of geometry.bars) {
    assert.ok(bar.width >= MIN_BAR_WIDTH && bar.width <= MAX_BAR_WIDTH, `bar width ${bar.width}`);
    assert.ok(bar.x >= geometry.padding.left - 0.01, "bars start inside the plot");
    assert.ok(bar.x + bar.width <= geometry.padding.left + geometry.plotWidth + 0.01, "bars end inside the plot");
  }
  assert.equal(geometry.yTicks.length, Y_TICK_COUNT);
  assert.equal(geometry.yTicks[geometry.yTicks.length - 1].y, geometry.padding.top);
  assert.equal(geometry.yTicks[0].y, geometry.baseY);
  assert.equal(geometry.xTicks[0].index, 0);
  assert.equal(geometry.xTicks[geometry.xTicks.length - 1].index, 3, "the last label is always drawn");
  assert.equal(geometry.areaPath.startsWith(geometry.linePath), true);
  assert.ok(geometry.areaPath.endsWith("Z"));
  // A day exactly at the axis maximum does touch the top grid line.
  const topped = buildChartGeometry([
    { label: "max", value: 5000 },
    { label: "zero", value: 0 },
  ]);
  assert.equal(topped.points[0].y, topped.padding.top);
});

test("chart: huge values and impossible boxes still produce finite geometry", () => {
  const geometry = buildChartGeometry(
    [
      { label: "d1", value: 1e12 },
      { label: "d2", value: 5e11 },
    ],
    { width: 640, height: 220 },
  );
  assert.equal(geometry.maxValue, 1e12);
  assert.doesNotMatch(JSON.stringify(geometry), /NaN|Infinity|null/);
  const tiny = buildChartGeometry([{ label: "d1", value: 1e12 }], { width: 10, height: 5, padding: { left: 200, right: 200, top: 50, bottom: 50 } });
  assert.ok(tiny.plotWidth >= 1 && tiny.plotHeight >= 1);
  assert.doesNotMatch(JSON.stringify(tiny), /NaN|Infinity/);
  assert.equal(buildChartGeometry([{ label: "d", value: 1 }], { width: "wide", height: NaN, padding: "none" }).width, 640);
});

test("chart: a long window thins its x labels but keeps every bar", () => {
  const geometry = buildChartGeometry(Array.from({ length: 365 }, (_unused, index) => ({ label: `2026-01-${index}`, value: index })));
  assert.equal(geometry.points.length, 365);
  assert.equal(geometry.bars.length, 365);
  assert.ok(geometry.xTicks.length <= 10, `expected thinned labels, got ${geometry.xTicks.length}`);
  assert.equal(geometry.xTicks[0].index, 0);
  assert.equal(geometry.xTicks[geometry.xTicks.length - 1].index, 364);
  for (const bar of geometry.bars) assert.equal(bar.width, MIN_BAR_WIDTH, "a 365-day window uses the narrow bars");
});

test("chart: summarizeUsage groups by model, sorts by tokens and totals the window", () => {
  const summary = summarizeUsage(USAGE_BODY);
  assert.equal(summary.windowDays, 2);
  assert.equal(summary.activeDays, 2);
  assert.deepEqual(summary.models.map((entry) => entry.model), ["deepseek-flash", "deepseek-v4-pro"], "descending by tokens");
  const flash = summary.models[0];
  assert.equal(flash.inputTokens, 4000);
  assert.equal(flash.cacheReadTokens, 4100);
  assert.equal(flash.outputTokens, 1200);
  assert.equal(flash.totalTokens, 9300);
  assert.equal(flash.estimatedCostCny, 0.0054);
  assert.equal(flash.days, 2);
  assert.deepEqual(summary.totals, {
    inputTokens: 4200,
    cacheReadTokens: 4200,
    outputTokens: 1250,
    totalTokens: 9650,
    estimatedCostCny: 0.0254,
  });
  assert.equal(summary.unknownModelTokens, 0);

  const unknown = summarizeUsage({ days: [{ date: "d", models: [{ inputTokens: 5 }, { model: "", outputTokens: 5 }] }] });
  assert.equal(unknown.models.length, 1);
  assert.equal(unknown.models[0].model, UNKNOWN_MODEL);
  assert.equal(unknown.unknownModelTokens, 10, "a missing model name is never guessed");
  assert.deepEqual(summarizeUsage(undefined).models, []);
  assert.equal(summarizeUsage(undefined).totals.totalTokens, 0);
  assert.equal(summarizeUsage({ days: [{ date: "d", models: [{ model: "deepseek-flash", inputTokens: 0 }] }] }).activeDays, 0);
});

/* ================================================================== *
 * 2. modal.mjs — constants and pure view models
 * ================================================================== */

test("modal: the platform entry is a bare URL and the window set is 7/30", () => {
  assert.equal(PLATFORM_USAGE_URL, "https://platform.deepseek.com/usage");
  assert.doesNotMatch(PLATFORM_USAGE_URL, /\?/, "no unverified deep-link parameters are passed");
  assert.deepEqual([...USAGE_WINDOWS], [7, 30]);
  assert.equal(DEFAULT_USAGE_DAYS, 30);
  assert.equal(MODAL_ID, "deepseek-usage");
  assert.equal(MODAL_STYLE_ID, "dsh-deepseek-usage-modal");
  assert.equal(MODAL_ROOT_ID, "root");
  assert.deepEqual(Object.keys(MODAL_STATES).sort(), ["error", "loading", "ready", "unconfigured"]);
  assert.equal(USAGE_DAYS_MIN, 1);
  assert.equal(USAGE_DAYS_MAX, 365);
});

test("modal: the stylesheet is self-contained", () => {
  assert.match(MODAL_CSS, /\.dsh-deepseek-usage-overlay\{position:fixed/);
  assert.match(MODAL_CSS, /\.dsh-deepseek-usage-panel\{/);
  assert.doesNotMatch(MODAL_CSS, /url\(/);
  assert.doesNotMatch(MODAL_CSS, /@import/);
  assert.doesNotMatch(MODAL_CSS, /https?:\/\//, "no external asset is referenced");
});

test("modal: the estimate label is STATIC copy, not a data-driven flag", () => {
  // The frozen `/usage` envelope whitelists exactly six fields (no `estimated`, no
  // `priceSource`), so the "this is an estimate" statement must live in the copy.
  assert.match(MODAL_DICTIONARY["usage.note"], /本地估算/);
  assert.match(MODAL_DICTIONARY["usage.note"], /官方峰谷单价/);
  assert.match(MODAL_DICTIONARY["usage.note"], /平台账单为权威/);
  assert.match(MODAL_DICTIONARY["usage.chart.cost.note"], /估算值/);
  assert.match(MODAL_DICTIONARY["usage.chart.cost.note"], /官方峰谷单价/);
  const source = readFileSync(join(PACKAGE_ROOT, "src", "client", "modal.mjs"), "utf8");
  assert.doesNotMatch(stripJsComments(source), /priceSource|payload\.estimated\b/, "the popover invents no estimate flag");
});

test("modal: the panel states the estimate's SCOPE, so a lower figure than the bill is explicable", async () => {
  // Measured evidence this copy exists for: a day whose DSH logs only start at 15:05 local
  // estimated ¥5.02 against a ¥13.60 platform bill. The ledger reads THIS machine's DSH
  // session logs only, so usage billed to the same account from another PC, the web UI, or
  // any other tool is invisible here. Saying so on the panel is the difference between a
  // "wrong number" and a "number with a stated scope".
  assert.match(MODAL_DICTIONARY["usage.scope"], /仅本机 DSH 会话日志/);
  assert.match(MODAL_DICTIONARY["usage.scope"], /其它电脑/);
  assert.match(MODAL_DICTIONARY["usage.scope"], /平台账单/, "the scope line still points at the authority");
  assert.match(MODAL_DICTIONARY["usage.note"], /仅限本机 DSH 会话日志/);
  // The cost chart's own label must carry the qualification too, not just "非平台账单".
  assert.match(MODAL_DICTIONARY["usage.chart.cost.note"], /不含本机 DSH 会话日志之外/);
  // …and the cost column names its currency.
  assert.match(MODAL_DICTIONARY["usage.table.cost"], /元/);
  // Rendered, not merely defined — asserted on the MOUNTED panel: `renderModalPanel` returns
  // a detached tree, so a document-level query only reaches it through openUsageModal. (A
  // first attempt asserted against the detached tree and failed for exactly that reason, not
  // because of the selector engine — the engine was checked separately.)
  const { doc } = domWithRoot();
  const handle = openUsageModal(
    { snapshot: normalizeBalancePayload(BALANCE_BODY) },
    { document: doc, readUsage: async () => normalizeUsagePayload(USAGE_BODY), now: () => ISO_MS },
  );
  try {
    // The usage block renders from an async read, so the first paint is the loading state;
    // let the read settle before asserting on the ready panel.
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    const scope = doc.querySelectorAll("[data-usage-scope='1']");
    assert.equal(scope.length, 1, "exactly one scope statement on the mounted panel");
    assert.match(textOf(scope[0]), /仅本机 DSH 会话日志/);
    const usageText = textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`));
    assert.ok(usageText.includes(MODAL_DICTIONARY["usage.scope"]), "the scope line is part of the rendered panel");
    // It qualifies the figures, so it must sit above the footer note.
    assert.ok(
      usageText.indexOf(MODAL_DICTIONARY["usage.scope"]) < usageText.indexOf(MODAL_DICTIONARY["usage.note"]),
      "the scope line comes before the footer note",
    );
  } finally {
    handle.close();
  }
});

test("modal: normalizeDays clamps into the host's accepted range", () => {
  assert.equal(normalizeDays(7), 7);
  assert.equal(normalizeDays("30"), 30);
  assert.equal(normalizeDays(7.9), 7);
  assert.equal(normalizeDays(0), 1);
  assert.equal(normalizeDays(-20), 1);
  assert.equal(normalizeDays(99999), 365);
  assert.equal(normalizeDays(undefined), DEFAULT_USAGE_DAYS);
  assert.equal(normalizeDays("abc"), DEFAULT_USAGE_DAYS);
  assert.equal(normalizeDays(NaN), DEFAULT_USAGE_DAYS);
});

test("modal: the balance card shows the real fields, the data time and the cache marker", () => {
  const text = modalText(undefined);
  const ready = describeBalanceCard(normalizeBalancePayload(BALANCE_BODY), text, ISO_MS);
  assert.equal(ready.state, MODAL_STATES.ready);
  assert.equal(ready.pending, false);
  assert.equal(ready.error, null);
  const byLabel = Object.fromEntries(ready.rows.map((row) => [row.label, row]));
  assert.equal(byLabel[text("card.total")].value, "¥12.30");
  assert.equal(byLabel[text("card.total")].emphasis, true);
  assert.equal(byLabel[text("card.toppedUp")].value, "¥10.30");
  assert.equal(byLabel[text("card.granted")].value, "¥2.00");
  assert.equal(byLabel[text("card.currency")].value, "CNY");
  assert.equal(byLabel[text("card.availability")].value, text("card.available"));
  assert.equal(byLabel[text("card.fetchedAt")].value, "2026-09-17 20:31（刚刚）");
  assert.equal(byLabel[text("card.source")].value, text("card.cached"));
  assert.equal(byLabel[text("card.source")].tone, "muted");

  const live = describeBalanceCard(normalizeBalancePayload({ ...BALANCE_BODY, cached: false, isAvailable: false, fetchedAt: null }), text, ISO_MS);
  const liveLabels = Object.fromEntries(live.rows.map((row) => [row.label, row]));
  assert.equal(liveLabels[text("card.source")].value, text("card.live"));
  assert.equal(liveLabels[text("card.fetchedAt")].value, "—");
  assert.equal(liveLabels[text("card.availability")].value, text("card.unavailable"));
  assert.equal(live.tone, "warn");

  const pending = describeBalanceCard({ state: MODAL_STATES.loading }, text, ISO_MS);
  assert.equal(pending.pending, true);
  assert.deepEqual(pending.rows, []);
  assert.equal(describeBalanceCard(undefined, text, ISO_MS).pending, true, "no snapshot is the loading state");

  const failed = describeBalanceCard(normalizeFailurePayload(502, { ok: false, error: { code: "upstream_error", message: "bad gateway" } }, ""), text, ISO_MS);
  assert.equal(failed.error.code, "upstream_error");
  assert.equal(failed.error.message, "bad gateway");
  assert.equal(failed.error.httpStatus, 502);
  assert.match(failed.error.detail, /HTTP 502/);
  assert.equal(failed.tone, "warn");

  const unconfigured = describeBalanceCard(normalizeFailurePayload(503, { ok: false, error: { code: "no_api_key", message: "no key" } }, ""), text, ISO_MS);
  assert.equal(unconfigured.state, MODAL_STATES.unconfigured);
  assert.equal(unconfigured.error.code, "no_api_key");

  const ledgerFree = describeBalanceCard(normalizeFailurePayload(503, { ok: false, error: { code: "ledger_unavailable" } }, ""), text, ISO_MS);
  assert.equal(ledgerFree.error.message, messageForCode("ledger_unavailable"));
  assert.match(ledgerFree.error.message, /台账/);
});

test("modal: the usage panel carries the window, the charts and the model table", () => {
  const text = modalText(undefined);
  const ready = describeUsagePanel(normalizeUsagePayload(USAGE_BODY), text, ISO_MS);
  assert.equal(ready.state, MODAL_STATES.ready);
  assert.equal(ready.error, null);
  assert.equal(ready.truncated, false);
  assert.equal(ready.generatedAt, ISO);
  assert.equal(ready.days, 7);
  assert.equal(ready.generatedAge, "刚刚", "the panel dates its own aggregation, like the balance card does");
  assert.equal(describeUsagePanel(normalizeUsagePayload(USAGE_BODY), text, ISO_MS + 3 * 86_400_000).generatedAge, "2026-09-17 20:31");
  assert.equal(ready.summary.models.length, 2);
  assert.equal(ready.charts.tokens.count, 2);
  assert.equal(ready.charts.cost.count, 2);
  assert.equal(ready.charts.tokens.maxValue, 10000);
  assert.equal(ready.charts.cost.maxValue, 0.05);
  assert.equal(ready.charts.tokens.hasValues, true);

  const truncated = describeUsagePanel(normalizeUsagePayload({ ok: true, days: [], truncated: true }), text, ISO_MS);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.tone, "warn");
  assert.equal(truncated.charts.tokens.isEmpty, true);

  const failed = describeUsagePanel(normalizeFailurePayload(503, { ok: false, error: { code: "ledger_unavailable" } }), text, ISO_MS);
  assert.equal(failed.error.code, "ledger_unavailable");
  assert.equal(failed.error.httpStatus, 503);
  assert.match(failed.error.message, /台账/);
  assert.equal(failed.charts, null);

  assert.equal(describeUsagePanel({ state: MODAL_STATES.loading }, text, ISO_MS).charts, null);
});

test("modal: describeModalModel composes both blocks and normalizes the window", () => {
  const text = modalText(undefined);
  const model = describeModalModel({ balance: normalizeBalancePayload(BALANCE_BODY), usage: normalizeUsagePayload(USAGE_BODY), days: 7 }, text, ISO_MS);
  assert.equal(model.id, MODAL_ID);
  assert.equal(model.days, 7);
  assert.equal(model.balance.rows.length, 7);
  assert.equal(model.usage.charts.tokens.count, 2);
  const fallback = describeModalModel(undefined, text, ISO_MS);
  assert.equal(fallback.days, DEFAULT_USAGE_DAYS);
  assert.equal(fallback.balance.pending, true);
  assert.equal(fallback.usage.state, MODAL_STATES.loading);
});

test("modal: a locale seat from the shell wins over the built-in dictionary", () => {
  assert.equal(modalText((key) => `loc:${key}`)("modal.title"), "loc:modal.title");
  assert.equal(modalText(undefined)("modal.title"), MODAL_DICTIONARY["modal.title"]);
  assert.equal(modalText((key) => key)("modal.title"), MODAL_DICTIONARY["modal.title"], "an unregistered namespace returns the key");
  for (const window of USAGE_WINDOWS) {
    assert.equal(MODAL_DICTIONARY["usage.window"].replace("{n}", String(window)), `近 ${window} 天`);
  }
  assert.equal(shortDayLabel("2026-09-17"), "09-17");
  assert.equal(shortDayLabel("x"), "x");
  assert.equal(shortDayLabel(undefined), "");
});

/* ================================================================== *
 * 3. one transport only: the shipped service.mjs
 * ================================================================== */

test("modal: the popover owns no transport of its own", () => {
  const code = stripJsComments(readFileSync(join(PACKAGE_ROOT, "src", "client", "modal.mjs"), "utf8"));
  assert.doesNotMatch(code, /\bfetch\s*\(/, "one transport only: service.mjs owns the fetch call");
  assert.doesNotMatch(code, /AbortController/, "no second timeout/abort policy");
  assert.doesNotMatch(code, /api\.deepseek\.com/i);
  assert.doesNotMatch(code, /localStorage|sessionStorage|document\.cookie/);
  const origins = code.split(PLATFORM_USAGE_URL).join("").split(SVG_NAMESPACE).join("");
  assert.doesNotMatch(origins, /https?:\/\/(?!127\.0\.0\.1)/, "the platform link target is the single absolute literal");
  assert.doesNotMatch(code, /iframe/i, "the platform page refuses framing, so there is nothing to embed");
});

test("modal: the charts are fed by service.readUsage over this origin's route", async () => {
  const spy = fetchSpy((url) => (String(url).includes("/usage") ? jsonResponse(200, USAGE_BODY) : jsonResponse(200, BALANCE_BODY)));
  const service = createBalanceService({ fetchImpl: spy.fetchImpl, now: () => 7 });
  const { doc } = domWithRoot();
  const handle = openUsageModal({ snapshot: normalizeBalancePayload(BALANCE_BODY), service }, { document: doc, now: () => ISO_MS });
  await tick();
  await tick();
  const urls = spy.calls.map((call) => call.url);
  assert.ok(urls.includes("/api/dsh-deepseek-usage/balance"), urls.join(" "));
  assert.ok(urls.includes("/api/dsh-deepseek-usage/usage?days=30"), urls.join(" "));
  for (const call of spy.calls) {
    assert.ok(call.url.startsWith("/"), call.url);
    assert.equal(call.init.credentials, "same-origin");
    assert.deepEqual(Object.keys(call.init.headers), ["accept"]);
  }
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.chart}]`).length, 2, "the service's envelope reached both charts");
  assert.equal(doc.querySelectorAll("rect.dsh-deepseek-usage-bar").length, 2);
  // …and the days switch changes the window the service is asked for.
  doc.querySelector(`[${MODAL_ATTR.days}="7"]`).dispatchEvent(fakeEvent("click").event);
  await tick();
  assert.equal(handle.days, 7);
  assert.ok(spy.calls.some((call) => call.url === "/api/dsh-deepseek-usage/usage?days=7"), spy.calls.map((call) => call.url).join(" "));
  handle.close();
});

test("modal: the real service's failure states land in the two blocks independently", async () => {
  const spy = fetchSpy((url) =>
    String(url).includes("/usage")
      ? jsonResponse(503, { ok: false, error: { code: "ledger_unavailable", message: "no zstd decoder on this machine" } })
      : jsonResponse(503, { ok: false, error: { code: "no_api_key", message: "no key configured" } }),
  );
  const service = createBalanceService({ fetchImpl: spy.fetchImpl });
  const { doc } = domWithRoot();
  const handle = openUsageModal({ snapshot: { state: MODAL_STATES.loading }, service }, { document: doc, now: () => ISO_MS });
  await tick();
  await tick();
  const cardText = textOf(doc.querySelector(`[${MODAL_ATTR.balance}]`));
  const usageText = textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`));
  assert.match(cardText, /no key configured/, "the card shows the host's own message");
  assert.match(cardText, /no_api_key/);
  assert.match(cardText, /HTTP 503/);
  assert.match(usageText, /no zstd decoder on this machine/);
  assert.match(usageText, /ledger_unavailable/);
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.chart}]`).length, 0, "a failed usage read renders no chart");
  // The two blocks fail independently: the card is a key problem, the ledger is not.
  assert.equal(doc.querySelector(`[${MODAL_ATTR.balance}] [data-error-code]`).getAttribute("data-error-code"), "no_api_key");
  assert.equal(doc.querySelector(`[${MODAL_ATTR.usage}] [data-error-code]`).getAttribute("data-error-code"), "ledger_unavailable");
  handle.close();
});

/* ================================================================== *
 * 4. DOM behaviour on the fake DOM
 * ================================================================== */

test("dom: styles are injected once and are self-contained", () => {
  const doc = createFakeDom();
  assert.equal(ensureModalStyles(undefined), false);
  assert.equal(ensureModalStyles(doc), true);
  assert.equal(ensureModalStyles(doc), false, "deduped by data-plugin-css");
  const styles = doc.querySelectorAll("style");
  assert.equal(styles.length, 1);
  assert.equal(styles[0].getAttribute("data-plugin-css"), MODAL_STYLE_ID);
  // One injected string, and it is the popover's rules FOLLOWED BY the chart
  // interaction's (appended, never interleaved) — the order the wiring promises.
  assert.equal(styles[0].textContent, MODAL_STYLE_TEXT);
  assert.equal(MODAL_STYLE_TEXT, `${MODAL_CSS}${CHART_INTERACTION_CSS}`);
  assert.equal(MODAL_STYLE_TEXT.indexOf(MODAL_CSS), 0, "the popover's rules come first");
  assert.ok(MODAL_STYLE_TEXT.indexOf(CHART_INTERACTION_CSS) >= MODAL_CSS.length, "the chart rules are appended after them");
  assert.match(MODAL_STYLE_TEXT, /\.dsh-deepseek-usage-tooltip\{/, "the tooltip styling really is in the injected text");
});

test("dom: the popover mounts on body, owns the dialog semantics and inerts #root", async () => {
  const { doc, root } = domWithRoot();
  const handle = openUsageModal(
    { snapshot: normalizeBalancePayload(BALANCE_BODY), service: { read: async () => normalizeBalancePayload(BALANCE_BODY) } },
    { document: doc, readUsage: async () => normalizeUsagePayload(USAGE_BODY), now: () => ISO_MS },
  );
  await tick();
  assert.equal(handle.isOpen, true);
  const overlay = doc.querySelector(`[${MODAL_ATTR.overlay}]`);
  assert.ok(overlay, "the overlay is appended to document.body");
  assert.equal(overlay.parentNode, doc.body);
  assert.equal(root.inert, true, "#root is inert while the dialog is open");
  const panel = doc.querySelector(`[${MODAL_ATTR.panel}]`);
  assert.equal(panel.getAttribute("role"), "dialog");
  assert.equal(panel.getAttribute("aria-modal"), "true");
  assert.equal(panel.getAttribute("aria-labelledby"), doc.querySelector(".dsh-deepseek-usage-title").getAttribute("id"));
  assert.equal(doc.activeElement, panel, "focus lands inside the dialog");
  handle.close();
  assert.equal(doc.querySelector(`[${MODAL_ATTR.overlay}]`), null);
  assert.equal(root.inert, false, "inert is restored on close");
});

test("dom: the balance card renders the host snapshot and refreshes with force", async () => {
  const { doc } = domWithRoot();
  const reads = [];
  const service = {
    async read(request) {
      reads.push(request ?? {});
      return normalizeBalancePayload(BALANCE_BODY);
    },
  };
  const handle = openUsageModal(
    { snapshot: normalizeBalancePayload(BALANCE_BODY), service },
    { document: doc, readUsage: async () => normalizeUsagePayload(USAGE_BODY), now: () => ISO_MS },
  );
  const cardText = textOf(doc.querySelector(`[${MODAL_ATTR.balance}]`));
  assert.match(cardText, /¥12\.30/);
  assert.match(cardText, /¥10\.30/);
  assert.match(cardText, /¥2\.00/);
  assert.match(cardText, /CNY/);
  assert.match(cardText, /2026-09-17 20:31/);
  assert.match(cardText, /来自宿主缓存/);
  assert.equal(reads.length, 1, "opening reads the balance once");
  assert.deepEqual(reads[0], {}, "opening does not force a new upstream call");
  doc.querySelector(`[${MODAL_ATTR.refresh}]`).dispatchEvent(fakeEvent("click").event);
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[1], { force: true }, "the card's refresh bypasses the host cache");
  await tick();
  assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.balance}]`)), /¥12\.30/);
  handle.close();
});

test("dom: the balance card degrades for a missing key and for an upstream failure", async () => {
  const cases = [
    { name: "no key", snapshot: normalizeFailurePayload(503, { ok: false, error: { code: "no_api_key", message: "no key configured" } }, ""), expected: /no key configured/ },
    { name: "upstream", snapshot: normalizeFailurePayload(502, { ok: false, error: { code: "upstream_error", message: "bad gateway" } }, ""), expected: /bad gateway/ },
  ];
  for (const item of cases) {
    const { doc } = domWithRoot();
    const handle = openUsageModal(
      { snapshot: item.snapshot },
      { document: doc, readUsage: async () => normalizeFailurePayload(503, { ok: false, error: { code: "ledger_unavailable" } }) },
    );
    await tick();
    assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.balance}]`)), item.expected, item.name);
    assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`)), /台账/, `${item.name}: the ledger failure is independent`);
    assert.ok(handle.isOpen);
    handle.close();
  }
});

test("dom: the usage block renders both charts, the static estimate label, the table and the note", async () => {
  const { doc } = domWithRoot();
  const handle = openUsageModal(
    { snapshot: normalizeBalancePayload(BALANCE_BODY) },
    { document: doc, readUsage: async () => normalizeUsagePayload(USAGE_BODY), now: () => ISO_MS },
  );
  assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`)), /正在聚合本地会话日志/);
  await tick();
  const tokens = doc.querySelector(`[${MODAL_ATTR.chart}="tokens"]`);
  const cost = doc.querySelector(`[${MODAL_ATTR.chart}="cost"]`);
  assert.ok(tokens && cost, "both the line and the bar view are rendered");
  assert.equal(tokens.namespaceURI, SVG_NAMESPACE);
  assert.equal(doc.querySelectorAll("path.dsh-deepseek-usage-line").length, 1);
  assert.equal(doc.querySelectorAll("rect.dsh-deepseek-usage-bar").length, 2, "one bar per day in the window");
  assert.equal(doc.querySelectorAll("circle.dsh-deepseek-usage-dot").length, 2);
  assert.equal(tokens.getAttribute("viewBox"), "0 0 640 220");
  const table = doc.querySelector(`[${MODAL_ATTR.models}]`);
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.models}] tbody tr`).length, 2);
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.models}] thead th`).length, 6);
  assert.match(textOf(table), /deepseek-flash/);
  assert.match(textOf(table), /deepseek-v4-pro/);
  assert.match(textOf(table), /窗口合计/);
  const usageText = textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`));
  assert.match(usageText, /每日 Token 总量（折线）/);
  assert.match(usageText, /每日估算费用（柱状）/);
  assert.match(usageText, /估算值：本地聚合 token × 官方峰谷单价/);
  assert.match(usageText, /本地估算（按 DSH 会话记录聚合 \+ 官方峰谷单价），平台账单为权威/);
  assert.match(usageText, /生成于 2026-09-17 20:31（刚刚）/);
  assert.equal(doc.querySelectorAll("[data-estimate-label='1']").length, 1, "the cost view carries its own static estimate label");
  assert.equal(doc.querySelectorAll(".dsh-deepseek-usage-tab[aria-pressed='true']")[0].getAttribute(MODAL_ATTR.days), "30");
  handle.close();
});

test("dom: the estimate label is present even for an empty window (no data flag to rely on)", async () => {
  const { doc } = domWithRoot();
  const handle = openUsageModal(
    { snapshot: { state: MODAL_STATES.loading } },
    {
      document: doc,
      readUsage: async () => normalizeUsagePayload({ ok: true, requestedDays: 30, days: [], generatedAt: ISO, truncated: false, totals: {} }),
    },
  );
  await tick();
  const usageText = textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`));
  assert.match(usageText, /该窗口内没有会话记录/);
  assert.match(usageText, /估算值：本地聚合 token × 官方峰谷单价/, "the estimate statement never depends on payload flags");
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.chart}]`).length, 2, "an empty window still renders a frame");
  assert.equal(doc.querySelectorAll("rect.dsh-deepseek-usage-bar").length, 0);
  assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.models}]`)), /窗口内没有按模型的数据/);
  handle.close();
});

test("dom: an all-zero window and a single day degrade with their own copy", async () => {
  const zero = domWithRoot();
  const zeroHandle = openUsageModal(
    { snapshot: { state: MODAL_STATES.loading } },
    {
      document: zero.doc,
      readUsage: async () =>
        normalizeUsagePayload({
          ok: true,
          requestedDays: 7,
          days: [
            { date: "2026-09-16", models: [{ model: "deepseek-flash", inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, estimatedCostCny: 0 }] },
            { date: "2026-09-17", models: [] },
          ],
          generatedAt: ISO,
          truncated: false,
          totals: {},
        }),
    },
  );
  await tick();
  assert.match(textOf(zero.doc.querySelector(`[${MODAL_ATTR.usage}]`)), /该窗口内有 2 天记录，但没有可统计的 token/);
  assert.equal(zero.doc.querySelectorAll("rect.dsh-deepseek-usage-bar").length, 2, "zero-height bars still describe the window");
  zeroHandle.close();

  const single = domWithRoot();
  const singleHandle = openUsageModal(
    { snapshot: { state: MODAL_STATES.loading } },
    {
      document: single.doc,
      readUsage: async () =>
        normalizeUsagePayload({
          ok: true,
          requestedDays: 7,
          days: [{ date: "2026-09-17", models: [{ model: "deepseek-flash", inputTokens: 100, estimatedCostCny: 0.1 }] }],
          generatedAt: ISO,
          truncated: false,
          totals: {},
        }),
    },
  );
  await tick();
  assert.equal(single.doc.querySelectorAll("circle.dsh-deepseek-usage-dot").length, 1);
  assert.match(textOf(single.doc.querySelector(`[${MODAL_ATTR.usage}]`)), /单点不连线/);
  singleHandle.close();
});

test("dom: a usage failure renders its code and retries through the retry button", async () => {
  const { doc } = domWithRoot();
  let attempts = 0;
  const handle = openUsageModal(
    { snapshot: { state: MODAL_STATES.loading } },
    {
      document: doc,
      readUsage: async () => {
        attempts += 1;
        return attempts === 1
          ? normalizeFailurePayload(503, { ok: false, error: { code: "ledger_unavailable", message: "no zstd decoder" } })
          : normalizeUsagePayload(USAGE_BODY);
      },
    },
  );
  await tick();
  const usageText = textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`));
  assert.match(usageText, /本地用量读取失败/);
  assert.match(usageText, /no zstd decoder/);
  assert.match(usageText, /HTTP 503/);
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.chart}]`).length, 0);
  const retry = doc.querySelector(`[${MODAL_ATTR.usageRetry}]`);
  assert.ok(retry, "the failure state is retryable");
  assert.equal(retry.getAttribute("disabled"), null);
  retry.dispatchEvent(fakeEvent("click").event);
  await tick();
  assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`)), /每日估算费用（柱状）/);
  assert.equal(attempts, 2);
  handle.close();
});

test("dom: without a service the dialog still opens and says why", async () => {
  const { doc, root } = domWithRoot();
  const handle = openUsageModal({}, { document: doc });
  await tick();
  assert.equal(handle.isOpen, true);
  assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.balance}]`)), /宿主服务未提供余额读取器/);
  assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`)), /宿主服务未提供 \/usage 读取器/);
  assert.equal(doc.querySelector(`[${MODAL_ATTR.refresh}]`).getAttribute("disabled"), "", "no reader, no refresh affordance");
  assert.equal(doc.querySelector(`[${MODAL_ATTR.usageRetry}]`).getAttribute("disabled"), "");
  assert.equal(root.inert, true);
  handle.close();
  assert.equal(root.inert, false);
});

test("dom: a throwing service is contained in both blocks", async () => {
  const { doc } = domWithRoot();
  const handle = openUsageModal(
    { snapshot: { state: MODAL_STATES.loading } },
    {
      document: doc,
      readUsage: () => {
        throw new Error("usage exploded");
      },
      service: {
        read() {
          throw new Error("balance exploded");
        },
      },
    },
  );
  await tick();
  assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.balance}]`)), /balance exploded/);
  assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`)), /usage exploded/);
  assert.doesNotThrow(() => doc.querySelector(`[${MODAL_ATTR.refresh}]`).dispatchEvent(fakeEvent("click").event));
  handle.close();
});

test("dom: the 7/30 switch reloads the window, keeps aria state and keeps focus", async () => {
  const { doc } = domWithRoot();
  const requests = [];
  const handle = openUsageModal(
    { snapshot: normalizeBalancePayload(BALANCE_BODY), days: 7 },
    {
      document: doc,
      readUsage: async (request) => {
        requests.push(request.days);
        return normalizeUsagePayload({ ...USAGE_BODY, requestedDays: request.days });
      },
      now: () => ISO_MS,
    },
  );
  await tick();
  assert.deepEqual(requests, [7]);
  const thirty = doc.querySelector(`[${MODAL_ATTR.days}="30"]`);
  assert.equal(thirty.getAttribute("aria-pressed"), "false");
  thirty.dispatchEvent(fakeEvent("click").event);
  assert.equal(handle.days, 30);
  assert.deepEqual(requests, [7, 30]);
  await tick();
  assert.equal(doc.querySelector(`[${MODAL_ATTR.days}="30"]`).getAttribute("aria-pressed"), "true");
  assert.equal(doc.querySelector(`[${MODAL_ATTR.days}="7"]`).getAttribute("aria-pressed"), "false");
  assert.equal(doc.activeElement, doc.querySelector(`[${MODAL_ATTR.days}="30"]`), "a re-render must not drop keyboard focus");
  handle.close();
});

test("dom: ESC closes, consumes the key, and restores focus to the opener", () => {
  const { doc, root } = domWithRoot();
  const opener = doc.createElement("button");
  doc.body.appendChild(opener);
  opener.focus();
  const handle = openUsageModal({ snapshot: normalizeBalancePayload(BALANCE_BODY) }, { document: doc, readUsage: async () => normalizeUsagePayload(USAGE_BODY) });
  assert.notEqual(doc.activeElement, opener, "focus moved into the dialog");
  const { record, event } = fakeEvent("keydown", { key: "Escape" });
  doc.dispatchEvent(event);
  assert.equal(record.preventDefault, 1, "ESC is consumed so the shell does not also react");
  assert.equal(handle.isOpen, false);
  assert.equal(doc.querySelector(`[${MODAL_ATTR.overlay}]`), null);
  assert.equal(root.inert, false);
  assert.equal(doc.activeElement, opener, "focus returns to whatever opened the popover");
  assert.doesNotThrow(() => doc.dispatchEvent(fakeEvent("keydown", { key: "Escape" }).event), "closing twice is a no-op");
  handle.close();
});

test("dom: a backdrop click closes, a click inside the panel does not", () => {
  const { doc } = domWithRoot();
  const handle = openUsageModal({ snapshot: normalizeBalancePayload(BALANCE_BODY) }, { document: doc, readUsage: async () => normalizeUsagePayload(USAGE_BODY) });
  const overlay = doc.querySelector(`[${MODAL_ATTR.overlay}]`);
  const panel = doc.querySelector(`[${MODAL_ATTR.panel}]`);
  const inside = fakeEvent("click");
  inside.event.target = panel;
  panel.dispatchEvent(inside.event);
  assert.equal(handle.isOpen, true, "a click inside the dialog keeps it open");
  const backdrop = fakeEvent("click");
  backdrop.event.target = overlay;
  overlay.dispatchEvent(backdrop.event);
  assert.equal(handle.isOpen, false, "a click on the backdrop closes it");
});

test("dom: Tab is trapped inside the dialog and wraps at both ends", () => {
  const { doc } = domWithRoot();
  const handle = openUsageModal({ snapshot: normalizeBalancePayload(BALANCE_BODY) }, { document: doc, readUsage: async () => normalizeUsagePayload(USAGE_BODY) });
  const panel = doc.querySelector(`[${MODAL_ATTR.panel}]`);
  const focusable = collectFocusable(panel);
  assert.ok(focusable.length >= 3, "close, refresh, window tabs and the platform link are focusable");
  focusable[focusable.length - 1].focus();
  const forward = fakeEvent("keydown", { key: "Tab" });
  doc.dispatchEvent(forward.event);
  assert.equal(forward.record.preventDefault, 1);
  assert.equal(doc.activeElement, focusable[0], "Tab at the end wraps to the first control");
  const backward = fakeEvent("keydown", { key: "Tab", shiftKey: true });
  doc.dispatchEvent(backward.event);
  assert.equal(backward.record.preventDefault, 1);
  assert.equal(doc.activeElement, focusable[focusable.length - 1], "Shift+Tab at the start wraps to the last control");
  const away = fakeEvent("keydown", { key: "Tab" });
  away.event.target = doc.body;
  doc.dispatchEvent(away.event);
  assert.equal(doc.activeElement, focusable[0], "focus that escaped the dialog is pulled back in");
  handle.close();
});

test("dom: the platform entry opens a new window and never a frame", () => {
  const { doc } = domWithRoot();
  const handle = openUsageModal({ snapshot: normalizeBalancePayload(BALANCE_BODY) }, { document: doc, readUsage: async () => normalizeUsagePayload(USAGE_BODY) });
  const link = doc.querySelector(`[${MODAL_ATTR.platform}]`);
  assert.equal(link.tagName, "A");
  assert.equal(link.getAttribute("href"), PLATFORM_USAGE_URL);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.match(link.getAttribute("rel"), /noopener/);
  assert.match(link.getAttribute("rel"), /noreferrer/);
  const { record, event } = fakeEvent("click");
  link.dispatchEvent(event);
  assert.equal(record.preventDefault, 1);
  const calls = doc.openCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [PLATFORM_USAGE_URL, "_blank", "noopener,noreferrer"]);
  assert.equal(doc.querySelectorAll("iframe").length, 0);
  handle.close();

  assert.equal(openPlatformUsage(undefined), false, "no window, no crash");
  assert.equal(openPlatformUsage({}), false);
  const spy = { calls: [], open(...args) { this.calls.push(args); } };
  assert.equal(openPlatformUsage(spy), true);
  assert.deepEqual(spy.calls[0], [PLATFORM_USAGE_URL, "_blank", "noopener,noreferrer"]);
});

test("dom: a second open replaces the first, and close() is idempotent", () => {
  const { doc, root } = domWithRoot();
  const deps = { document: doc, readUsage: async () => normalizeUsagePayload(USAGE_BODY) };
  const first = openUsageModal({ snapshot: normalizeBalancePayload(BALANCE_BODY) }, deps);
  const second = openUsageModal({ snapshot: normalizeBalancePayload(BALANCE_BODY) }, deps);
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.overlay}]`).length, 1, "exactly one overlay, never a stack");
  assert.equal(root.inert, true);
  first.close();
  assert.equal(second.isOpen, true, "closing the stale handle must not close the live dialog");
  second.close();
  second.close();
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.overlay}]`).length, 0);
  assert.equal(root.inert, false);
});

test("dom: an already-inert #root is left inert, and a missing #root is not fatal", () => {
  const doc = createFakeDom();
  const root = doc.createElement("div");
  root.setAttribute("id", MODAL_ROOT_ID);
  root.inert = true;
  doc.body.appendChild(root);
  const handle = openUsageModal({ snapshot: normalizeBalancePayload(BALANCE_BODY) }, { document: doc, readUsage: async () => normalizeUsagePayload(USAGE_BODY) });
  assert.equal(root.inert, true);
  handle.close();
  assert.equal(root.inert, true, "the popover must not un-inert something it did not inert");

  const bare = createFakeDom();
  assert.doesNotThrow(() => {
    const other = openUsageModal({ snapshot: normalizeBalancePayload(BALANCE_BODY) }, { document: bare });
    other.close();
  });
  const noDom = openUsageModal({ snapshot: normalizeBalancePayload(BALANCE_BODY) }, { document: undefined, window: undefined });
  assert.equal(noDom.isOpen, false, "no DOM means an inert handle, not a throw");
  assert.equal(noDom.element, null);
  assert.doesNotThrow(() => noDom.close());
});

test("dom: setRootInert reports what it did, and restoreRootInert honours it", () => {
  const { doc, root } = domWithRoot();
  assert.deepEqual(setRootInert(doc, true), { applied: true, previous: false });
  assert.equal(root.inert, true);
  assert.equal(root.getAttribute("inert"), "", "the attribute is set, not only the property");
  assert.deepEqual(setRootInert(doc, false), { applied: true, previous: true });
  assert.equal(root.inert, false);
  assert.equal(root.getAttribute("inert"), null);
  assert.equal(setRootInert(undefined, true).applied, false);
  assert.equal(setRootInert(createFakeDom(), true).applied, false, "no #root, nothing to do");

  // Restore walks the recorded state: a root that some other overlay had already
  // inerted must not be un-inerted by this dialog's close.
  const shared = domWithRoot();
  shared.root.inert = true;
  const recorded = setRootInert(shared.doc, true);
  assert.equal(recorded.previous, true);
  assert.equal(restoreRootInert(shared.doc, recorded), false);
  assert.equal(shared.root.inert, true, "another overlay's inert survives our close");
  const own = domWithRoot();
  const ours = setRootInert(own.doc, true);
  assert.equal(restoreRootInert(own.doc, ours), true);
  assert.equal(own.root.inert, false);
  assert.equal(restoreRootInert(own.doc, { applied: false }), false);
  assert.equal(restoreRootInert(own.doc, undefined), false);
});

test("dom: renderModalPanel is driven purely by its model and handlers", () => {
  const doc = createFakeDom();
  const text = modalText(undefined);
  const model = describeModalModel({ balance: normalizeBalancePayload(BALANCE_BODY), usage: normalizeUsagePayload(USAGE_BODY), days: 7 }, text, ISO_MS);
  const clicks = [];
  const panel = renderModalPanel(
    doc,
    model,
    {
      onClose: () => clicks.push("close"),
      onRefreshBalance: () => clicks.push("refresh"),
      onRetryUsage: () => clicks.push("retry-usage"),
      onSelectDays: (days) => clicks.push(`days:${days}`),
      onPlatform: () => clicks.push("platform"),
    },
    text,
  );
  doc.body.appendChild(panel);
  assert.equal(panel.getAttribute("role"), "dialog");
  assert.match(textOf(panel), /DeepSeek 余额与用量/);
  assert.match(textOf(panel), /账户余额/);
  assert.match(textOf(panel), /¥12\.30/);
  assert.match(textOf(panel), /在 platform\.deepseek\.com 打开用量页/);
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.chart}]`).length, 2);
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.usageRetry}]`).length, 0, "a healthy panel offers no usage retry");
  doc.querySelector(`[${MODAL_ATTR.close}]`).dispatchEvent(fakeEvent("click").event);
  doc.querySelector(`[${MODAL_ATTR.refresh}]`).dispatchEvent(fakeEvent("click").event);
  doc.querySelector(`[${MODAL_ATTR.days}="7"]`).dispatchEvent(fakeEvent("click").event);
  doc.querySelector(`[${MODAL_ATTR.platform}]`).dispatchEvent(fakeEvent("click").event);
  assert.deepEqual(clicks, ["close", "refresh", "days:7", "platform"]);
  assert.equal(collectFocusable(panel).length >= 4, true);

  const empty = renderModalPanel(doc, describeModalModel({ usage: { state: MODAL_STATES.loading } }, text, ISO_MS), {}, text);
  assert.equal(empty.querySelector(`[${MODAL_ATTR.refresh}]`).getAttribute("disabled"), "", "a missing handler disables its control");
  assert.equal(empty.querySelector(`[${MODAL_ATTR.close}]`).getAttribute("disabled"), null);
});

test("dom: createUsageModalOpener consumes the activation-time runtime", async () => {
  const { doc } = domWithRoot();
  const reads = [];
  const service = {
    async read() {
      return normalizeBalancePayload(BALANCE_BODY);
    },
    async readUsage(request) {
      reads.push(request);
      return normalizeUsagePayload(USAGE_BODY);
    },
  };
  const opener = createUsageModalOpener({ React: { createElement: () => null }, primitives: undefined, icons: {}, Tooltip: undefined, service, text: (key) => key, slot: "sidebar.footer.action" });
  assert.equal(typeof opener, "function");
  // In node there is no ambient `document`, so the opener must degrade to an inert
  // handle instead of throwing (the browser passes the real document by accident of
  // the global, which is exactly what the composed bundle test exercises).
  const handle = opener({ snapshot: normalizeBalancePayload(BALANCE_BODY), wide: true, service });
  await tick();
  assert.equal(handle.isOpen, false);
  assert.equal(handle.element, null);
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.overlay}]`).length, 0);
  handle.close();

  const withDoc = createUsageModalOpener({ service, text: (key) => key, document: doc, now: () => ISO_MS });
  const bound = withDoc({ snapshot: normalizeBalancePayload(BALANCE_BODY), service });
  await tick();
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.overlay}]`).length, 1);
  assert.equal(doc.querySelector(`[${MODAL_ATTR.panel}]`).getAttribute("role"), "dialog");
  assert.deepEqual(reads, [{ days: DEFAULT_USAGE_DAYS }], "the runtime's service is the single reader");
  assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`)), /每日估算费用（柱状）/);
  bound.close();
});

/* ================================================================== *
 * 3b. cross-half: the popover against the REAL host route family
 * ================================================================== */

/**
 * Boot the plugin's actual route family (`makeRoutes` + the host's own
 * `/usage` reader) on a loopback port, so the popover is driven by real host code
 * and real HTTP instead of by a stubbed fetch.
 * @param options - `{ aggregate, balance }` (the readers' answers).
 * @returns `{ origin, close, requests }`.
 */
async function startHostFamily(options) {
  const requests = [];
  const routes = makeRoutes({
    balance: { read: async () => options.balance },
    usage: createHostUsageReader(options.aggregate, { sessionsRoot: "unused-in-this-test", cacheDir: null }),
    logger: { warn() {} },
  });
  const byPath = new Map(routes.map((route) => [route.path, route]));
  const server = createServer((request, response) => {
    const path = String(request.url ?? "").split("?")[0];
    requests.push(path);
    const route = byPath.get(path);
    if (route === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "not_found", message: path } }));
      return;
    }
    Promise.resolve(route.handler(request, response)).catch(() => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "internal", message: "handler threw" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * The browser's own origin resolution: the real `fetch` is given the loopback base,
 * while the assertion proves the browser half still emitted a RELATIVE path.
 * @param origin - the loopback base.
 * @returns `{ calls, fetchImpl }`.
 */
function originBoundFetch(origin) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      assert.ok(String(url).startsWith("/"), `the browser half must stay relative, got ${url}`);
      return fetch(`${origin}${url}`, init);
    },
  };
}

/** A ledger payload shaped exactly like T3's `aggregateUsage` result. */
function ledgerPayload(days) {
  return {
    ok: true,
    requestedDays: days,
    days: [
      { date: "2026-09-16", models: [{ model: "deepseek-flash", inputTokens: 1000, cacheReadTokens: 4000, outputTokens: 500, estimatedCostCny: 0.0012 }] },
      { date: "2026-09-17", models: [{ model: "deepseek-flash", inputTokens: 3000, cacheReadTokens: 100, outputTokens: 700, estimatedCostCny: 0.0042 }] },
    ],
    generatedAt: ISO,
    truncated: false,
    totals: { inputTokens: 4000, cacheReadTokens: 4100, outputTokens: 1200, estimatedCostCny: 0.0054 },
    // Host-side diagnostics that the route must NOT put on the wire (captain L3).
    estimated: true,
    priceSource: { url: "internal", fetchedOn: "2026-09-17" },
    ledger: { available: true },
  };
}

test("cross-half: the popover renders what the real host routes answer", async () => {
  const host = await startHostFamily({
    aggregate: async ({ days }) => ledgerPayload(days),
    balance: { ok: true, currency: "CNY", totalBalance: 12.3, grantedBalance: 2, toppedUpBalance: 10.3, isAvailable: true, fetchedAt: ISO, cached: false },
  });
  try {
    const bridge = originBoundFetch(host.origin);
    const service = createBalanceService({ fetchImpl: bridge.fetchImpl, now: () => 7 });
    const { doc } = domWithRoot();
    const handle = openUsageModal({ snapshot: { state: MODAL_STATES.loading }, service }, { document: doc, now: () => ISO_MS });
    await waitFor(() => doc.querySelectorAll(`[${MODAL_ATTR.chart}]`).length === 2);
    await waitFor(() => /¥12\.30/.test(textOf(doc.querySelector(`[${MODAL_ATTR.balance}]`))));

    // The card and both charts came from real HTTP responses.
    assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.balance}]`)), /¥12\.30/);
    assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.chart}]`).length, 2);
    assert.equal(doc.querySelectorAll("rect.dsh-deepseek-usage-bar").length, 2, "one bar per day the host returned");
    assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.models}] tbody tr`).length, 1);
    assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.models}]`)), /deepseek-flash/);
    assert.match(textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`)), /生成于 2026-09-17/, "the host's generatedAt reached the panel");
    assert.deepEqual(host.requests.filter((path) => path === ROUTES.usage).length, 1);
    assert.deepEqual(host.requests.filter((path) => path === ROUTES.balance).length, 1);
    for (const call of bridge.calls) assert.ok(call.url.startsWith("/api/dsh-deepseek-usage/"), call.url);

    // The wire carries the six contract fields only: the estimate label in the DOM is
    // static copy, because there is no `estimated`/`priceSource` flag to read (L3).
    const body = await (await fetch(`${host.origin}${ROUTES.usage}?days=7`)).json();
    assert.deepEqual(Object.keys(body).sort(), ["days", "generatedAt", "ok", "requestedDays", "totals", "truncated"]);
    assert.equal(body.ok, true);
    assert.equal("estimated" in body, false);
    handle.close();
  } finally {
    await host.close();
  }
});

test("cross-half: the host's real error statuses reach the popover as the four states", async () => {
  // 503 ledger_unavailable: the real degraded path when this machine cannot read the
  // local ledger (no Zstandard decoder / unusable payload).
  const degraded = await startHostFamily({
    aggregate: async () => ({ ledger: { available: false, unavailableReason: "no zstd decoder in this build" } }),
    balance: { ok: true, currency: "CNY", totalBalance: 1, isAvailable: true, fetchedAt: ISO, cached: true },
  });
  try {
    const service = createBalanceService({ fetchImpl: originBoundFetch(degraded.origin).fetchImpl });
    const { doc } = domWithRoot();
    const handle = openUsageModal({ snapshot: { state: MODAL_STATES.loading }, service }, { document: doc, now: () => ISO_MS });
    await waitFor(() => /ledger_unavailable/.test(textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`))));
    const usageText = textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`));
    assert.match(usageText, /ledger_unavailable/);
    assert.match(usageText, /HTTP 503/);
    assert.match(usageText, /zstd decoder/);
    assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.chart}]`).length, 0, "a degraded ledger renders no chart at all");
    handle.close();
  } finally {
    await degraded.close();
  }

  // 400 bad_request: the raw window is rejected by the real parser (the popover's own
  // day switch clamps first, so this exercises the frozen error path directly).
  const strict = await startHostFamily({
    aggregate: async ({ days }) => ledgerPayload(days),
    balance: { ok: true, currency: "CNY", totalBalance: 1, isAvailable: true, fetchedAt: ISO, cached: false },
  });
  try {
    const service = createBalanceService({ fetchImpl: originBoundFetch(strict.origin).fetchImpl });
    const rejected = await service.readUsage({ days: 400 });
    assert.equal(rejected.state, MODAL_STATES.error);
    assert.equal(rejected.code, "bad_request");
    assert.equal(rejected.httpStatus, 400);
    assert.equal("days" in rejected, false, "a failure carries the shared failure shape, so the popover must render it as a state, not as data");
    const { doc } = domWithRoot();
    const handle = openUsageModal(
      { snapshot: { state: MODAL_STATES.loading }, service },
      { document: doc, readUsage: () => service.readUsage({ days: 400 }), now: () => ISO_MS },
    );
    await waitFor(() => /bad_request/.test(textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`))));
    const usageText = textOf(doc.querySelector(`[${MODAL_ATTR.usage}]`));
    assert.match(usageText, /bad_request/);
    assert.match(usageText, /HTTP 400/);
    handle.close();
  } finally {
    await strict.close();
  }
});

/* ================================================================== *
 * 4b. theme tokens, contrast and readability (T15)
 * ================================================================== */

test("theme: every --dsw-* name in MODAL_CSS is one the shell itself uses", () => {
  const vocabulary = shellTokenVocabulary();
  if (vocabulary.source !== "fallback") {
    for (const name of SHELL_TOKEN_FALLBACK) {
      assert.ok(vocabulary.names.has(name), `${name} is in our fallback list but not in the shell's stylesheet — one of the two is wrong`);
    }
    assert.ok(vocabulary.names.size >= 70, `expected the shell's whole vocabulary, saw ${vocabulary.names.size} names`);
  }
  const used = cssTokenNames(MODAL_STYLE_TEXT);
  assert.ok(used.length >= 15, `expected a token-driven stylesheet, saw ${used.length} names`);
  const unknown = used.filter((name) => !vocabulary.names.has(name));
  assert.deepEqual(unknown, [], `MODAL_CSS references names the shell does not define (vocabulary: ${vocabulary.source})`);
});

test("theme: the three dead token names are gone and their replacements are in place", () => {
  for (const dead of DEAD_TOKENS) {
    assert.ok(!MODAL_CSS.includes(dead), `${dead} does not exist in the shell and must not come back`);
  }
  // The mapping an earlier revision got wrong, pinned name by name.
  assert.ok(MODAL_CSS.includes("background:var(--dsw-alias-bg-layer-2)"), "panel background: bg-elevated → bg-layer-2 (the layer the shell's own dialog paints)");
  assert.ok(MODAL_CSS.includes("var(--dsw-alias-border-l2)"), "dividers: border-secondary → border-l2");
  assert.ok(MODAL_CSS.includes("var(--dsw-alias-border-l3)"), "outlined controls: border-secondary → border-l3 (the shell's own `.outline`)");
  assert.ok(MODAL_CSS.includes("var(--dsw-alias-state-warn-primary)"), "warning accent: status-warning → state-warn-primary");
  // …and the module's executable code is grep-clean as well: the names may only survive
  // in the doc comment that records why they were removed.
  const code = stripJsComments(readFileSync(join(PACKAGE_ROOT, "src", "client", "modal.mjs"), "utf8"));
  for (const dead of DEAD_TOKENS) assert.ok(!code.includes(dead), `${dead} still appears in executable code`);
});

test("theme: MODAL_CSS has no literal colour and no colour fallback", () => {
  // The gates run over the WHOLE injected string: the chart interaction's rules ship in
  // the same `<style>` element, so they are subject to the same discipline.
  assert.deepEqual(cssColorLiterals(MODAL_CSS), [], "a literal colour cannot follow the theme");
  assert.deepEqual(cssColorLiterals(CHART_INTERACTION_CSS), [], "the chart interaction's rules carry no literal colour either");
  // A font stack is not a theme value (the shell's own rule passes the same fallback);
  // a COLOUR fallback would silently win whenever a token is missing, so it is banned.
  const fallbacks = [...MODAL_STYLE_TEXT.matchAll(/var\((?!--dsw-font-family)[^)]*,/g)].map((match) => match[0]);
  assert.deepEqual(fallbacks, [], "a hardcoded colour fallback defeats the token indirection");
  assert.ok(MODAL_STYLE_TEXT.includes("var(--dsw-font-family,"), "the font-family fallback mirrors the shell's own rule");
  for (const dead of DEAD_TOKENS) assert.ok(!MODAL_STYLE_TEXT.includes(dead), `${dead} must not reappear in the injected text`);
  // The interaction's hint line must not use the dimmed token: this suite measured it at
  // 1.45:1 (dark) / 1.26:1 (light), i.e. unusable for text (captain revision 5). It also
  // must not stay on `label-tertiary`: on the tooltip's own layer that measures 3.71:1
  // (light), below the 4.5:1 body-text floor, so every line inside the bubble is now
  // `label-primary` (18.90:1) or `label-secondary` (5.80:1).
  assert.ok(!CHART_INTERACTION_CSS.includes("--dsw-alias-label-dimmed"), "label-dimmed is not a text colour");
  assert.match(CHART_INTERACTION_CSS, /\.dsh-deepseek-usage-tooltip-hint\{margin-top:2px;color:var\(--dsw-alias-label-secondary\)\}/);
});

test("theme: the panel paints an opaque shell layer, the backdrop is the shell's own mask", () => {
  assert.match(MODAL_CSS, /\.dsh-deepseek-usage-panel\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/);
  assert.match(MODAL_CSS, /\.dsh-deepseek-usage-panel\{[^}]*box-shadow:var\(--dsw-elevation-prominent\)/);
  assert.match(MODAL_CSS, /\.dsh-deepseek-usage-overlay\{[^}]*background:var\(--dsw-alias-bg-mask-1\)/);
  assert.match(MODAL_CSS, /\.dsh-deepseek-usage-overlay\{[^}]*backdrop-filter:var\(--dsw-mask-blur\)/);
  const theme = resolveThemeTokens();
  if (!theme.available) {
    assert.ok(true, `shell theme not installed at ${SHELL_THEME}; the layer name is pinned above`);
    return;
  }
  for (const which of ["light", "dark"]) {
    const panel = parseColor(resolveTokenValue(theme, which, "--dsw-alias-bg-layer-2"));
    assert.ok(panel, `${which}: bg-layer-2 resolves`);
    assert.equal(panel.a, 1, `${which}: the panel layer must be opaque, otherwise the text sits on whatever is behind it`);
  }
});

test("theme: text colour comes only from label tokens, state colours stay accents", () => {
  // `(?<![-\w])` is load-bearing: without it `border-color:` looks like a text colour,
  // and the check would ask a border token to satisfy a text-contrast rule.
  const declarations = [...MODAL_CSS.matchAll(/(?<![-\w])color:([^;}]+)/g)].map((match) => match[1].trim());
  assert.ok(declarations.length >= 8, `expected several text-colour declarations, saw ${declarations.length}`);
  for (const value of declarations) {
    if (value === "inherit" || value === "currentColor") continue;
    const token = /var\((--dsw-[a-z0-9-]+)\)/.exec(value);
    assert.ok(token, `color:${value} is not a token`);
    assert.match(
      token[1],
      /^--dsw-alias-label-/,
      `color:${value} is not a label token — the state/brand colours measure below 4.5:1 on the light panel`,
    );
  }
  // Borders, in turn, must use a border token (or `transparent`), never a label colour.
  const borderColors = [...MODAL_CSS.matchAll(/(?<![-\w])border-color:([^;}]+)/g)].map((match) => match[1].trim());
  for (const value of borderColors) {
    assert.match(value, /^var\(--dsw-alias-border-l[0-9]\)$/, `border-color:${value} must be a shell border token`);
  }
  assert.ok(MODAL_CSS.includes("border-color:var(--dsw-alias-border-l3)"), "the selected day tab keeps its outlined border");
  // Chart axis labels are text too (SVG text uses `fill`).
  assert.match(MODAL_CSS, /\.dsh-deepseek-usage-axis\{fill:var\(--dsw-alias-label-secondary\)/);
  // The state colours are still used — as non-text accents, which is what they can carry.
  assert.match(MODAL_CSS, /data-tone='warn'\]:before\{[^}]*background:var\(--dsw-alias-state-warn-primary\)/);
  assert.match(MODAL_CSS, /\.dsh-deepseek-usage-error\{[^}]*border-left:2px solid var\(--dsw-alias-state-error-primary\)/);
});

test("theme: every pairing the popover paints clears its tier in BOTH themes", () => {
  const theme = resolveThemeTokens();
  if (!theme.available) {
    assert.ok(true, `shell theme not installed at ${SHELL_THEME}; names are still gated by the vocabulary test`);
    return;
  }
  const PANEL = "--dsw-alias-bg-layer-2";
  const pairings = [
    // [what, foreground token, background token, minimum WCAG ratio]
    ["body text", "--dsw-alias-label-primary", PANEL, 4.5],
    ["card labels / secondary text", "--dsw-alias-label-secondary", PANEL, 4.5],
    ["tertiary captions", "--dsw-alias-label-tertiary", PANEL, 3],
    ["table header", "--dsw-alias-label-secondary", PANEL, 4.5],
    ["primary button label", "--dsw-alias-label-primary-foreground", "--dsw-alias-button-primary-fill", 4.5],
    ["section divider l2", "--dsw-alias-border-l2", PANEL, 1.2],
    ["outlined control l3", "--dsw-alias-border-l3", PANEL, 1.2],
    ["hover fill", "--dsw-alias-interactive-bg-hover", PANEL, 1.05],
    ["selected tab fill", "--dsw-alias-button-ghost-active-fill", PANEL, 1.05],
    ["chart stroke / focus ring", "--dsw-alias-brand-primary", PANEL, 3],
  ];
  const measured = [];
  for (const which of ["light", "dark"]) {
    assert.ok(parseColor(resolveTokenValue(theme, which, PANEL)), `${which}: ${PANEL} resolves`);
    for (const [what, fgName, bgName, min] of pairings) {
      const fg = parseColor(resolveTokenValue(theme, which, fgName));
      const bg = parseColor(resolveTokenValue(theme, which, bgName));
      assert.ok(fg && bg, `${which}: ${what} — ${fgName} on ${bgName} must resolve; an unresolvable token is the bug this task fixes`);
      const value = contrastRatio(fg, bg);
      measured.push(`${which} ${what} ${value.toFixed(2)}:1`);
      assert.ok(value >= min, `${which} theme: ${what} is ${value.toFixed(2)}:1 (needs >= ${min}) for ${fgName} on ${bgName}`);
    }
  }
  assert.equal(measured.length, pairings.length * 2, `expected both themes × every pairing, measured: ${measured.join(", ")}`);
});

test("theme: the injected stylesheet is well-formed", () => {
  // A hand-joined array of strings: a missing `;` or an unbalanced brace makes the
  // browser drop rules silently, which is exactly how a colour can vanish.
  for (const [name, css] of [
    ["MODAL_CSS", MODAL_CSS],
    ["CHART_INTERACTION_CSS", CHART_INTERACTION_CSS],
    ["MODAL_STYLE_TEXT", MODAL_STYLE_TEXT],
  ]) {
    assert.equal((css.match(/{/g) ?? []).length, (css.match(/}/g) ?? []).length, `${name}: balanced braces`);
    assert.ok(!css.includes("{}"), `${name}: no empty rule`);
    assert.ok(!css.includes(";;"), `${name}: no empty declaration`);
    assert.ok(!css.includes("undefined"), `${name}: a joined array must not smuggle \`undefined\` in`);
    for (const rule of css.matchAll(/\{[^}]*\}/g)) {
      const body = rule[0].slice(1, -1);
      // CSS lets the final declaration omit its `;`, so only the segments BETWEEN
      // terminators are checked — each must still be `property:value`, which catches a
      // joined string that lost its `:` or produced an empty declaration.
      for (const segment of body.split(";").map((part) => part.trim()).filter((part) => part !== "")) {
        assert.match(segment, /^[a-z-]+:\S/, `${name}: malformed declaration ${JSON.stringify(segment)} in ${rule[0]}`);
      }
    }
  }
});

/* ================================================================== *
 * 4c. the chart interaction is WIRED (captain revision 5)
 * ================================================================== */

test("interaction: the popover really calls the chart binder (no unreachable module)", async () => {
  // Source level: the call site lives in modal.mjs, not only in chart.mjs's exports.
  const source = stripJsComments(readFileSync(join(PACKAGE_ROOT, "src", "client", "modal.mjs"), "utf8"));
  assert.match(source, /attachChartInteraction\(\{/, "modal.mjs must call the binder");
  assert.match(source, /attachChartInteractions\(doc, panel, model, liveCharts\)/, "…once per render");
  assert.ok(source.includes("chart.update({ geometry, payload, marker })"), "the documented update() path is exercised");
  assert.ok(source.includes("chart.destroy()"), "the previous binders are destroyed, so listeners cannot accumulate");
  // Bundle level: the composed classic script carries the call, not just the definition.
  const bundle = stripWs(readFileSync(BUNDLE_PATH, "utf8"));
  assert.match(bundle, /attachChartInteractions\(doc,panel,model,liveCharts\)/, "the composed script wires the charts");
  assert.ok(bundle.includes(stripWs("CHART_INTERACTION_CSS")), "…and merges the interaction stylesheet");
  assert.match(bundle, /MODAL_STYLE_TEXT=`\$\{MODAL_CSS\}\$\{CHART_INTERACTION_CSS\}`/);
});

test("interaction: both charts get hit targets, tooltips and a keyboard-reachable root", async () => {
  const { doc } = domWithRoot();
  const handle = openUsageModal(
    { snapshot: normalizeBalancePayload(BALANCE_BODY) },
    { document: doc, readUsage: async () => normalizeUsagePayload(USAGE_BODY) },
  );
  await tick();
  assert.equal(doc.querySelectorAll(`.${CHART_INTERACTION.hitLayerClass}`).length, 2, "one hit layer per chart");
  assert.equal(doc.querySelectorAll(`.${CHART_INTERACTION.tooltipClass}`).length, 2, "one tooltip per chart");
  assert.equal(doc.querySelectorAll(`.${CHART_INTERACTION.hitClass}`).length, 4, "USAGE_BODY has two days × two charts");
  const kinds = [];
  for (const svg of doc.querySelectorAll(`[${MODAL_ATTR.chart}]`)) {
    kinds.push(svg.getAttribute(MODAL_ATTR.chart));
    assert.equal(svg.getAttribute("tabindex"), "0", "without tabindex the keyboard path is unreachable and hover is the only way in");
    assert.equal(svg.getAttribute("role"), "group");
    assert.match(svg.getAttribute("aria-label"), /每日用量图表/);
    // Two owners, two attributes: the binder marks the root it took over, and it must
    // NOT be the name the renderer uses for the view it drew (it writes "1" in there).
    assert.equal(svg.getAttribute(CHART_INTERACTION.rootAttr), "1", "the binder marks the root it owns");
    assert.notEqual(MODAL_ATTR.chart, CHART_INTERACTION.rootAttr, "the renderer's marker must not share the binder's attribute name");
  }
  assert.deepEqual(kinds.sort(), ["cost", "tokens"], "both views stay identifiable after the binder took the root over");
  const tooltip = doc.querySelector(`.${CHART_INTERACTION.tooltipClass}`);
  // The tooltip must START hidden (an empty bubble hanging over the chart on open is the
  // user-visible failure this pins). The binder sets both the attribute and the property.
  assert.equal(tooltip.hidden, true, "the tooltip property is true before any interaction");
  assert.notEqual(tooltip.getAttribute(CHART_INTERACTION.hiddenAttr), null, "…and the hidden attribute is present");
  assert.equal(tooltip.parentNode.getAttribute("class").includes("dsh-deepseek-usage-figure"), true, "the tooltip hangs off the figure");

  // A window switch rebuilds the panel: the previous binders must be destroyed, so the
  // counts stay put instead of silently accumulating listeners and tooltips.
  doc.querySelector(`[${MODAL_ATTR.days}="7"]`).dispatchEvent(fakeEvent("click").event);
  await tick();
  assert.equal(doc.querySelectorAll(`.${CHART_INTERACTION.hitLayerClass}`).length, 2, "no accumulation after a rebuild");
  assert.equal(doc.querySelectorAll(`.${CHART_INTERACTION.tooltipClass}`).length, 2, "no orphan tooltips after a rebuild");
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.chart}]`).length, 2);
  handle.close();
  assert.equal(doc.querySelectorAll(`.${CHART_INTERACTION.tooltipClass}`).length, 0, "closing destroys the charts");
});

test("interaction: the payload travels with the view model so tooltips need no second read", () => {
  const text = modalText(undefined);
  const panel = describeUsagePanel(normalizeUsagePayload(USAGE_BODY), text, ISO_MS);
  assert.ok(panel.payload, "the raw envelope is carried");
  assert.equal(panel.payload.days.length, 2);
  assert.equal(panel.charts.tokens.count, 2);
  // Without a payload the charts are simply not wired — attachChartInteractions degrades.
  assert.deepEqual(attachChartInteractions(undefined, undefined, undefined, []), []);
  assert.deepEqual(attachChartInteractions({}, { querySelector: () => null }, { usage: { charts: null } }, []), []);
});

/* ------------------------------------------------------------------ *
 * tooltip placement: the live defect, pinned
 *
 * The shipped popover placed the bubble with SVG USER coordinates while its
 * containing block was the `position:fixed` overlay, so a pointer at (865, 603)
 * drew the tooltip at (340, 74) — the top-left corner of the screen. A real
 * browser measured `viewBox="0 0 640 220"` rendered into a 672×231 box (scale
 * 1.05), so user units are not CSS pixels either. These tests use a double whose
 * CTM carries exactly that scale and origin, which is what makes them able to
 * fail if the translation ever regresses to a bare subtraction.
 * ------------------------------------------------------------------ */

/**
 * An SVG double whose CTM carries a real scale + origin, as the live chart does.
 * @param doc - the fake document.
 * @param host - the figure the SVG is appended to.
 * @param options - `{ left, top, scale }` of the rendered box.
 * @returns the SVG node.
 */
function attachFixedSvgDouble(doc, host, { left = 448, top = 499, scale = 1.05 } = {}) {
  const svg = doc.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 640 220");
  svg.setAttribute("width", "640");
  svg.setAttribute("height", "220");
  svg.getBoundingClientRect = () => ({ left, top, width: 640 * scale, height: 220 * scale, right: left + 640 * scale, bottom: top + 220 * scale });
  svg.getScreenCTM = () => ({
    a: scale,
    b: 0,
    c: 0,
    d: scale,
    e: left,
    f: top,
    inverse: () => ({ a: 1 / scale, b: 0, c: 0, d: 1 / scale, e: -left / scale, f: -top / scale }),
    transformPoint: (point) => ({ x: left + point.x * scale, y: top + point.y * scale }),
  });
  svg.createSVGPoint = () => ({
    x: 0,
    y: 0,
    matrixTransform(matrix) {
      return { x: matrix.a * this.x + matrix.c * this.y + matrix.e, y: matrix.b * this.x + matrix.d * this.y + matrix.f };
    },
  });
  host.appendChild(svg);
  return svg;
}

const TOOLTIP_PAYLOAD = {
  days: [
    { date: "2026-09-15", models: [{ model: "deepseek-chat", inputTokens: 100, cacheReadTokens: 0, outputTokens: 0 }] },
    { date: "2026-09-16", models: [{ model: "deepseek-chat", inputTokens: 300, cacheReadTokens: 0, outputTokens: 0 }] },
    { date: "2026-09-17", models: [{ model: "deepseek-chat", inputTokens: 500, cacheReadTokens: 0, outputTokens: 0 }] },
  ],
};
const TOOLTIP_POINTS = [
  { label: "2026-09-15", value: 100 },
  { label: "2026-09-16", value: 300 },
  { label: "2026-09-17", value: 500 },
];

test("chart tooltip: a real chart places it in viewport pixels and follows the pointer", () => {
  // Every browser defines it; the binder reads it to keep the bubble on screen.
  const hadInnerWidth = Object.prototype.hasOwnProperty.call(globalThis, "innerWidth");
  const previousInnerWidth = globalThis.innerWidth;
  globalThis.innerWidth = 1600;
  try {
    const doc = createFakeDom();
    const host = doc.createElement("figure");
    doc.body.appendChild(host);
    const svg = attachFixedSvgDouble(doc, host);
    const geometry = buildChartGeometry(TOOLTIP_POINTS);
    const chart = chartModule.attachChartInteraction({
      doc,
      svg,
      root: host,
      getState: () => ({ geometry, payload: TOOLTIP_PAYLOAD }),
      measure: () => ({ left: 448, top: 499 }),
    });

    // The bubble leaves the host entirely: only `document.body` is free of the
    // transformed/filtered ancestors that would re-anchor a `position:fixed` box.
    const tooltip = doc.querySelector(`.${CHART_INTERACTION.tooltipClass}`);
    assert.ok(tooltip, "the binder creates a tooltip");
    assert.equal(tooltip.parentNode, doc.body, "the viewport-positioned tooltip is attached to document.body, not the figure");
    assert.equal(tooltip.getAttribute(CHART_INTERACTION.tooltipFixedAttr), "1", "…and is marked as viewport-positioned");

    // Hover exactly ON the middle day's marker, which sits well inside the plot so the
    // bubble lands ABOVE it (the flip is asserted on its own below). The bubble is
    // anchored to the DAY'S DATA POINT — the thing the active dot highlights — not to
    // the raw pointer; with the real 30-day window those are ~19px apart, and this test
    // keeps them identical so the arithmetic pins the translation, not a coincidence.
    const middle = geometry.points[1];
    const clientX = 448 + middle.x * 1.05;
    const clientY = 499 + middle.y * 1.05;
    const { event } = fakeEvent("pointermove", { clientX, clientY });
    svg.dispatchEvent(event);

    assert.equal(chart.getActiveIndex(), 1, "the pointer maps to the hovered day through the CTM, not by subtracting the origin");
    assert.equal(chart.isVisible(), true, "the tooltip is open");
    assert.equal(tooltip.getAttribute("hidden"), null, "…and not hidden");
    assert.match(textOf(tooltip), /2026-09-16/, "…and shows the hovered day");
    const left = Number.parseFloat(tooltip.style.left);
    const top = Number.parseFloat(tooltip.style.top);
    assert.ok(Number.isFinite(left) && Number.isFinite(top), `left/top must be finite pixels, saw ${tooltip.style.left} / ${tooltip.style.top}`);
    // Viewport space: the marker sits at clientX and the bubble centres on it. The
    // tolerance covers the half-width the fake box reports (its `min-width` padding is
    // not a real layout); the defect this pins was 611px — the old user-space placement
    // wrote x≈626 into a viewport-anchored box.
    assert.ok(Math.abs(left - clientX) <= 16, `left=${left} must sit on the pointer (clientX=${clientX})`);
    assert.ok(Math.abs(top - (clientY - 12)) <= 1, `top=${top} must sit one offset above the marker (${clientY - 12})`);
    assert.equal(tooltip.style.transform, "translate(-50%, -100%)");
    assert.equal(tooltip.getAttribute("data-side"), "top");
    chart.destroy();
    assert.equal(doc.querySelector(`.${CHART_INTERACTION.tooltipClass}`), null, "destroy removes the bubble from the body it was attached to");
  } finally {
    if (hadInnerWidth) globalThis.innerWidth = previousInnerWidth;
    else delete globalThis.innerWidth;
  }
});

test("chart tooltip: a marker at the plot's top flips the bubble below itself", () => {
  const hadInnerWidth = Object.prototype.hasOwnProperty.call(globalThis, "innerWidth");
  const previousInnerWidth = globalThis.innerWidth;
  globalThis.innerWidth = 1600;
  try {
    const doc = createFakeDom();
    const host = doc.createElement("figure");
    doc.body.appendChild(host);
    const svg = attachFixedSvgDouble(doc, host);
    const geometry = buildChartGeometry(TOOLTIP_POINTS);
    const chart = chartModule.attachChartInteraction({
      doc,
      svg,
      root: host,
      getState: () => ({ geometry, payload: TOOLTIP_PAYLOAD }),
    });
    const tooltip = doc.querySelector(`.${CHART_INTERACTION.tooltipClass}`);
    // The last day is the series maximum, so its marker sits on the plot's top edge.
    const top = geometry.points[2];
    const clientY = 499 + top.y * 1.05;
    const { event } = fakeEvent("pointermove", { clientX: 448 + top.x * 1.05, clientY });
    svg.dispatchEvent(event);
    assert.equal(chart.getActiveIndex(), 2);
    assert.equal(tooltip.getAttribute("data-side"), "bottom", "no room above means the bubble goes below");
    assert.equal(tooltip.style.transform, "translate(-50%, 0)");
    assert.ok(Number.parseFloat(tooltip.style.top) > clientY, `top=${tooltip.style.top} must be below the marker (${clientY})`);
    chart.destroy();
  } finally {
    if (hadInnerWidth) globalThis.innerWidth = previousInnerWidth;
    else delete globalThis.innerWidth;
  }
});

test("chart tooltip: without a screen CTM it degrades to the host-anchored placement", () => {
  const doc = createFakeDom();
  const host = doc.createElement("figure");
  doc.body.appendChild(host);
  // No measurable box and no CTM — the shape the older suites use.
  const svg = doc.createElementNS(SVG_NAMESPACE, "svg");
  host.appendChild(svg);
  const geometry = buildChartGeometry(TOOLTIP_POINTS);
  const chart = chartModule.attachChartInteraction({
    doc,
    svg,
    root: host,
    getState: () => ({ geometry, payload: TOOLTIP_PAYLOAD }),
    measure: () => ({ left: 0, top: 0 }),
  });
  const tooltip = doc.querySelector(`.${CHART_INTERACTION.tooltipClass}`);
  assert.equal(tooltip.parentNode, host, "no viewport coordinates means the bubble stays in the host container");
  assert.equal(tooltip.getAttribute(CHART_INTERACTION.tooltipFixedAttr), null, "…and is not marked as viewport-positioned");
  const markerX = 626;
  const { event } = fakeEvent("pointermove", { clientX: markerX, clientY: 12 });
  svg.dispatchEvent(event);
  assert.equal(chart.getActiveIndex(), 2, "the fallback still hit-tests the right day");
  // User units, as before: the pure placement function's own answer (which clamps
  // into the PLOT box, not the whole 640px viewBox — so 626 lands on 632).
  const expected = chartModule.tooltipPlacement(geometry, { markerX, markerY: 12 }, {});
  assert.equal(Number.parseFloat(tooltip.style.left), expected.left, "the fallback keeps the old, user-space placement");
  assert.ok(Number.parseFloat(tooltip.style.left) > geometry.width / 2, "…which is in user units, not viewport pixels");
  chart.destroy();
});

test("bundle: the composed classic script carries the viewport tooltip placement", () => {
  const bundle = readFileSync(BUNDLE_PATH, "utf8");
  assert.match(bundle, /data-dsh-usage-tooltip-fixed/, "the viewport marker survives composition");
  assert.match(bundle, /\.dsh-deepseek-usage-tooltip\[data-dsh-usage-tooltip-fixed\]\{position:fixed\}/, "…and so does the rule that makes it fixed");
  assert.match(bundle, /getScreenCTM/, "the coordinate translation is inlined, not left in the sources");
});

/* ================================================================== *
 * 5. the composed classic-script bundle
 * ================================================================== */

/**
 * The composer's transformation, restated so the test can prove the inlined copy
 * equals the sources (same rule as `tests/ui-row.test.mjs`).
 * @param text - one source module.
 * @returns the flattened module body.
 */
function flattenSource(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^import\s.*from\s+"\.\/[A-Za-z0-9_.-]+\.mjs";\s*$/.test(line))
    .map((line) => line.replace(/^export\s+(default\s+)?/, ""))
    .join("\n");
}

test("bundle: chart.mjs and modal.mjs are inlined byte-for-byte", () => {
  const composed = stripWs(readFileSync(BUNDLE_PATH, "utf8"));
  for (const name of CLIENT_SOURCES) {
    const source = readFileSync(join(PACKAGE_ROOT, "src", "client", name), "utf8");
    const flattened = stripWs(flattenSource(source));
    assert.ok(flattened.length > 500, `${name} has a real body`);
    assert.ok(composed.includes(flattened), `${name} has drifted from lib/client.js — recompose the browser half`);
  }
  for (const name of NEW_SOURCES) {
    assert.match(readFileSync(join(PACKAGE_ROOT, "src", "client", name), "utf8"), /^export /m, `${name} keeps line-start exports`);
    assert.match(composed, new RegExp(`begin:src/client/${name.replace(".", "\\.")}`), `${name} keeps its section marker`);
  }
});

test("bundle: the row's drift guard also covers the popover modules", () => {
  // A "false green" would be a guard that never looks at the new modules.
  const guard = readFileSync(join(PACKAGE_ROOT, "tests", "ui-row.test.mjs"), "utf8");
  const declared = /const CLIENT_SOURCES = \[([^\]]*)\]/.exec(guard);
  assert.ok(declared, "tests/ui-row.test.mjs declares CLIENT_SOURCES");
  for (const name of NEW_SOURCES) {
    assert.ok(declared[1].includes(`"${name}"`), `tests/ui-row.test.mjs must list ${name} in CLIENT_SOURCES`);
  }
});

test("bundle: every exported function of the popover modules is the composed one", () => {
  const composed = stripWs(readFileSync(BUNDLE_PATH, "utf8"));
  for (const [name, namespace] of [
    ["chart.mjs", chartModule],
    ["modal.mjs", modalModule],
  ]) {
    const entries = Object.entries(namespace).filter(([, value]) => typeof value === "function");
    assert.ok(entries.length > 8, `${name} exports a testable surface`);
    for (const [key, value] of entries) {
      assert.ok(composed.includes(stripWs(value.toString())), `${name} export "${key}" is missing (or stale) in lib/client.js`);
    }
  }
});

test("bundle: the classic script parses, adds no dependency and hides no secret", () => {
  const text = readFileSync(BUNDLE_PATH, "utf8");
  const code = stripJsComments(text);
  assert.doesNotMatch(text, /^\s*(?:import|export)\s/m, "a classic <script> would throw a SyntaxError on ESM syntax");
  assert.doesNotMatch(text, /\bimport\s*\(/, "no dynamic import: /plugins serves only registered bundle URLs");
  assert.doesNotThrow(() => new vm.Script(text, { filename: "lib/client.js" }));
  assert.doesNotMatch(code, /iframe/i, "the platform page refuses framing, so there is nothing to embed");
  assert.doesNotMatch(code, /\bd3\b|mermaid/, "no charting library is pulled in");
  assert.doesNotMatch(text, /api\.deepseek\.com/i, "the browser half never contacts the credential-bearing API host");
  assert.doesNotMatch(text, /\bsk-[A-Za-z0-9_-]{6,}\b/);
  assert.doesNotMatch(text, /localStorage|sessionStorage/);
  assert.doesNotMatch(text, /document\.cookie/);
  // The platform LINK TARGET is the one allowed absolute origin (a user-initiated
  // navigation) and the SVG namespace is an XML identifier that is never fetched;
  // both must appear exactly once, in their frozen form.
  assert.doesNotMatch(text.split(PLATFORM_USAGE_URL).join("").split(SVG_NAMESPACE).join(""), /https?:\/\/(?!127\.0\.0\.1)/, "no other absolute origin");
  assert.match(text, /platform\.deepseek\.com\/usage/);
  assert.match(text, /http:\/\/www\.w3\.org\/2000\/svg/, "the SVG element factory keeps the real namespace");
});

test("bundle: running it registers the row and opens the real popover through the wiring", async () => {
  const text = readFileSync(BUNDLE_PATH, "utf8");
  const { doc, root } = domWithRoot();
  const registrations = [];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/usage")) return jsonResponse(200, USAGE_BODY);
    return jsonResponse(200, BALANCE_BODY);
  };
  const sandbox = {
    console,
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    document: doc,
    window: doc.defaultView,
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(text, sandbox, { filename: "lib/client.js" });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, "dsh-deepseek-usage");

  const { React } = reactHarness();
  const kit = { React, Tooltip: () => null, IconRefreshOutline14: () => null, IconLoadingOutline16: () => null, IconWarningOutline16: () => null, IconGaugeOutline16: () => null };
  const exports = registrations[0].factory((specifier) => {
    if (specifier === "react") return React;
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return kit;
    throw new Error(`client-modules: require("${specifier}") missed the module table`);
  });
  assert.equal(typeof exports.getModalOpener, "function");
  assert.equal(exports.getModalOpener(), undefined, "no opener exists before activation");

  let component;
  exports.apply({
    slots: {
      inject(_key, callback) {
        callback();
      },
      register(_options, registered) {
        component = registered;
      },
    },
  });
  const opener = exports.getModalOpener();
  assert.equal(typeof opener, "function", "the composition wiring publishes the popover opener during apply()");

  const harness = reactHarness();
  const row = harness.render(component, { wide: true });
  await tick();
  const rowNode = findNodes(row, (node) => node.props?.["data-dsh-usage-row"] === ROW_ID);
  assert.equal(rowNode.length, 1);
  // Click the row's body: the row asks its `resolveModal` seat, which must resolve
  // to the popover composed into this very bundle.
  assert.doesNotThrow(() => rowNode[0].props.onClick({ stopPropagation() {}, preventDefault() {} }));
  assert.ok(doc.querySelector(`[${MODAL_ATTR.overlay}]`), "clicking the row opens the popover end to end in the classic script");
  assert.equal(root.inert, true);
  await tick();
  await tick();
  assert.equal(doc.querySelectorAll(`[${MODAL_ATTR.chart}]`).length, 2, "the host's usage envelope reached the charts");
  assert.equal(doc.querySelector(`[${MODAL_ATTR.platform}]`).getAttribute("href"), PLATFORM_USAGE_URL);
  assert.ok(calls.some((url) => url.includes("/api/dsh-deepseek-usage/balance")), "the balance card read this origin's route");
  assert.ok(calls.some((url) => url.includes("/api/dsh-deepseek-usage/usage?days=30")), "the charts read the usage window");
  const { event } = fakeEvent("keydown", { key: "Escape" });
  doc.dispatchEvent(event);
  assert.equal(doc.querySelector(`[${MODAL_ATTR.overlay}]`), null);
  assert.equal(root.inert, false);
});

/* ------------------------------------------------------------------ *
 * A tiny React stand-in for the composed-bundle test (React is a shell
 * seed word and is not resolvable from this package's directory).
 * ------------------------------------------------------------------ */

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

function reactHarness() {
  const hooks = [];
  let cursor = 0;
  let pending = [];
  const React = {
    createElement(type, props, ...children) {
      const flat = [];
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child);
        else if (child !== null && child !== undefined && child !== false) flat.push(child);
      }
      const provided = props?.children;
      const resolved =
        flat.length > 0
          ? flat
          : provided === undefined || provided === null || provided === false
            ? []
            : Array.isArray(provided)
              ? provided
              : [provided];
      return { type, props: { ...(props ?? {}), children: resolved } };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      const slot = index;
      const set = (next) => {
        hooks[slot] = typeof next === "function" ? next(hooks[slot]) : next;
      };
      return [hooks[slot], set];
    },
    useRef(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useCallback(fn, deps) {
      const index = cursor;
      cursor += 1;
      const previous = hooks[index];
      if (previous === undefined || !sameDeps(previous.deps, deps)) hooks[index] = { fn, deps };
      return hooks[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor;
      cursor += 1;
      const previous = hooks[index];
      if (previous === undefined) {
        hooks[index] = { deps };
        pending.push(fn);
      } else if (!sameDeps(previous.deps, deps)) {
        previous.deps = deps;
        pending.push(fn);
      }
    },
  };
  return {
    React,
    render(component, props) {
      cursor = 0;
      const tree = component(props);
      const effects = pending;
      pending = [];
      for (const effect of effects) effect();
      return tree;
    },
  };
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== "object") return;
  visit(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const child of children) walk(child, visit);
}

function findNodes(tree, predicate) {
  const found = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}
