/**
 * Host-half tests for dsh-deepseek-usage (T2): balance reader, route family,
 * and the cordis assembly.
 *
 * No real network, no real host, no real clock: every collaborator is injected.
 * Run: `node --test tests/host-balance.test.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BALANCE_TTL_MS,
  BALANCE_URL,
  CREDENTIAL_REF_NAME,
  REDACTION_PLACEHOLDER,
  balanceFailure,
  classifyUpstreamStatus,
  createBalanceService,
  parseBalanceBody,
  redactSecret,
  resolveDeepseekApiKey,
  scrubSecretShapes,
  sanitizeMessage,
  statusForErrorCode,
} from "../src/host/balance.mjs";
import {
  HEALTH_ALIAS,
  ROUTES,
  isLoopbackAddress,
  isLoopbackRequest,
  makeHealthAliasRoute,
  makeRoutes,
} from "../src/host/routes.mjs";
import { createHostPlugin, name as pluginName } from "../src/host/plugin.mjs";
import hostEntry from "../lib/index.js";

/** A secret that must never appear in a response, a log line, or an error message. */
const SENTINEL = "sk-SENTINEL-0123456789abcdef";

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/** Upstream body in the official shape (decimal strings, balance_infos array). */
function upstreamBody({
  currency = "CNY",
  total = "12.02",
  granted = "0.00",
  toppedUp = "12.02",
  available = true,
  infos,
} = {}) {
  return {
    is_available: available,
    balance_infos: infos ?? [
      { currency, total_balance: total, granted_balance: granted, topped_up_balance: toppedUp },
    ],
  };
}

/** Minimal `Response`-alike for a JSON body. */
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

/** Minimal `Response`-alike whose body is not JSON. */
function textResponse(status, text = "<html>not json</html>") {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { throw new SyntaxError(`Unexpected token < in JSON at position 0 (${text.length} bytes)`); },
  };
}

/** A fetch double that records every call and answers from `handler`. */
function makeFetch(handler) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init, calls.length);
    },
  };
}

/** A controllable clock in ms. */
function makeClock(start = Date.parse("2026-09-17T16:05:51.000Z")) {
  let at = start;
  return {
    now: () => at,
    advance(ms) { at += ms; },
    at: () => new Date(at).toISOString(),
  };
}

/** A logger double that records everything it is asked to print. */
function makeLogger() {
  const lines = [];
  return { lines, warn(message) { lines.push(String(message)); } };
}

/** A credentials double; `key === undefined` reproduces "not configured". */
function makeCredentials(key, { throws } = {}) {
  const refs = [];
  return {
    refs,
    async resolve(ref) {
      refs.push(ref);
      if (throws !== undefined) throw throws;
      return key === undefined ? undefined : { value: key, source: "env" };
    },
  };
}

/** A webServer double enforcing the real duplicate-route rule. */
function makeWebServer({ refuse = [] } = {}) {
  const registered = [];
  return {
    registered,
    register(route) {
      if (refuse.includes(route.path)) throw new Error(`duplicate (kind, path) ${route.kind} ${route.path}`);
      if (registered.some((existing) => existing.kind === route.kind && existing.path === route.path)) {
        throw new Error(`duplicate (kind, path) ${route.kind} ${route.path}`);
      }
      registered.push(route);
      return () => {
        const index = registered.indexOf(route);
        if (index !== -1) registered.splice(index, 1);
      };
    },
    paths() { return registered.map((route) => route.path); },
    route(path) { return registered.find((route) => route.path === path); },
  };
}

/** A cordis-context double exposing only what the plugin reads. */
function makeCtx({ webServer, credentials, logger } = {}) {
  const services = new Map();
  if (webServer !== undefined) services.set("webServer", webServer);
  if (credentials !== undefined) services.set("credentials", credentials);
  const injects = [];
  return {
    logger,
    injects,
    get(name) { return services.get(name); },
    inject(names, callback) { injects.push({ names, callback }); },
    effect(callback) { return callback(); },
    provide(name, value) { services.set(name, value); },
  };
}

/** A request double. */
function makeRequest({
  method = "GET",
  url = ROUTES.balance,
  remoteAddress = "127.0.0.1",
  host = "127.0.0.1:3080",
  headers = {},
} = {}) {
  return { method, url, socket: { remoteAddress }, headers: { host, ...headers } };
}

/** A response double capturing status, headers, and body. */
function makeResponse() {
  const state = { status: undefined, headers: undefined, body: "" };
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers; },
    end(body) { if (body !== undefined && body !== null) state.body = String(body); },
    json() { return state.body === "" ? undefined : JSON.parse(state.body); },
  };
}

/** Drive one route handler end to end. */
async function callRoute(route, request) {
  const response = makeResponse();
  await route.handler(request, response);
  return response;
}

/** Build a balance service wired to a fetch double and a credentials double. */
function makeService({ apiKey = SENTINEL, handler, logger, now, timeoutMs, ttlMs, getApiKey } = {}) {
  const fetchDouble = makeFetch(handler ?? (() => jsonResponse(200, upstreamBody())));
  const service = createBalanceService({
    getApiKey: getApiKey ?? (async () => apiKey),
    fetchImpl: fetchDouble.fetchImpl,
    now: now ?? (() => Date.now()),
    logger,
    timeoutMs,
    ttlMs,
  });
  return { service, fetchDouble };
}

/* ------------------------------------------------------------------ *
 * balance.mjs — success paths
 * ------------------------------------------------------------------ */

test("balance: success envelope matches the frozen contract and prefers CNY", async () => {
  const { service, fetchDouble } = makeService({
    handler: () =>
      jsonResponse(200, {
        is_available: true,
        balance_infos: [
          { currency: "USD", total_balance: "1.50", granted_balance: "0.00", topped_up_balance: "1.50" },
          { currency: "CNY", total_balance: "12.02", granted_balance: "0.00", topped_up_balance: "12.02" },
        ],
      }),
  });

  const envelope = await service.read();

  assert.deepEqual(Object.keys(envelope).sort(), [
    "cached",
    "currency",
    "fetchedAt",
    "grantedBalance",
    "isAvailable",
    "ok",
    "toppedUpBalance",
    "totalBalance",
  ]);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.currency, "CNY");
  assert.equal(envelope.totalBalance, 12.02);
  assert.equal(envelope.grantedBalance, 0);
  assert.equal(envelope.toppedUpBalance, 12.02);
  assert.equal(envelope.isAvailable, true);
  assert.equal(envelope.cached, false);
  assert.match(envelope.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  assert.equal(fetchDouble.calls.length, 1);
  assert.equal(fetchDouble.calls[0].url, BALANCE_URL);
  assert.equal(fetchDouble.calls[0].init.method, "GET");
  assert.equal(fetchDouble.calls[0].init.headers.authorization, `Bearer ${SENTINEL}`);
  assert.equal(fetchDouble.calls[0].init.headers.accept, "application/json");
  assert.ok(!fetchDouble.calls[0].url.includes(SENTINEL), "the key must never travel in the URL");
  assert.ok(!JSON.stringify(envelope).includes(SENTINEL));
});

test("balance: reports the first entry's currency when CNY is absent", async () => {
  const { service } = makeService({
    handler: () =>
      jsonResponse(200, {
        is_available: false,
        balance_infos: [{ currency: "USD", total_balance: "0.42", granted_balance: "0.10", topped_up_balance: "0.32" }],
      }),
  });

  const envelope = await service.read();
  assert.equal(envelope.ok, true);
  assert.equal(envelope.currency, "USD");
  assert.equal(envelope.totalBalance, 0.42);
  assert.equal(envelope.grantedBalance, 0.1);
  assert.equal(envelope.toppedUpBalance, 0.32);
  assert.equal(envelope.isAvailable, false);
});

test("balance: granted/topped-up default to 0 when the upstream omits them", async () => {
  const { service } = makeService({
    handler: () => jsonResponse(200, { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "3.00" }] }),
  });

  const envelope = await service.read();
  assert.equal(envelope.grantedBalance, 0);
  assert.equal(envelope.toppedUpBalance, 0);
});

/* ------------------------------------------------------------------ *
 * balance.mjs — distinguishable structured errors
 * ------------------------------------------------------------------ */

test("balance: an unconfigured key is no_api_key and never calls upstream", async () => {
  const fetchDouble = makeFetch(() => jsonResponse(200, upstreamBody()));
  const service = createBalanceService({
    getApiKey: async () => undefined,
    fetchImpl: fetchDouble.fetchImpl,
  });

  const envelope = await service.read();
  assert.deepEqual(envelope, {
    ok: false,
    error: { code: "no_api_key", message: `${CREDENTIAL_REF_NAME} is not configured for this host` },
  });
  assert.equal(fetchDouble.calls.length, 0);
});

test("balance: an empty key string is no_api_key", async () => {
  const fetchDouble = makeFetch(() => jsonResponse(200, upstreamBody()));
  const service = createBalanceService({ getApiKey: async () => "", fetchImpl: fetchDouble.fetchImpl });
  const envelope = await service.read();
  assert.equal(envelope.error.code, "no_api_key");
  assert.equal(fetchDouble.calls.length, 0);
});

test("balance: a throwing credential provider is no_api_key, not a crash", async () => {
  const fetchDouble = makeFetch(() => jsonResponse(200, upstreamBody()));
  const service = createBalanceService({
    getApiKey: async () => { throw new Error(`provider refused for Bearer ${SENTINEL}`); },
    fetchImpl: fetchDouble.fetchImpl,
  });

  const envelope = await service.read();
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "no_api_key");
  assert.ok(!envelope.error.message.includes(SENTINEL), "a provider error must not leak the key");
  assert.equal(fetchDouble.calls.length, 0);
});

test("balance: every upstream failure maps to a distinct frozen code", async () => {
  const cases = [
    { label: "401", response: jsonResponse(401, { error: "unauthorized" }), code: "unauthorized" },
    { label: "403", response: jsonResponse(403, {}), code: "unauthorized" },
    { label: "429", response: jsonResponse(429, {}), code: "rate_limited" },
    { label: "400", response: jsonResponse(400, {}), code: "upstream_error" },
    { label: "500", response: jsonResponse(500, {}), code: "upstream_error" },
    { label: "503", response: jsonResponse(503, {}), code: "upstream_error" },
  ];

  const seen = new Set();
  for (const entry of cases) {
    const { service } = makeService({ handler: () => entry.response });
    const envelope = await service.read();
    assert.equal(envelope.ok, false, `${entry.label} must fail`);
    assert.equal(envelope.error.code, entry.code, `${entry.label} must map to ${entry.code}`);
    assert.match(envelope.error.message, new RegExp(`HTTP ${entry.response.status}`));
    assert.ok(!envelope.error.message.includes(SENTINEL));
    seen.add(envelope.error.code);
  }
  assert.deepEqual([...seen].sort(), ["rate_limited", "unauthorized", "upstream_error"]);
});

test("balance: classifyUpstreamStatus keeps the frozen mapping", () => {
  assert.equal(classifyUpstreamStatus(401), "unauthorized");
  assert.equal(classifyUpstreamStatus(403), "unauthorized");
  assert.equal(classifyUpstreamStatus(429), "rate_limited");
  assert.equal(classifyUpstreamStatus(404), "upstream_error");
  assert.equal(classifyUpstreamStatus(502), "upstream_error");
});

test("balance: a structurally unusable 200 body is bad_response", async () => {
  const bodies = [
    { label: "no balance_infos", body: {} },
    { label: "empty balance_infos", body: { is_available: true, balance_infos: [] } },
    { label: "balance_infos not an array", body: { is_available: true, balance_infos: "CNY" } },
    { label: "entry without currency", body: { is_available: true, balance_infos: [{ total_balance: "1.00" }] } },
    { label: "non-3-letter currency", body: { is_available: true, balance_infos: [{ currency: "rmb", total_balance: "1.00" }] } },
    { label: "missing total_balance", body: { is_available: true, balance_infos: [{ currency: "CNY" }] } },
    { label: "unparseable total_balance", body: { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "n/a" }] } },
    { label: "negative total_balance", body: { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "-1.00" }] } },
    { label: "is_available not boolean", body: { is_available: "yes", balance_infos: [{ currency: "CNY", total_balance: "1.00" }] } },
    { label: "body is an array", body: [] },
    { label: "body is null", body: null },
  ];

  for (const entry of bodies) {
    const { service } = makeService({ handler: () => jsonResponse(200, entry.body) });
    const envelope = await service.read();
    assert.equal(envelope.ok, false, `${entry.label} must fail`);
    assert.equal(envelope.error.code, "bad_response", `${entry.label} must be bad_response`);
    assert.ok(!envelope.error.message.includes(SENTINEL));
  }

  const notJson = makeService({ handler: () => textResponse(200) });
  const envelope = await notJson.service.read();
  assert.equal(envelope.error.code, "bad_response");
  assert.match(envelope.error.message, /not JSON/);
});

test("balance: parseBalanceBody is usable directly and rejects unusable shapes", () => {
  assert.deepEqual(parseBalanceBody(upstreamBody()), {
    currency: "CNY",
    totalBalance: 12.02,
    grantedBalance: 0,
    toppedUpBalance: 12.02,
    isAvailable: true,
  });
  assert.throws(() => parseBalanceBody({}), /no balance_infos array/);
  assert.throws(() => parseBalanceBody({ is_available: true, balance_infos: [] }), /empty/);
  assert.throws(() => parseBalanceBody({ is_available: true, balance_infos: [{ currency: "CNY" }] }), /total_balance is missing/);
});

test("balance: a network rejection is network_error and a timeout is timeout", async () => {
  const network = makeService({
    handler: () => { throw new TypeError("fetch failed"); },
  });
  const networkEnvelope = await network.service.read();
  assert.equal(networkEnvelope.error.code, "network_error");
  assert.match(networkEnvelope.error.message, /fetch failed/);

  // A fetcher that honors the abort signal: the plugin's own 10s timer is
  // reconfigured to 10ms so this exercises the real timeout path.
  const slow = makeService({
    timeoutMs: 10,
    handler: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
      }),
  });
  const timeoutEnvelope = await slow.service.read();
  assert.equal(timeoutEnvelope.error.code, "timeout");
  assert.match(timeoutEnvelope.error.message, /timed out after 10 ms/);
  assert.ok(!timeoutEnvelope.error.message.includes(SENTINEL));

  const abortNamed = makeService({
    handler: () => Promise.reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
  });
  const abortEnvelope = await abortNamed.service.read();
  assert.equal(abortEnvelope.error.code, "timeout");

  const dnsFailure = makeService({
    handler: () => Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND api.deepseek.com"), { code: "ENOTFOUND" })),
  });
  const dnsEnvelope = await dnsFailure.service.read();
  assert.equal(dnsEnvelope.error.code, "network_error");
  assert.match(dnsEnvelope.error.message, /ENOTFOUND/);
});

/* ------------------------------------------------------------------ *
 * balance.mjs — TTL cache and force
 * ------------------------------------------------------------------ */

test("balance: the 60s TTL serves a cache hit and expires on time", async () => {
  const clock = makeClock();
  let upstream = 1;
  const { service, fetchDouble } = makeService({
    now: clock.now,
    handler: () => jsonResponse(200, upstreamBody({ total: `${upstream}.00` })),
  });

  const first = await service.read();
  assert.equal(first.cached, false);
  assert.equal(first.totalBalance, 1);
  assert.equal(fetchDouble.calls.length, 1);

  clock.advance(BALANCE_TTL_MS - 1);
  const hit = await service.read();
  assert.equal(hit.cached, true, "inside the TTL the snapshot is served from cache");
  assert.equal(hit.totalBalance, 1);
  assert.equal(hit.fetchedAt, first.fetchedAt, "a cache hit keeps the original fetch instant");
  assert.equal(fetchDouble.calls.length, 1);
  assert.deepEqual(service.cacheState(), { warm: true, ageMs: BALANCE_TTL_MS - 1, expiresInMs: 1 });

  clock.advance(2);
  upstream = 2;
  const afterExpiry = await service.read();
  assert.equal(afterExpiry.cached, false);
  assert.equal(afterExpiry.totalBalance, 2);
  assert.equal(fetchDouble.calls.length, 2);
  assert.notEqual(afterExpiry.fetchedAt, first.fetchedAt);
});

test("balance: force bypasses the TTL and re-reads upstream", async () => {
  const clock = makeClock();
  const { service, fetchDouble } = makeService({ now: clock.now });

  await service.read();
  const forced = await service.read({ force: true });
  assert.equal(forced.cached, false);
  assert.equal(fetchDouble.calls.length, 2);

  clock.advance(1000);
  const cachedAgain = await service.read();
  assert.equal(cachedAgain.cached, true);
  assert.equal(fetchDouble.calls.length, 2);
  assert.deepEqual(service.cacheState(), { warm: true, ageMs: 1000, expiresInMs: BALANCE_TTL_MS - 1000 });
});

test("balance: failures are never cached, so a fixed key recovers immediately", async () => {
  const clock = makeClock();
  let key = SENTINEL;
  let answer = () => jsonResponse(429, {});
  const fetchDouble = makeFetch(() => answer());
  const service = createBalanceService({
    getApiKey: async () => key,
    fetchImpl: fetchDouble.fetchImpl,
    now: clock.now,
  });

  const limited = await service.read();
  assert.equal(limited.error.code, "rate_limited");

  key = SENTINEL;
  answer = () => jsonResponse(200, upstreamBody());
  const recovered = await service.read();
  assert.equal(recovered.ok, true, "an error must not be served from the cache");
  assert.equal(fetchDouble.calls.length, 2);
  assert.equal(fetchDouble.calls[1].init.headers.authorization, `Bearer ${SENTINEL}`);
});

test("balance: invalidate() drops the snapshot; cacheState reports a cold cache", async () => {
  const { service, fetchDouble } = makeService();
  assert.deepEqual(service.cacheState(), { warm: false });
  await service.read();
  assert.equal(service.cacheState().warm, true);
  service.invalidate();
  assert.deepEqual(service.cacheState(), { warm: false });
  await service.read();
  assert.equal(fetchDouble.calls.length, 2);
});

test("balance: a stale cache reads cold and is refetched", async () => {
  const clock = makeClock();
  const { service } = makeService({ now: clock.now });
  await service.read();
  clock.advance(BALANCE_TTL_MS * 3);
  assert.equal(service.cacheState().warm, false);
  assert.equal(service.cacheState().expiresInMs, 0);
});

/* ------------------------------------------------------------------ *
 * balance.mjs — the key never leaves the host
 * ------------------------------------------------------------------ */

test("balance: no failure envelope or log line ever contains the key", async () => {
  const logger = makeLogger();
  const scenarios = [
    { label: "no_api_key", getApiKey: async () => undefined, handler: () => jsonResponse(200, upstreamBody()) },
    { label: "unauthorized", handler: () => jsonResponse(401, {}) },
    { label: "rate_limited", handler: () => jsonResponse(429, {}) },
    { label: "upstream_error", handler: () => jsonResponse(500, {}) },
    { label: "network_error", handler: () => { throw new Error(`connect failed for Bearer ${SENTINEL}`); } },
    { label: "timeout", timeoutMs: 10, handler: (_url, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) },
    { label: "bad_response", handler: () => jsonResponse(200, {}) },
    { label: "bad_response/json", handler: () => textResponse(200) },
  ];

  for (const scenario of scenarios) {
    const fetchDouble = makeFetch(scenario.handler);
    const service = createBalanceService({
      getApiKey: scenario.getApiKey ?? (async () => SENTINEL),
      fetchImpl: fetchDouble.fetchImpl,
      logger,
      timeoutMs: scenario.timeoutMs,
    });
    const envelope = await service.read();
    assert.equal(envelope.ok, false, `${scenario.label} must fail`);
    const serialized = JSON.stringify(envelope);
    assert.ok(!serialized.includes(SENTINEL), `${scenario.label}: response body leaked the key`);
    const wanted = fetchDouble.calls.length > 0;
    if (wanted) assert.equal(fetchDouble.calls[0].init.headers.authorization, `Bearer ${SENTINEL}`);
  }

  assert.ok(logger.lines.length >= scenarios.length, "each failure is logged");
  const log = logger.lines.join("\n");
  assert.ok(!log.includes(SENTINEL), "a log line leaked the key");
  assert.ok(log.includes("network_error"), "the network failure's redacted detail is logged");
  assert.ok(log.includes(REDACTION_PLACEHOLDER), "the embedded key was replaced by the placeholder");
});

test("balance: redactSecret and balanceFailure are the shared safety net", () => {
  assert.equal(redactSecret(`Bearer ${SENTINEL} rejected`, SENTINEL), `Bearer ${REDACTION_PLACEHOLDER} rejected`);
  assert.equal(redactSecret(`x=${encodeURIComponent(SENTINEL)}`, SENTINEL), `x=${REDACTION_PLACEHOLDER}`);
  assert.equal(redactSecret("plain", undefined), "plain");
  assert.equal(redactSecret("plain", ""), "plain");
  assert.equal(scrubSecretShapes(`oops sk-abcdef123456 here`), `oops ${REDACTION_PLACEHOLDER} here`);
  assert.equal(scrubSecretShapes(`header Bearer abcdef123456789`), `header ${REDACTION_PLACEHOLDER}`);
  assert.equal(sanitizeMessage(`x ${SENTINEL} y`, SENTINEL), `x ${REDACTION_PLACEHOLDER} y`);
  assert.deepEqual(balanceFailure("rate_limited", "too many"), { ok: false, error: { code: "rate_limited", message: "too many" } });
  assert.throws(() => balanceFailure("boom", "x"), /unknown balance error code/);
});

/* ------------------------------------------------------------------ *
 * plugin.mjs — assembly, credential seam, registration
 * ------------------------------------------------------------------ */

test("plugin: exports the shape lib/index.js mounts", () => {
  const harness = createHostPlugin({});
  assert.equal(harness.name, "dsh-deepseek-usage");
  assert.equal(typeof harness.apply, "function");
  assert.equal(pluginName, "dsh-deepseek-usage");
  assert.equal(hostEntry.name, "dsh-deepseek-usage");
  assert.equal(typeof hostEntry.apply, "function", "lib/index.js must forward apply from src/host/plugin.mjs");
  assert.ok(Array.isArray(hostEntry.inject), "lib/index.js forwards the inject list (empty = lazy service wiring)");
  assert.equal(hostEntry.name, harness.name);
});

test("plugin: resolves the key through ctx.credentials.resolve(credentialRef(...))", async () => {
  const credentials = makeCredentials(SENTINEL);
  const webServer = makeWebServer();
  const fetchDouble = makeFetch(() => jsonResponse(200, upstreamBody()));
  const ctx = makeCtx({ webServer, credentials });

  createHostPlugin({ fetchImpl: fetchDouble.fetchImpl }).apply(ctx);

  const response = await callRoute(webServer.route(ROUTES.balance), makeRequest());
  assert.equal(response.state.status, 200);
  assert.equal(response.json().ok, true);
  assert.equal(credentials.refs.length, 1);
  assert.equal(credentials.refs[0], CREDENTIAL_REF_NAME, "the branded reference carries the env name");
  assert.equal(fetchDouble.calls[0].init.headers.authorization, `Bearer ${SENTINEL}`);
  assert.ok(!JSON.stringify(response.json()).includes(SENTINEL));
});

test("plugin: resolveDeepseekApiKey degrades to undefined without a provider", async () => {
  assert.equal(await resolveDeepseekApiKey({ get: () => undefined }), undefined);
  assert.equal(await resolveDeepseekApiKey(undefined), undefined);
  const credentials = makeCredentials(undefined);
  assert.equal(await resolveDeepseekApiKey({ get: () => credentials }), undefined);
});

test("plugin: registers /balance, the canonical /health, /usage, and the bare /health alias", () => {
  const webServer = makeWebServer();
  createHostPlugin({ getApiKey: async () => SENTINEL }).apply(makeCtx({ webServer }));

  assert.deepEqual(webServer.paths(), [ROUTES.balance, ROUTES.health, ROUTES.usage, HEALTH_ALIAS]);
  for (const route of webServer.registered) assert.equal(route.kind, "exact");
  assert.equal(ROUTES.balance, "/api/dsh-deepseek-usage/balance");
  assert.equal(ROUTES.health, "/api/dsh-deepseek-usage/health");
  assert.equal(ROUTES.usage, "/api/dsh-deepseek-usage/usage");
  assert.equal(HEALTH_ALIAS, "/health");
  assert.equal(typeof routeHandlerOf(webServer, ROUTES.balance), "function");
  assert.equal(typeof routeHandlerOf(webServer, ROUTES.usage), "function");
});

test("plugin: a /health collision degrades to a warning instead of failing the boot", () => {
  const logger = makeLogger();
  const webServer = makeWebServer({ refuse: [HEALTH_ALIAS] });
  createHostPlugin({ getApiKey: async () => SENTINEL, logger }).apply(makeCtx({ webServer, logger }));

  assert.deepEqual(webServer.paths(), [ROUTES.balance, ROUTES.health, ROUTES.usage]);
  assert.equal(logger.lines.length, 1);
  assert.match(logger.lines[0], /\/health alias not registered/);
  assert.ok(!logger.lines[0].includes(SENTINEL));
});

test("plugin: waits for webServer through ctx.inject when it is not active yet", () => {
  const webServer = makeWebServer();
  const ctx = makeCtx({ credentials: makeCredentials(SENTINEL) });
  createHostPlugin({}).apply(ctx);

  assert.equal(ctx.injects.length, 1);
  assert.deepEqual(ctx.injects[0].names, ["webServer"]);
  assert.equal(webServer.paths().length, 0, "nothing is registered before the service exists");

  const derived = makeCtx({ webServer, credentials: makeCredentials(SENTINEL) });
  ctx.injects[0].callback(derived);
  assert.deepEqual(webServer.paths(), [ROUTES.balance, ROUTES.health, ROUTES.usage, HEALTH_ALIAS]);
});

test("plugin: a context that throws on undeclared service reads still defers, not fails", () => {
  // A real cordis context is a proxy: reading a service outside the fiber's
  // declared `inject` throws `cannot get property "x" without inject`. Probing
  // `webServer` that way took the entire plugin tree down at boot.
  const target = {
    injects: [],
    logger: undefined,
    get() {
      return undefined;
    },
    inject(names, callback) {
      this.injects.push({ names, callback });
    },
  };
  const ctx = new Proxy(target, {
    get: (inner, prop) => {
      if (prop in inner) return inner[prop];
      throw new Error(`cannot get property "${prop}" without inject`);
    },
  });

  assert.doesNotThrow(() => createHostPlugin({}).apply(ctx));
  assert.deepEqual(ctx.injects.map((entry) => entry.names), [["webServer"]]);
});

test("plugin: without any web server it warns instead of throwing", () => {
  const logger = makeLogger();
  createHostPlugin({ logger }).apply({ logger });
  assert.equal(logger.lines.length, 1);
  assert.match(logger.lines[0], /webServer service is unavailable/);
});

test("plugin: row config overrides the TTL", async () => {
  const clock = makeClock();
  const webServer = makeWebServer();
  const fetchDouble = makeFetch(() => jsonResponse(200, upstreamBody()));
  const ctx = makeCtx({ webServer, credentials: makeCredentials(SENTINEL) });
  createHostPlugin({ fetchImpl: fetchDouble.fetchImpl, now: clock.now }).apply(ctx, { ttlMs: 1000 });

  const route = webServer.route(ROUTES.balance);
  await callRoute(route, makeRequest());
  clock.advance(1500);
  await callRoute(route, makeRequest());
  assert.equal(fetchDouble.calls.length, 2, "a 1s TTL must expire after 1.5s");
});

/* ------------------------------------------------------------------ *
 * routes.mjs — fence, methods, envelopes
 * ------------------------------------------------------------------ */

test("routes: the loopback fence accepts loopback forms and refuses everything else", async () => {
  /** A fresh plugin per case, so the TTL cache cannot hide an upstream call. */
  const mount = () => {
    const webServer = makeWebServer();
    const credentials = makeCredentials(SENTINEL);
    const fetchDouble = makeFetch(() => jsonResponse(200, upstreamBody()));
    createHostPlugin({ fetchImpl: fetchDouble.fetchImpl }).apply(makeCtx({ webServer, credentials }));
    return { webServer, credentials, fetchDouble, route: webServer.route(ROUTES.balance) };
  };

  const allowed = [
    { label: "ipv4 loopback", remoteAddress: "127.0.0.1" },
    { label: "ipv4 mapped", remoteAddress: "::ffff:127.0.0.1" },
    { label: "ipv6 loopback", remoteAddress: "::1", host: "localhost:3080" },
    { label: "localhost host", remoteAddress: "127.0.0.5", host: "localhost:3080" },
    { label: "same-origin browser", remoteAddress: "127.0.0.1", headers: { origin: "http://127.0.0.1:3080", "sec-fetch-site": "same-origin" } },
  ];
  for (const entry of allowed) {
    const harness = mount();
    const response = await callRoute(harness.route, makeRequest(entry));
    assert.equal(response.state.status, 200, `${entry.label} must be allowed`);
    assert.equal(response.json().ok, true, `${entry.label} must reach the balance reader`);
    assert.equal(harness.fetchDouble.calls.length, 1, `${entry.label} must reach upstream once`);
    assert.equal(harness.credentials.refs.length, 1, `${entry.label} must resolve the credential once`);
  }

  const refused = [
    { label: "lan address", remoteAddress: "192.168.1.20" },
    { label: "other private net", remoteAddress: "10.0.0.5" },
    { label: "loopback prefix lookalike (1270.)", remoteAddress: "1270.0.0.1" },
    { label: "non-loopback Host", remoteAddress: "127.0.0.1", host: "evil.example.com" },
    { label: "host without loopback authority", remoteAddress: "127.0.0.1", host: "0.0.0.0:3080" },
    { label: "cross-site fetch", remoteAddress: "127.0.0.1", headers: { "sec-fetch-site": "cross-site" } },
    { label: "cross-origin", remoteAddress: "127.0.0.1", headers: { origin: "http://evil.example.com" } },
    { label: "spoofed X-Forwarded-For", remoteAddress: "192.168.1.20", headers: { "x-forwarded-for": "127.0.0.1" } },
  ];
  for (const entry of refused) {
    const harness = mount();
    const response = await callRoute(harness.route, makeRequest(entry));
    assert.equal(response.state.status, 403, `${entry.label} must be refused`);
    assert.deepEqual(response.json(), { error: "forbidden: loopback-only" });
    assert.equal(harness.fetchDouble.calls.length, 0, `${entry.label} must never reach upstream`);
    assert.equal(harness.credentials.refs.length, 0, `${entry.label} must never resolve a credential`);
  }
});

test("routes: isLoopbackRequest / isLoopbackAddress cover the address families", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.255.255.254"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:192.168.0.1"), false);
  assert.equal(isLoopbackAddress("128.0.0.1"), false);
  assert.equal(isLoopbackAddress("fe80::1"), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }), false, "a missing Host is refused");
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "not a host" } }), false);
});

test("routes: methods are GET/HEAD only, and HEAD sends no body", async () => {
  const webServer = makeWebServer();
  const fetchDouble = makeFetch(() => jsonResponse(200, upstreamBody()));
  createHostPlugin({ fetchImpl: fetchDouble.fetchImpl }).apply(makeCtx({ webServer, credentials: makeCredentials(SENTINEL) }));
  const route = webServer.route(ROUTES.balance);

  const posted = await callRoute(route, makeRequest({ method: "POST" }));
  assert.equal(posted.state.status, 405);
  assert.deepEqual(posted.json(), { error: "method not allowed: POST" });

  const head = await callRoute(route, makeRequest({ method: "HEAD" }));
  assert.equal(head.state.status, 200);
  assert.equal(head.state.body, "");
  assert.equal(head.state.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(head.state.headers["cache-control"], "no-store");
  assert.equal(head.state.headers["referrer-policy"], "no-referrer");
  assert.ok(Number(head.state.headers["content-length"]) > 0);
});

test("routes: force=1 bypasses the cache and force=0 does not", async () => {
  const webServer = makeWebServer();
  const credentials = makeCredentials(SENTINEL);
  const fetchDouble = makeFetch(() => jsonResponse(200, upstreamBody()));
  createHostPlugin({ fetchImpl: fetchDouble.fetchImpl }).apply(makeCtx({ webServer, credentials }));
  const route = webServer.route(ROUTES.balance);

  const first = await callRoute(route, makeRequest({ url: `${ROUTES.balance}?force=1` }));
  assert.equal(first.json().cached, false);
  const second = await callRoute(route, makeRequest({ url: `${ROUTES.balance}?force=1` }));
  assert.equal(second.json().cached, false);
  assert.equal(fetchDouble.calls.length, 2);

  const throttled = await callRoute(route, makeRequest({ url: `${ROUTES.balance}?force=0` }));
  assert.equal(throttled.json().cached, true);
  assert.equal(fetchDouble.calls.length, 2);

  const plain = await callRoute(route, makeRequest({ url: ROUTES.balance }));
  assert.equal(plain.json().cached, true);
});

test("routes: a failure answers its real HTTP status, never 200, and leaks no key", async () => {
  const webServer = makeWebServer();
  const credentials = makeCredentials(SENTINEL);
  const fetchDouble = makeFetch(() => jsonResponse(429, {}));
  createHostPlugin({ fetchImpl: fetchDouble.fetchImpl }).apply(makeCtx({ webServer, credentials }));

  const response = await callRoute(webServer.route(ROUTES.balance), makeRequest());
  assert.equal(response.state.status, 502, "an upstream 429 must surface as 502, not 200");
  assert.deepEqual(response.json(), { ok: false, error: { code: "rate_limited", message: "official balance endpoint answered HTTP 429" } });
  assert.ok(!response.state.body.includes(SENTINEL));
  assert.ok(!response.state.body.includes("Bearer"));
});

test("routes: the captain's status table maps every frozen error code", async () => {
  const cases = [
    {
      label: "no_api_key -> 503",
      mount: () => createHostPlugin({ getApiKey: async () => undefined, fetchImpl: () => jsonResponse(200, upstreamBody()) }),
      status: 503,
      code: "no_api_key",
    },
    {
      label: "unauthorized -> 502",
      mount: () => createHostPlugin({ getApiKey: async () => SENTINEL, fetchImpl: () => jsonResponse(401, {}) }),
      status: 502,
      code: "unauthorized",
    },
    {
      label: "rate_limited -> 502",
      mount: () => createHostPlugin({ getApiKey: async () => SENTINEL, fetchImpl: () => jsonResponse(429, {}) }),
      status: 502,
      code: "rate_limited",
    },
    {
      label: "upstream_error -> 502",
      mount: () => createHostPlugin({ getApiKey: async () => SENTINEL, fetchImpl: () => jsonResponse(500, {}) }),
      status: 502,
      code: "upstream_error",
    },
    {
      label: "bad_response -> 502",
      mount: () => createHostPlugin({ getApiKey: async () => SENTINEL, fetchImpl: () => jsonResponse(200, {}) }),
      status: 502,
      code: "bad_response",
    },
    {
      label: "network_error -> 502",
      mount: () => createHostPlugin({ getApiKey: async () => SENTINEL, fetchImpl: () => { throw new TypeError("fetch failed"); } }),
      status: 502,
      code: "network_error",
    },
    {
      label: "timeout -> 504",
      mount: () => createHostPlugin({
        getApiKey: async () => SENTINEL,
        timeoutMs: 10,
        fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
      }),
      status: 504,
      code: "timeout",
    },
  ];

  for (const entry of cases) {
    const webServer = makeWebServer();
    entry.mount().apply(makeCtx({ webServer, credentials: makeCredentials(SENTINEL) }));
    const response = await callRoute(webServer.route(ROUTES.balance), makeRequest());
    assert.equal(response.state.status, entry.status, entry.label);
    assert.equal(response.json().ok, false, entry.label);
    assert.equal(response.json().error.code, entry.code, entry.label);
    assert.ok(!response.state.body.includes(SENTINEL), entry.label);
  }
});

test("routes: bad_request maps to 400 for the family (T3's invalid ?days=)", () => {
  assert.equal(statusForErrorCode("bad_request"), 400);
  assert.equal(statusForErrorCode("no_api_key"), 503);
  assert.equal(statusForErrorCode("internal"), 500);
  assert.equal(statusForErrorCode("not_a_code"), 500, "an unknown code must not become 200");
});

test("routes: an unexpected reader failure is a 500 internal envelope, not a hang", async () => {
  const logger = makeLogger();
  const routes = makeRoutes({
    balance: {
      read: () => { throw new Error(`reader exploded with Bearer ${SENTINEL}`); },
      cacheState: () => ({ warm: false }),
    },
    logger,
  });
  const response = await callRoute(routes[0], makeRequest());

  assert.equal(response.state.status, 500);
  assert.equal(response.json().error.code, "internal");
  assert.ok(!response.state.body.includes(SENTINEL), "the internal envelope leaked the key");
  assert.ok(!logger.lines.join("\n").includes(SENTINEL), "the internal log leaked the key");
});

test("routes: a broken /health reader is a 500 internal envelope too", async () => {
  const routes = makeRoutes({
    balance: { read: async () => ({ ok: false, error: { code: "no_api_key", message: "x" } }), cacheState: () => { throw new Error("cache broke"); } },
  });
  const response = await callRoute(routes[1], makeRequest({ url: ROUTES.health }));
  assert.equal(response.state.status, 500);
  assert.equal(response.json().error.code, "internal");
});

test("routes: /health reports liveness plus cache freshness on both paths", async () => {
  const clock = makeClock();
  const webServer = makeWebServer();
  const credentials = makeCredentials(SENTINEL);
  const fetchDouble = makeFetch(() => jsonResponse(200, upstreamBody()));
  createHostPlugin({ fetchImpl: fetchDouble.fetchImpl, now: clock.now, version: "9.9.9" }).apply(makeCtx({ webServer, credentials }));

  const cold = await callRoute(webServer.route(ROUTES.health), makeRequest({ url: ROUTES.health }));
  assert.equal(cold.state.status, 200);
  assert.deepEqual(cold.json(), {
    ok: true,
    name: "dsh-deepseek-usage",
    version: "9.9.9",
    route: ROUTES.health,
    uptimeMs: 0,
    balanceCache: { warm: false },
  });

  await callRoute(webServer.route(ROUTES.balance), makeRequest());
  clock.advance(5000);
  const warm = await callRoute(webServer.route(ROUTES.health), makeRequest({ url: ROUTES.health }));
  // The snapshot was fetched at T0 and is read at T0+5s: it is 5s old and has
  // 55s of its 60s TTL left, which is exactly what the popover needs to show
  // staleness without re-reading upstream.
  assert.deepEqual(warm.json().balanceCache, { warm: true, ageMs: 5000, expiresInMs: 55_000 });

  const alias = await callRoute(webServer.route(HEALTH_ALIAS), makeRequest({ url: HEALTH_ALIAS }));
  assert.equal(alias.state.status, 200);
  assert.deepEqual(alias.json(), warm.json());
});

test("routes: the alias is fenced and GET-only too", async () => {
  const webServer = makeWebServer();
  createHostPlugin({ getApiKey: async () => SENTINEL }).apply(makeCtx({ webServer }));
  const alias = webServer.route(HEALTH_ALIAS);

  assert.equal((await callRoute(alias, makeRequest({ url: HEALTH_ALIAS, remoteAddress: "192.168.1.20" }))).state.status, 403);
  assert.equal((await callRoute(alias, makeRequest({ url: HEALTH_ALIAS, method: "DELETE" }))).state.status, 405);
  assert.equal((await callRoute(alias, makeRequest({ url: HEALTH_ALIAS, method: "HEAD" }))).state.body, "");
});

test("routes: makeRoutes rejects a missing balance reader", () => {
  assert.throws(() => makeRoutes({}), /requires deps\.balance/);
  assert.throws(() => makeHealthAliasRoute({ balance: {} }), /requires deps\.balance/);
});

test("routes: version falls back to the package manifest", () => {
  const webServer = makeWebServer();
  createHostPlugin({ getApiKey: async () => SENTINEL }).apply(makeCtx({ webServer }));
  const route = webServer.route(ROUTES.health);
  const response = makeResponse();
  route.handler(makeRequest({ url: ROUTES.health }), response);
  assert.match(response.json().version, /^\d+\.\d+\.\d+$/);
});

test("routes: no route ever answers with the key, for any fenced outcome", async () => {
  const outcomes = [
    { label: "ok", status: 200, handler: () => jsonResponse(200, upstreamBody()) },
    { label: "401", status: 502, handler: () => jsonResponse(401, { error: `bad key ${SENTINEL}` }) },
    { label: "429", status: 502, handler: () => jsonResponse(429, {}) },
    { label: "500", status: 502, handler: () => jsonResponse(500, { message: `upstream echoed ${SENTINEL}` }) },
    { label: "not-json", status: 502, handler: () => textResponse(200, `body containing ${SENTINEL}`) },
    { label: "throw", status: 502, handler: () => { throw new Error(`socket error with ${SENTINEL}`); } },
  ];

  for (const outcome of outcomes) {
    const webServer = makeWebServer();
    const logger = makeLogger();
    const fetchDouble = makeFetch(outcome.handler);
    createHostPlugin({ fetchImpl: fetchDouble.fetchImpl, logger }).apply(makeCtx({ webServer, credentials: makeCredentials(SENTINEL), logger }));
    const response = await callRoute(webServer.route(ROUTES.balance), makeRequest());
    assert.equal(response.state.status, outcome.status, outcome.label);
    assert.ok(!response.state.body.includes(SENTINEL), `${outcome.label}: body leaked the key`);
    assert.ok(!response.state.body.includes("Bearer"), `${outcome.label}: body leaked the credential header`);
    assert.ok(!logger.lines.join("\n").includes(SENTINEL), `${outcome.label}: log leaked the key`);
  }
});

/* ------------------------------------------------------------------ *
 * helpers used above
 * ------------------------------------------------------------------ */

/**
 * Read one registered route's handler.
 * @param webServer - the double.
 * @param path - route path.
 * @returns the handler function.
 */
function routeHandlerOf(webServer, path) {
  const route = webServer.route(path);
  assert.ok(route !== undefined, `route ${path} must be registered`);
  return route.handler;
}
