/**
 * dsh-deepseek-usage — host-side DeepSeek balance reader.
 *
 * Reads `GET https://api.deepseek.com/user/balance` with the API key resolved
 * from the host credential seam, caches the successful snapshot for a short
 * TTL, and returns the response envelope frozen by
 * `tests/contract.test.mjs`:
 *
 *   success: `{ ok: true, currency, totalBalance, grantedBalance,
 *               toppedUpBalance, isAvailable, fetchedAt, cached }`
 *   failure: `{ ok: false, error: { code, message } }`
 *
 * Two rules bind every path in this module:
 *   1. The API key never leaves the process: it goes into the Authorization
 *      header only — never a URL, never a response body, never a log line, and
 *      never an error message (every outgoing text passes {@link redactSecret}).
 *   2. The key is re-resolved per upstream operation (never cached), because
 *      the credential seam promises a changed value reaches the next operation.
 *      What the TTL caches is the *balance snapshot*, not the credential.
 *
 * Prerequisite: resolving `@deepseek-ai/dsh-credentials` from this package
 * requires the package-local `node_modules` junction documented in README.md
 * (§装载前置).
 *
 * @module dsh-deepseek-usage/host/balance
 */

import { credentialRef } from "@deepseek-ai/dsh-credentials";

/** Official balance endpoint (the only endpoint that reports an account balance). */
export const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** Environment-variable-style credential reference resolved through `ctx.credentials`. */
export const CREDENTIAL_REF_NAME = "DEEPSEEK_API_KEY";

/** Cache TTL for a successful snapshot (ms). `force=1` bypasses it. */
export const BALANCE_TTL_MS = 60_000;

/** Upstream request timeout (ms). */
export const BALANCE_TIMEOUT_MS = 10_000;

/** Replacement text for anything that could carry the secret. */
export const REDACTION_PLACEHOLDER = "[redacted]";

/**
 * The shared closed set of error codes this package may emit. It is the union
 * of the balance codes and the usage route's codes, and it must stay identical
 * to the frozen set in `tests/contract.test.mjs` (that file asserts equality,
 * so a drift here fails the contract test loudly instead of surfacing as a
 * thrown guard at request time).
 *
 * `ledger_unavailable` is the usage route's degraded answer (no readable local
 * session ledger — e.g. a Node build without `zlib.zstdDecompress`), and
 * `internal` is the catch-all for an unexpected local failure.
 */
export const BALANCE_ERROR_CODES = Object.freeze([
  // balance
  "no_api_key",
  "unauthorized",
  "rate_limited",
  "timeout",
  "network_error",
  "upstream_error",
  "bad_response",
  // usage
  "bad_request",
  "ledger_unavailable",
  // shared catch-all
  "internal",
]);

/**
 * HTTP status per frozen error code (captain ruling, plan §6.6): a failure is
 * never disguised as `200`. The closed code set is unchanged — only the
 * transport status now carries the real semantics.
 *
 * | situation                  | code              | status |
 * |----------------------------|-------------------|--------|
 * | invalid `?days=`           | bad_request       | 400    |
 * | no usable API key          | no_api_key        | 503    |
 * | upstream non-2xx (incl 429)| unauthorized /     | 502    |
 * |                            | rate_limited /     |        |
 * |                            | upstream_error     |        |
 * | upstream timed out         | timeout           | 504    |
 * | upstream body unusable     | bad_response      | 502    |
 * | local ledger unreadable    | ledger_unavailable| 503    |
 * | local reader failure       | internal          | 500    |
 *
 * `ledger_unavailable` is 503 (not 502) on purpose: 502 means "the upstream
 * answered badly", while an unreadable local session ledger means this host
 * cannot serve that capability right now — Service Unavailable.
 */
export const ERROR_STATUS = Object.freeze({
  bad_request: 400,
  no_api_key: 503,
  unauthorized: 502,
  rate_limited: 502,
  upstream_error: 502,
  timeout: 504,
  bad_response: 502,
  network_error: 502,
  ledger_unavailable: 503,
  internal: 500,
});

/**
 * Map one frozen error code onto its HTTP status.
 * @param code - a code from {@link BALANCE_ERROR_CODES} (or the usage route's `bad_request`).
 * @returns the status; an unknown code degrades to 500 rather than 200.
 */
export function statusForErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_STATUS, code) ? ERROR_STATUS[code] : 500;
}

/** True for the currencies the official endpoint reports per account. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Key-shaped token patterns, used when the actual secret value is unknown —
 * for example when the credential provider itself throws, so there is no value
 * to compare against. Redacting by shape is deliberate defense in depth: an
 * upstream library's error message must not be able to smuggle a key out.
 */
const SECRET_SHAPES = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
]);

/**
 * Reduce every occurrence of a secret from outward-bound text.
 * @param text - candidate message (error message, log line).
 * @param secret - the secret value to remove; empty/undefined is a no-op.
 * @returns the text with each occurrence replaced by {@link REDACTION_PLACEHOLDER}.
 */
export function redactSecret(text, secret) {
  const value = typeof text === "string" ? text : String(text);
  if (typeof secret !== "string" || secret === "") return value;
  let redacted = value;
  for (const variant of new Set([secret, encodeURIComponent(secret)])) {
    if (variant === "") continue;
    redacted = redacted.split(variant).join(REDACTION_PLACEHOLDER);
  }
  return redacted;
}

/**
 * Redact secret-shaped tokens (`sk-…`, `Bearer …`) without knowing the value.
 * @param text - candidate message.
 * @returns the text with every key-shaped token replaced.
 */
export function scrubSecretShapes(text) {
  let out = typeof text === "string" ? text : String(text);
  for (const pattern of SECRET_SHAPES) out = out.replace(pattern, REDACTION_PLACEHOLDER);
  return out;
}

/**
 * The one sanitizer every outward-bound string passes through: exact-value
 * redaction first, then shape redaction for whatever the value check missed.
 * @param text - candidate message.
 * @param secret - the known secret, when there is one.
 * @returns a message safe to log, return, or surface in an error envelope.
 */
export function sanitizeMessage(text, secret) {
  return scrubSecretShapes(redactSecret(text, secret));
}

/**
 * Build one structured failure envelope.
 * @param code - one of {@link BALANCE_ERROR_CODES}.
 * @param message - human-readable, secret-free message.
 * @returns the frozen error envelope.
 */
export function balanceFailure(code, message) {
  if (!BALANCE_ERROR_CODES.includes(code)) throw new Error(`dsh-deepseek-usage: unknown balance error code ${JSON.stringify(code)}`);
  return { ok: false, error: { code, message } };
}

/**
 * Map an upstream HTTP status onto this module's error codes.
 * @param status - the response status code.
 * @returns the error code (never `no_api_key`/`bad_response`).
 */
export function classifyUpstreamStatus(status) {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  return "upstream_error";
}

/**
 * Thrown by {@link parseBalanceBody} for a structurally unusable body.
 * Carries the frozen code so callers do not re-map it.
 */
export class BalanceBodyError extends Error {
  /**
   * @param message - secret-free description of what the body lacked.
   */
  constructor(message) {
    super(message);
    this.name = "BalanceBodyError";
    this.code = "bad_response";
  }
}

/**
 * Parse one positive, finite amount out of the upstream decimal-string form.
 * @param value - raw field value (the official endpoint sends strings such as "12.02").
 * @param field - field name for the diagnostic.
 * @returns the parsed number.
 * @throws {BalanceBodyError} when the field is absent, unparseable, or negative.
 */
function parseAmount(value, field) {
  if (typeof value !== "string" && typeof value !== "number") throw new BalanceBodyError(`balance response ${field} is missing`);
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new BalanceBodyError(`balance response ${field} is not a number`);
  if (parsed < 0) throw new BalanceBodyError(`balance response ${field} is negative`);
  return parsed;
}

/**
 * Pick the account entry to report, preferring CNY.
 * @param infos - the upstream `balance_infos` array.
 * @returns the chosen entry.
 * @throws {BalanceBodyError} when the array carries no usable entry.
 */
function pickBalanceInfo(infos) {
  if (!Array.isArray(infos)) throw new BalanceBodyError("balance response has no balance_infos array");
  if (infos.length === 0) throw new BalanceBodyError("balance response balance_infos is empty");
  const encodable = infos.filter((info) => typeof info === "object" && info !== null);
  if (encodable.length === 0) throw new BalanceBodyError("balance response balance_infos has no object entry");
  const preferred = encodable.find((info) => info.currency === "CNY");
  return preferred ?? encodable[0];
}

/**
 * Parse the official balance body into the numbers the contract exposes.
 * @param body - decoded JSON body from the upstream endpoint.
 * @returns `{ currency, totalBalance, grantedBalance, toppedUpBalance, isAvailable }`.
 * @throws {BalanceBodyError} when the body is structurally unusable.
 */
export function parseBalanceBody(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BalanceBodyError("balance response is not a JSON object");
  }
  const info = pickBalanceInfo(body.balance_infos);
  if (typeof info.currency !== "string" || !CURRENCY_PATTERN.test(info.currency)) {
    throw new BalanceBodyError("balance response entry has no 3-letter currency code");
  }
  if (typeof body.is_available !== "boolean") throw new BalanceBodyError("balance response has no boolean is_available");
  return {
    currency: info.currency,
    totalBalance: parseAmount(info.total_balance, "total_balance"),
    grantedBalance: info.granted_balance === undefined ? 0 : parseAmount(info.granted_balance, "granted_balance"),
    toppedUpBalance: info.topped_up_balance === undefined ? 0 : parseAmount(info.topped_up_balance, "topped_up_balance"),
    isAvailable: body.is_available,
  };
}

/**
 * Whether an error is an abort/timeout signal.
 * @param error - the rejection value.
 * @param aborted - whether our own timeout controller already fired.
 * @returns true when the failure must classify as `timeout`.
 */
export function isTimeoutFailure(error, aborted) {
  if (aborted) return true;
  const name = typeof error === "object" && error !== null ? error.name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Create the balance reader.
 *
 * Every collaborator is injected so tests drive the whole state machine with a
 * fake fetcher, a fake clock, and a fake credential provider — no real network.
 *
 * @param deps - collaborators.
 * @param deps.getApiKey - resolves the current plaintext key (`undefined` when unconfigured).
 * @param deps.fetchImpl - `fetch`-compatible implementation.
 * @param deps.now - clock in ms since epoch.
 * @param deps.logger - optional `{ warn }` sink (receives redacted lines only).
 * @param deps.timeoutMs - upstream timeout (default {@link BALANCE_TIMEOUT_MS}).
 * @param deps.ttlMs - success-cache TTL (default {@link BALANCE_TTL_MS}).
 * @param deps.url - upstream endpoint (default {@link BALANCE_URL}).
 * @returns the reader: `read({ force })`, `invalidate()`, `cacheState()`.
 */
export function createBalanceService(deps) {
  const {
    getApiKey,
    fetchImpl,
    now = () => Date.now(),
    logger,
    timeoutMs = BALANCE_TIMEOUT_MS,
    ttlMs = BALANCE_TTL_MS,
    url = BALANCE_URL,
  } = deps;

  if (typeof getApiKey !== "function") throw new TypeError("createBalanceService: getApiKey must be a function");
  if (typeof fetchImpl !== "function") throw new TypeError("createBalanceService: fetchImpl must be a function");

  /** Last successful envelope plus the instant it stops being fresh, or undefined. */
  let cache;

  /**
   * Log one redacted warning, never throwing into the request path.
   * @param text - message; any secret inside is stripped first.
   * @param secret - the key to strip.
   */
  const warn = (text, secret) => {
    if (logger === undefined || typeof logger.warn !== "function") return;
    try {
      logger.warn(`dsh-deepseek-usage: ${sanitizeMessage(text, secret)}`);
    } catch {
      /* a broken logger must not fail a balance request */
    }
  };

  /**
   * Perform one upstream read.
   * @param force - bypass the TTL cache.
   * @returns the frozen envelope for this operation.
   */
  async function read(options = {}) {
    const force = options.force === true;
    const requestedAt = now();

    if (!force && cache !== undefined && cache.expiresAt > requestedAt) {
      return { ...cache.payload, cached: true };
    }

    let apiKey;
    try {
      apiKey = await getApiKey();
    } catch (error) {
      const message = sanitizeMessage(`credential resolution failed: ${error instanceof Error ? error.message : String(error)}`, apiKey);
      warn(`balance no_api_key: ${message}`, apiKey);
      return balanceFailure("no_api_key", message);
    }
    if (typeof apiKey !== "string" || apiKey === "") {
      const message = `${CREDENTIAL_REF_NAME} is not configured for this host`;
      warn(`balance no_api_key: ${message}`, apiKey);
      return balanceFailure("no_api_key", message);
    }

    const controller = new AbortController();
    // The timer stays referenced on purpose: a timeout must still fire when the
    // upstream request is the only pending work, otherwise the loop can drain
    // and the request hangs instead of failing as `timeout`. It is always
    // cleared in the `finally` below, so it never outlives this call.
    const timer = setTimeout(() => {
      controller.abort(new DOMException(`balance request exceeded ${timeoutMs} ms`, "TimeoutError"));
    }, timeoutMs);

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      const detail = sanitizeMessage(error instanceof Error ? error.message : String(error), apiKey);
      if (isTimeoutFailure(error, controller.signal.aborted)) {
        const message = `balance request timed out after ${timeoutMs} ms`;
        warn(`balance timeout: ${detail}`, apiKey);
        return balanceFailure("timeout", message);
      }
      const message = `balance request failed: ${detail}`;
      warn(`balance network_error: ${message}`, apiKey);
      return balanceFailure("network_error", message);
    } finally {
      clearTimeout(timer);
    }

    const status = typeof response?.status === "number" ? response.status : 0;
    const ok = response?.ok === true || (status >= 200 && status < 300);
    if (!ok) {
      const code = classifyUpstreamStatus(status);
      const message = `official balance endpoint answered HTTP ${status}`;
      warn(`balance ${code}: ${message}`, apiKey);
      return balanceFailure(code, message);
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      const detail = sanitizeMessage(error instanceof Error ? error.message : String(error), apiKey);
      const message = `balance response body is not JSON: ${detail}`;
      warn(`balance bad_response: ${message}`, apiKey);
      return balanceFailure("bad_response", message);
    }

    let parsed;
    try {
      parsed = parseBalanceBody(body);
    } catch (error) {
      const message = sanitizeMessage(error instanceof Error ? error.message : String(error), apiKey);
      warn(`balance bad_response: ${message}`, apiKey);
      return balanceFailure("bad_response", message);
    }

    const payload = {
      ok: true,
      currency: parsed.currency,
      totalBalance: parsed.totalBalance,
      grantedBalance: parsed.grantedBalance,
      toppedUpBalance: parsed.toppedUpBalance,
      isAvailable: parsed.isAvailable,
      fetchedAt: new Date(requestedAt).toISOString(),
      cached: false,
    };
    cache = { payload, expiresAt: requestedAt + ttlMs };
    return payload;
  }

  return {
    read,
    /** Drop the cached snapshot (the next read hits upstream). */
    invalidate() {
      cache = undefined;
    },
    /**
     * Inspect the cache without reading upstream (used by `/health`).
     * @param at - clock override; defaults to `now()`.
     * @returns `{ warm, ageMs, expiresInMs }` — `warm` is false when empty or stale.
     */
    cacheState(at = now()) {
      if (cache === undefined) return { warm: false };
      const fresh = cache.expiresAt > at;
      return {
        warm: fresh,
        ageMs: Math.max(0, at - Date.parse(cache.payload.fetchedAt)),
        expiresInMs: Math.max(0, cache.expiresAt - at),
      };
    },
  };
}

/**
 * Resolve the DeepSeek API key through the host credential seam.
 *
 * `ctx.credentials.resolve` is the only path that yields a plaintext value;
 * the remote/describe surfaces are structurally value-free. The provider is
 * looked up per call so a credential provider that activates after this plugin
 * still answers.
 *
 * @param ctx - cordis context exposing `credentials`.
 * @returns the plaintext key, or `undefined` while unconfigured.
 */
export async function resolveDeepseekApiKey(ctx) {
  const provider = typeof ctx?.get === "function" ? ctx.get("credentials") : ctx?.credentials;
  if (provider === undefined || provider === null || typeof provider.resolve !== "function") return undefined;
  const resolved = await provider.resolve(credentialRef(CREDENTIAL_REF_NAME));
  return resolved?.value;
}
