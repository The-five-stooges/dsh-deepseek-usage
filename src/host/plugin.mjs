/**
 * dsh-deepseek-usage — host-half cordis plugin (assembly).
 *
 * This is the module `lib/index.js` mounts. It wires collaborators, hands them
 * to the route family, and registers the family on the host web server. It
 * reads no credential file and holds no secret of its own: the plaintext key is
 * resolved per operation through `ctx.credentials` by
 * {@link resolveDeepseekApiKey}.
 *
 * Everything else is injected, so the whole plugin is testable without a real
 * host, a real network, or a real clock:
 *
 *   createHostPlugin({ fetchImpl, getApiKey, now, logger, version, timeoutMs, ttlMs })
 *
 * Lifetime: `apply(ctx)` waits for the `webServer` service instead of declaring
 * a hard `inject`, so a profile without a web server (TUI/headless) leaves the
 * plugin inert rather than blocking activation.
 *
 * @module dsh-deepseek-usage/host/plugin
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BALANCE_TIMEOUT_MS,
  BALANCE_TTL_MS,
  createBalanceService,
  resolveDeepseekApiKey,
} from "./balance.mjs";
import { aggregateUsage as aggregateLedgerUsage, defaultSessionsRoot } from "./ledger.mjs";
import {
  HEALTH_ALIAS,
  PLUGIN_NAME,
  ROUTES,
  createUsageReader,
  makeHealthAliasRoute,
  makeRoutes,
} from "./routes.mjs";

/** Canonical plugin name (also the row name in cordis.patch.yml). */
export const name = PLUGIN_NAME;

/** Services this plugin consumes; resolved lazily so a non-web profile is inert. */
export const inject = Object.freeze([]);

/**
 * Where this plugin's mutable ledger index lives.
 *
 * Deliberately NOT inside the plugin package: a package is read-only code whose
 * `files` manifest is what gets published, and an in-package cache would both
 * grow inside the installed tree and risk being shipped. `%DSH_HOME%\storages\`
 * is the host's designated home for plugin state.
 *
 * @param env - environment to read (`DSH_HOME` locates the host home).
 * @returns the absolute cache directory for the ledger index.
 */
export function defaultLedgerCacheDir(env = process.env) {
  const configured = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  // With no DSH_HOME (a bare script, a test run) fall back to the OS temp home
  // rather than the process CWD: a relative-looking default could land inside
  // the plugin package and reintroduce exactly the in-package state this avoids.
  const home = configured === "" ? join(tmpdir(), "dsh-home") : configured;
  return join(home, "storages", PLUGIN_NAME, "ledger-cache");
}

/** Read this package's version for `/health` without assuming a JSON import mode. */
function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Read one service off a cordis context, tolerating the `get`-less fake
 * contexts tests build.
 * @param ctx - cordis context (or a test double).
 * @param key - service name.
 * @returns the service, or undefined.
 */
function serviceOf(ctx, key) {
  if (ctx === undefined || ctx === null) return undefined;
  // `ctx.get` is cordis' non-throwing store read. The bare property access below
  // must stay a test-double-only path: on a real context it throws once the fiber
  // has a runtime and `key` is not in its declared `inject`, which is exactly the
  // "service is not up yet" case this probe has to answer with undefined.
  if (typeof ctx.get === "function") return ctx.get(key);
  return ctx[key];
}

/**
 * Register every route, tying each registration to the plugin's fiber.
 * @param webCtx - context exposing `webServer` (and `effect` when available).
 * @param routes - route descriptors.
 */
function registerRoutes(webCtx, routes) {
  const webServer = serviceOf(webCtx, "webServer");
  if (webServer === undefined || typeof webServer.register !== "function") {
    throw new TypeError(`${PLUGIN_NAME}: webServer service exposes no register(route)`);
  }
  const register = (route) => {
    if (typeof webCtx.effect === "function") webCtx.effect(() => webServer.register(route), `${PLUGIN_NAME}: ${route.path}`);
    else webServer.register(route);
  };
  for (const route of routes) register(route);
}

/**
 * Run `mount` once a web server is available.
 * @param ctx - cordis context.
 * @param mount - receives a web-server-bearing context.
 * @param logger - optional logger used for the degraded path.
 */
function withWebServer(ctx, mount, logger) {
  if (serviceOf(ctx, "webServer") !== undefined) {
    mount(ctx);
    return;
  }
  if (typeof ctx?.inject === "function") {
    ctx.inject(["webServer"], (webCtx) => {
      mount(webCtx ?? ctx);
    });
    return;
  }
  logger?.warn?.(`${PLUGIN_NAME}: webServer service is unavailable — balance routes were not registered`);
}

/**
 * Build the host plugin with optional collaborator overrides.
 * @param overrides - test/dev injection points.
 * @param overrides.fetchImpl - `fetch`-compatible implementation.
 * @param overrides.getApiKey - key provider; defaults to `ctx.credentials`.
 * @param overrides.now - clock in ms.
 * @param overrides.logger - logger override.
 * @param overrides.version - version string for `/health`.
 * @param overrides.timeoutMs - upstream timeout.
 * @param overrides.ttlMs - success-cache TTL.
 * @param overrides.aggregateUsage - ledger aggregator; defaults to T3's `aggregateUsage`.
 * @param overrides.sessionsRoot - session-log root; defaults to `<DSH_HOME>/sessions`.
 * @param overrides.cacheDir - ledger index directory; defaults to
 *   {@link defaultLedgerCacheDir} (`<DSH_HOME>/storages/…`), `null` for no disk cache.
 * @param overrides.ledgerBudgetMs - wall-clock budget for one aggregation.
 * @returns `{ name, inject, apply, balanceFor(ctx) }`.
 */
export function createHostPlugin(overrides = {}) {
  const {
    fetchImpl = (url, init) => globalThis.fetch(url, init),
    getApiKey,
    now = () => Date.now(),
    logger,
    version = readVersion(),
    timeoutMs = BALANCE_TIMEOUT_MS,
    ttlMs = BALANCE_TTL_MS,
    aggregateUsage = aggregateLedgerUsage,
    sessionsRoot = defaultSessionsRoot(),
    cacheDir = defaultLedgerCacheDir(),
    ledgerBudgetMs,
  } = overrides;

  return {
    name: PLUGIN_NAME,
    inject,
    /**
     * Activate the host half.
     * @param ctx - cordis context of the mounted row.
     * @param config - row config (optional `timeoutMs`/`ttlMs` overrides).
     */
    apply(ctx, config) {
      const ctxLogger = logger ?? ctx?.logger;
      const balance = createBalanceService({
        getApiKey: getApiKey ?? (() => resolveDeepseekApiKey(ctx)),
        fetchImpl,
        now,
        logger: ctxLogger,
        timeoutMs: config?.timeoutMs ?? timeoutMs,
        ttlMs: config?.ttlMs ?? ttlMs,
      });
      const usage = createUsageReader(aggregateUsage, { sessionsRoot, cacheDir, budgetMs: ledgerBudgetMs });
      const deps = { balance, usage, version, now, logger: ctxLogger };

      withWebServer(
        ctx,
        (webCtx) => {
          registerRoutes(webCtx, makeRoutes(deps));
          const alias = makeHealthAliasRoute(deps);
          try {
            registerRoutes(webCtx, [alias]);
          } catch (error) {
            ctxLogger?.warn?.(
              `${PLUGIN_NAME}: ${HEALTH_ALIAS} alias not registered (${error instanceof Error ? error.message : String(error)}); ${ROUTES.health} stays available`,
            );
          }
        },
        ctxLogger,
      );
    },
  };
}

export default createHostPlugin();
