/**
 * dsh-deepseek-usage — browser-half tests (T5: footer balance row + refresh).
 *
 * What this suite freezes:
 *
 *  1. `format.mjs` is pure: money/count/time formatting, missing fields, huge
 *     numbers, unknown currencies — values only, never pixels.
 *  2. `service.mjs` talks ONLY to this origin's `/api/dsh-deepseek-usage/*`:
 *     relative URLs, `same-origin`, no `Authorization`, no key material, and a
 *     four-state result that never rejects.
 *  3. `row.mjs` registers on the sidebar's `sidebar.footer.action` seat (rendered
 *     in the shell's `footArea` BEFORE `sidebar.settings`), renders four distinct
 *     states, retries from the error state, stops propagation on the refresh
 *     button so it cannot bubble into the popover, and degrades to icon + Tooltip
 *     in the rail.
 *  4. `lib/client.js` (the CLASSIC-script bundle) is not stale: every export of
 *     every `src/client/*.mjs` module is proven present, the file parses as a
 *     classic script (ESM syntax would be a SyntaxError), and running it in
 *     `node:vm` registers `sidebar.footer.action` end to end.
 *
 * @module dsh-deepseek-usage/tests/ui-row
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  EMPTY_VALUE,
  PENDING_VALUE,
  currencySymbol,
  formatAmount,
  formatClock,
  formatCompactNumber,
  formatMoney,
  formatRelativeTime,
  groupDigits,
  makeTextLookup,
  normalizeCurrency,
  toFiniteNumber,
  toTimestamp,
} from "../src/client/format.mjs";
import {
  BALANCE_PATH,
  DEFAULT_TIMEOUT_MS,
  ERROR_MESSAGES,
  HEALTH_PATH,
  ROUTE_BASE,
  ROW_STATES,
  USAGE_PATH,
  createBalanceService,
  messageForCode,
  normalizeBalancePayload,
  normalizeFailurePayload,
  normalizeParseFailure,
  normalizeTransportFailure,
  normalizeUsagePayload,
  stateForErrorCode,
} from "../src/client/service.mjs";
import {
  ROW_CSS,
  ROW_DICTIONARY,
  ROW_ID,
  ROW_LOCALE_NAMESPACE,
  ROW_ORDER,
  ROW_SLOT,
  ROW_STYLE_ID,
  createBalanceRow,
  describeState,
  ensureRowStyles,
  keyActivateHandler,
  refreshClickHandler,
  renderBalanceRow,
  renderRefreshButton,
  rowClickHandler,
  rowText,
  wrapWithTooltip,
} from "../src/client/row.mjs";
import createClientHalf, {
  MODAL_GLOBAL_KEY,
  PLUGIN_INJECT,
  PLUGIN_NAME,
  PRIMITIVES_SPECIFIER,
  REACT_SPECIFIER,
  createModalRuntime,
  getModalOpener,
  installComposedModal,
  optionalRequire,
  pickIcons,
  setModalFactory,
  setModalOpener,
  warnUnavailable,
} from "../src/client/index.mjs";
import * as formatModule from "../src/client/format.mjs";
import * as serviceModule from "../src/client/service.mjs";
import * as rowModule from "../src/client/row.mjs";
import * as indexModule from "../src/client/index.mjs";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_SOURCES = ["format.mjs", "service.mjs", "row.mjs", "index.mjs", "chart.mjs", "modal.mjs"];
const BUNDLE_PATH = join(PACKAGE_ROOT, "lib", "client.js");
const ISO = "2026-09-17T20:31:05";
const ISO_MS = Date.parse(ISO);

/** Collapse all whitespace: the equivalence check is whitespace-insensitive. */
function stripWs(text) {
  return String(text).replace(/\s+/g, "");
}

/**
 * Remove `//` and `/* … *\/` comments with a small scanner, so the "no key material"
 * assertions talk about the EXECUTABLE half rather than about documentation that
 * quotes the rule. Strings/templates are preserved verbatim.
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

/* ------------------------------------------------------------------ *
 * A minimal React + tree harness (React itself is a shell seed word and
 * is not resolvable from this package's directory, so the tests supply a
 * stand-in that implements exactly the hooks the row uses).
 * ------------------------------------------------------------------ */

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

function createReactStub() {
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
      // React accepts either variadic children or `props.children`; our row uses
      // both (the Tooltip wrapper passes `children` inside the props object).
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
    /** Render one component, then run the effects it newly scheduled. */
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

function textOf(node) {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (node === null || node === undefined || typeof node !== "object") return "";
  const children = node.props?.children;
  if (!Array.isArray(children)) return "";
  return children.map(textOf).join("");
}

/** A Tooltip stand-in that records the label it was handed. */
function TooltipStub(props) {
  return null;
}

/** Icon stand-ins. */
function IconStub() {
  return null;
}

function rowDeps(extra = {}) {
  const harness = createReactStub();
  return {
    harness,
    deps: {
      React: harness.React,
      Tooltip: TooltipStub,
      icons: { refresh: IconStub, loading: IconStub, warning: IconStub, balance: IconStub },
      ...extra,
    },
  };
}

function viewFor(status, snapshot, extra = {}) {
  const view = describeState(status, snapshot, rowText(undefined), ISO_MS);
  return Object.assign(view, { wide: true, hint: "", onRefresh() {}, onOpen() {} }, extra);
}

/** A fake DOM event that records propagation control. */
function fakeEvent(extra = {}) {
  const record = { stopPropagation: 0, preventDefault: 0 };
  return {
    record,
    event: {
      stopPropagation() {
        record.stopPropagation += 1;
      },
      preventDefault() {
        record.preventDefault += 1;
      },
      ...extra,
    },
  };
}

/** One JSON response stand-in. */
function jsonResponse(status, body) {
  return {
    status,
    async json() {
      if (body === undefined) throw new SyntaxError("Unexpected token < in JSON at position 0");
      return body;
    },
  };
}

/** A fetch spy: records every call and answers from a url table. */
function createFetchSpy(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return { calls, fetchImpl };
}

const READY_BODY = Object.freeze({
  ok: true,
  currency: "CNY",
  totalBalance: 12.3,
  grantedBalance: 2,
  toppedUpBalance: 10.3,
  isAvailable: true,
  fetchedAt: new Date(ISO_MS).toISOString(),
  cached: false,
});

/* ================================================================== *
 * 1. format.mjs — pure formatting
 * ================================================================== */

test("format: formatAmount renders grouped money", () => {
  assert.equal(formatAmount(12.3), "12.30");
  assert.equal(formatAmount(0), "0.00");
  assert.equal(formatAmount(1234567.891), "1,234,567.89");
  assert.equal(formatAmount(-1234.5), "-1,234.50");
  assert.equal(formatAmount("42.5"), "42.50");
  assert.equal(formatAmount("  7  "), "7.00");
  assert.equal(formatAmount(999.999), "1,000.00");
  assert.equal(formatAmount(-0.001), "0.00", "a rounded-away value must not keep the minus sign");
  assert.equal(formatAmount(1, 3), "1.000");
  assert.equal(formatAmount(1, 0), "1");
  assert.equal(formatAmount(1, 99), "1.00", "an out-of-range decimals argument falls back to 2");
  assert.equal(formatAmount(1, -1), "1.00");
});

test("format: formatAmount degrades to the placeholder for missing fields", () => {
  for (const junk of [undefined, null, "", "   ", "abc", NaN, Infinity, -Infinity, {}, [], true, false]) {
    assert.equal(formatAmount(junk), EMPTY_VALUE, `expected placeholder for ${JSON.stringify(junk) ?? String(junk)}`);
  }
  assert.equal(EMPTY_VALUE, "—");
});

test("format: formatAmount survives huge numbers", () => {
  assert.equal(formatAmount(1e15), "1,000,000,000,000,000.00");
  assert.equal(formatAmount(Number.MAX_SAFE_INTEGER), "9,007,199,254,740,991.00");
  assert.equal(formatAmount(1e21), "1.00e+21", "toFixed switches to exponential here");
  assert.equal(formatAmount(1e21, 0), "1e+21");
  assert.equal(formatAmount(-1e21, 0), "-1e+21");
  assert.equal(formatAmount("1e21"), "1.00e+21");
});

test("format: number coercion and digit grouping", () => {
  assert.equal(toFiniteNumber("12"), 12);
  assert.equal(toFiniteNumber(" 1.5 "), 1.5);
  assert.equal(toFiniteNumber(""), null);
  assert.equal(toFiniteNumber("abc"), null);
  assert.equal(toFiniteNumber(NaN), null);
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber({}), null);
  assert.equal(groupDigits("1234567"), "1,234,567");
  assert.equal(groupDigits("12"), "12");
  assert.equal(groupDigits(""), "");
});

test("format: currency normalization and symbols", () => {
  assert.equal(normalizeCurrency("CNY"), "CNY");
  assert.equal(normalizeCurrency("rmb"), "RMB");
  assert.equal(normalizeCurrency(" usd "), "USD");
  assert.equal(normalizeCurrency("CN"), null);
  assert.equal(normalizeCurrency("CNYX"), null);
  assert.equal(normalizeCurrency("¥"), null);
  assert.equal(normalizeCurrency(""), null);
  assert.equal(normalizeCurrency(undefined), null);
  assert.equal(normalizeCurrency(840), null);
  assert.equal(currencySymbol("CNY"), "¥");
  assert.equal(currencySymbol("rmb"), "¥");
  assert.equal(currencySymbol("USD"), "$");
  assert.equal(currencySymbol("XYZ"), null);
  assert.equal(currencySymbol(null), null);
});

test("format: formatMoney with known, unknown and absent currencies", () => {
  assert.equal(formatMoney(12.3, "CNY"), "¥12.30");
  assert.equal(formatMoney(12.3, "rmb"), "¥12.30");
  assert.equal(formatMoney(12.3, "USD"), "$12.30");
  assert.equal(formatMoney(12.3, "XYZ"), "12.30 XYZ");
  assert.equal(formatMoney(12.3, ""), "12.30");
  assert.equal(formatMoney(12.3, undefined), "12.30");
  assert.equal(formatMoney(undefined, "CNY"), EMPTY_VALUE);
  assert.equal(formatMoney("abc", "CNY"), EMPTY_VALUE);
  assert.equal(formatMoney(0, "CNY"), "¥0.00");
});

test("format: formatCompactNumber", () => {
  assert.equal(formatCompactNumber(999), "999");
  assert.equal(formatCompactNumber(1000), "1k");
  assert.equal(formatCompactNumber(12345), "12.3k");
  assert.equal(formatCompactNumber(1e6), "1M");
  assert.equal(formatCompactNumber(1.5e9), "1.5B");
  assert.equal(formatCompactNumber(2.25e12), "2.3T");
  assert.equal(formatCompactNumber(-1500), "-1.5k");
  assert.equal(formatCompactNumber(999999), "999,999", "no 1000k artefact");
  assert.equal(formatCompactNumber(undefined), EMPTY_VALUE);
});

test("format: timestamps and freshness", () => {
  assert.equal(formatClock(ISO), "2026-09-17 20:31");
  assert.equal(formatClock("not a date"), EMPTY_VALUE);
  assert.equal(formatClock(undefined), EMPTY_VALUE);
  assert.equal(toTimestamp(ISO), ISO_MS);
  assert.equal(toTimestamp("nope"), null);
  const iso = new Date(ISO_MS).toISOString();
  assert.equal(formatRelativeTime(iso, ISO_MS), "刚刚");
  assert.equal(formatRelativeTime(iso, ISO_MS + 5_000), "刚刚");
  assert.equal(formatRelativeTime(iso, ISO_MS + 30_000), "30 秒前");
  assert.equal(formatRelativeTime(iso, ISO_MS + 5 * 60_000), "5 分钟前");
  assert.equal(formatRelativeTime(iso, ISO_MS + 2 * 3_600_000), "2 小时前");
  assert.equal(formatRelativeTime(iso, ISO_MS + 3 * 86_400_000), formatClock(ISO), "beyond a day it is absolute");
  assert.equal(formatRelativeTime(iso, ISO_MS - 60_000), "刚刚", "clock skew must not print a negative age");
  assert.equal(formatRelativeTime("nope", ISO_MS), EMPTY_VALUE);
  assert.equal(formatRelativeTime(iso, "not a clock"), EMPTY_VALUE);
});

test("format: the locale seat wins, the built-in dictionary is the fallback", () => {
  assert.equal(makeTextLookup(undefined, { a: "A" })("a"), "A");
  assert.equal(makeTextLookup(undefined, { a: "A" })("zzz"), "zzz");
  assert.equal(makeTextLookup((key) => `loc:${key}`, { a: "A" })("a"), "loc:a");
  assert.equal(makeTextLookup((key) => key, { a: "A" })("a"), "A", "an unregistered namespace returns the key");
  assert.equal(
    makeTextLookup(
      () => {
        throw new Error("broken locale seat");
      },
      { a: "A" },
    )("a"),
    "A",
  );
  assert.equal(makeTextLookup(() => "", { a: "A" })("a"), "A");
  assert.equal(rowText(undefined)("row.label"), "DeepSeek 余额");
  assert.equal(ROW_DICTIONARY["row.retry"], "重试");
});

/* ================================================================== *
 * 2. service.mjs — host route client
 * ================================================================== */

test("service: routes are the host's frozen family, and the code set matches", () => {
  assert.equal(ROUTE_BASE, "/api/dsh-deepseek-usage");
  assert.equal(BALANCE_PATH, "/api/dsh-deepseek-usage/balance");
  assert.equal(USAGE_PATH, "/api/dsh-deepseek-usage/usage");
  assert.equal(HEALTH_PATH, "/api/dsh-deepseek-usage/health");
  assert.equal(DEFAULT_TIMEOUT_MS, 15_000);
  assert.deepEqual(Object.keys(ROW_STATES).sort(), ["error", "loading", "ready", "unconfigured"]);
  assert.deepEqual(
    Object.keys(ERROR_MESSAGES).sort(),
    [
      "bad_request",
      "bad_response",
      "internal",
      "ledger_unavailable",
      "network_error",
      "no_api_key",
      "rate_limited",
      "timeout",
      "unauthorized",
      "upstream_error",
    ],
    "the closed code set frozen by the contract (host BALANCE_ERROR_CODES + the usage route's ledger_unavailable)",
  );
  assert.equal(messageForCode("no_api_key"), ERROR_MESSAGES.no_api_key);
  assert.equal(messageForCode("brand_new_code"), "未知错误（brand_new_code）");
  assert.equal(messageForCode(undefined), "未知错误");
  assert.equal(stateForErrorCode("no_api_key"), ROW_STATES.unconfigured);
  assert.equal(stateForErrorCode("timeout"), ROW_STATES.error);
  assert.equal(stateForErrorCode(null), ROW_STATES.error);
});

test("service: envelope normalization", () => {
  const ready = normalizeBalancePayload(READY_BODY);
  assert.equal(ready.state, ROW_STATES.ready);
  assert.equal(ready.currency, "CNY");
  assert.equal(ready.totalBalance, 12.3);
  assert.equal(ready.isAvailable, true);
  assert.equal(ready.cached, false);
  const sparse = normalizeBalancePayload({ ok: true });
  assert.equal(sparse.state, ROW_STATES.ready);
  assert.equal(sparse.currency, null);
  assert.equal(sparse.totalBalance, null);
  assert.equal(sparse.isAvailable, false);
  assert.equal(sparse.fetchedAt, null);
  const notAnObject = normalizeBalancePayload(undefined);
  assert.equal(notAnObject.state, ROW_STATES.ready);
  assert.equal(notAnObject.totalBalance, null);

  const unconfigured = normalizeFailurePayload(503, { ok: false, error: { code: "no_api_key", message: "no key" } }, "x");
  assert.equal(unconfigured.state, ROW_STATES.unconfigured);
  assert.equal(unconfigured.code, "no_api_key");
  assert.equal(unconfigured.message, "no key");
  assert.equal(unconfigured.httpStatus, 503);
  const upstream = normalizeFailurePayload(502, { ok: false, error: { code: "rate_limited" } }, "fallback");
  assert.equal(upstream.state, ROW_STATES.error);
  assert.equal(upstream.code, "rate_limited");
  assert.equal(upstream.message, ERROR_MESSAGES.rate_limited);
  const bodyless = normalizeFailurePayload(500, "not json", "宿主返回 500");
  assert.equal(bodyless.state, ROW_STATES.error);
  assert.equal(bodyless.code, null);
  assert.equal(bodyless.message, "宿主返回 500");

  const network = normalizeTransportFailure(new Error("boom"), false);
  assert.equal(network.code, "network_error");
  assert.match(network.message, /boom/);
  const timeout = normalizeTransportFailure(new Error("aborted"), true);
  assert.equal(timeout.code, "timeout");
  const parse = normalizeParseFailure(200, new SyntaxError("Unexpected token <"));
  assert.equal(parse.code, "bad_response");
  assert.equal(parse.httpStatus, 200);
});

test("service: read() hits only this origin's route family", async () => {
  const spy = createFetchSpy(() => jsonResponse(200, READY_BODY));
  const service = createBalanceService({ fetchImpl: spy.fetchImpl, now: () => 1_700_000_000_000 });
  const result = await service.read();
  assert.equal(result.state, ROW_STATES.ready);
  assert.equal(result.totalBalance, 12.3);
  assert.equal(spy.calls.length, 1);
  const [{ url, init }] = spy.calls;
  assert.equal(url, "/api/dsh-deepseek-usage/balance");
  assert.ok(url.startsWith("/"), "a relative path is mandatory: an absolute URL means a second origin");
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.cache, "no-store");
  assert.deepEqual(Object.keys(init.headers), ["accept"], "the browser half sends no credential headers");
  assert.doesNotMatch(JSON.stringify(init), /\bsk-[A-Za-z0-9]{6,}/);
  assert.doesNotMatch(JSON.stringify(init), /authorization/i);
});

test("service: force bypasses the host cache with a cache-buster", async () => {
  const spy = createFetchSpy(() => jsonResponse(200, READY_BODY));
  const service = createBalanceService({ fetchImpl: spy.fetchImpl, now: () => 1234 });
  await service.read({ force: true });
  assert.equal(spy.calls[0].url, "/api/dsh-deepseek-usage/balance?force=1&_=1234");
  await service.read({ force: false });
  assert.equal(spy.calls[1].url, "/api/dsh-deepseek-usage/balance");
});

test("service: transport failures become states, never rejections", async () => {
  const cases = [
    { name: "503 no_api_key", response: jsonResponse(503, { ok: false, error: { code: "no_api_key", message: "no key" } }), state: ROW_STATES.unconfigured, code: "no_api_key" },
    { name: "502 upstream", response: jsonResponse(502, { ok: false, error: { code: "upstream_error", message: "bad gateway" } }), state: ROW_STATES.error, code: "upstream_error" },
    { name: "504 timeout", response: jsonResponse(504, { ok: false, error: { code: "timeout", message: "slow" } }), state: ROW_STATES.error, code: "timeout" },
    { name: "500 internal", response: jsonResponse(500, { ok: false, error: { code: "internal", message: "boom" } }), state: ROW_STATES.error, code: "internal" },
    { name: "200 non-JSON", response: jsonResponse(200, undefined), state: ROW_STATES.error, code: "bad_response" },
    { name: "502 non-JSON", response: jsonResponse(502, undefined), state: ROW_STATES.error, code: null },
    { name: "200 shared shape but not ok", response: jsonResponse(200, { totalBalance: 1 }), state: ROW_STATES.error, code: null },
  ];
  for (const item of cases) {
    const spy = createFetchSpy(() => item.response);
    const service = createBalanceService({ fetchImpl: spy.fetchImpl });
    const result = await service.read();
    assert.equal(result.state, item.state, item.name);
    assert.equal(result.code, item.code, item.name);
    assert.equal(typeof result.message, "string", item.name);
  }

  const throwing = createBalanceService({
    fetchImpl: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  const network = await throwing.read();
  assert.equal(network.state, ROW_STATES.error);
  assert.equal(network.code, "network_error");

  const weird = createBalanceService({
    fetchImpl: async () => {
      throw "not an Error";
    },
  });
  const odd = await weird.read();
  assert.equal(odd.state, ROW_STATES.error);
  assert.match(odd.message, /not an Error/);

  const noFetch = createBalanceService({ fetchImpl: undefined, now: () => 0 });
  const original = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const missing = await noFetch.read();
    assert.equal(missing.state, ROW_STATES.error);
    assert.equal(missing.code, "network_error");
  } finally {
    globalThis.fetch = original;
  }
});

test("service: a hanging host route times out and is abortable", async () => {
  const slow = createBalanceService({
    timeoutMs: 5,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  const result = await slow.read();
  assert.equal(result.state, ROW_STATES.error);
  assert.equal(result.code, "timeout");
});

test("service: usage and health reuse the same family and stay relative", async () => {
  const usageBody = {
    ok: true,
    requestedDays: 7,
    generatedAt: ISO,
    truncated: false,
    days: [
      { date: "2026-09-16", models: [{ model: "deepseek-chat", inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, estimatedCostCny: 0.001 }] },
      { date: "2026-09-17", models: [] },
    ],
    totals: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, totalTokens: 15, estimatedCostCny: 0.001 },
  };
  const spy = createFetchSpy((url) => (url.includes("/usage") ? jsonResponse(200, usageBody) : jsonResponse(200, { ok: true, name: "dsh-deepseek-usage", version: "0.1.0", uptimeMs: 5, balanceCache: { ageMs: 1 } })));
  const service = createBalanceService({ fetchImpl: spy.fetchImpl });
  assert.equal(service.balanceUrl, BALANCE_PATH);
  assert.equal(service.usageUrl, USAGE_PATH);
  const usage = await service.readUsage({ days: 7 });
  assert.equal(spy.calls[0].url, "/api/dsh-deepseek-usage/usage?days=7");
  assert.equal(usage.state, ROW_STATES.ready);
  assert.equal(usage.requestedDays, 7);
  assert.equal(usage.generatedAt, ISO);
  assert.equal(usage.truncated, false);
  assert.equal(usage.days.length, 2, "the usage shape survives normalization (T6's chart reads days)");
  assert.equal(usage.days[0].models[0].model, "deepseek-chat");
  assert.equal(usage.totals.totalTokens, 15);
  assert.equal(usage.payload, usageBody);
  await service.readUsage();
  assert.equal(spy.calls[1].url, "/api/dsh-deepseek-usage/usage");
  const health = await service.readHealth();
  assert.equal(spy.calls[2].url, "/api/dsh-deepseek-usage/health");
  assert.equal(health.name, "dsh-deepseek-usage");
  assert.equal(health.balanceCache.ageMs, 1);
  for (const call of spy.calls) assert.ok(call.url.startsWith(`${ROUTE_BASE}/`), call.url);
});

test("service: a usage-side ledger failure keeps its own code and status", async () => {
  for (const [status, code] of [
    [503, "ledger_unavailable"],
    [400, "bad_request"],
  ]) {
    const spy = createFetchSpy(() => jsonResponse(status, { ok: false, error: { code, message: `no ${code}` } }));
    const service = createBalanceService({ fetchImpl: spy.fetchImpl });
    const result = await service.readUsage({ days: 7 });
    assert.equal(result.state, ROW_STATES.error);
    assert.equal(result.code, code);
    assert.equal(result.httpStatus, status);
    assert.equal(result.days, undefined, "a failure carries no chart data");
  }
  assert.match(messageForCode("ledger_unavailable"), /台账/);
});

/* ================================================================== *
 * 3. row.mjs — four states, refresh, rail
 * ================================================================== */

test("row: the seat, id and order are the shell's sidebar footer action", () => {
  assert.equal(ROW_SLOT, "sidebar.footer.action");
  assert.equal(ROW_ID, "deepseek-usage");
  assert.equal(typeof ROW_ORDER, "number");
  assert.equal(ROW_LOCALE_NAMESPACE, "deepseek-usage");
  assert.equal(ROW_STYLE_ID, "dsh-deepseek-usage-row");
});

test("row: the occupant really is rendered above the Settings row", () => {
  // Structural evidence from the shell itself: footArea renders the footer-action
  // slot and THEN the settings slot, so an occupant of this slot cannot appear
  // below Settings.
  const runtime = process.env.DSH_RUNTIME_ROOT ?? "C:\\Users\\Administrator\\AppData\\Local\\DSH-Portable\\runtime";
  const sidebarClient = join(runtime, "node_modules", "@deepseek-ai", "dsh-client-ui-sidebar", "lib", "client.js");
  if (!existsSync(sidebarClient)) {
    assert.ok(true, `shell source not present at ${sidebarClient}; the seat name is frozen by the assertion above`);
    return;
  }
  const source = readFileSync(sidebarClient, "utf8");
  const footerIndex = source.indexOf('renderSlot("sidebar.footer.action"');
  const settingsIndex = source.indexOf('renderSlot("sidebar.settings"');
  assert.ok(footerIndex > 0, "the shell renders the footer-action slot");
  assert.ok(settingsIndex > 0, "the shell renders the settings slot");
  assert.ok(footerIndex < settingsIndex, "inside footArea the footer-action slot comes BEFORE settings");
  assert.match(source, /footArea/, "both seats live in the shell's footArea");
});

test("row: four states have their own headline, amount and affordance", () => {
  const text = rowText(undefined);
  const loading = describeState(ROW_STATES.loading, { state: ROW_STATES.loading }, text, ISO_MS);
  assert.equal(loading.status, "loading");
  assert.equal(loading.headline, "余额加载中");
  assert.equal(loading.amountText, PENDING_VALUE);
  assert.equal(loading.busy, true, "refresh is disabled while a read is in flight");
  assert.equal(loading.retryable, false);

  const ready = describeState(ROW_STATES.ready, normalizeBalancePayload(READY_BODY), text, ISO_MS);
  assert.equal(ready.headline, "DeepSeek 余额");
  assert.equal(ready.amountText, "¥12.30");
  assert.match(ready.tooltip, /¥12\.30/);
  assert.equal(ready.busy, false);
  assert.equal(ready.retryable, true);

  const unconfigured = describeState(
    ROW_STATES.unconfigured,
    normalizeFailurePayload(503, { ok: false, error: { code: "no_api_key", message: "no key" } }, ""),
    text,
    ISO_MS,
  );
  assert.equal(unconfigured.headline, "未配置 API key");
  assert.equal(unconfigured.amountText, EMPTY_VALUE);
  assert.equal(unconfigured.retryLabel, "重试");
  assert.equal(unconfigured.retryable, true);
  assert.match(unconfigured.tooltip, /API key/);

  const failure = describeState(
    ROW_STATES.error,
    normalizeFailurePayload(502, { ok: false, error: { code: "upstream_error", message: "bad gateway" } }, ""),
    text,
    ISO_MS,
  );
  assert.equal(failure.headline, "余额读取失败");
  assert.equal(failure.amountText, EMPTY_VALUE);
  assert.equal(failure.retryLabel, "重试");
  assert.equal(failure.retryable, true);
  assert.match(failure.detail, /upstream_error/);
  assert.match(failure.tooltip, /重试/);
});

test("row: each state renders its own branch", () => {
  const { deps } = rowDeps();
  const states = [
    [ROW_STATES.loading, { state: ROW_STATES.loading }],
    [ROW_STATES.ready, normalizeBalancePayload(READY_BODY)],
    [ROW_STATES.unconfigured, normalizeFailurePayload(503, { ok: false, error: { code: "no_api_key", message: "no key" } }, "")],
    [ROW_STATES.error, normalizeFailurePayload(502, { ok: false, error: { code: "upstream_error", message: "bad gateway" } }, "")],
  ];
  for (const [status, snapshot] of states) {
    const tree = renderBalanceRow(deps, viewFor(status, snapshot));
    const row = findNodes(tree, (node) => node.props?.["data-dsh-usage-row"] === ROW_ID);
    assert.equal(row.length, 1, status);
    assert.equal(row[0].props["data-state"], status);
    const amount = findNodes(tree, (node) => node.props?.["data-dsh-usage-amount"] === ROW_ID);
    assert.equal(amount.length, 1, status);
    assert.equal(textOf(amount[0]), viewFor(status, snapshot).amountText, status);
  }
  const errorTree = renderBalanceRow(
    deps,
    viewFor(ROW_STATES.error, normalizeFailurePayload(502, { ok: false, error: { code: "upstream_error", message: "bad gateway" } }, "")),
  );
  const retry = findNodes(errorTree, (node) => node.props?.["data-dsh-usage-refresh"] === ROW_ID)[0];
  assert.equal(retry.props["data-retry"], "1");
  assert.match(textOf(retry), /重试/, "the error state retries through a visible button");
  assert.match(retry.props["aria-label"], /重试/);
  const loadingButton = findNodes(
    renderBalanceRow(deps, viewFor(ROW_STATES.loading, { state: ROW_STATES.loading })),
    (node) => node.props?.["data-dsh-usage-refresh"] === ROW_ID,
  )[0];
  assert.equal(loadingButton.props.disabled, true);
});

test("row: the refresh button never bubbles into the popover", () => {
  let refreshed = 0;
  let opened = 0;
  const { deps } = rowDeps();
  const tree = renderBalanceRow(
    deps,
    viewFor(ROW_STATES.ready, normalizeBalancePayload(READY_BODY), {
      onRefresh: () => {
        refreshed += 1;
      },
      onOpen: () => {
        opened += 1;
      },
    }),
  );
  const row = findNodes(tree, (node) => node.props?.["data-dsh-usage-row"] === ROW_ID)[0];
  const refresh = findNodes(tree, (node) => node.props?.["data-dsh-usage-refresh"] === ROW_ID)[0];
  assert.ok(row && refresh, "both the row and the refresh button exist");
  assert.notEqual(refresh.props.onClick, row.props.onClick, "the refresh button owns its own handler");

  const { record, event } = fakeEvent();
  refresh.props.onClick(event);
  assert.equal(record.stopPropagation, 1, "stopPropagation is required: an un-stopped click also opens the popover");
  assert.equal(refreshed, 1);
  assert.equal(opened, 0, "refreshing must not open the popover");

  const rowEvent = fakeEvent();
  row.props.onClick(rowEvent.event);
  assert.equal(opened, 1, "the row body opens the popover");
  assert.equal(refreshed, 1);
  assert.equal(rowEvent.record.stopPropagation, 0);
});

test("row: handler factories stop propagation and never throw", () => {
  const { record, event } = fakeEvent();
  let calls = 0;
  refreshClickHandler(() => {
    calls += 1;
  })(event);
  assert.equal(record.stopPropagation, 1);
  assert.equal(calls, 1);
  assert.doesNotThrow(() => refreshClickHandler(undefined)(undefined));
  assert.equal(refreshClickHandler(undefined).length, 1);
  assert.doesNotThrow(() => rowClickHandler(undefined)(event));
  const enter = fakeEvent({ key: "Enter" });
  let opened = 0;
  keyActivateHandler(() => {
    opened += 1;
  })(enter.event);
  assert.equal(opened, 1);
  assert.equal(enter.record.preventDefault, 1);
  const other = fakeEvent({ key: "a" });
  keyActivateHandler(() => {
    opened += 1;
  })(other.event);
  assert.equal(opened, 1, "only Enter/Space activate the row");
  assert.equal(other.record.preventDefault, 0);
});

test("row: the 56px rail degrades to an icon with the number in a Tooltip", () => {
  const { deps } = rowDeps();
  const readyView = viewFor(ROW_STATES.ready, normalizeBalancePayload(READY_BODY), { wide: false });
  const tree = renderBalanceRow(deps, readyView);
  const tooltips = findNodes(tree, (node) => node.type === TooltipStub);
  assert.equal(tooltips.length, 1, "the rail wraps its icon in the shell Tooltip primitive");
  assert.match(tooltips[0].props.label, /¥12\.30/, "the Tooltip must carry the number");
  assert.equal(tooltips[0].props.side, "top");
  const buttons = findNodes(tree, (node) => node.type === "button");
  assert.equal(buttons.length, 1, "the rail keeps exactly one control");
  assert.equal(buttons[0].props["data-dsh-usage-rail"], ROW_ID);
  assert.match(buttons[0].props["aria-label"], /¥12\.30/);
  assert.match(buttons[0].props.title, /¥12\.30/);
  assert.equal(findNodes(tree, (node) => node.props?.["data-dsh-usage-amount"] !== undefined).length, 0, "no wide amount span in the rail");
  assert.equal(findNodes(tree, (node) => node.type === "button" && node.props["data-dsh-usage-refresh"] !== undefined).length, 0);
});

test("row: the rail still responds without the primitive kit", () => {
  const { harness } = rowDeps();
  const deps = { React: harness.React, Tooltip: undefined, icons: {} };
  let opened = 0;
  const tree = renderBalanceRow(
    deps,
    viewFor(ROW_STATES.ready, normalizeBalancePayload(READY_BODY), {
      wide: false,
      onOpen: () => {
        opened += 1;
      },
    }),
  );
  assert.equal(findNodes(tree, (node) => node.type === TooltipStub).length, 0);
  const button = findNodes(tree, (node) => node.type === "button")[0];
  assert.match(button.props.title, /¥12\.30/);
  button.props.onClick(fakeEvent().event);
  assert.equal(opened, 1);
  assert.match(textOf(button), /◈/, "the icon falls back to a text glyph");
  assert.equal(wrapWithTooltip(deps, "x", "child"), "child");
});

test("row: the stylesheet is injected once and stays self-contained", () => {
  const appended = [];
  const style = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, textContent: "" };
  const doc = {
    head: {
      appendChild(node) {
        appended.push(node);
        this.children = (this.children ?? []).concat(node);
      },
    },
    createElement() {
      return style;
    },
    querySelector(selector) {
      return appended.some((node) => selector.includes(node.attrs["data-plugin-css"])) ? appended[0] : null;
    },
  };
  assert.equal(ensureRowStyles(undefined), false);
  assert.equal(ensureRowStyles(doc), true);
  assert.equal(ensureRowStyles(doc), false, "idempotent: the style tag is deduped by data-plugin-css");
  assert.equal(appended.length, 1);
  assert.equal(style.textContent, ROW_CSS);
  assert.match(ROW_CSS, /@keyframes dsh-deepseek-usage-spin/);
  assert.doesNotMatch(ROW_CSS, /url\(/);
  assert.doesNotMatch(ROW_CSS, /@import/);
});

/* ================================================================== *
 * 4. index.mjs — registration wiring and the optional popover opener
 * ================================================================== */

test("index: the plugin exports the shell's client-plugin shape", () => {
  const { React } = rowDeps().harness;
  const half = createClientHalf((specifier) => {
    if (specifier === REACT_SPECIFIER) return React;
    throw new Error(`no module ${specifier}`);
  });
  assert.equal(half.name, PLUGIN_NAME);
  assert.equal(PLUGIN_NAME, "dsh-deepseek-usage");
  assert.deepEqual([...half.inject], [...PLUGIN_INJECT]);
  assert.deepEqual([...PLUGIN_INJECT], ["slots"]);
  assert.equal(typeof half.apply, "function");
});

test("index: unknown require specifiers fail loud, optional ones do not", () => {
  assert.throws(() => createClientHalf(() => undefined), /react/i);
  assert.throws(() => createClientHalf(undefined), /require/i);
  const { React } = rowDeps().harness;
  const half = createClientHalf((specifier) => {
    if (specifier === REACT_SPECIFIER) return React;
    throw new Error("cannot resolve");
  });
  assert.ok(half, "a missing primitive kit must not fail the half");
  assert.equal(optionalRequire(() => 1, "x"), 1);
  assert.equal(
    optionalRequire(() => {
      throw new Error("no");
    }, "x"),
    undefined,
  );
  assert.deepEqual(pickIcons(undefined), { refresh: undefined, loading: undefined, warning: undefined, balance: undefined });
  assert.equal(typeof pickIcons({ IconRefreshOutline14: IconStub }).refresh, "function");
});

test("index: apply registers exactly the sidebar footer seat", () => {
  const { React } = rowDeps().harness;
  const half = createClientHalf((specifier) => {
    if (specifier === REACT_SPECIFIER) return React;
    throw new Error("cannot resolve");
  });
  const injected = [];
  const registered = [];
  const ctx = {
    slots: {
      inject(key, callback) {
        injected.push(key);
        registered.push(callback());
      },
      register(options, component) {
        return { options, component };
      },
    },
  };
  const service = half.apply(ctx);
  assert.equal(typeof service.read, "function", "apply hands the service back for the popover");
  assert.deepEqual(injected, [ROW_SLOT]);
  assert.equal(registered.length, 1);
  const { options, component } = registered[0];
  assert.equal(options.name, ROW_SLOT);
  assert.equal(options.id, ROW_ID);
  assert.equal(options.order, ROW_ORDER);
  assert.equal(options.locale, ROW_LOCALE_NAMESPACE);
  assert.equal(options.label(), "DeepSeek 余额");
  assert.equal(typeof component, "function");

  // The registered component renders through the shell's owner prop `wide`.
  const harness = createReactStub();
  const wideTree = harness.render(component, { wide: true, t: (key) => key });
  assert.equal(findNodes(wideTree, (node) => node.props?.["data-dsh-usage-row"] === ROW_ID).length, 1);
  const railTree = harness.render(component, { wide: false, t: (key) => key });
  assert.equal(findNodes(railTree, (node) => node.props?.["data-dsh-usage-rail"] === ROW_ID).length, 1);
});

test("index: the popover opener is optional and resolved defensively", () => {
  assert.equal(getModalOpener({}), undefined);
  assert.equal(getModalOpener({ [MODAL_GLOBAL_KEY]: { open: "not a function" } }), undefined);
  const globalOpen = () => {};
  assert.equal(getModalOpener({ [MODAL_GLOBAL_KEY]: globalOpen }), globalOpen);
  assert.equal(getModalOpener({ [MODAL_GLOBAL_KEY]: { open: globalOpen } }), globalOpen);
  const composedOpen = () => {};
  const previous = setModalOpener(composedOpen);
  assert.equal(previous, undefined);
  assert.equal(getModalOpener({ [MODAL_GLOBAL_KEY]: globalOpen }), composedOpen, "the composed opener wins over the global");
  assert.equal(setModalOpener(undefined), composedOpen);
  assert.equal(getModalOpener({ [MODAL_GLOBAL_KEY]: globalOpen }), globalOpen);
  setModalOpener(undefined);
  assert.equal(getModalOpener({}), undefined);
});

test("index: the composed popover factory gets the runtime and its opener goes live", () => {
  setModalOpener(undefined);
  setModalFactory(undefined);
  const { React } = rowDeps().harness;
  const half = createClientHalf((specifier) => {
    if (specifier === REACT_SPECIFIER) return React;
    throw new Error("cannot resolve");
  });
  const seen = [];
  const opener = () => {};
  const previous = setModalFactory((runtime) => {
    seen.push(runtime);
    return opener;
  });
  assert.equal(previous, undefined);
  let component;
  const service = half.apply({
    slots: {
      inject(_key, callback) {
        callback();
      },
      register(_options, registered) {
        component = registered;
      },
    },
  });
  assert.equal(seen.length, 1, "the factory runs once, at activation");
  assert.equal(typeof seen[0].React.createElement, "function", "the runtime carries React (require is not reachable at script-evaluation time)");
  assert.equal(seen[0].service, service);
  assert.equal(typeof seen[0].text, "function");
  assert.equal(seen[0].slot, ROW_SLOT);
  assert.ok(Object.isFrozen(seen[0]));
  assert.equal(getModalOpener({}), opener, "the returned opener is installed for the row");
  assert.equal(typeof component, "function");

  // A factory that throws, or returns junk, degrades instead of breaking activation.
  setModalFactory(() => {
    throw new Error("factory exploded");
  });
  assert.equal(installComposedModal({ React, service, text: () => "" }), undefined);
  setModalFactory(() => "not a function");
  assert.equal(installComposedModal({ React, service, text: () => "" }), undefined);
  assert.equal(typeof createModalRuntime({ React, service, text: () => "" }).slot, "string");
  assert.doesNotThrow(() => warnUnavailable("test warning"));
  setModalFactory(undefined);
  setModalOpener(undefined);
});

test("index: cosmetically missing collaborators degrade loudly, never silently", () => {
  const { React } = rowDeps().harness;
  const half = createClientHalf((specifier) => {
    if (specifier === REACT_SPECIFIER) return React;
    throw new Error("cannot resolve");
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    for (const ctx of [undefined, {}, { slots: null }, { slots: {} }, { slots: { inject() {} } }]) {
      const service = half.apply(ctx);
      assert.equal(typeof service.read, "function", "the balance service is still handed back");
    }
    assert.equal(warnings.length, 5, "each missing-slot activation warns");
    assert.match(warnings[0], /dsh-deepseek-usage/);
    assert.match(warnings[0], /ctx\.slots/);
    assert.match(warnings[0], /sidebar\.footer\.action/);
    warnings.length = 0;
    const registered = [];
    half.apply({
      slots: {
        inject(key, callback) {
          registered.push(key);
          callback();
        },
        register() {
          throw new Error("slot not declared by this shell");
        },
      },
    });
    assert.equal(registered.length, 1, "a failing register does not break the inject call");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /slot not declared/);
  } finally {
    console.warn = originalWarn;
  }
});

test("index: the composed half renders the loading branch before any read resolves", () => {
  const { React } = rowDeps().harness;
  const half = createClientHalf((specifier) => {
    if (specifier === REACT_SPECIFIER) return React;
    throw new Error("cannot resolve");
  });
  let component;
  half.apply({
    slots: {
      inject(_key, callback) {
        callback();
      },
      register(_options, registered) {
        component = registered;
      },
    },
  });
  const harness = createReactStub();
  const tree = harness.render(component, { wide: true });
  assert.match(textOf(tree), /余额加载中/);
  assert.equal(findNodes(tree, (node) => node.props?.["data-dsh-usage-refresh"] === ROW_ID)[0].props.disabled, true);
});

/* ================================================================== *
 * 5. component lifecycle: initial read, refresh, retry, missing popover
 * ================================================================== */

function mountRow(options = {}) {
  const harness = createReactStub();
  const reads = [];
  const service = {
    async read(request) {
      reads.push(request ?? {});
      if (typeof options.read === "function") return options.read(request ?? {}, reads.length);
      return normalizeBalancePayload(READY_BODY);
    },
  };
  const Component = createBalanceRow({
    React: harness.React,
    service,
    resolveModal: options.resolveModal,
    Tooltip: TooltipStub,
    icons: {},
    document: undefined,
    now: () => ISO_MS,
  });
  return { harness, reads, Component };
}

test("row component: mounts into loading, then shows the amount", async () => {
  const { harness, reads, Component } = mountRow();
  const first = harness.render(Component, { wide: true });
  assert.match(textOf(first), /余额加载中/);
  assert.equal(reads.length, 1, "mount triggers exactly one read");
  assert.deepEqual(reads[0], { force: false });
  await tick();
  const second = harness.render(Component, { wide: true });
  assert.match(textOf(second), /¥12\.30/);
  assert.match(textOf(second), /DeepSeek 余额/);
  assert.equal(reads.length, 1, "no read storm on re-render");
  const state = findNodes(second, (node) => node.props?.["data-dsh-usage-row"])[0].props["data-state"];
  assert.equal(state, ROW_STATES.ready);
});

test("row component: refresh forces a new read and stops propagation", async () => {
  const { harness, reads, Component } = mountRow();
  harness.render(Component, { wide: true });
  await tick();
  const ready = harness.render(Component, { wide: true });
  const refresh = findNodes(ready, (node) => node.props?.["data-dsh-usage-refresh"] === ROW_ID)[0];
  const { record, event } = fakeEvent();
  refresh.props.onClick(event);
  assert.equal(record.stopPropagation, 1);
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[1], { force: true });
  const loading = harness.render(Component, { wide: true });
  assert.match(textOf(loading), /余额加载中/);
  await tick();
  assert.match(textOf(harness.render(Component, { wide: true })), /¥12\.30/);
});

test("row component: the error state is retryable and recovers", async () => {
  const { harness, reads, Component } = mountRow({
    read: (_request, attempt) =>
      attempt === 1
        ? normalizeFailurePayload(502, { ok: false, error: { code: "upstream_error", message: "bad gateway" } }, "")
        : normalizeBalancePayload(READY_BODY),
  });
  harness.render(Component, { wide: true });
  await tick();
  const failed = harness.render(Component, { wide: true });
  assert.match(textOf(failed), /余额读取失败/);
  assert.equal(findNodes(failed, (node) => node.props?.["data-dsh-usage-row"])[0].props["data-state"], ROW_STATES.error);
  const retry = findNodes(failed, (node) => node.props?.["data-dsh-usage-refresh"] === ROW_ID)[0];
  assert.match(textOf(retry), /重试/);
  retry.props.onClick(fakeEvent().event);
  await tick();
  const recovered = harness.render(Component, { wide: true });
  assert.match(textOf(recovered), /¥12\.30/);
  assert.equal(reads.length, 2);
});

test("row component: a missing popover shows a hint instead of throwing", async () => {
  const { harness, Component } = mountRow({ resolveModal: () => undefined });
  harness.render(Component, { wide: true });
  await tick();
  const ready = harness.render(Component, { wide: true });
  const row = findNodes(ready, (node) => node.props?.["data-dsh-usage-row"] === ROW_ID)[0];
  assert.doesNotThrow(() => row.props.onClick(fakeEvent().event));
  const hinted = harness.render(Component, { wide: true });
  assert.match(textOf(hinted), /弹层尚未装配/);
  assert.match(textOf(hinted), /src\/client\/modal\.mjs/);
  assert.equal(findNodes(hinted, (node) => node.props?.["data-dsh-usage-row"] === ROW_ID).length, 1, "the row still renders");
});

test("row component: a composed popover receives the snapshot, and a throwing one is contained", async () => {
  const opened = [];
  const mounted = mountRow({ resolveModal: () => (view) => opened.push(view) });
  mounted.harness.render(mounted.Component, { wide: true });
  await tick();
  const ready = mounted.harness.render(mounted.Component, { wide: true });
  findNodes(ready, (node) => node.props?.["data-dsh-usage-row"] === ROW_ID)[0].props.onClick(fakeEvent().event);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].wide, true);
  assert.equal(opened[0].snapshot.totalBalance, 12.3);
  assert.equal(typeof opened[0].service.read, "function");

  const throwing = mountRow({
    resolveModal: () => () => {
      throw new Error("popover exploded");
    },
  });
  throwing.harness.render(throwing.Component, { wide: true });
  await tick();
  const tree = throwing.harness.render(throwing.Component, { wide: true });
  assert.doesNotThrow(() => findNodes(tree, (node) => node.props?.["data-dsh-usage-row"] === ROW_ID)[0].props.onClick(fakeEvent().event));
  assert.match(textOf(throwing.harness.render(throwing.Component, { wide: true })), /popover exploded/);
});

test("row component: an unusable service result still renders a state", async () => {
  const { harness, Component } = mountRow({ read: () => undefined });
  harness.render(Component, { wide: true });
  await tick();
  const tree = harness.render(Component, { wide: true });
  assert.match(textOf(tree), /余额读取失败/);
  const emptyRow = findNodes(tree, (node) => node.props?.["data-dsh-usage-row"] === ROW_ID)[0];
  assert.match(emptyRow.props.title, /宿主返回了空结果/, "the diagnostic travels in the tooltip");

  const rejects = mountRow({
    read: () => {
      throw new Error("synchronous explosion");
    },
  });
  rejects.harness.render(rejects.Component, { wide: true });
  await tick();
  const rejected = rejects.harness.render(rejects.Component, { wide: true });
  const rejectedRow = findNodes(rejected, (node) => node.props?.["data-dsh-usage-row"] === ROW_ID)[0];
  assert.equal(rejectedRow.props["data-state"], ROW_STATES.error, "a synchronous throw must not break the render");
  assert.match(textOf(rejected), /余额读取失败/);
  assert.match(rejectedRow.props.title, /synchronous explosion/);
  assert.match(rejectedRow.props["aria-label"], /synchronous explosion/);
});

/* ================================================================== *
 * 5b. layout and theme tokens (T15: own line + real colours)
 * ================================================================== */

/** The installed shell; same resolution rule the other suites use. */
const RUNTIME_ROOT = process.env.DSH_RUNTIME_ROOT ?? "C:\\Users\\Administrator\\AppData\\Local\\DSH-Portable\\runtime";
const SHELL_ASSETS = join(RUNTIME_ROOT, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "assets");
const SIDEBAR_CLIENT = join(RUNTIME_ROOT, "node_modules", "@deepseek-ai", "dsh-client-ui-sidebar", "lib", "client.js");

/** The tokens the row is allowed to use (see the same list in ui-modal.test.mjs). */
const ROW_TOKEN_FALLBACK = [
  "--dsw-alias-brand-primary",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
];

/**
 * The vocabulary of `--dsw-*` names the shell consumes, read from its own compiled
 * stylesheet (its asset name carries a build hash, so it is discovered).
 * @returns `{ names, source }`.
 */
function shellTokenVocabulary() {
  if (existsSync(SHELL_ASSETS)) {
    const candidate = readdirSync(SHELL_ASSETS).find((name) => /^index-.*\.css$/.test(name));
    if (candidate !== undefined) {
      const css = readFileSync(join(SHELL_ASSETS, candidate), "utf8");
      return { names: new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((match) => match[0])), source: join(SHELL_ASSETS, candidate) };
    }
  }
  return { names: new Set(ROW_TOKEN_FALLBACK), source: "fallback" };
}

test("row theme: ROW_CSS uses only shell tokens and no literal colour", () => {
  const vocabulary = shellTokenVocabulary();
  if (vocabulary.source !== "fallback") {
    for (const name of ROW_TOKEN_FALLBACK) {
      assert.ok(vocabulary.names.has(name), `${name} is in our fallback list but not in the shell's stylesheet`);
    }
  }
  const used = [...new Set([...ROW_CSS.matchAll(/--dsw-[a-z0-9-]+/g)].map((match) => match[0]))].sort();
  assert.ok(used.length >= 4, `expected a token-driven stylesheet, saw ${used.length} names`);
  assert.deepEqual(
    used.filter((name) => !vocabulary.names.has(name)),
    [],
    `ROW_CSS references names the shell does not define (vocabulary: ${vocabulary.source})`,
  );
  // `--dsw-alias-status-warning` never existed in the shell; a review found it in the
  // popover, and this row must not grow the same kind of name.
  assert.deepEqual(
    [...new Set([...ROW_CSS.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g)].map((match) => match[0]))],
    [],
    "a literal colour cannot follow the theme",
  );
});

test("row layout: the shell's .footerActions is a flex ROW, which is why we shared a line", () => {
  // Root cause with evidence (captain + this suite both re-read it):
  //   client.js CSS: `.footerActions{display:flex}` and the matching
  //   `.footerActions{flex:none;width:100%;min-width:0}`, inside a
  //   `.footArea{flex-direction:column;…}` whose children are
  //   [footerActions(renderSlot "sidebar.footer.action"), settingsArea].
  // A contribution to that slot is therefore an ITEM of a flex row — it shares the row
  // with every other plugin's button. If the shell ever stops being that shape, the fix
  // below stops being the right fix, so this premise is asserted rather than assumed.
  if (!existsSync(SIDEBAR_CLIENT)) {
    assert.ok(true, `shell source not present at ${SIDEBAR_CLIENT}; the slot order test above still pins the seat`);
    return;
  }
  const source = readFileSync(SIDEBAR_CLIENT, "utf8");
  const prefix = /\.([A-Za-z0-9_-]+)_footerActions\{display:flex\}/.exec(source)?.[1];
  assert.ok(prefix, "the shell's footerActions must still declare `display:flex` — that is the row we used to share");
  assert.match(source, new RegExp(`\\.${prefix}_settingsArea,\\.${prefix}_footerActions\\{flex:none;width:100%;min-width:0\\}`));
  assert.match(source, new RegExp(`\\.${prefix}_footArea\\{flex-direction:column;flex:none;display:flex\\}`));
  assert.match(source, new RegExp(`\\.${prefix}_collapsed \\.${prefix}_footerActions\\{justify-content:center;width:auto;display:flex\\}`));
  assert.match(source, new RegExp(`\\.${prefix}_collapsed \\.${prefix}_footArea\\{align-items:center\\}`));
  assert.match(source, /renderSlot\("sidebar\.footer\.action"/, "the seat is still the footer-action slot");
});

test("row layout: the row takes a full flex line, and the container rule reaches us", () => {
  for (const root of ["dsh-deepseek-usage-row", "dsh-deepseek-usage-block", "dsh-deepseek-usage-rail"]) {
    assert.match(
      ROW_CSS,
      new RegExp(`\\.${root}\\{[^}]*flex:1 0 100%`),
      `${root} must claim the whole line (flex-basis 100%, and no shrink, so the row is never squeezed by a sibling)`,
    );
  }
  // The shell's container has no `flex-wrap`, so a 100%-basis item would squeeze its
  // siblings instead of moving to its own line. We add wrap — but only while this
  // component is inside, and we re-assert `width:100%` because the collapsed rail
  // sets `width:auto` (without a definite width the rail's 100% basis would degrade to
  // content size).
  const containerRules = [...ROW_CSS.matchAll(/\[class\*='footerActions'\][^{]*\{[^}]*\}/g)].map((match) => match[0]);
  assert.equal(containerRules.length, 1, "exactly one container rule, so the shell is touched in one place");
  // DESCENDANT match, never `:has(> …)`. Revision 3 scoped this rule to a DIRECT child
  // and the rule therefore never applied: the slot renderer wraps our entry in an extra
  // element whose computed style is `display:contents`, so our row is still a flex ITEM
  // of `.footerActions` but not its child. `:has(… )` matches at any depth, which is what
  // makes the basis work no matter how the slot wraps us. The live DOM measured
  // `.footerActions{display:flex;flex-wrap:nowrap}` with the row sharing a line; the
  // "row layout: measured in a real browser" test below pins the fixed shape.
  for (const root of ["dsh-deepseek-usage-row", "dsh-deepseek-usage-block", "dsh-deepseek-usage-rail"]) {
    assert.match(containerRules[0], new RegExp(`:has\\(\\.${root}\\)`), `${root} must be reachable at any depth`);
  }
  assert.doesNotMatch(containerRules[0], /:has\(>/, "`>` cannot match a slot contribution — the wrapper is display:contents");
  assert.match(containerRules[0], /\{flex-wrap:wrap;width:100%\}$/);
  // The substring match survives the shell's build-hash prefix (`hHd-Xa_footerActions`).
  assert.match(ROW_CSS, /\[class\*='footerActions'\]/);
});

test("row layout: the 56px rail keeps its geometry and still gets its own line", () => {
  assert.match(ROW_CSS, /\.dsh-deepseek-usage-rail\{[^}]*display:flex;align-items:center;justify-content:center/);
  assert.match(ROW_CSS, /\.dsh-deepseek-usage-rail-button\{[^}]*width:36px;height:36px/, "the shell's rail buttons are 36x36");
  assert.match(ROW_CSS, /\.dsh-deepseek-usage-rail-button\{[^}]*border-radius:50%/);
  // The rail root carries the same full basis as the wide roots: in the collapsed state
  // the container is content-sized, so the basis degrades to content size (the icon keeps
  // its 36px box) and the wrap rule keeps it off its siblings' line.
  assert.match(ROW_CSS, /\.dsh-deepseek-usage-rail\{[^}]*flex:1 0 100%/);
});

/* ------------------------------------------------------------------ *
 * The same rule, MEASURED. The assertions above only prove the CSS text
 * says what we meant; they cannot prove a browser agrees. That gap is
 * how a row with `flex:1 0 100%` still shared a line with another
 * plugin's chip while 211 tests were green, so at least one layout claim
 * is settled by a real engine.
 * ------------------------------------------------------------------ */

/**
 * The installed Edge, or the first candidate that exists.
 * @returns the executable path, or `undefined`.
 */
function installedBrowser() {
  const candidates = [
    process.env.DSH_TEST_BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter((candidate) => typeof candidate === "string" && candidate !== "");
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Run the shipped CSS through a real layout engine on the fixture DOM.
 *
 * Starting a browser is the flaky part (a sibling test's Edge may still be winding
 * down), so a probe that cannot launch is retried once on a different port. If it
 * still cannot launch the test FAILS — a layout claim is never silently skipped.
 *
 * @param root - which plugin root to mount (`dsh-deepseek-usage-row|block|rail`).
 * @param port - DevTools port; one per test, so concurrent runs do not share a browser.
 * @param css - the stylesheet to measure (defaults to the shipped `ROW_CSS`).
 * @returns the probe's measurements.
 */
function runLayoutProbe(root, port, css = ROW_CSS) {
  const probe = join(PACKAGE_ROOT, "tools", "visual", "row-wrap-probe.mjs");
  assert.ok(existsSync(probe), `the probe must ship with the tests: ${probe}`);
  const cssFile = join(mkdtempSync(join(tmpdir(), "dsh-row-css-")), "row.css");
  writeFileSync(cssFile, css, "utf8");
  const attempts = [String(port), String(Number(port) + 100)];
  let last = null;
  for (const candidate of attempts) {
    last = spawnSync(process.execPath, [probe, "--css-file", cssFile, "--root", root, "--port", candidate], {
      encoding: "utf8",
      timeout: 120_000,
    });
    // Exit 2 is the probe's own "could not launch/inspect a browser" signal.
    if (last.status !== 2) break;
  }
  assert.notEqual(last.status, 2, `the browser probe must run (tried ports ${attempts.join(", ")}): ${last.stderr ?? ""}`);
  assert.equal(last.status, 0, `probe exit ${last.status}: ${last.stderr ?? ""} ${last.stdout ?? ""}`);
  return JSON.parse(last.stdout);
}

test("row layout: measured in a real browser — the row takes a line of its own", { skip: installedBrowser() === undefined ? "no Chromium-family browser installed" : false }, () => {
  const measured = runLayoutProbe("dsh-deepseek-usage-row", "9223");
  // The premise, measured rather than assumed: the slot's wrapper really does sit
  // between the container and the row, which is why a direct-child rule cannot match.
  assert.equal(measured.rowIsDirectChildOfContainer, false, "the wrapper must remain in the fixture, or the test stops reproducing the bug");
  assert.equal(measured.containerDisplay, "flex", "the shell's footer is a flex row");
  assert.equal(measured.containerFlexWrap, "wrap", "our container rule must actually match through the display:contents wrapper");
  assert.equal(measured.containerWidth, 256, "the expanded sidebar footer");
  assert.equal(measured.rowWidth, measured.containerWidth, `the row must fill its line, measured ${measured.rowWidth}px of ${measured.containerWidth}px`);
  assert.equal(
    measured.rowOnOwnLine,
    true,
    `the row must not share a line with another plugin's chip (row top ${measured.rowTop}, chip top ${measured.chipTop})`,
  );
});

test("row layout: measured in a real browser — the collapsed rail also gets its own line", { skip: installedBrowser() === undefined ? "no Chromium-family browser installed" : false }, () => {
  // The collapsed sidebar (56px) mounts a DIFFERENT root — `.dsh-deepseek-usage-rail`
  // — and the live measurement was 36px wide inside a 35px-wide `.footerActions`, so a
  // container rule that only reached `.dsh-deepseek-usage-row` would silently leave the
  // rail sharing a line. The fixture renders the rail root for exactly that reason.
  const measured = runLayoutProbe("dsh-deepseek-usage-rail", "9224");
  assert.equal(measured.root, "dsh-deepseek-usage-rail", "the fixture must render the rail root");
  assert.equal(measured.containerFlexWrap, "wrap", "the container rule must reach the rail root too — the live collapse mounts this one");
  assert.equal(measured.rowOnOwnLine, true, "the rail must not share a line with another plugin's entry");
  assert.ok(measured.rowWidth > 0 && measured.rowWidth <= measured.containerWidth, `the rail keeps a sane width inside the rail column, measured ${measured.rowWidth}`);
});

test("row layout: measured in a real browser — the OLD direct-child rule is the bug", { skip: installedBrowser() === undefined ? "no Chromium-family browser installed" : false }, () => {
  // The A/B that isolates the cause: same fixture, same DOM, only the container rule
  // differs. This is what turns "we think the `>` was the problem" into a fact, and it
  // is the guard that stops the `>` from creeping back in a future refactor.
  const oldRule = ROW_CSS.replace(
    "[class*='footerActions']:has(.dsh-deepseek-usage-row),[class*='footerActions']:has(.dsh-deepseek-usage-block),[class*='footerActions']:has(.dsh-deepseek-usage-rail){flex-wrap:wrap;width:100%}",
    "[class*='footerActions']:has(>.dsh-deepseek-usage-row),[class*='footerActions']:has(>.dsh-deepseek-usage-block),[class*='footerActions']:has(>.dsh-deepseek-usage-rail){flex-wrap:wrap;width:100%}",
  );
  assert.notEqual(oldRule, ROW_CSS, "the direct-child form must still be reconstructible, or this test is not testing anything");
  const before = runLayoutProbe("dsh-deepseek-usage-row", "9225", oldRule);
  assert.equal(before.containerFlexWrap, "nowrap", "with `:has(> …)` the container does NOT wrap — that is why the row shared a line");
  assert.equal(before.rowOnOwnLine, false, "…and the row sits on the same line as the other plugin's chip");
  assert.equal(before.rowTop, before.chipTop, `both must share a top edge (row ${before.rowTop}, chip ${before.chipTop})`);
});

/* ================================================================== *
 * 6. the composed classic-script bundle
 * ================================================================== */

test("docs: the English and Chinese READMEs are a matched pair", () => {
  // The shell's own packages ship `README.md` + `README.zh.md` with a language line on each
  // side (e.g. `dsh-credentials`). This plugin follows that convention, and the pairing is
  // asserted so a section added to one language cannot be forgotten in the other.
  const enPath = join(PACKAGE_ROOT, "README.md");
  const zhPath = join(PACKAGE_ROOT, "README.zh.md");
  assert.ok(existsSync(enPath), "README.md must exist");
  assert.ok(existsSync(zhPath), "README.zh.md must exist");

  const en = readFileSync(enPath, "utf8");
  const zh = readFileSync(zhPath, "utf8");

  // Each side links to the other, using the shell's own wording, near the top.
  assert.match(en.split("\n").slice(0, 6).join("\n"), /English \| \[中文\]\(README\.zh\.md\)/, "the English README links to the Chinese one");
  assert.match(zh.split("\n").slice(0, 6).join("\n"), /\[English\]\(README\.md\) \| 中文/, "the Chinese README links back to the English one");

  // Same heading outline length — the structure is the thing that drifts.
  const headingCount = (text) => (text.match(/^#{2,3} .+$/gm) ?? []).length;
  const enHeadings = headingCount(en);
  assert.ok(enHeadings >= 7, `expected the README to have real sections, saw ${enHeadings}`);
  assert.equal(headingCount(zh), enHeadings, `heading count differs: en=${enHeadings} zh=${headingCount(zh)}`);

  // Code fences must pair up on both sides (a dropped fence swallows the rest of the file).
  for (const [name, text] of [
    ["README.md", en],
    ["README.zh.md", zh],
  ]) {
    const fences = (text.match(/^```/gm) ?? []).length;
    assert.equal(fences % 2, 0, `${name}: unbalanced code fence (${fences})`);
  }

  // Every relative link in the Chinese README must point at a file that exists.
  for (const match of zh.matchAll(/\]\((?!https?:)([^)#]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (target === "") continue;
    assert.ok(existsSync(join(PACKAGE_ROOT, target)), `README.zh.md links to a missing path: ${target}`);
  }
});

test("bundle: no ESM syntax, and the classic script parses", () => {
  const text = readFileSync(BUNDLE_PATH, "utf8");
  assert.ok(text.length > 10_000, "the composed browser half is inlined, not a stub");
  assert.doesNotMatch(text, /^\s*(?:import|export)\s/m, "classic <script> would throw a SyntaxError on ESM syntax");
  assert.doesNotMatch(text, /\bimport\s*\(/, "no dynamic import: /plugins serves only registered bundle URLs");
  assert.doesNotThrow(() => new vm.Script(text, { filename: "lib/client.js" }), "must parse as a classic script");
  assert.match(text, /browser half is not composed/, "the loud-failure guard stays in place");
});

/**
 * The composer's transformation, restated here so the test can prove the inlined
 * copy equals the sources: drop the sibling `import` lines (the modules become one
 * closure) and remove a line-start `export `/`export default ` keyword.
 */
function flattenSource(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^import\s.*from\s+"\.\/[A-Za-z0-9_.-]+\.mjs";\s*$/.test(line))
    .map((line) => line.replace(/^export\s+(default\s+)?/, ""))
    .join("\n");
}

test("bundle: every source module is inlined byte-for-byte (whitespace-insensitive)", () => {
  const composed = stripWs(readFileSync(BUNDLE_PATH, "utf8"));
  for (const name of CLIENT_SOURCES) {
    const source = readFileSync(join(PACKAGE_ROOT, "src", "client", name), "utf8");
    const flattened = stripWs(flattenSource(source));
    assert.ok(flattened.length > 500, `${name} has a real body`);
    assert.ok(
      composed.includes(flattened),
      `${name} has drifted from lib/client.js — recompose the browser half (src/client → lib/client.js)`,
    );
  }
});

test("bundle: every exported function of every module is the composed one", () => {
  const composed = stripWs(readFileSync(BUNDLE_PATH, "utf8"));
  const modules = [
    ["format.mjs", formatModule],
    ["service.mjs", serviceModule],
    ["row.mjs", rowModule],
    ["index.mjs", indexModule],
  ];
  for (const [name, namespace] of modules) {
    const entries = Object.entries(namespace);
    assert.ok(entries.length > 5, `${name} exports a testable surface`);
    for (const [key, value] of entries) {
      if (typeof value !== "function") continue;
      assert.ok(
        composed.includes(stripWs(value.toString())),
        `${name} export "${key}" is missing (or stale) in lib/client.js`,
      );
    }
  }
  assert.equal(typeof indexModule.default, "function", "index.mjs default-exports the composed half");
});

test("bundle: running it registers the sidebar footer seat end to end", () => {
  const text = readFileSync(BUNDLE_PATH, "utf8");
  const registrations = [];
  const sandbox = { console, __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
  vm.createContext(sandbox);
  vm.runInContext(text, sandbox, { filename: "lib/client.js" });
  assert.equal(registrations.length, 1, "a classic-script bundle registers exactly one module factory");
  assert.equal(registrations[0].id, PLUGIN_NAME);

  const harness = createReactStub();
  const kit = { React: harness.React, Tooltip: TooltipStub, IconRefreshOutline14: IconStub, IconLoadingOutline16: IconStub, IconWarningOutline16: IconStub, IconGaugeOutline16: IconStub };
  const exports = registrations[0].factory((specifier) => {
    if (specifier === REACT_SPECIFIER) return harness.React;
    if (specifier === PRIMITIVES_SPECIFIER) return kit;
    throw new Error(`client-modules: require("${specifier}") missed the module table`);
  });
  assert.equal(exports.name, PLUGIN_NAME);
  assert.deepEqual([...exports.inject], ["slots"]);

  const injected = [];
  let component;
  exports.apply({
    slots: {
      inject(key, callback) {
        injected.push(key);
        callback();
      },
      register(options, registered) {
        assert.equal(options.name, ROW_SLOT);
        component = registered;
        return options.id;
      },
    },
  });
  assert.deepEqual(injected, [ROW_SLOT]);
  assert.equal(typeof component, "function");

  const wide = harness.render(component, { wide: true });
  assert.equal(findNodes(wide, (node) => node.props?.["data-dsh-usage-row"] === ROW_ID).length, 1);
  const rail = harness.render(component, { wide: false });
  const tooltips = findNodes(rail, (node) => node.type === TooltipStub);
  assert.equal(tooltips.length, 1);
  assert.equal(findNodes(rail, (node) => node.type === "button").length, 1);
  // The inlined service has no fetch in the sandbox realm: it must degrade, not throw.
  assert.match(textOf(wide), /余额加载中/);
});

test("bundle: no key material and no upstream API origin in the EXECUTABLE browser half", () => {
  const markers = {
    "format.mjs": "formatAmount",
    "service.mjs": "createBalanceService",
    "row.mjs": "renderBalanceRow",
    "index.mjs": "createClientHalf",
    "chart.mjs": "buildChartGeometry",
    "modal.mjs": "openUsageModal",
    "lib/client.js": "registerClientBundle",
  };
  // The four modules this task owns must be origin-free: the browser half issues
  // only same-origin relative requests.
  const ORIGIN_FREE = ["format.mjs", "service.mjs", "row.mjs", "index.mjs"];
  // The platform usage page is a user-click NAVIGATION TARGET owned by T6's
  // `modal.mjs` (captain ruling: bare `https://platform.deepseek.com/usage` opened
  // with window.open). It is the single absolute literal the composed bundle may
  // carry; the upstream API host below stays banned everywhere, in every file.
  const ALLOWED_LINK_TARGET = /https:\/\/platform\.deepseek\.com\/usage/g;
  // The other allowed literal is `modal.mjs`/`chart.mjs`'s SVG namespace, an XML
  // namespace IDENTIFIER handed to createElementNS — it names an element type, it is
  // never an origin anything is requested from, and the platform's API host ban
  // below still covers every file. (Added with T6's modules on the captain's ruling
  // that the drift guard must cover them.)
  const ALLOWED_SVG_NAMESPACE = /https?:\/\/www\.w3\.org\/2000\/svg/g;
  const sources = CLIENT_SOURCES.map((name) => [name, readFileSync(join(PACKAGE_ROOT, "src", "client", name), "utf8")]);
  sources.push(["lib/client.js", readFileSync(BUNDLE_PATH, "utf8")]);
  for (const [name, raw] of sources) {
    const code = stripJsComments(raw);
    assert.match(code, new RegExp(markers[name]), `${name}: the comment stripper kept the code`);
    assert.ok(code.length < raw.length, `${name}: comments were actually stripped`);
    assert.doesNotMatch(code, /api\.deepseek\.com/i, `${name}: the browser half never contacts the platform API host`);
    assert.doesNotMatch(code, /\bsk-[A-Za-z0-9_-]{6,}\b/, `${name}: no key-shaped literal`);
    assert.doesNotMatch(code, /authorization/i, `${name}: no Authorization header is ever built`);
    assert.doesNotMatch(code, /x-api-key/i, `${name}: no api-key header is ever built`);
    assert.doesNotMatch(code, /localStorage|sessionStorage/, `${name}: no browser storage is used`);
    assert.doesNotMatch(code, /document\.cookie/, `${name}: no cookie access`);
    const scanned = ORIGIN_FREE.includes(name)
      ? code
      : code.replace(ALLOWED_LINK_TARGET, "").replace(ALLOWED_SVG_NAMESPACE, "");
    assert.doesNotMatch(scanned, /https?:\/\/(?!127\.0\.0\.1)/, `${name}: no absolute remote origin beyond the allowed literals`);
  }
  // …and the raw upstream host literal stays out of the shipped files entirely.
  for (const [name, raw] of sources) assert.doesNotMatch(raw, /api\.deepseek\.com/i, name);
  // Guard the allowance itself: it must not become a blanket exemption.
  assert.doesNotMatch(stripJsComments(sources[0][1]), /platform\.deepseek\.com/i, "our own modules never carry the link");
});
