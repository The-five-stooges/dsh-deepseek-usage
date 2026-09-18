/**
 * dsh-deepseek-usage — browser-half entry (thin assembly layer + inlined half).
 *
 * Served to the browser by `@deepseek-ai/dsh-client-modules` as
 * `/plugins/dsh-deepseek-usage/client.js` and executed as a CLASSIC
 * `<script src>` (dsh-host-webserver `renderRow`, `case "script-src"`), so this
 * file must not use ESM syntax. Its job is to register the bundle factory with the
 * client module system:
 *
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * The module system materializes the bundle on first import, hands `factory` a
 * SYNCHRONOUS `require` bound to the module table (React, the primitive kit, other
 * client packages), and memoizes the returned exports. See
 * `@deepseek-ai/dsh-client-modules/lib/types/client/manifest.d.ts`
 * ("Closure factory holding the whole bundle body") and docs/load-path.md
 * §"浏览器半的装配约束" for the measured evidence behind that constraint.
 *
 * The feature logic is NOT authored here: the six modules under `src/client/`
 * are composed verbatim into the single slot below. The composition is mechanical:
 *
 *   - each module body is copied unchanged EXCEPT that a line-start
 *     `export ` / `export default ` keyword is removed;
 *   - the sibling `import ... from "./x.mjs"` lines are dropped, because the
 *     modules become one closure and the identifiers are already in scope;
 *   - index.mjs's default export becomes the slot's return value;
 *   - the slot ends with the composition wiring, which publishes the popover
 *     factory (`setModalFactory`) for the row's `resolveModal` seat.
 *
 * A classic script is evaluated BEFORE `factory(require)` runs, so React and the
 * balance service do not exist yet — that is why the wiring installs a FACTORY
 * and not the opener itself (`installComposedModal` calls it from `apply(ctx)`).
 *
 * `tests/ui-row.test.mjs` and `tests/ui-modal.test.mjs` assert the equivalence of
 * this copy against the sources (every exported function's source text must appear
 * here), and run the composed script through `node:vm` — the former proves the
 * classic-script envelope still registers `sidebar.footer.action`, the latter proves
 * that clicking the row opens the real popover. A source edit that forgets to
 * recompose fails the suites instead of shipping a stale bundle.
 *
 * @module dsh-deepseek-usage/client
 */

/** The composed browser half: same call shape the envelope always used. */
var createClientHalf = (function () {
  "use strict";

  /* ==================== begin: src/client/format.mjs ==================== */
/**
 * dsh-deepseek-usage — browser-half formatting helpers.
 *
 * Pure functions only: no DOM, no React, no network, no clock of their own
 * (`nowMs` is always passed in), so every branch is testable in plain node.
 * They turn the host's frozen balance envelope into the strings the sidebar row
 * shows. `tests/ui-row.test.mjs` asserts the values — never pixels.
 *
 * COMPOSITION NOTE: the browser bundle is a classic script and cannot use ESM,
 * so this module is inlined **verbatim** into `lib/client.js` (see the
 * `createClientHalf` slot there). Keep every `export ` at a line start — the
 * composer strips that keyword and nothing else — and let the equivalence test
 * in `tests/ui-row.test.mjs` prove the inlined copy has not drifted.
 *
 * @module dsh-deepseek-usage/client/format
 */

/** What every formatter returns for a missing or unusable value. */
const EMPTY_VALUE = "—";

/** The row's placeholder while a read is in flight (visually distinct from {@link EMPTY_VALUE}). */
const PENDING_VALUE = "…";

/**
 * Above this magnitude `Number.prototype.toFixed` switches to exponential
 * notation (`(1e21).toFixed(2) === "1e+21"`), which would smuggle an `e+21` into
 * a money string. Values at or above it are rendered as an explicit exponential.
 */
const EXPONENTIAL_THRESHOLD = 1e21;

/**
 * Symbol per ISO-4217 code, for the codes DeepSeek actually reports plus the
 * common ones. An unknown-but-valid code renders as `<amount> <CODE>`.
 */
const CURRENCY_SYMBOLS = Object.freeze({
  CNY: "¥",
  RMB: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  HKD: "HK$",
});

/** Matching unit ladder for {@link formatCompactNumber}, largest first. */
const COMPACT_UNITS = Object.freeze([
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
]);

/**
 * Coerce one envelope field to a finite number.
 * @param value - number, numeric string, or anything else.
 * @returns the finite number, or `null` when the value is unusable.
 */
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Group the integer part of a decimal string with thousands separators.
 * @param intText - digits without sign or separators.
 * @returns the grouped text.
 */
function groupDigits(intText) {
  return intText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format a balance amount: grouping, fixed decimals, `EMPTY_VALUE` for junk.
 * @param value - the raw amount (number or numeric string).
 * @param decimals - decimal places (default 2; an out-of-range value falls back to 2).
 * @returns the formatted amount, or {@link EMPTY_VALUE}.
 */
function formatAmount(value, decimals = 2) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return EMPTY_VALUE;
  const places = Number.isInteger(decimals) && decimals >= 0 && decimals <= 6 ? decimals : 2;
  if (Math.abs(numeric) >= EXPONENTIAL_THRESHOLD) return numeric.toExponential(places);
  const fixed = numeric.toFixed(places);
  // `(-0.001).toFixed(2)` is "-0.00": a rounded-away value must not keep the sign.
  const negative = fixed.startsWith("-") && Number(fixed) !== 0;
  const digits = fixed.startsWith("-") ? fixed.slice(1) : fixed;
  const dot = digits.indexOf(".");
  const integerPart = dot === -1 ? digits : digits.slice(0, dot);
  const fractionPart = dot === -1 ? "" : digits.slice(dot);
  const grouped = `${groupDigits(integerPart)}${fractionPart}`;
  return negative ? `-${grouped}` : grouped;
}

/**
 * Reduce a currency field to an uppercase three-letter code.
 * @param currency - the envelope's `currency` (e.g. `"CNY"`, `"rmb"`, `""`).
 * @returns the code, or `null` when the value is not a three-letter code.
 */
function normalizeCurrency(currency) {
  if (typeof currency !== "string") return null;
  const trimmed = currency.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : null;
}

/**
 * Look up a currency symbol.
 * @param currency - any currency field value.
 * @returns the symbol, or `null` when the code is unknown/absent.
 */
function currencySymbol(currency) {
  const code = normalizeCurrency(currency);
  if (code === null) return null;
  return Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code) ? CURRENCY_SYMBOLS[code] : null;
}

/**
 * Format an amount together with its currency.
 * @param value - the raw amount.
 * @param currency - the envelope's currency field.
 * @returns `¥12.34` / `12.34 XYZ` / `12.34` (no currency) / {@link EMPTY_VALUE}.
 */
function formatMoney(value, currency) {
  const amount = formatAmount(value);
  if (amount === EMPTY_VALUE) return EMPTY_VALUE;
  const code = normalizeCurrency(currency);
  if (code === null) return amount;
  const symbol = currencySymbol(code);
  return symbol === null ? `${amount} ${code}` : `${symbol}${amount}`;
}

/**
 * Format a count (tokens, requests) compactly for narrow UI.
 * @param value - the raw count.
 * @returns `12.3k` / `1M` / `999,999` / {@link EMPTY_VALUE}.
 */
function formatCompactNumber(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return EMPTY_VALUE;
  const abs = Math.abs(numeric);
  const sign = numeric < 0 ? "-" : "";
  if (abs < 1000) return `${sign}${formatAmount(abs, 0)}`;
  for (const [scale, suffix] of COMPACT_UNITS) {
    if (abs < scale) continue;
    const rounded = Math.round((abs / scale) * 10) / 10;
    // 999,999 must carry to "1M"-style units rather than printing "1000k".
    if (rounded >= 1000 && scale !== COMPACT_UNITS[0][0]) continue;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${sign}${text}${suffix}`;
  }
  return `${sign}${formatAmount(abs, 0)}`;
}

/**
 * Parse an ISO timestamp.
 * @param iso - the raw timestamp.
 * @returns epoch ms, or `null` when unparseable.
 */
function toTimestamp(iso) {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pad a number to two digits.
 * @param value - the number.
 * @returns the padded text.
 */
function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Format an absolute local clock reading (`YYYY-MM-DD HH:mm`).
 * @param iso - the timestamp.
 * @returns the clock text, or {@link EMPTY_VALUE}.
 */
function formatClock(iso) {
  const at = toTimestamp(iso);
  if (at === null) return EMPTY_VALUE;
  const date = new Date(at);
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Describe how fresh a snapshot is, relative to `nowMs`.
 * @param iso - the snapshot's `fetchedAt`.
 * @param nowMs - the caller's clock (epoch ms).
 * @returns `刚刚` / `3 分钟前` / an absolute clock reading beyond a day / {@link EMPTY_VALUE}.
 */
function formatRelativeTime(iso, nowMs = Date.now()) {
  const at = toTimestamp(iso);
  if (at === null) return EMPTY_VALUE;
  const base = toFiniteNumber(nowMs);
  if (base === null) return EMPTY_VALUE;
  const delta = base - at;
  if (delta < 10_000) return "刚刚";
  if (delta < 60_000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return formatClock(iso);
}

/**
 * Build the row's text lookup: the slot's `t` seat when it resolves a key, the
 * built-in Simplified-Chinese dictionary otherwise. A `t` from an unregistered
 * locale namespace returns the key itself, which is exactly the fallback signal.
 * @param t - optional locale seat (`(key) => string`).
 * @param dictionary - the fallback dictionary (defaults to `{}`, i.e. keys).
 * @returns a `(key) => string` lookup that never throws.
 */
function makeTextLookup(t, dictionary = {}) {
  return function text(key) {
    if (typeof t === "function") {
      try {
        const localized = t(key);
        if (typeof localized === "string" && localized !== "" && localized !== key) return localized;
      } catch {
        /* a broken locale seat must not blank the row */
      }
    }
    return Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key;
  };
}

  /* ==================== end: src/client/format.mjs ==================== */

  /* ==================== begin: src/client/service.mjs ==================== */
/**
 * dsh-deepseek-usage — browser-half client for the host route family.
 *
 * HARD CONSTRAINT: the browser half talks **only** to
 * `/api/dsh-deepseek-usage/*` on its own origin. It never reads, stores, or
 * forwards an API key, never sends an `Authorization` header, and never contacts
 * the DeepSeek platform API host — the key lives in the host, and a direct call
 * would also die on CORS and on the platform's `frame-ancestors 'none'` policy.
 * (That rule is greppable: `tests/ui-row.test.mjs` asserts the platform host
 * literal appears nowhere in this half.) Every request is a relative path with
 * `credentials: "same-origin"`, so the host's loopback fence keeps working and no
 * secret can cross the wire.
 *
 * The service normalizes the host's frozen envelopes into exactly the four row
 * states the UI renders:
 *
 *   loading       — the caller's own in-flight state (never returned by `read`)
 *   ready         — `{ ok:true, currency, totalBalance, … }`
 *   unconfigured  — `no_api_key` (HTTP 503): the host has no usable key
 *   error         — every other failure, retryable
 *
 * `read()` never rejects: a thrown `fetch`, a non-JSON body, an HTTP failure, a
 * timeout, and a host-side `internal` all come back as a result object. The row
 * therefore has no unhandled-rejection path.
 *
 * COMPOSITION NOTE: inlined verbatim into `lib/client.js`; keep `export ` at line
 * starts (see `format.mjs` for the full rule).
 *
 * @module dsh-deepseek-usage/client/service
 */

/** Route family base path — the host's `ROUTE_BASE` (`src/host/routes.mjs`). */
const ROUTE_BASE = "/api/dsh-deepseek-usage";

/** Frozen balance endpoint (host: `ROUTES.balance`). */
const BALANCE_PATH = `${ROUTE_BASE}/balance`;

/** Aggregated local-usage endpoint (host: T3's `/usage`; consumed by T6's popover). */
const USAGE_PATH = `${ROUTE_BASE}/usage`;

/** Freshness endpoint (host: `ROUTES.health`) — diagnostics only. */
const HEALTH_PATH = `${ROUTE_BASE}/health`;

/** Default client-side ceiling for one host round-trip. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** The four row states. `loading` is caller-owned; the other three come from `read`. */
const ROW_STATES = Object.freeze({
  loading: "loading",
  ready: "ready",
  unconfigured: "unconfigured",
  error: "error",
});

/**
 * Closed error-code set the host can emit (`BALANCE_ERROR_CODES` plus the usage
 * route's `bad_request` and its `ledger_unavailable`), each with user-facing copy.
 * An unknown code still renders through {@link messageForCode} instead of throwing.
 * UI dictionary copy lives in `row.mjs`; this module is transport only.
 */
const ERROR_MESSAGES = Object.freeze({
  no_api_key: "宿主未配置 DeepSeek API key",
  unauthorized: "API key 无效或无权访问",
  rate_limited: "请求过于频繁，请稍后重试",
  timeout: "宿主读取上游超时",
  network_error: "无法连接宿主路由",
  upstream_error: "上游返回错误",
  bad_response: "上游响应不可用",
  bad_request: "请求参数不合法",
  ledger_unavailable: "本机无法读取用量台账",
  internal: "宿主内部错误",
});

/**
 * User-facing copy for one host error code.
 * @param code - the envelope's `error.code`.
 * @returns the dictionary copy, or a readable fallback naming the code.
 */
function messageForCode(code) {
  if (typeof code === "string" && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)) {
    return ERROR_MESSAGES[code];
  }
  return typeof code === "string" && code !== "" ? `未知错误（${code}）` : "未知错误";
}

/**
 * Classify one host error code into a row state.
 * @param code - the envelope's `error.code`.
 * @returns `"unconfigured"` for `no_api_key`, otherwise `"error"`.
 */
function stateForErrorCode(code) {
  return code === "no_api_key" ? ROW_STATES.unconfigured : ROW_STATES.error;
}

/**
 * Normalize a host success envelope.
 * @param payload - the parsed `{ ok:true, … }` body.
 * @returns a `ready` result (fields copied defensively; never throws).
 */
function normalizeBalancePayload(payload) {
  const body = payload !== null && typeof payload === "object" ? payload : {};
  return {
    state: ROW_STATES.ready,
    currency: typeof body.currency === "string" ? body.currency : null,
    totalBalance: body.totalBalance === undefined ? null : body.totalBalance,
    grantedBalance: body.grantedBalance === undefined ? null : body.grantedBalance,
    toppedUpBalance: body.toppedUpBalance === undefined ? null : body.toppedUpBalance,
    isAvailable: body.isAvailable === true,
    fetchedAt: typeof body.fetchedAt === "string" ? body.fetchedAt : null,
    cached: body.cached === true,
    code: null,
    message: "",
    httpStatus: 200,
  };
}

/**
 * Normalize a host failure (any HTTP status, any body) into a row result.
 * @param httpStatus - the transport status, when there was a response.
 * @param payload - the parsed body, when it parsed.
 * @param fallbackMessage - copy to use when the body carries no usable message.
 * @returns an `unconfigured` or `error` result.
 */
function normalizeFailurePayload(httpStatus, payload, fallbackMessage) {
  const body = payload !== null && typeof payload === "object" ? payload : null;
  const error = body !== null && body.error !== null && typeof body.error === "object" ? body.error : null;
  const code = error !== null && typeof error.code === "string" && error.code !== "" ? error.code : null;
  const explicit = error !== null && typeof error.message === "string" && error.message !== "" ? error.message : null;
  // Precedence: the host's own message, then the closed-set copy for the code, and
  // only then the caller's transport-level fallback ("宿主返回 502").
  const fallback =
    code !== null
      ? messageForCode(code)
      : typeof fallbackMessage === "string" && fallbackMessage !== ""
        ? fallbackMessage
        : messageForCode(code);
  return {
    state: stateForErrorCode(code),
    currency: null,
    totalBalance: null,
    grantedBalance: null,
    toppedUpBalance: null,
    isAvailable: false,
    fetchedAt: null,
    cached: false,
    code,
    message: explicit !== null ? explicit : fallback,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
  };
}

/**
 * Normalize a host success envelope for the aggregated usage window (T6's popover
 * consumes `days`/`totals` verbatim; the contract that freezes that shape is
 * `tests/contract.test.mjs`).
 * @param payload - the parsed `{ ok:true, requestedDays, days, totals, … }` body.
 * @returns a `ready` result carrying the raw payload.
 */
function normalizeUsagePayload(payload) {
  const body = payload !== null && typeof payload === "object" ? payload : {};
  return {
    state: ROW_STATES.ready,
    ok: true,
    requestedDays: Number.isInteger(body.requestedDays) ? body.requestedDays : null,
    generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : null,
    truncated: body.truncated === true,
    days: Array.isArray(body.days) ? body.days : [],
    totals: body.totals !== null && typeof body.totals === "object" ? body.totals : null,
    payload: body,
    code: null,
    message: "",
    httpStatus: 200,
  };
}

/**
 * Normalize the host's `/health` envelope (diagnostics only).
 * @param payload - the parsed health body.
 * @returns a `ready` result carrying the raw payload.
 */
function normalizeHealthPayload(payload) {
  const body = payload !== null && typeof payload === "object" ? payload : {};
  return {
    state: ROW_STATES.ready,
    ok: true,
    name: typeof body.name === "string" ? body.name : null,
    version: typeof body.version === "string" ? body.version : null,
    uptimeMs: Number.isFinite(body.uptimeMs) ? body.uptimeMs : null,
    balanceCache: body.balanceCache !== null && typeof body.balanceCache === "object" ? body.balanceCache : null,
    payload: body,
    code: null,
    message: "",
    httpStatus: 200,
  };
}

/**
 * Build the client-side failure for a transport-level error (no response).
 * @param error - the thrown value.
 * @param aborted - whether our own timeout controller already fired.
 * @returns an `error` result with `timeout` or `network_error`.
 */
function normalizeTransportFailure(error, aborted) {
  const code = aborted === true ? "timeout" : "network_error";
  const detail = error instanceof Error && error.message !== "" ? error.message : String(error);
  return {
    state: ROW_STATES.error,
    currency: null,
    totalBalance: null,
    grantedBalance: null,
    toppedUpBalance: null,
    isAvailable: false,
    fetchedAt: null,
    cached: false,
    code,
    message: `${messageForCode(code)}（${detail}）`,
    httpStatus: null,
  };
}

/**
 * Build the client-side failure for a body that did not parse as JSON.
 * @param httpStatus - the transport status.
 * @param error - the parse failure.
 * @returns an `error` result.
 */
function normalizeParseFailure(httpStatus, error) {
  const detail = error instanceof Error && error.message !== "" ? error.message : String(error);
  return {
    state: ROW_STATES.error,
    currency: null,
    totalBalance: null,
    grantedBalance: null,
    toppedUpBalance: null,
    isAvailable: false,
    fetchedAt: null,
    cached: false,
    code: "bad_response",
    message: `${messageForCode("bad_response")}（${detail}）`,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
  };
}

/**
 * Build the balance/usage service the row (and T6's popover) share.
 *
 * Every collaborator is injectable so the module is testable without a browser:
 * `fetchImpl` (default `globalThis.fetch`, resolved at call time), `now`,
 * `timeoutMs`, and the abort-controller/timer factories.
 *
 * @param options - service collaborators.
 * @param options.fetchImpl - fetch implementation.
 * @param options.now - clock in ms.
 * @param options.timeoutMs - per-request ceiling.
 * @param options.basePath - route family base (defaults to {@link ROUTE_BASE}).
 * @param options.credentials - fetch credentials mode (defaults to `same-origin`).
 * @returns `{ read, readUsage, health, balanceUrl, usageUrl }`.
 */
function createBalanceService(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const basePath = typeof options.basePath === "string" && options.basePath !== "" ? options.basePath : ROUTE_BASE;
  const credentials = typeof options.credentials === "string" ? options.credentials : "same-origin";
  const resolveFetch =
    typeof options.fetchImpl === "function"
      ? () => options.fetchImpl
      : () => (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);

  /**
   * One GET against the route family, normalized into a result — never a rejection.
   *
   * Status first, body second (captain ruling in the README): a failure is never
   * disguised as 200, so a non-2xx status is a failure even when the body happens
   * to parse, and an `ok:false` body is a failure even on a 200.
   *
   * @param path - route path below {@link ROUTE_BASE}.
   * @param query - query string without the leading `?` (may be empty).
   * @param signal - caller abort signal (optional).
   * @param normalize - success-shape normalizer (defaults to the balance shape).
   * @returns the normalized result object.
   */
  async function requestJson(path, query, signal, normalize) {
    const fetchImpl = resolveFetch();
    if (typeof fetchImpl !== "function") {
      const missing = new Error("this environment has no fetch");
      return normalizeTransportFailure(missing, false);
    }
    // Relative path only: an absolute URL here would mean a second origin.
    const url = query === "" ? `${basePath}${path}` : `${basePath}${path}?${query}`;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let aborted = false;
    let timer = null;
    if (controller !== null) {
      // Deliberately NOT unref'd: the timeout must still fire when this request is
      // the only pending work (the host half learned the same lesson in t2).
      timer = setTimeout(() => {
        aborted = true;
        controller.abort(new Error(`host route exceeded ${timeoutMs} ms`));
      }, timeoutMs);
      if (signal !== undefined && signal !== null && typeof signal.addEventListener === "function") {
        if (signal.aborted === true) {
          aborted = true;
          controller.abort(signal.reason);
        } else {
          signal.addEventListener("abort", () => {
            aborted = true;
            controller.abort(signal.reason);
          });
        }
      }
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        credentials,
        cache: "no-store",
        ...(controller === null ? {} : { signal: controller.signal }),
      });
    } catch (error) {
      return normalizeTransportFailure(error, aborted);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    const status = Number.isInteger(response?.status) ? response.status : 0;
    let payload = null;
    let parsed = false;
    try {
      payload = await response.json();
      parsed = true;
    } catch (error) {
      if (status >= 200 && status < 300) return normalizeParseFailure(status, error);
      return normalizeFailurePayload(status, null, `宿主返回 ${status}`);
    }
    if (parsed === true && payload !== null && typeof payload === "object" && payload.ok === true && status < 300) {
      return (typeof normalize === "function" ? normalize : normalizeBalancePayload)(payload);
    }
    if (parsed === true && payload !== null && typeof payload === "object" && payload.ok === false) {
      return normalizeFailurePayload(status, payload, `宿主返回 ${status}`);
    }
    return normalizeFailurePayload(status, null, `宿主返回 ${status}`);
  }

  return {
    basePath,
    balanceUrl: `${basePath}/balance`,
    usageUrl: `${basePath}/usage`,
    /**
     * Read the account balance.
     * @param request - `{ force }` to bypass the host's TTL cache.
     * @returns the normalized result (never rejects).
     */
    async read(request = {}) {
      const force = request !== null && typeof request === "object" && request.force === true;
      const signal = request !== null && typeof request === "object" ? request.signal : undefined;
      return requestJson("/balance", force ? `force=1&_=${now()}` : "", signal, normalizeBalancePayload);
    },
    /**
     * Read the host-aggregated local usage window (T6's popover consumes it).
     * @param request - `{ days }` window size.
     * @returns the normalized result (never rejects) carrying `days`/`totals`.
     */
    async readUsage(request = {}) {
      const days = request !== null && typeof request === "object" ? request.days : undefined;
      const signal = request !== null && typeof request === "object" ? request.signal : undefined;
      const query = Number.isInteger(days) && days > 0 ? `days=${days}` : "";
      return requestJson("/usage", query, signal, normalizeUsagePayload);
    },
    /**
     * Read the host's liveness envelope (cache freshness, diagnostics).
     * @returns the normalized result (never rejects).
     */
    async readHealth() {
      return requestJson("/health", "", undefined, normalizeHealthPayload);
    },
  };
}

  /* ==================== end: src/client/service.mjs ==================== */

  /* ==================== begin: src/client/row.mjs ==================== */
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


/** The slot seat this row occupies (declared by the sidebar shell). */
const ROW_SLOT = "sidebar.footer.action";

/** The row's cell key inside that list slot. */
const ROW_ID = "deepseek-usage";

/**
 * Position among the slot's entries (ascending; the shipped `cordis-panel` entry
 * registers at the default 0). A positive order keeps the balance row to its
 * right, so the two entries never trade places.
 */
const ROW_ORDER = 100;

/** Locale namespace this row reads its `t` seat from (unregistered ⇒ zh fallback). */
const ROW_LOCALE_NAMESPACE = "deepseek-usage";

/** `data-plugin-css` id of the injected row stylesheet (dedupe key). */
const ROW_STYLE_ID = "dsh-deepseek-usage-row";

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
const ROW_CSS = [
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
const ROW_DICTIONARY = Object.freeze({
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
function rowText(t) {
  return makeTextLookup(t, ROW_DICTIONARY);
}

/**
 * Inject the row stylesheet once per document.
 * @param doc - the owning document (absent in node, where this is a no-op).
 * @returns true when a new `<style>` was appended.
 */
function ensureRowStyles(doc) {
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
function refreshClickHandler(onRefresh) {
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
function rowClickHandler(onOpen) {
  return function handleRowClick() {
    if (typeof onOpen === "function") onOpen();
  };
}

/**
 * Keyboard handler: Enter/Space activate the row like a click.
 * @param onOpen - the open action.
 * @returns the keydown handler.
 */
function keyActivateHandler(onOpen) {
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
function describeState(status, snapshot, text, nowMs) {
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
function wrapWithTooltip(deps, label, child) {
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
function renderGlyph(deps, view, key) {
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
function renderRefreshButton(deps, view, key) {
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
function renderBalanceRow(deps, view) {
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
function createBalanceRow(deps) {
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

  /* ==================== end: src/client/row.mjs ==================== */

  /* ==================== begin: src/client/index.mjs ==================== */
/**
 * dsh-deepseek-usage — browser half (client plugin entry).
 *
 * Registers exactly one occupant on the sidebar's list slot
 * `sidebar.footer.action`, which the sidebar shell renders in its `footArea`
 * immediately BEFORE the `sidebar.settings` seat — hence "the balance row above
 * the Settings row" without touching the sidebar shell, the layout, or any
 * shipped package.
 *
 * Composition contract (see `docs/load-path.md` §3 and `README.md`):
 * the browser module system loads this package's bundle as a CLASSIC
 * `<script src="/plugins/dsh-deepseek-usage/client.js">` and needs
 * `factory(require)` to return exports SYNCHRONOUSLY, so this file is authored as
 * ESM but is inlined verbatim into `lib/client.js`'s `createClientHalf` slot.
 * Therefore:
 *
 *  - the default export is a FUNCTION OF `require`, not a module that imports
 *    React itself — everything the browser shell owns (React, the primitive kit)
 *    arrives through the factory's synchronous `require`, which also keeps this
 *    module importable by plain node for tests;
 *  - the only `import` statements are the three sibling modules that the composer
 *    flattens into the same closure (those lines are dropped, the declarations
 *    remain);
 *  - nothing here touches an API key. The browser half talks only to this
 *    origin's `/api/dsh-deepseek-usage/*` through `service.mjs`.
 *
 * @module dsh-deepseek-usage/client
 */


/** Plugin id (the bundle's module-table id and this plugin's cordis name). */
const PLUGIN_NAME = "dsh-deepseek-usage";

/** Services this client plugin waits for before applying. */
const PLUGIN_INJECT = Object.freeze(["slots"]);

/** Specifier of the shared UI primitive kit inside the browser module table. */
const PRIMITIVES_SPECIFIER = "@deepseek-ai/dsh-client-ui-primitives";

/** React specifier handed to the bundle factory by the shell. */
const REACT_SPECIFIER = "react";

/**
 * Well-known global an independently-bundled popover can publish its opener on
 * (`{ open(snapshot) }`). The in-bundle path is {@link setModalOpener}; this is
 * only the second resolution step, so T6 can wire either way.
 */
const MODAL_GLOBAL_KEY = "__DSH_DEEPSEEK_USAGE_MODAL__";

/** Holder for the popover opener composed into this bundle (T6: `src/client/modal.mjs`). */
let modalOpener;

/**
 * Holder for a composed popover FACTORY: `(runtime) => opener`.
 *
 * A factory exists because `setModalOpener` runs at CLASSIC-SCRIPT evaluation
 * time, when `factory(require)` has not been called yet and no React is reachable —
 * so a composed peer cannot build elements there. A factory is called once from
 * {@link createClientHalf}'s `apply` with the activation-time runtime
 * (`{ React, primitives, icons, Tooltip, service, text, slot }`), and whatever
 * opener it returns is installed through {@link setModalOpener}.
 */
let modalFactory;

/**
 * Publish the popover opener (T6 calls this at composition time).
 * @param opener - `(view) => void`; pass `undefined` to clear.
 * @returns the previously installed opener.
 */
function setModalOpener(opener) {
  const previous = modalOpener;
  modalOpener = typeof opener === "function" ? opener : undefined;
  return previous;
}

/**
 * Publish the popover factory (T6's wiring line; alternative to {@link setModalOpener}).
 * @param factory - `(runtime) => opener`; pass `undefined` to clear.
 * @returns the previously installed factory.
 */
function setModalFactory(factory) {
  const previous = modalFactory;
  modalFactory = typeof factory === "function" ? factory : undefined;
  return previous;
}

/**
 * Build the activation-time runtime handed to a composed popover factory.
 * @param runtime - the activation-time collaborators.
 * @returns the frozen runtime object.
 */
function createModalRuntime(runtime) {
  return Object.freeze({
    React: runtime.React,
    primitives: runtime.primitives,
    icons: runtime.icons,
    Tooltip: runtime.Tooltip,
    service: runtime.service,
    text: runtime.text,
    slot: ROW_SLOT,
  });
}

/**
 * Install the composed factory's opener, when one is composed.
 *
 * Failures degrade loudly-but-safely: the row then shows its "popover not
 * composed" hint instead of breaking activation.
 *
 * @param runtime - activation-time collaborators (see {@link createModalRuntime}).
 * @returns the installed opener, or `undefined`.
 */
function installComposedModal(runtime) {
  if (typeof modalFactory !== "function" || getModalOpener() !== undefined) return undefined;
  let opener;
  try {
    opener = modalFactory(createModalRuntime(runtime));
  } catch (error) {
    warnUnavailable(`the composed popover factory threw: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (typeof opener !== "function") {
    if (opener !== undefined) warnUnavailable("the composed popover factory returned no opener function");
    return undefined;
  }
  setModalOpener(opener);
  return opener;
}

/**
 * Resolve the popover opener: the composed one first, then the well-known global.
 * @param root - global object to consult (defaults to `globalThis`).
 * @returns the opener, or `undefined` when no popover is composed.
 */
function getModalOpener(root) {
  if (typeof modalOpener === "function") return modalOpener;
  const host = root === undefined ? globalThis : root;
  const published = host === undefined || host === null ? undefined : host[MODAL_GLOBAL_KEY];
  if (published === null || published === undefined) return undefined;
  return typeof published === "function" ? published : typeof published.open === "function" ? published.open : undefined;
}

/**
 * Require an optional shell module without failing the whole bundle.
 * @param require - the factory's synchronous require.
 * @param specifier - module id.
 * @returns the exports, or `undefined` when the module table has no such id.
 */
function optionalRequire(require, specifier) {
  try {
    return require(specifier);
  } catch {
    return undefined;
  }
}

/**
 * The icon set pulled from the primitive kit (each may be missing; the row falls
 * back to a text glyph).
 * @param primitives - the kit's exports.
 * @returns `{ refresh, loading, warning, balance }`.
 */
function pickIcons(primitives) {
  const kit = primitives !== null && typeof primitives === "object" ? primitives : {};
  return {
    refresh: kit.IconRefreshOutline14 ?? kit.IconRefreshOutline16,
    loading: kit.IconLoadingOutline16,
    warning: kit.IconWarningOutline16,
    balance: kit.IconGaugeOutline16 ?? kit.IconDataOutline16,
  };
}

/**
 * Warn once, loudly enough to be findable, naming the plugin and the seat.
 * @param message - the diagnostic.
 */
function warnUnavailable(message) {
  try {
    if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(`${PLUGIN_NAME}: ${message}`);
  } catch {
    /* a broken console must not break activation */
  }
}

/**
 * Build the client half.
 *
 * @param require - the bundle factory's synchronous `require` (module table).
 * @returns the cordis client plugin: `{ name, inject, apply, setModalOpener, getModalOpener }`.
 */
function createClientHalf(require) {
  if (typeof require !== "function") {
    throw new Error(`${PLUGIN_NAME}: the browser bundle factory must supply require (module table)`);
  }
  const React = require(REACT_SPECIFIER);
  if (React === null || React === undefined || typeof React.createElement !== "function") {
    throw new Error(`${PLUGIN_NAME}: require("react") returned no usable React — the shell's module table must supply it`);
  }
  const primitives = optionalRequire(require, PRIMITIVES_SPECIFIER);
  const icons = pickIcons(primitives);
  const Tooltip = primitives !== undefined && primitives !== null ? primitives.Tooltip : undefined;
  const text = rowText(undefined);

  /**
   * Register the row on the sidebar foot slot.
   * @param ctx - the client cordis context (`slots` is injected).
   * @returns the balance service (T6's popover reuses it).
   */
  function apply(ctx) {
    const service = createBalanceService({});
    const slots = ctx !== null && ctx !== undefined ? ctx.slots : undefined;
    // The seat is declared by the sidebar shell, and `inject: ["slots"]` normally
    // guarantees the service — but `dsh.client.inject` is only an ordering hint
    // (README: "informational ordering hint, not a capability declaration"), so the
    // absence of the slot service degrades EXPLICITLY instead of rendering nothing.
    if (slots === null || slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") {
      warnUnavailable(`the client slot service is unavailable (ctx.slots) — "${ROW_SLOT}" was not mounted`);
      return service;
    }
    const BalanceRow = createBalanceRow({
      React,
      service,
      icons,
      Tooltip,
      document: typeof document === "undefined" ? undefined : document,
      now: () => Date.now(),
      resolveModal: () => getModalOpener(),
    });
    installComposedModal({ React, primitives, icons, Tooltip, service, text });
    slots.inject(ROW_SLOT, () => {
      try {
        return slots.register(
          {
            name: ROW_SLOT,
            id: ROW_ID,
            order: ROW_ORDER,
            locale: ROW_LOCALE_NAMESPACE,
            label: () => text("row.label"),
          },
          BalanceRow,
        );
      } catch (error) {
        // The shell's own slot error boundary is the second line of defense; this
        // line makes the reason findable ("slot undeclared / shell without the seat").
        warnUnavailable(
          `registering on "${ROW_SLOT}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    });
    return service;
  }

  return {
    name: PLUGIN_NAME,
    inject: PLUGIN_INJECT,
    apply,
    setModalOpener,
    getModalOpener,
  };
}

  /* ==================== end: src/client/index.mjs ==================== */

  /* ==================== begin: src/client/chart.mjs ==================== */
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


/** SVG namespace for every element the popover creates. */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The currency the host's estimated cost is denominated in.
 *
 * The English pricing page quotes USD and the Chinese one quotes CNY for the same
 * models — with DIFFERENT numbers — and the account this plugin reports on is billed
 * in CNY (its balance payload carries CNY, and the host's `PRICE_TABLE_SOURCE.currency`
 * is `CNY` too). The symbol comes from `format.mjs`'s own table rather than a literal
 * here, so the one place that knows "CNY is ¥" stays the one place.
 */
const COST_CURRENCY = "CNY";

/** The cost currency's symbol, e.g. `¥`; falls back to `CNY ` when unknown. */
const COST_SYMBOL = currencySymbol(COST_CURRENCY) ?? `${COST_CURRENCY} `;

/** The two chart views; the values are the host's own field names. */
const CHART_METRICS = Object.freeze({
  tokens: "totalTokens",
  cost: "estimatedCostCny",
});

/** Default drawing box (CSS pixels); the popover passes the measured one. */
const DEFAULT_CHART_SIZE = Object.freeze({ width: 640, height: 220 });

/** Default inner margins: left/bottom leave room for the axis labels. */
const CHART_PADDING = Object.freeze({ top: 12, right: 14, bottom: 26, left: 56 });

/** Number of horizontal grid lines (including both ends). */
const Y_TICK_COUNT = 5;

/** A bar never grows wider than this, however few days the window has. */
const MAX_BAR_WIDTH = 26;

/** …and never narrower than this, so a long window stays visible. */
const MIN_BAR_WIDTH = 1;

/** The host's placeholder model id for a message that carried no model name. */
const UNKNOWN_MODEL = "unknown";

/**
 * Coerce one host field to a usable non-negative count. Anything unusable
 * (missing, `NaN`, `Infinity`, a string, a negative number) becomes `0`, because
 * a chart must never print `NaN` or a negative bar.
 * @param value - the raw field.
 * @returns a finite number `>= 0`.
 */
function toCount(value) {
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
function toPositive(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Round to two decimals — the precision every SVG attribute is written with, so
 * the geometry is deterministic and comparable without asserting pixels.
 * @param value - the raw coordinate.
 * @returns the rounded coordinate (never `-0`).
 */
function round2(value) {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Clamp to `[0, 1]`.
 * @param value - the raw ratio.
 * @returns the clamped ratio.
 */
function clamp01(value) {
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
function daysOf(payload) {
  if (payload === null || payload === undefined || typeof payload !== "object") return [];
  return Array.isArray(payload.days) ? payload.days : [];
}

/**
 * The host's `day.models` as an array.
 * @param day - one day bucket.
 * @returns the model buckets (possibly empty).
 */
function modelsOf(day) {
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
function costOf(model) {
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
function projectSeries(payload, metric = CHART_METRICS.tokens) {
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
function niceCeil(value) {
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
function formatMetricValue(value, metric = CHART_METRICS.tokens) {
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
function buildChartGeometry(series, options = {}) {
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
function summarizeUsage(payload) {
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
const HIT_MODES = Object.freeze({
  column: "column",
  bar: "bar",
  point: "point",
});

/** Default hover radius in px for {@link HIT_MODES.point}. */
const HIT_RADIUS = 16;

/** Tooltip copy; every string can be overridden through `options.labels`. */
const TOOLTIP_LABELS = Object.freeze({
  input: "输入",
  cacheRead: "缓存读",
  output: "输出",
  cost: "费用",
  total: "合计",
  none: "当日无用量记录",
});

/** The cost figure is a local estimate; the platform bill stays authoritative. */
const TOOLTIP_NOTE = "本地估算，平台账单为权威";

/** Footer hint: the keyboard path reaches the same tooltip as the pointer. */
const TOOLTIP_HINT = "←/→ 切换日期 · Esc 关闭";

/**
 * The attribute/class vocabulary shared by the binder and the renderer. Using
 * one frozen table keeps the highlight assertable (`data-active="true"`,
 * `aria-selected="true"`) without either side guessing at names.
 */
const CHART_INTERACTION = Object.freeze({
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
const TOOLTIP_MIN_WIDTH = 150;

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
const CHART_INTERACTION_CSS = [
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
function plotBoxOf(geometry) {
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
function buildHitTargets(geometry, options = {}) {
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
function hitTest(geometry, x, y, options = {}) {
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
function keyboardIndex(geometry, current, key) {
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
function activeAttributes(isActive) {
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
function hitTargetAttributes(target, activeIndex, options = {}) {
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
function tooltipRowText(row, labels = TOOLTIP_LABELS) {
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
function tooltipFields(row, labels = TOOLTIP_LABELS) {
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
function tooltipTotalText(totals, labels = TOOLTIP_LABELS) {
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
function tooltipTotalFields(totals, labels = TOOLTIP_LABELS) {
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
function tooltipModel(payload, dayRef, options = {}) {
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
function tooltipLines(model, labels = TOOLTIP_LABELS) {
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
function tooltipPlacement(geometry, hit, options = {}) {
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
function attachChartInteraction(options = {}) {
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

  /* ==================== end: src/client/chart.mjs ==================== */

  /* ==================== begin: src/client/modal.mjs ==================== */
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


/** Plugin-scoped id shared by the overlay, its styles and its data attributes. */
const MODAL_ID = "deepseek-usage";

/** `data-plugin-css` id of the injected popover stylesheet (dedupe key). */
const MODAL_STYLE_ID = "dsh-deepseek-usage-modal";

/**
 * Where the platform's usage page lives. Bare on purpose: an unsupported deep-link
 * parameter must not be invented (the SPA's parsing is unverified), and the page
 * itself redirects into its login flow when signed out.
 */
const PLATFORM_USAGE_URL = "https://platform.deepseek.com/usage";

/** The usage windows the popover offers, in days (T6 acceptance: 7/30). */
const USAGE_WINDOWS = Object.freeze([7, 30]);

/** Window selected when the popover opens (matches the host's own default). */
const DEFAULT_USAGE_DAYS = 30;

/** Smallest/largest window the host route accepts (`routes.mjs` USAGE_DAYS_MIN/MAX). */
const USAGE_DAYS_MIN = 1;
const USAGE_DAYS_MAX = 365;

/** The shell mount point that gets `inert` while the dialog is open. */
const MODAL_ROOT_ID = "root";

/** The four states the popover renders (the service's states, reused verbatim). */
const MODAL_STATES = Object.freeze({
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
const MODAL_ATTR = Object.freeze({
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
const MODAL_DICTIONARY = Object.freeze({
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
function modalText(t) {
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
const MODAL_CSS = [
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
const MODAL_STYLE_TEXT = `${MODAL_CSS}${CHART_INTERACTION_CSS}`;

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
function ensureModalStyles(doc) {
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
function collectFocusable(root) {
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
function setRootInert(doc, inert, rootId = MODAL_ROOT_ID) {
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
function restoreRootInert(doc, state, rootId = MODAL_ROOT_ID) {
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
function normalizeDays(days) {
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
function describeBalanceCard(snapshot, text, nowMs = Date.now()) {
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
function describeUsagePanel(snapshot, text, nowMs = Date.now()) {
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
function describeModalModel(state, text, nowMs = Date.now()) {
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
function shortDayLabel(label) {
  return typeof label === "string" && label.length >= 10 ? label.slice(5) : String(label ?? "");
}

/**
 * Render one SVG chart (line for tokens, bars for cost) from chart geometry.
 * @param doc - the owning document.
 * @param kind - `"tokens"` or `"cost"`.
 * @param geometry - a {@link buildChartGeometry} model.
 * @returns the `<svg>` element.
 */
function renderChartSvg(doc, kind, geometry) {
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
function attachChartInteractions(doc, panel, model, registry) {
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
function renderModelTable(doc, text, summary) {
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
function renderModalPanel(doc, model, handlers = {}, text = modalText(undefined)) {
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
function openPlatformUsage(win, url = PLATFORM_USAGE_URL) {
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
function createUsageModalOpener(runtime = {}) {
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
function openUsageModal(view = {}, deps = {}) {
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

  /* ==================== end: src/client/modal.mjs ==================== */

  /* ==================== begin: composition wiring (assembly layer, not a source module) ==================== */
  // Publish the popover FACTORY, not the opener: at classic-script evaluation time
  // `factory(require)` has not run, so React and the service do not exist yet.
  // `installComposedModal` (index.mjs) calls this from `apply(ctx)` with the
  // activation-time runtime and installs the returned opener on the row's seat.
  setModalFactory(function (runtime) {
    return createUsageModalOpener(runtime);
  });
  /* ==================== end: composition wiring ==================== */

  return createClientHalf;
})();

(function registerClientBundle(root) {
  "use strict";

  var ID = "dsh-deepseek-usage";

  var loader = root.__ModuleLoader__;
  if (loader === undefined || loader === null || typeof loader.load !== "function") {
    throw new Error(
      ID + ": window.__ModuleLoader__ is missing — this bundle must be loaded through the DSH web shell",
    );
  }

  loader.load({
    id: ID,
    factory: function (require) {
      if (typeof createClientHalf !== "function") {
        throw new Error(
          ID +
            ": browser half is not composed — inline src/client/index.mjs into the createClientHalf slot of lib/client.js (see docs/load-path.md)",
        );
      }
      return createClientHalf(require);
    },
  });
})(globalThis);
