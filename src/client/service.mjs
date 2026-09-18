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
export const ROUTE_BASE = "/api/dsh-deepseek-usage";

/** Frozen balance endpoint (host: `ROUTES.balance`). */
export const BALANCE_PATH = `${ROUTE_BASE}/balance`;

/** Aggregated local-usage endpoint (host: T3's `/usage`; consumed by T6's popover). */
export const USAGE_PATH = `${ROUTE_BASE}/usage`;

/** Freshness endpoint (host: `ROUTES.health`) — diagnostics only. */
export const HEALTH_PATH = `${ROUTE_BASE}/health`;

/** Default client-side ceiling for one host round-trip. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** The four row states. `loading` is caller-owned; the other three come from `read`. */
export const ROW_STATES = Object.freeze({
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
export const ERROR_MESSAGES = Object.freeze({
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
export function messageForCode(code) {
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
export function stateForErrorCode(code) {
  return code === "no_api_key" ? ROW_STATES.unconfigured : ROW_STATES.error;
}

/**
 * Normalize a host success envelope.
 * @param payload - the parsed `{ ok:true, … }` body.
 * @returns a `ready` result (fields copied defensively; never throws).
 */
export function normalizeBalancePayload(payload) {
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
export function normalizeFailurePayload(httpStatus, payload, fallbackMessage) {
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
export function normalizeUsagePayload(payload) {
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
export function normalizeHealthPayload(payload) {
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
export function normalizeTransportFailure(error, aborted) {
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
export function normalizeParseFailure(httpStatus, error) {
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
export function createBalanceService(options = {}) {
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
