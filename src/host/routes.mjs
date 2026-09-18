/**
 * dsh-deepseek-usage — host HTTP route family.
 *
 * Registers, through `ctx.webServer.register` (kind `exact`):
 *
 *   GET /api/dsh-deepseek-usage/balance[?force=1]   → the frozen balance envelope
 *   GET /api/dsh-deepseek-usage/health              → liveness + cache state
 *   GET /api/dsh-deepseek-usage/usage[?days=N]      → the frozen usage envelope
 *   GET /health                                     → optional alias of the above
 *
 * `/usage` reads the host-side ledger (T3, `ledger.mjs`) through `deps.usage`,
 * a reader shaped exactly like the balance reader: `read({ days }) →
 * { ok:true, requestedDays, days, generatedAt, truncated, totals }` on success,
 * or the frozen failure envelope. The ledger diagnostics and the price source
 * stay host-side: only contract fields cross the wire.
 *
 * Every route carries the family trust fence: the socket address must be
 * loopback (127/8, `::1`, or an IPv4-mapped form), the `Host` header must name
 * a loopback authority, browser same-origin markers must agree, and
 * `X-Forwarded-For` is never consulted. A rejected request answers `403`
 * before any credential is resolved or any upstream call happens.
 *
 * HTTP status policy (captain ruling, plan §6.6): **a failure is never disguised
 * as 200**. Success is 200; failures answer the real status for their frozen
 * error code (`503` no key, `504` timeout, `502` upstream non-2xx or unusable
 * body, `400` bad request, `500` internal). The response body keeps the frozen
 * envelope shape `{ ok:false, error:{ code, message } }`. `403` (fence) and
 * `405` (method) are outside the envelope.
 *
 * @module dsh-deepseek-usage/host/routes
 */

import { balanceFailure, sanitizeMessage, statusForErrorCode } from "./balance.mjs";

/** Route family base path. */
export const ROUTE_BASE = "/api/dsh-deepseek-usage";

/** Canonical exact paths of the family. */
export const ROUTES = Object.freeze({
  balance: `${ROUTE_BASE}/balance`,
  health: `${ROUTE_BASE}/health`,
  usage: `${ROUTE_BASE}/usage`,
});

/** Optional bare liveness alias (also fenced). */
export const HEALTH_ALIAS = "/health";

/** Plugin name reported by `/health`. */
export const PLUGIN_NAME = "dsh-deepseek-usage";

/** Response headers shared by the family; responses are never cached by a browser. */
export const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
});

/** Methods answered with a body (HEAD answers headers only). */
const ALLOWED_METHODS = Object.freeze(["GET", "HEAD"]);

/* ------------------------------------------------------------------ *
 * `/usage` window parsing (mirrors the frozen contract, exactly)
 * ------------------------------------------------------------------ */

/** Window used when `?days=` is absent. */
export const USAGE_DAYS_DEFAULT = 30;

/** Smallest accepted `?days=` value. */
export const USAGE_DAYS_MIN = 1;

/** Largest accepted `?days=` value. */
export const USAGE_DAYS_MAX = 365;

/**
 * The RAW `?days=` query value, in the shape the frozen contract normalizes.
 *
 * `URLSearchParams.get` returns only the first of repeated parameters, which
 * would make `?days=3&days=4` a silent 3-day window. The contract's
 * `normalizeDays` instead receives `undefined` when absent and a `string[]` when
 * repeated (and fails the array on "days must be a single query value"), so the
 * repeat has to survive this far. This is the one place that decides which
 * shape reaches {@link parseUsageDays}.
 *
 * @param searchParams - the request's parsed query.
 * @returns `undefined`, a single string, or the array of repeated values.
 */
export function rawUsageDays(searchParams) {
  const values = searchParams.getAll("days");
  if (values.length === 0) return undefined;
  if (values.length === 1) return values[0];
  return values;
}

/**
 * Normalize the `?days=N` query value into the requested window.
 *
 * Mirrors `normalizeDays` in `tests/contract.test.mjs`: absent means
 * {@link USAGE_DAYS_DEFAULT}; anything else must be a single decimal integer
 * inside `[1, 365]`, so a REPEATED parameter (which arrives as an array) is
 * rejected rather than silently resolved to its first value. A throw here
 * becomes `400 bad_request` — the producer side of the contract, so the client
 * never has to guess.
 *
 * @param raw - raw query value (`undefined` when absent, `string[]` when repeated).
 * @returns the effective window (integer).
 * @throws {RangeError} when the value is not a single in-range decimal integer.
 */
export function parseUsageDays(raw) {
  if (raw === null || raw === undefined) return USAGE_DAYS_DEFAULT;
  if (Array.isArray(raw)) throw new RangeError(`days must be a single query value, received ${raw.length}`);
  if (typeof raw !== "string") throw new RangeError("days must be a single query value");
  if (!/^\d+$/.test(raw)) throw new RangeError(`days must be a decimal integer, received ${JSON.stringify(raw)}`);
  const value = Number(raw);
  if (!(value >= USAGE_DAYS_MIN && value <= USAGE_DAYS_MAX)) {
    throw new RangeError(`days must be within [${USAGE_DAYS_MIN}, ${USAGE_DAYS_MAX}], received ${raw}`);
  }
  return value;
}

/**
 * Whether a socket address is an IPv4 loopback literal (127/8).
 * @param v4 - dotted-quad candidate.
 * @returns true for 127.0.0.0/8.
 */
export function isIPv4Loopback(v4) {
  const parts = v4.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Whether a socket remote address names the loopback range.
 * @param address - `req.socket.remoteAddress`.
 * @returns true for 127/8, `::1`, and IPv4-mapped loopback.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
  return isIPv4Loopback(normalized);
}

/**
 * Whether a URL hostname names a loopback authority.
 * @param hostname - hostname parsed out of the Host/Origin header.
 * @returns true for `localhost`, `[::1]`, and 127/8.
 */
export function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return isIPv4Loopback(hostname);
}

/**
 * The family trust fence. The socket address is authoritative; forwarded
 * headers are ignored, and browser cross-site markers are refused.
 * @param request - incoming HTTP request.
 * @returns true when the request may enter the family.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false;
  const host = request?.headers?.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * Write one JSON response, honoring HEAD (headers only).
 * @param request - the incoming request (for the HEAD check).
 * @param response - node ServerResponse.
 * @param status - status code.
 * @param body - JSON-serializable body.
 */
export function writeJson(request, response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(payload) });
  if (request.method === "HEAD") response.end();
  else response.end(payload);
}

/**
 * Build the shared pieces one route path needs (guard + health body). Building
 * them per call site keeps `makeRoutes` and {@link makeHealthAliasRoute}
 * independent, so the alias can be registered defensively on its own.
 * @param deps - route collaborators; see {@link makeRoutes}.
 * @returns `{ guard, healthBody }`.
 */
function createFamily(deps) {
  const { balance, version = "0.0.0", now = () => Date.now(), logger } = deps;
  if (balance === undefined || typeof balance.read !== "function") {
    throw new TypeError("dsh-deepseek-usage: makeRoutes requires deps.balance exposing read({ force })");
  }
  const startedAt = now();
  return {
    /**
     * Fence, then method check.
     * @param request - incoming request.
     * @param response - node ServerResponse.
     * @returns true when the handler may continue.
     */
    guard(request, response) {
      if (!isLoopbackRequest(request)) {
        writeJson(request, response, 403, { error: "forbidden: loopback-only" });
        return false;
      }
      if (!ALLOWED_METHODS.includes(request.method)) {
        writeJson(request, response, 405, { error: `method not allowed: ${request.method}` });
        return false;
      }
      return true;
    },
    /**
     * Answer `/health`, converting a broken reader into the `internal` envelope.
     * @param request - incoming request.
     * @param response - node ServerResponse.
     */
    respondHealth(request, response) {
      try {
        writeJson(request, response, 200, this.healthBody());
      } catch (error) {
        writeEnvelope(request, response, internalEnvelope(error, logger));
      }
    },
    /** The `/health` body: liveness plus the balance cache's freshness. */
    healthBody() {
      return {
        ok: true,
        name: PLUGIN_NAME,
        version,
        route: ROUTES.health,
        uptimeMs: Math.max(0, now() - startedAt),
        balanceCache: balance.cacheState(),
      };
    },
  };
}

/**
 * Write one frozen envelope with the HTTP status its code implies.
 * @param request - the incoming request.
 * @param response - node ServerResponse.
 * @param envelope - `{ ok:true, … }` or `{ ok:false, error:{ code, message } }`.
 */
export function writeEnvelope(request, response, envelope) {
  const status = envelope?.ok === true ? 200 : statusForErrorCode(envelope?.error?.code);
  writeJson(request, response, status, envelope);
}

/**
 * Build the `internal` envelope for an unexpected local failure.
 * @param error - the thrown value.
 * @param logger - optional logger; receives a sanitized line.
 * @returns `{ ok:false, error:{ code:"internal", message } }`.
 */
export function internalEnvelope(error, logger) {
  const message = sanitizeMessage(
    `route handler failed: ${error instanceof Error ? error.message : String(error)}`,
    undefined,
  );
  try {
    logger?.warn?.(`${PLUGIN_NAME}: ${message}`);
  } catch {
    /* a broken logger must not mask the original failure */
  }
  return { ok: false, error: { code: "internal", message } };
}

/**
 * Run one reader call, converting a throw into the `internal` envelope.
 * @param read - thunk returning the frozen envelope.
 * @param logger - optional logger.
 * @returns the envelope, never a rejection.
 */
async function readSafely(read, logger) {
  try {
    return await read();
  } catch (error) {
    return internalEnvelope(error, logger);
  }
}

/**
 * Pick the contract fields out of a ledger payload.
 *
 * The ledger returns extra host-side diagnostics (`ledger`, `priceSource`,
 * `estimated`) that the client never needs. Rebuilding the envelope field by
 * field keeps the response exactly as `assertUsagePayload` freezes it, and
 * guarantees a ledger change cannot leak a new field onto the wire by accident.
 *
 * @param payload - an `aggregateUsage` result.
 * @returns `{ ok:true, requestedDays, days, generatedAt, truncated, totals }`.
 */
export function usageEnvelope(payload) {
  return {
    ok: true,
    requestedDays: payload.requestedDays,
    days: payload.days,
    generatedAt: payload.generatedAt,
    truncated: payload.truncated,
    totals: {
      inputTokens: payload.totals.inputTokens,
      cacheReadTokens: payload.totals.cacheReadTokens,
      outputTokens: payload.totals.outputTokens,
      estimatedCostCny: payload.totals.estimatedCostCny,
    },
  };
}

/**
 * Create the `/usage` reader the route handler consumes.
 *
 * The ledger is synchronous, but the reader is async for symmetry with the
 * balance reader (and so a future disk-backed ledger needs no route change).
 *
 * Its two degraded paths are deliberate:
 *   - a ledger that reports itself unavailable (no Zstandard decoder in this
 *     Node build) becomes the frozen `ledger_unavailable` code, with the reason
 *     in the message — never a 200 carrying an empty chart, and never a throw.
 *   - a payload that does not look like a ledger result (a missing window or day
 *     list) becomes `internal` rather than an unparseable body.
 *
 * @param aggregate - T3's `aggregateUsage(options)`.
 * @param options - ledger wiring for this host.
 * @param options.sessionsRoot - session-log root (default: the ledger's own).
 * @param options.cacheDir - external cache directory; `null` disables on-disk caching.
 * @param options.budgetMs - wall-clock budget for one aggregation.
 * @returns `{ read({ days }) }` resolving to a frozen envelope.
 */
export function createUsageReader(aggregate, { sessionsRoot, cacheDir, budgetMs } = {}) {
  if (typeof aggregate !== "function") throw new TypeError("createUsageReader requires the ledger's aggregateUsage function");

  return {
    /**
     * Aggregate the requested window.
     * @param options - `{ days }`.
     * @returns the frozen usage envelope.
     */
    async read(options = {}) {
      const days = parseUsageDays(options.days === undefined ? null : String(options.days));
      const ledgerOptions = { days };
      if (sessionsRoot !== undefined) ledgerOptions.sessionsRoot = sessionsRoot;
      if (cacheDir !== undefined) ledgerOptions.cacheDir = cacheDir;
      if (budgetMs !== undefined) ledgerOptions.budgetMs = budgetMs;

      const payload = await aggregate(ledgerOptions);
      if (payload?.ledger?.available === false) {
        return balanceFailure(
          "ledger_unavailable",
          `local session ledger is unavailable: ${payload.ledger.unavailableReason ?? "no Zstandard decoder in this Node build"}`,
        );
      }
      if (!Number.isInteger(payload?.requestedDays) || !Array.isArray(payload?.days) || typeof payload?.totals !== "object" || payload.totals === null) {
        return balanceFailure("internal", "local session ledger returned an unusable payload");
      }
      return usageEnvelope(payload);
    },
  };
}

/**
 * Build the family's canonical routes.
 * @param deps - route collaborators.
 * @param deps.balance - the balance reader (`{ read, cacheState }`).
 * @param deps.usage - the usage reader (`{ read }`); when absent, `/usage`
 *   answers the frozen `ledger_unavailable` envelope instead of disappearing.
 * @param deps.version - plugin version reported by `/health` (optional).
 * @param deps.now - clock in ms (optional; defaults to `Date.now`).
 * @param deps.logger - optional logger for the degraded paths.
 * @returns the route list for `ctx.webServer.register`.
 */
export function makeRoutes(deps) {
  const { balance, usage, logger } = deps;
  const family = createFamily(deps);
  const usageReader =
    usage !== undefined && typeof usage.read === "function"
      ? usage
      : {
          read: async () =>
            balanceFailure("ledger_unavailable", "the host mounted no local session ledger for this plugin"),
        };
  return [
    {
      kind: "exact",
      path: ROUTES.balance,
      async handler(request, response) {
        if (!family.guard(request, response)) return;
        const url = new URL(request.url ?? ROUTES.balance, "http://localhost");
        const forceParam = url.searchParams.get("force");
        const force = forceParam !== null && forceParam !== "0" && forceParam !== "false";
        const envelope = await readSafely(() => balance.read({ force }), logger);
        writeEnvelope(request, response, envelope);
      },
    },
    {
      kind: "exact",
      path: ROUTES.health,
      handler(request, response) {
        if (!family.guard(request, response)) return;
        family.respondHealth(request, response);
      },
    },
    {
      kind: "exact",
      path: ROUTES.usage,
      async handler(request, response) {
        if (!family.guard(request, response)) return;
        const url = new URL(request.url ?? ROUTES.usage, "http://localhost");
        let days;
        try {
          // `getAll`, not `get`: `get` would silently drop a repeat and hand back
          // the first value, but the frozen contract's `normalizeDays` takes the
          // RAW query value and requires a single string — a repeat must be a
          // 400, so the whole list has to reach the parser.
          days = parseUsageDays(rawUsageDays(url.searchParams));
        } catch (error) {
          // A malformed window is the client's fault, so it is `bad_request`
          // (400), not the `internal` envelope readSafely would build.
          writeEnvelope(request, response, balanceFailure("bad_request", `invalid ?days= parameter: ${error.message}`));
          return;
        }
        const envelope = await readSafely(() => usageReader.read({ days }), logger);
        writeEnvelope(request, response, envelope);
      },
    },
  ];
}

/**
 * Build the optional bare `/health` alias route.
 *
 * It is registered separately because a bare global path can collide with
 * another profile plugin; the caller registers it defensively and degrades to
 * a warning instead of failing the boot.
 * @param deps - same collaborators as {@link makeRoutes}.
 * @returns one route descriptor for `ctx.webServer.register`.
 */
export function makeHealthAliasRoute(deps) {
  const family = createFamily(deps);
  return {
    kind: "exact",
    path: HEALTH_ALIAS,
    handler(request, response) {
      if (!family.guard(request, response)) return;
      family.respondHealth(request, response);
    },
  };
}
