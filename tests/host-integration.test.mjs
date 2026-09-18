/**
 * T4 — host integration tests: both endpoints of the family, one assembly.
 *
 * This suite drives the *assembled* plugin (T1 entry → T2 balance reader → T3
 * ledger → routes) with two injected fixtures at once:
 *
 *   - `/balance` against a fake fetcher and a fake credential seam (no network),
 *   - `/usage`   against a synthetic session-log directory (no real logs),
 *
 * and it exercises them two ways: directly (route handler + response double) and
 * over a REAL loopback HTTP server, so the fence, the Host header, HEAD handling
 * and the JSON framing are all covered rather than assumed.
 *
 * Shape claims are not re-derived from prose. The frozen contract's own opt-in
 * live check (`tests/contract.test.mjs`, enabled here with
 * `DSH_DEEPSEEK_USAGE_BASE_URL`) is pointed at that HTTP server, so the contract
 * file itself validates these responses; the local assertions below are an
 * additional, purely structural guard.
 *
 * Run with the host's own Node (the PATH Node 22 has no `zlib.zstdDecompress`):
 *   C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe --test tests/host-integration.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { aggregateUsage as aggregateLedgerUsage, defaultCacheDir as defaultLedgerCacheDirFromLedgerModule, defaultSessionsRoot } from "../src/host/ledger.mjs";
import { createHostPlugin, defaultLedgerCacheDir, name as pluginName } from "../src/host/plugin.mjs";
import { HEALTH_ALIAS, PLUGIN_NAME, ROUTES, parseUsageDays, rawUsageDays } from "../src/host/routes.mjs";
// The status table lives in balance.mjs (T2) and is imported by routes.mjs; this
// suite reads it from its owner so a re-export drift cannot hide a real change.
import { statusForErrorCode } from "../src/host/balance.mjs";

/** Fake credential value; every test asserts it never reaches a response body. */
const SENTINEL = "sk-integration-0000000000000000000000000000";

/** The plugin package root (the directory that must stay free of cache state). */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 2026-09-15T00:00:00Z — fixture window start, months before the wall clock's window. */
const BASE_MS = Date.parse("2026-09-15T00:00:00.000Z");
/** One UTC hour in ms. */
const HOUR = 3_600_000;
/** Fixture log mtime: late enough to look "recent", distinct per file. */
const FIXTURE_MTIME_MS = Date.parse("2026-09-17T10:00:00Z");

/* ------------------------------------------------------------------ *
 * Local structural guards
 *
 * These do NOT replace the frozen contract: they only assert the parts of the
 * envelope a live HTTP check cannot know (the exact requested window). The
 * contract file itself is run against this host's real HTTP server below.
 * ------------------------------------------------------------------ */

/** Assert one `{ ok:true, … }` balance envelope. */
function assertBalanceEnvelope(payload) {
  assert.equal(payload.ok, true);
  assert.match(payload.currency, /^[A-Z]{3}$/);
  for (const field of ["totalBalance", "grantedBalance", "toppedUpBalance"]) {
    assert.equal(typeof payload[field], "number", `${field} must be a number`);
    assert.ok(Number.isFinite(payload[field]) && payload[field] >= 0);
  }
  assert.equal(typeof payload.isAvailable, "boolean");
  assert.match(payload.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  assert.equal(typeof payload.cached, "boolean");
}

/**
 * Assert one `{ ok:true, … }` usage envelope against an expected window.
 * @param payload - decoded JSON body.
 * @param expectedDays - the window the request asked for.
 */
function assertUsageEnvelope(payload, expectedDays) {
  assert.equal(payload.ok, true);
  assert.equal(payload.requestedDays, expectedDays, "the echoed window must match the request");
  assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  assert.equal(typeof payload.truncated, "boolean");
  assert.ok(Array.isArray(payload.days));
  assert.equal(payload.days.length, expectedDays, "one bucket per requested day, zero-filled");

  let previous;
  for (const day of payload.days) {
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
    if (previous !== undefined) assert.ok(day.date > previous, "dates must ascend");
    previous = day.date;
    assert.ok(Array.isArray(day.models));
    for (const model of day.models) {
      assert.equal(typeof model.model, "string");
      assert.ok(model.model.length > 0);
      for (const field of ["inputTokens", "cacheReadTokens", "outputTokens", "estimatedCostCny"]) {
        assert.equal(typeof model[field], "number", `${model.model}.${field} must be a number`);
        assert.ok(Number.isFinite(model[field]) && model[field] >= 0);
      }
    }
  }

  assertTotalsMatchDays(payload);
}

/** Assert `totals` equals the day/model sum (a USD sum needs a tolerance). */
function assertTotalsMatchDays(payload, label = "totals") {
  const summed = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, estimatedCostCny: 0 };
  for (const day of payload.days) {
    for (const model of day.models) {
      summed.inputTokens += model.inputTokens;
      summed.cacheReadTokens += model.cacheReadTokens;
      summed.outputTokens += model.outputTokens;
      summed.estimatedCostCny += model.estimatedCostCny;
    }
  }
  assert.equal(payload.totals.inputTokens, summed.inputTokens, `${label}.inputTokens`);
  assert.equal(payload.totals.cacheReadTokens, summed.cacheReadTokens, `${label}.cacheReadTokens`);
  assert.equal(payload.totals.outputTokens, summed.outputTokens, `${label}.outputTokens`);
  // Floating-point addition is not associative, so a 1e-12 tolerance is the
  // honest comparison here (the frozen contract test uses 1e-6).
  assert.ok(
    Math.abs(payload.totals.estimatedCostCny - summed.estimatedCostCny) < 1e-12,
    `${label}.estimatedCostCny: ${payload.totals.estimatedCostCny} vs ${summed.estimatedCostCny}`,
  );
}

/** Assert one `{ ok:false, error }` envelope from the closed code set. */
function assertErrorEnvelope(payload, expectedCode) {
  assert.equal(payload.ok, false);
  assert.equal(typeof payload.error, "object");
  assert.equal(typeof payload.error.message, "string");
  assert.ok(payload.error.message.length > 0);
  if (expectedCode !== undefined) assert.equal(payload.error.code, expectedCode);
  assert.ok(statusForErrorCode(payload.error.code) >= 400, "a failure code must never map to 2xx");
}

/* ------------------------------------------------------------------ *
 * Synthetic Zstandard session logs (the container shape the host writes)
 * ------------------------------------------------------------------ */

/** Largest raw block this encoder emits. */
const MAX_RAW_BLOCK = 131_072;

/**
 * Window descriptor for a single-segment frame whose body is raw blocks; a raw
 * block never references history outside itself, so one block is enough.
 * @param size - frame payload size in bytes.
 * @returns the one-byte window descriptor value.
 */
function windowDescriptor(size) {
  const need = Math.max(1, Math.min(MAX_RAW_BLOCK, size));
  let exponent = 0;
  let window = 1024;
  while (window < need && exponent < 31) {
    exponent += 1;
    window *= 2;
  }
  return ((exponent + 10) & 0x1f) << 3;
}

/**
 * Encode one complete Zstandard frame made of raw blocks.
 * @param data - payload (string or Buffer).
 * @returns the frame bytes.
 */
function encodeZstdFrame(data) {
  const source = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const head = Buffer.alloc(6);
  head.writeUInt32LE(0xfd2fb528, 0);
  head.writeUInt8(0x00, 4); // no single-segment flag, no checksum, no content size
  head.writeUInt8(windowDescriptor(source.length), 5);

  const parts = [];
  if (source.length === 0) {
    const empty = Buffer.alloc(3);
    empty.writeUIntLE(1, 0, 3);
    parts.push(empty);
  }
  for (let offset = 0; offset < source.length; ) {
    const size = Math.min(MAX_RAW_BLOCK, source.length - offset);
    const last = offset + size >= source.length ? 1 : 0;
    const header = Buffer.alloc(3);
    header.writeUIntLE((size << 3) | last, 0, 3);
    parts.push(header, source.subarray(offset, offset + size));
    offset += size;
  }
  return Buffer.concat([head, ...parts]);
}

/** One durable `assistant/message` settlement, as the host writes it. */
function assistantMessage({ seq, time, turn = 1, step = 1, model = "deepseek-flash", usage }) {
  return {
    type: "assistant/message",
    seq,
    time,
    data: {
      turn,
      step,
      message: {
        role: "assistant",
        content: [],
        id: `message-${seq}`,
        source: { kind: "model", provider: "deepseek-official", model },
      },
      usage,
    },
  };
}

/** JSONL text for the given events (always newline-terminated). */
function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/**
 * Write one synthetic session log.
 * @param root - `<temp>/sessions`.
 * @param spec - `{ id, workspace?, events?, batches?, mtimeMs? }`.
 * @returns the log path.
 */
function writeSessionLog(root, { id, workspace = "--E-integration--", events, batches, mtimeMs = FIXTURE_MTIME_MS }) {
  const directory = join(root, workspace, id);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "session.v3.jsonl.zstd");
  const container = batches === undefined ? [jsonl(events ?? [])] : batches;
  writeFileSync(path, Buffer.concat(container.map((batch) => encodeZstdFrame(batch))));
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

/**
 * The fixture's usage, spanning three UTC days and two models, with counts
 * chosen so every per-field comparison is unambiguous.
 */
const FIXTURE_EVENTS = Object.freeze({
  "session-a": [
    JSON.parse('{"type":"session","version":3,"id":"session-a","createdAt":1789645101211}'),
    assistantMessage({ seq: 10, time: BASE_MS + HOUR, turn: 1, step: 1, usage: { inputTokens: 1_200, cacheReadTokens: 4_800, outputTokens: 640 } }),
    assistantMessage({ seq: 20, time: BASE_MS + 25 * HOUR, turn: 2, step: 1, model: "deepseek-v4-pro", usage: { inputTokens: 300, cacheReadTokens: 900, outputTokens: 220 } }),
    assistantMessage({ seq: 30, time: BASE_MS + 49 * HOUR, turn: 3, step: 1, usage: { inputTokens: 250, cacheReadTokens: 1_500, outputTokens: 130 } }),
  ],
  "session-b": [
    assistantMessage({ seq: 10, time: BASE_MS + 25 * HOUR, turn: 1, step: 1, usage: { inputTokens: 40, cacheReadTokens: 60, outputTokens: 7 } }),
    assistantMessage({ seq: 20, time: BASE_MS + 49 * HOUR, turn: 2, step: 1, model: "deepseek-v4-pro", usage: { inputTokens: 90, cacheReadTokens: 10, outputTokens: 11 } }),
  ],
});

/** Write the shared fixture logs into a sessions root. */
function writeFixtureLogs(sessionsRoot) {
  writeSessionLog(sessionsRoot, { id: "session-a", events: FIXTURE_EVENTS["session-a"] });
  writeSessionLog(sessionsRoot, { id: "session-b", events: FIXTURE_EVENTS["session-b"], mtimeMs: FIXTURE_MTIME_MS - 1000 });
}

/** Build the shared fixture: one temp root with fake logs and an external cache dir. */
function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-usage-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  const cacheDir = join(root, "storages", "dsh-deepseek-usage", "ledger-cache");
  mkdirSync(sessionsRoot, { recursive: true });
  return { root, sessionsRoot, cacheDir };
}

/* ------------------------------------------------------------------ *
 * Request / response doubles and the upstream balance fake
 * ------------------------------------------------------------------ */

/** Build the upstream balance body in the official decimal-string form. */
function upstreamBody(overrides = {}) {
  return {
    is_available: true,
    balance_infos: [
      { currency: "USD", total_balance: "1.50", granted_balance: "0.00", topped_up_balance: "1.50" },
      { currency: "CNY", total_balance: "12.02", granted_balance: "0.00", topped_up_balance: "12.02" },
    ],
    ...overrides,
  };
}

/** A `fetch`-compatible double that records calls. */
function makeFetch(handler) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, init) {
      calls.push({ url: String(url), init });
      return handler(String(url), init ?? {});
    },
  };
}

/** A JSON response double with the fields the balance reader reads. */
function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

/** A credentials double; `key === undefined` reproduces "not configured". */
function makeCredentials(key) {
  const refs = [];
  return {
    refs,
    async resolve(ref) {
      refs.push(ref);
      return key === undefined ? undefined : { value: key, source: "env" };
    },
  };
}

/** A webServer double enforcing the real duplicate-route rule. */
function makeWebServer() {
  const registered = [];
  return {
    registered,
    register(route) {
      if (registered.some((existing) => existing.kind === route.kind && existing.path === route.path)) {
        throw new Error(`duplicate (kind, path) ${route.kind} ${route.path}`);
      }
      registered.push(route);
      return () => {
        const index = registered.indexOf(route);
        if (index !== -1) registered.splice(index, 1);
      };
    },
    paths() {
      return registered.map((route) => route.path);
    },
    route(path) {
      return registered.find((route) => route.path === path);
    },
  };
}

/** A cordis-context double exposing only what the plugin reads. */
function makeCtx({ webServer, credentials, logger } = {}) {
  const services = new Map();
  if (webServer !== undefined) services.set("webServer", webServer);
  if (credentials !== undefined) services.set("credentials", credentials);
  return {
    injects: [],
    logger,
    get(serviceName) {
      return services.get(serviceName);
    },
    inject(nameList, callback) {
      this.injects.push({ names: nameList, callback });
    },
    effect(callback) {
      return callback();
    },
  };
}

/** A request double (loopback by construction). */
function makeRequest({ method = "GET", url = ROUTES.balance, remoteAddress = "127.0.0.1", host = "127.0.0.1:3080", headers = {} } = {}) {
  return { method, url, socket: { remoteAddress }, headers: { host, ...headers } };
}

/** A response double capturing status, headers, and body. */
function makeResponse() {
  const state = { status: undefined, headers: undefined, body: "" };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(body) {
      if (body !== undefined && body !== null) state.body = String(body);
    },
    json() {
      return state.body === "" ? undefined : JSON.parse(state.body);
    },
  };
}

/** Drive one route handler end to end and return the response double. */
async function callRoute(route, request) {
  assert.ok(route !== undefined, `route ${request.url} must be registered`);
  const response = makeResponse();
  await route.handler(request, response);
  return response;
}

/**
 * Mount the plugin with both fixtures wired.
 * @param options - `{ fixture, credentials, fetchImpl, cacheDirOverride, aggregateUsage, ledgerBudgetMs, logger }`.
 */
function mountHost(options = {}) {
  const { fixture, credentials = makeCredentials(SENTINEL), fetchImpl } = options;
  const webServer = makeWebServer();
  const fetchDouble = makeFetch(fetchImpl ?? (() => jsonResponse(200, upstreamBody())));
  const plugin = createHostPlugin({
    fetchImpl: fetchDouble.fetchImpl,
    sessionsRoot: fixture?.sessionsRoot,
    cacheDir: options.cacheDirOverride === undefined ? fixture?.cacheDir : options.cacheDirOverride,
    ledgerBudgetMs: options.ledgerBudgetMs,
    aggregateUsage: options.aggregateUsage,
    version: "0.1.0-test",
    logger: options.logger,
  });
  plugin.apply(makeCtx({ webServer, credentials, logger: options.logger }));

  return {
    plugin,
    webServer,
    credentials,
    fetchDouble,
    requestBalance: (request) => callRoute(webServer.route(ROUTES.balance), request ?? makeRequest({ url: ROUTES.balance })),
    requestUsage: (url) => callRoute(webServer.route(ROUTES.usage), makeRequest({ url })),
    requestHealth: () => callRoute(webServer.route(ROUTES.health), makeRequest({ url: ROUTES.health })),
  };
}

/* ------------------------------------------------------------------ *
 * A real loopback HTTP server over the assembled routes
 * ------------------------------------------------------------------ */

/**
 * Serve the plugin's registered routes over real HTTP, honoring HEAD.
 * @param routes - registered route descriptors.
 * @returns `{ url, close, server }`.
 */
async function startHttpHost(routes) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const route = routes.find((candidate) => candidate.kind === "exact" && candidate.path === path);
    if (route === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"no route"}');
      return;
    }
    Promise.resolve()
      .then(() => route.handler(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end('{"ok":false,"error":{"code":"internal","message":"handler threw"}}');
      });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Fetch `path` from the loopback host and decode the JSON body. */
async function getJson(base, path, init) {
  const response = await fetch(`${base}${path}`, { headers: { host: new URL(base).host, ...(init?.headers ?? {}) }, ...init });
  const body = await response.text();
  return { status: response.status, headers: response.headers, body, json: () => JSON.parse(body) };
}

/**
 * Issue a request with a FORBIDDEN `Host` header.
 *
 * `fetch` refuses to send a caller-supplied `Host`, so this has to go through
 * `node:http` options directly — which is the only way to prove the fence reads
 * the real header value off the socket rather than trusting the URL.
 * @param base - origin of the running test host.
 * @param path - request path.
 * @param headers - extra headers (the `host` override lands here).
 * @returns `{ status, body }`.
 */
function requestWithHost({ base, path, headers }) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: target.hostname, port: target.port, path, method: "GET", headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/* ------------------------------------------------------------------ *
 * 0. The real loopback host
 *
 * The routes are served over a genuine socket so the fence, HEAD handling, the
 * JSON framing and the status codes are exercised end to end, not just through
 * a response double. (`tests/contract.test.mjs` exports no validators and is
 * out of scope here, so its live check cannot be pointed at this host; the
 * local `assertUsageEnvelope` / `assertBalanceEnvelope` guards stand in, and
 * the contract file still owns the frozen shapes it ships.)
 * ------------------------------------------------------------------ */

let liveHost;

test.before(async () => {
  const fixture = makeFixture({ after: () => {} });
  writeFixtureLogs(fixture.sessionsRoot);
  const fetchDouble = makeFetch(() => jsonResponse(200, upstreamBody()));
  const webServer = makeWebServer();
  createHostPlugin({
    fetchImpl: fetchDouble.fetchImpl,
    sessionsRoot: fixture.sessionsRoot,
    cacheDir: fixture.cacheDir,
    version: "0.1.0-test",
  }).apply(makeCtx({ webServer, credentials: makeCredentials(SENTINEL) }));
  liveHost = await startHttpHost(webServer.registered);
});

test.after(async () => {
  if (liveHost !== undefined) await liveHost.close();
});

/* ------------------------------------------------------------------ *
 * 1. Registration and the frozen shape over real HTTP
 * ------------------------------------------------------------------ */

test("integration: the assembled host registers /balance, /health, and /usage", (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const host = mountHost({ fixture });

  assert.deepEqual(host.webServer.paths(), [ROUTES.balance, ROUTES.health, ROUTES.usage, HEALTH_ALIAS]);
  for (const route of host.webServer.registered) assert.equal(route.kind, "exact", `${route.path} must be an exact route`);
  assert.equal(pluginName, PLUGIN_NAME);
  assert.equal(host.plugin.name, "dsh-deepseek-usage");
  assert.deepEqual(host.plugin.inject, [], "the web server is awaited, not declared as a hard inject");
});

test("http: /usage answers the frozen shape over a real socket", async () => {
  const response = await getJson(liveHost.url, `${ROUTES.usage}?days=7`);
  assert.equal(response.status, 200, "a healthy ledger answers 200");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

  const payload = response.json();
  assertUsageEnvelope(payload, 7);
  assert.equal(payload.truncated, false);
  assert.deepEqual(
    payload.days.filter((day) => day.models.length > 0).map((day) => day.date),
    ["2026-09-15", "2026-09-16", "2026-09-17"],
    "only the three days the fixture logs cover carry models",
  );
  // The host-side ledger diagnostics must NOT cross the wire.
  assert.deepEqual(Object.keys(payload).sort(), ["days", "generatedAt", "ok", "requestedDays", "totals", "truncated"]);
  assert.equal(response.body.includes("ledger-cache"), false, "the cache path must not leak to the client");
  assert.equal(/sk-[A-Za-z0-9]/.test(response.body), false, "no credential material may appear");
});

test("http: /balance answers the frozen shape over the same socket", async () => {
  const response = await getJson(liveHost.url, ROUTES.balance);
  assert.equal(response.status, 200);
  const payload = response.json();
  assertBalanceEnvelope(payload);
  assert.equal(payload.currency, "CNY", "CNY is preferred when present");
  assert.equal(payload.totalBalance, 12.02);
});

test("http: the default window is 30 days and the cap is 365", async () => {
  const defaulted = await getJson(liveHost.url, ROUTES.usage);
  assert.equal(defaulted.status, 200);
  assert.equal(defaulted.json().requestedDays, 30, "an absent ?days= means 30");

  const capped = await getJson(liveHost.url, `${ROUTES.usage}?days=365`);
  assert.equal(capped.status, 200);
  assertUsageEnvelope(capped.json(), 365);
});

test("http: chart projections are one { label, value } per day on the frozen axis", async () => {
  const payload = (await getJson(liveHost.url, `${ROUTES.usage}?days=7`)).json();
  const expected = payload.days.map((day) => day.date);
  for (const metric of ["totalTokens", "inputTokens", "cacheReadTokens", "outputTokens", "estimatedCostCny"]) {
    const points = payload.days.map((day) => ({
      label: day.date,
      value: day.models.reduce((sum, model) => {
        if (metric === "totalTokens") return sum + model.inputTokens + model.cacheReadTokens + model.outputTokens;
        return sum + model[metric];
      }, 0),
    }));
    assert.equal(points.length, payload.requestedDays, `${metric} needs one point per day`);
    assert.deepEqual(points.map((point) => point.label), expected, `${metric} must stay on the day axis`);
    for (const point of points) assert.ok(Number.isFinite(point.value) && point.value >= 0);
  }
  // The last point of the window is what the chart draws at "today", and the window
  // ROLLS with the wall clock: an earlier revision hardcoded the fixture's own day
  // totals here, which made this assertion go red the moment the fixture's fixed
  // dates (2026-09-15..17) fell out of the trailing 7-day window. Assert the shape and
  // the totals identity instead — the exact per-day numbers are already pinned against
  // the ledger in "integration: /usage data is field-for-field identical".
  const totalTokens = payload.days.map((day) => day.models.reduce((sum, m) => sum + m.inputTokens + m.cacheReadTokens + m.outputTokens, 0));
  assert.equal(totalTokens.length, payload.days.length);
  assertTotalsMatchDays({ days: payload.days, totals: payload.totals }, "the 7-day window's totals must equal its days");
});

/* ------------------------------------------------------------------ *
 * 2. /usage is field-for-field the ledger's own output
 * ------------------------------------------------------------------ */

test("integration: /usage data is field-for-field identical to the ledger module's output", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const host = mountHost({ fixture });

  for (const days of [1, 3, 7, 30]) {
    const served = (await host.requestUsage(`${ROUTES.usage}?days=${days}`)).json();
    // Same fixture, same collaborator, called directly — every value must match.
    // `generatedAt` is the one field that legitimately differs: it is the instant
    // of each aggregation, not a property of the data, so it is checked for
    // validity and freshness instead of equality.
    const direct = aggregateLedgerUsage({ days, sessionsRoot: fixture.sessionsRoot, cacheDir: fixture.cacheDir });
    assert.deepEqual(served.days, direct.days, `days=${days}: day buckets must match the ledger`);
    assertTotalsMatchDays({ days: served.days, totals: served.totals }, `days=${days}: served totals`);
    assertTotalsMatchDays({ days: direct.days, totals: direct.totals }, `days=${days}: ledger totals`);
    assert.equal(served.truncated, direct.truncated, `days=${days}: truncated must match the ledger`);
    assert.equal(served.requestedDays, direct.requestedDays);
    assert.match(served.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
    assert.ok(Math.abs(Date.parse(served.generatedAt) - Date.now()) < 60_000, `days=${days}: generatedAt must be now-ish`);
    assertUsageEnvelope(served, days);
  }
});

test("integration: the served aggregate is the fixture's hand-computed sum", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const host = mountHost({ fixture });

  const payload = (await host.requestUsage(`${ROUTES.usage}?days=7`)).json();
  const byDate = Object.fromEntries(payload.days.map((day) => [day.date, Object.fromEntries(day.models.map((model) => [model.model, model]))]));

  const day15 = byDate["2026-09-15"]["deepseek-flash"];
  assert.deepEqual(
    { input: day15.inputTokens, cacheRead: day15.cacheReadTokens, output: day15.outputTokens },
    { input: 1_200, cacheRead: 4_800, output: 640 },
    "2026-09-15 holds exactly session A's first settlement",
  );
  assert.ok(day15.estimatedCostCny > 0, "a known model must be priced");

  // 2026-09-16: v4-pro 300/900/220 plus flash 40/60/7 — two models, one bucket.
  assert.equal(byDate["2026-09-16"]["deepseek-v4-pro"].inputTokens, 300);
  assert.equal(byDate["2026-09-16"]["deepseek-flash"].inputTokens, 40);
  assert.equal(byDate["2026-09-16"]["deepseek-flash"].outputTokens, 7);

  // 2026-09-17: flash 250/1_500/130 plus v4-pro 90/10/11.
  assert.deepEqual(
    {
      input: byDate["2026-09-17"]["deepseek-flash"].inputTokens,
      cacheRead: byDate["2026-09-17"]["deepseek-flash"].cacheReadTokens,
      output: byDate["2026-09-17"]["deepseek-flash"].outputTokens,
    },
    { input: 250, cacheRead: 1_500, output: 130 },
  );
  assert.deepEqual(
    {
      input: byDate["2026-09-17"]["deepseek-v4-pro"].inputTokens,
      cacheRead: byDate["2026-09-17"]["deepseek-v4-pro"].cacheReadTokens,
      output: byDate["2026-09-17"]["deepseek-v4-pro"].outputTokens,
    },
    { input: 90, cacheRead: 10, output: 11 },
  );

  assert.deepEqual(
    {
      input: payload.totals.inputTokens,
      cacheRead: payload.totals.cacheReadTokens,
      output: payload.totals.outputTokens,
    },
    { input: 1200 + 300 + 250 + 40 + 90, cacheRead: 4800 + 900 + 1500 + 60 + 10, output: 640 + 220 + 130 + 7 + 11 },
  );
});

test("integration: a truncated aggregate is reported as such, never as a smaller window", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  // Two logs with distinct mtimes: the ledger sorts by path and checks the
  // budget before each file, so a zero budget is guaranteed to read the first
  // one and stop — the partial result must stay contract-shaped and admit it.
  writeSessionLog(fixture.sessionsRoot, {
    id: "session-zz-last",
    events: [assistantMessage({ seq: 1, time: BASE_MS + 25 * HOUR, turn: 9, step: 1, usage: { inputTokens: 5_000, cacheReadTokens: 0, outputTokens: 500 } })],
    mtimeMs: FIXTURE_MTIME_MS - 2000,
  });
  const partial = mountHost({ fixture, ledgerBudgetMs: 0 });
  const complete = mountHost({ fixture });

  const partialPayload = (await partial.requestUsage(`${ROUTES.usage}?days=7`)).json();
  assert.equal(partialPayload.truncated, true, "an expired budget must be visible in the payload");
  assertUsageEnvelope(partialPayload, 7);

  const completePayload = (await complete.requestUsage(`${ROUTES.usage}?days=7`)).json();
  assert.equal(completePayload.truncated, false, "the same fixture with a real budget is complete");
  assertUsageEnvelope(completePayload, 7);

  assert.ok(
    completePayload.totals.inputTokens > partialPayload.totals.inputTokens,
    "the truncated run must hold strictly less data than the complete one",
  );
});

/* ------------------------------------------------------------------ *
 * 3. Both endpoints at once — the actual assembly claim
 * ------------------------------------------------------------------ */

test("integration: /balance and /usage both serve, from one mounted plugin", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const host = mountHost({ fixture });

  const balance = await host.requestBalance();
  assert.equal(balance.state.status, 200);
  assertBalanceEnvelope(balance.json());
  assert.equal(balance.json().currency, "CNY", "CNY is preferred");
  assert.equal(balance.json().cached, false);
  assert.equal(host.fetchDouble.calls.length, 1, "the balance read reached the fake upstream once");
  assert.equal(host.credentials.refs.length, 1, "the credential was resolved once");

  const usage = await host.requestUsage(`${ROUTES.usage}?days=7`);
  assert.equal(usage.state.status, 200);
  assertUsageEnvelope(usage.json(), 7);
  assert.equal(host.fetchDouble.calls.length, 1, "a usage read must not touch the upstream balance endpoint");

  const health = await host.requestHealth();
  assert.equal(health.state.status, 200);
  assert.equal(health.json().ok, true);
  assert.equal(health.json().balanceCache.warm, true, "the earlier balance read warmed the cache");

  // Three different endpoints, one plugin instance, no cross-talk.
  assert.notEqual(balance.state.body, usage.state.body);
  assert.notEqual(health.state.body, usage.state.body);
});

test("http: both endpoints answer from one real host, back to back", async () => {
  const balance = await getJson(liveHost.url, ROUTES.balance);
  const usage = await getJson(liveHost.url, `${ROUTES.usage}?days=3`);
  const health = await getJson(liveHost.url, ROUTES.health);

  assert.equal(balance.status, 200);
  assert.equal(usage.status, 200);
  assert.equal(health.status, 200);
  assertBalanceEnvelope(balance.json());
  assertUsageEnvelope(usage.json(), 3);
  assert.equal(health.json().name, "dsh-deepseek-usage");
  assert.equal(typeof health.json().balanceCache.warm, "boolean");

  const alias = await getJson(liveHost.url, HEALTH_ALIAS);
  assert.equal(alias.status, 200, "the bare /health alias serves too");
  assert.equal(alias.json().route, ROUTES.health);
});

test("integration: a missing credential degrades /balance but leaves /usage working", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const host = mountHost({ fixture, credentials: makeCredentials(undefined) });

  const balance = await host.requestBalance();
  assert.equal(balance.state.status, 503, "no API key is 503, never a 200");
  assertErrorEnvelope(balance.json(), "no_api_key");
  assert.equal(host.fetchDouble.calls.length, 0, "no key means no upstream call");

  const usage = await host.requestUsage(`${ROUTES.usage}?days=3`);
  assert.equal(usage.state.status, 200, "the local ledger does not need the API key");
  assertUsageEnvelope(usage.json(), 3);
  assert.equal(host.credentials.refs.length, 1, "the usage route adds no credential resolution of its own");
});

test("integration: a balance upstream failure does not disturb the usage route", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const host = mountHost({ fixture, fetchImpl: () => jsonResponse(429, {}) });

  const balance = await host.requestBalance();
  assert.equal(balance.state.status, 502);
  assertErrorEnvelope(balance.json(), "rate_limited");

  const usage = await host.requestUsage(`${ROUTES.usage}?days=3`);
  assert.equal(usage.state.status, 200);
  assertUsageEnvelope(usage.json(), 3);
  assert.equal(host.fetchDouble.calls.length, 1, "only the balance read went upstream");
});

/* ------------------------------------------------------------------ *
 * 4. The fence and the method policy cover the new route too
 * ------------------------------------------------------------------ */

test("integration: /usage is fenced, GET/HEAD-only, and never resolves a credential", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const host = mountHost({ fixture });
  const route = host.webServer.route(ROUTES.usage);

  const refused = await callRoute(route, makeRequest({ url: ROUTES.usage, remoteAddress: "192.168.1.20" }));
  assert.equal(refused.state.status, 403, "a non-loopback peer is refused");
  assert.equal(host.credentials.refs.length, 0);

  const foreignHost = await callRoute(route, makeRequest({ url: ROUTES.usage, host: "evil.example" }));
  assert.equal(foreignHost.state.status, 403, "a non-loopback Host is refused");

  const crossSite = await callRoute(route, makeRequest({ url: ROUTES.usage, headers: { "sec-fetch-site": "cross-site" } }));
  assert.equal(crossSite.state.status, 403);

  const posted = await callRoute(route, makeRequest({ url: ROUTES.usage, method: "POST" }));
  assert.equal(posted.state.status, 405);

  const head = await callRoute(route, makeRequest({ url: ROUTES.usage, method: "HEAD" }));
  assert.equal(head.state.status, 200);
  assert.equal(head.state.body, "", "HEAD answers headers only");
  assert.equal(host.credentials.refs.length, 0, "the usage route never resolves a credential");

  // Over the socket, an outside Host header is refused by the same fence. This
  // needs a raw http request: `fetch` refuses to send a caller-supplied Host.
  const denylisted = await requestWithHost({ base: liveHost.url, path: ROUTES.usage, headers: { host: "evil.example" } });
  assert.equal(denylisted.status, 403, "the fence must read the real Host header off the socket");
  assert.match(denylisted.body, /loopback-only/);

  const allowedBySocket = await requestWithHost({
    base: liveHost.url,
    path: `${ROUTES.usage}?days=3`,
    headers: { host: new URL(liveHost.url).host },
  });
  assert.equal(allowedBySocket.status, 200, "a loopback Host on the same socket is allowed");
  assertUsageEnvelope(JSON.parse(allowedBySocket.body), 3);
});

/* ------------------------------------------------------------------ *
 * 5. `?days=` contract surface
 * ------------------------------------------------------------------ */

test("integration: a malformed or out-of-range ?days= is 400 bad_request", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const host = mountHost({ fixture });

  for (const raw of ["0", "366", "7.5", "abc", "-1", "", "1e3", " 7 "]) {
    const response = await host.requestUsage(`${ROUTES.usage}?days=${encodeURIComponent(raw)}`);
    assert.equal(response.state.status, 400, `days=${JSON.stringify(raw)} must be rejected`);
    assertErrorEnvelope(response.json(), "bad_request");
    assert.match(response.json().error.message, /days/);
  }

  // A repeated parameter is NOT resolved to its first value: the frozen
  // contract's `normalizeDays` takes the raw query value and requires a single
  // string, so `?days=3&days=4` must be refused. Reaching the parser requires
  // the handler to read every value (`getAll`), not just the first (`get`).
  const repeated = await host.requestUsage(`${ROUTES.usage}?days=3&days=4`);
  assert.equal(repeated.state.status, 400, "a repeated parameter must be a 400, not a silent first value");
  assertErrorEnvelope(repeated.json(), "bad_request");
  assert.match(repeated.json().error.message, /single query value/);

  // The same must hold over a real socket, where the query string is parsed by
  // the URL layer rather than by the test's request double.
  const repeatedOverSocket = await getJson(liveHost.url, `${ROUTES.usage}?days=3&days=4`);
  assert.equal(repeatedOverSocket.status, 400);
  assertErrorEnvelope(repeatedOverSocket.json(), "bad_request");

  // Even a repeat of the SAME value is a repeat.
  const repeatedSame = await host.requestUsage(`${ROUTES.usage}?days=7&days=7`);
  assert.equal(repeatedSame.state.status, 400);
  assertErrorEnvelope(repeatedSame.json(), "bad_request");

  // A repeated UNRELATED parameter is not our concern.
  const otherRepeated = await host.requestUsage(`${ROUTES.usage}?days=3&force=1&force=1`);
  assert.equal(otherRepeated.state.status, 200);
  assert.equal(otherRepeated.json().requestedDays, 3);

  // The boundaries are accepted, and an unrelated parameter is ignored.
  for (const [raw, expected] of [["1", 1], ["30", 30], ["365", 365]]) {
    const response = await host.requestUsage(`${ROUTES.usage}?days=${raw}`);
    assert.equal(response.state.status, 200, `days=${raw} must be accepted`);
    assert.equal(response.json().requestedDays, expected);
  }
  const extra = await host.requestUsage(`${ROUTES.usage}?days=3&force=1&nonsense=1`);
  assert.equal(extra.state.status, 200);
  assert.equal(extra.json().requestedDays, 3);
});

test("http: a bad ?days= is 400 over the socket too", async () => {
  const bad = await getJson(liveHost.url, `${ROUTES.usage}?days=0`);
  assert.equal(bad.status, 400);
  assertErrorEnvelope(bad.json(), "bad_request");
});

test("integration: parseUsageDays mirrors the contract's normalizeDays exactly", () => {
  assert.equal(parseUsageDays(null), 30, "absent means 30");
  assert.equal(parseUsageDays("1"), 1);
  assert.equal(parseUsageDays("365"), 365);
  for (const bad of ["0", "366", "7.5", "abc", "", "-1", "0x10", "1 0", "1e3"]) {
    assert.throws(() => parseUsageDays(bad), RangeError, `days=${JSON.stringify(bad)} must throw`);
  }
  assert.throws(() => parseUsageDays(["7"]), /single query value/);
  assert.throws(() => parseUsageDays(7), RangeError, "a non-string is not a query value");
});

test("integration: rawUsageDays hands the parser the contract's raw shape", () => {
  const params = (query) => new URLSearchParams(query);

  assert.equal(rawUsageDays(params("")), undefined, "absent stays absent");
  assert.equal(rawUsageDays(params("force=1")), undefined, "an unrelated parameter is not a days value");
  assert.equal(rawUsageDays(params("days=7")), "7", "one value arrives as a single string");
  assert.equal(rawUsageDays(params("days=")), "", "an empty value arrives as an empty string, not undefined");
  assert.deepEqual(rawUsageDays(params("days=3&days=4")), ["3", "4"], "a repeat arrives as an array");
  assert.deepEqual(rawUsageDays(params("days=7&days=7")), ["7", "7"], "even a repeat of the same value");

  // The two together are the contract's `normalizeDays`: each raw shape either
  // yields a window or throws, and an array always throws.
  assert.equal(parseUsageDays(rawUsageDays(params("days=7"))), 7);
  assert.equal(parseUsageDays(rawUsageDays(params(""))), 30);
  assert.throws(() => parseUsageDays(rawUsageDays(params("days=3&days=4"))), /single query value/);
  assert.throws(() => parseUsageDays(rawUsageDays(params("days="))), /decimal integer/);
});

/* ------------------------------------------------------------------ *
 * 6. Ledger cache location (captain ruling)
 * ------------------------------------------------------------------ */

test("cache ruling: the default cache directory is external, beside the host's storages", () => {
  assert.equal(
    defaultLedgerCacheDir({ DSH_HOME: join("C:", "DSH") }),
    join("C:", "DSH", "storages", "dsh-deepseek-usage", "ledger-cache"),
  );
  const fromEnv = defaultLedgerCacheDir({ DSH_HOME: join("X:", "home") });
  assert.match(fromEnv, /storages[/\\]dsh-deepseek-usage[/\\]ledger-cache$/);
  for (const env of [{ DSH_HOME: join("X:", "home") }, {}]) {
    const dir = defaultLedgerCacheDir(env);
    assert.equal(
      dir === PACKAGE_ROOT || dir.startsWith(PACKAGE_ROOT.replace(/[/\\]$/, "") + "/") || dir.startsWith(PACKAGE_ROOT + "\\"),
      false,
      `the default must never point inside the plugin package, got ${dir}`,
    );
  }
  assert.equal(defaultLedgerCacheDir({}).includes("plugins"), false, "with no DSH_HOME it still stays out of the package");
});

test("cache ruling: the ledger's OWN default agrees, and survives a plugin installed under DSH_HOME", () => {
  // The tests above exercise `plugin.mjs#defaultLedgerCacheDir`, which is the value the
  // plugin actually injects — so they could not see that `ledger.mjs#defaultCacheDir`
  // (the fallback for a caller that injects nothing) resolved to
  // `<DSH_HOME>/plugins/dsh-deepseek-usage/.ledger-cache`. That path looks external but
  // IS the package whenever the plugin is installed where the shell expects it, so a
  // bare-ledger host wrote its index into the installed tree. Found by inspection on
  // 2026-09-18 (a hand-rolled ledger call created `.ledger-cache` inside the package);
  // this test states the rule so it cannot come back.
  const homes = [join("C:", "DSH"), join("C:", "some", "launcher", "home"), ""];
  for (const home of homes) {
    const env = home === "" ? {} : { DSH_HOME: home };
    const fromPlugin = defaultLedgerCacheDir(env);
    const fromLedger = defaultLedgerCacheDirFromLedgerModule(env);
    assert.equal(fromLedger, fromPlugin, `ledger.mjs and plugin.mjs must agree for DSH_HOME=${home || "(unset)"}`);
    assert.match(fromLedger, /storages[/\\]dsh-deepseek-usage[/\\]ledger-cache$/);
    assert.equal(fromLedger.replace(/\\/g, "/").startsWith(PACKAGE_ROOT.replace(/\\/g, "/")), false, `${fromLedger} must stay out of the package`);
  }
  // The case that was actually broken: the plugin living at <DSH_HOME>/plugins/<name>.
  const installHome = join(PACKAGE_ROOT, "..", "..");
  const resolved = defaultLedgerCacheDirFromLedgerModule({ DSH_HOME: installHome });
  assert.equal(
    resolved.replace(/\\/g, "/").startsWith(PACKAGE_ROOT.replace(/\\/g, "/")),
    false,
    `with the plugin installed under DSH_HOME the cache must still leave the package, got ${resolved}`,
  );
});

test("cache ruling: a cold /usage writes outside the package and re-reads clean", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const host = mountHost({ fixture });

  assert.equal(existsSync(fixture.cacheDir), false, "nothing is written before the first request");
  const first = await host.requestUsage(`${ROUTES.usage}?days=7`);
  assert.equal(first.state.status, 200);
  assert.equal(existsSync(join(fixture.cacheDir, "index.json")), true, "the cold read persisted its index externally");
  assert.equal(existsSync(join(PACKAGE_ROOT, ".ledger-cache")), false, "the plugin package must stay free of cache state");
  assert.equal(readdirSync(PACKAGE_ROOT).includes(".ledger-cache"), false, "no .ledger-cache directory may exist in the package");

  // A second read is served from that external index and reproduces the data.
  // (`generatedAt` moves with the clock, so the data is compared, not the stamp.)
  const second = await host.requestUsage(`${ROUTES.usage}?days=7`);
  assert.deepEqual(second.json().days, first.json().days, "the cached index must reproduce the cold day buckets");
  assertTotalsMatchDays(second.json(), "cached totals");
  assert.equal(second.json().truncated, first.json().truncated);

  // The package manifest is a whitelist and must not name the cache at all.
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  assert.ok(Array.isArray(manifest.files));
  // The publish whitelist, pinned so a stray directory cannot ride along. DEVELOPMENT.md and
  // LICENSE joined it when the package was prepared for public release; the point of the
  // assertion is unchanged — nothing carrying machine-local state may be listed.
  assert.deepEqual(manifest.files, ["lib", "src", "cordis.patch.yml", "README.md", "DEVELOPMENT.md", "LICENSE", "docs"]);
  for (const entry of manifest.files) {
    assert.equal(entry.includes("ledger-cache"), false);
    assert.equal(entry.includes("node_modules"), false, "the machine-local node_modules junction must never be published");
    assert.equal(entry.startsWith("."), false, "no dotfile may be published");
  }
  // And the release itself must not be private: it is installed from a public repo.
  assert.notEqual(manifest.private, true, "a published plugin cannot be private");
  assert.equal(typeof manifest.license, "string", "the published manifest declares a license");
});

test("cache ruling: the plugin's real default cache dir follows this host's DSH_HOME", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const expected = defaultLedgerCacheDir();
  t.after(() => rmSync(expected, { recursive: true, force: true }));

  // No cacheDir override: exercise the actual default the host would use.
  const webServer = makeWebServer();
  const fetchDouble = makeFetch(() => jsonResponse(200, upstreamBody()));
  createHostPlugin({
    fetchImpl: fetchDouble.fetchImpl,
    sessionsRoot: fixture.sessionsRoot,
    // `cacheDir` deliberately omitted → defaultLedgerCacheDir() → host storages.
  }).apply(makeCtx({ webServer, credentials: makeCredentials(SENTINEL) }));

  const response = await callRoute(webServer.route(ROUTES.usage), makeRequest({ url: `${ROUTES.usage}?days=3` }));
  assert.equal(response.state.status, 200);
  assertUsageEnvelope(response.json(), 3);

  assert.equal(expected.startsWith(PACKAGE_ROOT), false, "the default location is the host's, never the package's");
  assert.equal(existsSync(join(expected, "index.json")), true, `the default run must write to ${expected}`);
  assert.equal(existsSync(join(PACKAGE_ROOT, ".ledger-cache")), false);
  assert.equal(defaultSessionsRoot().endsWith("sessions"), true);
});

test("cache ruling: cacheDir: null is an explicit no-disk mode", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const host = mountHost({ fixture, cacheDirOverride: null });

  const first = await host.requestUsage(`${ROUTES.usage}?days=7`);
  assert.equal(first.state.status, 200);
  assert.equal(existsSync(fixture.cacheDir), false, "cacheDir:null must write nothing at all");
  assert.equal(existsSync(join(PACKAGE_ROOT, ".ledger-cache")), false);

  const second = await host.requestUsage(`${ROUTES.usage}?days=7`);
  assert.deepEqual(second.json().days, first.json().days, "no cache still yields the same data");
  assertTotalsMatchDays(second.json(), "uncached totals");
});

/* ------------------------------------------------------------------ *
 * 7. Node degradation (captain ruling) — observable, never a crash
 * ------------------------------------------------------------------ */

test("node ruling: this Node build has Zstandard, so the route serves data", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  const host = mountHost({ fixture });

  assert.equal(typeof zstdDecompressSync, "function", "the suite requires the host's own Node");
  const ledger = aggregateLedgerUsage({ days: 3, sessionsRoot: fixture.sessionsRoot, cacheDir: fixture.cacheDir });
  assert.equal(ledger.ledger.available, true);
  assert.equal(ledger.ledger.unavailableReason, undefined);
  assert.equal((await host.requestUsage(`${ROUTES.usage}?days=3`)).state.status, 200);
});

test("node ruling: a ledger that is unavailable maps to the closed code ledger_unavailable", async (t) => {
  const fixture = makeFixture(t);
  writeFixtureLogs(fixture.sessionsRoot);
  // Stand in for a Node build without `zlib.zstdDecompressSync`: the ledger
  // reports itself unavailable rather than throwing or answering an empty chart.
  const unavailable = async () => ({
    ok: true,
    requestedDays: 3,
    days: [],
    generatedAt: new Date().toISOString(),
    truncated: false,
    totals: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, estimatedCostCny: 0 },
    ledger: { available: false, unavailableReason: "this Node build exposes no node:zlib Zstandard decoder" },
  });
  const host = mountHost({ fixture, aggregateUsage: unavailable });

  const response = await host.requestUsage(`${ROUTES.usage}?days=3`);
  assert.equal(response.state.status, 503, "a local capability gap is 503, never a fake 200");
  const payload = response.json();
  assertErrorEnvelope(payload, "ledger_unavailable");
  assert.match(payload.error.message, /Zstandard/);
  assert.deepEqual(Object.keys(payload).sort(), ["error", "ok"], "only the frozen envelope crosses the wire");
});

test("node ruling: a ledger throwing a secret-bearing failure is a 500 internal envelope", async (t) => {
  const fixture = makeFixture(t);
  const host = mountHost({
    fixture,
    aggregateUsage: async () => {
      throw new Error(`ledger exploded with Bearer ${SENTINEL}`);
    },
  });

  const response = await host.requestUsage(`${ROUTES.usage}?days=3`);
  assert.equal(response.state.status, 500);
  assertErrorEnvelope(response.json(), "internal");
  assert.equal(response.state.body.includes(SENTINEL), false, "the internal envelope leaked the key");
});

test("node ruling: a ledger payload that is not contract-shaped is internal, not served", async (t) => {
  const fixture = makeFixture(t);
  for (const payload of [{ ok: true, days: "not an array" }, undefined, { ok: true, requestedDays: 3, days: [], totals: null }]) {
    const host = mountHost({ fixture, aggregateUsage: async () => payload });
    const response = await host.requestUsage(`${ROUTES.usage}?days=3`);
    assert.equal(response.state.status, 500, `payload ${JSON.stringify(payload)} must not be served as success`);
    assertErrorEnvelope(response.json(), "internal");
  }
});

test("node ruling: on a Node without zstd the module loads and the route answers the frozen envelope", async (t) => {
  const pathNode = whichNodeWithoutZstd();
  if (pathNode === undefined) {
    t.skip("no second Node binary available to prove the degraded path");
    return;
  }

  const pluginUrl = new URL("../src/host/plugin.mjs", import.meta.url).href;
  const routesUrl = new URL("../src/host/routes.mjs", import.meta.url).href;
  const script = `
    import { createHostPlugin } from ${JSON.stringify(pluginUrl)};
    import { ROUTES } from ${JSON.stringify(routesUrl)};
    import * as zlib from "node:zlib";
    const webServer = {
      registered: [],
      register(route) { this.registered.push(route); return () => {}; },
      route(path) { return this.registered.find((r) => r.path === path); },
    };
    const ctx = { get: (k) => (k === "webServer" ? webServer : undefined), effect: (cb) => cb() };
    createHostPlugin({ getApiKey: async () => "sentinel-not-a-real-key" }).apply(ctx);
    const route = webServer.route(ROUTES.usage);
    const response = {
      state: {},
      writeHead(status, headers) { this.state.status = status; this.state.headers = headers; },
      end(body) { this.state.body = body === undefined || body === null ? "" : String(body); },
    };
    await route.handler(
      { method: "GET", url: ROUTES.usage + "?days=3", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" } },
      response,
    );
    const body = JSON.parse(response.state.body);
    process.stdout.write(JSON.stringify({
      zstd: typeof zlib.zstdDecompressSync,
      status: response.state.status,
      ok: body.ok,
      code: body.error && body.error.code,
      keys: Object.keys(body).sort(),
      registered: webServer.registered.map((r) => r.path),
    }));
  `;

  const run = spawnSync(pathNode, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.error, undefined, `spawning ${pathNode} failed: ${run.error?.message}`);
  assert.equal(run.status, 0, `the module must load and answer on a zstd-less Node (stderr: ${run.stderr})`);
  assert.equal(run.stderr.includes("SyntaxError"), false, "the module must not fail to load");

  const observed = JSON.parse(run.stdout);
  assert.equal(observed.zstd, "undefined", "the fallback Node is expected to have no Zstandard decoder");
  assert.equal(observed.status, 503, "a missing local capability is 503 (captain ruling), never a fake 200");
  assert.equal(observed.ok, false);
  assert.equal(observed.code, "ledger_unavailable", "the failure code stays inside the frozen closed set");
  assert.deepEqual(observed.keys, ["error", "ok"], "the degraded answer is still the frozen envelope");
  assert.deepEqual(
    observed.registered,
    [ROUTES.balance, ROUTES.health, ROUTES.usage, HEALTH_ALIAS],
    "all four routes, including the bare /health alias, still register without zstd",
  );
});

/**
 * Locate a second Node binary that is expected to lack Zstandard: the PATH node
 * on this host is fnm's v22.11.0, whose `node:zlib` has no `zstdDecompressSync`.
 * @returns the path, or `undefined` when no usable second binary exists.
 */
function whichNodeWithoutZstd() {
  const candidates = [];
  const configured = process.env.DSH_TEST_NODE_NO_ZSTD;
  if (typeof configured === "string" && configured !== "") candidates.push(configured);
  const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["node"], { encoding: "utf8" });
  if (found.status === 0) {
    for (const line of found.stdout.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate !== "" && candidate !== process.execPath) candidates.push(candidate);
    }
  }
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-e", "process.stdout.write(typeof require('node:zlib').zstdDecompressSync)"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (probe.status === 0 && probe.stdout.trim() === "undefined") return candidate;
  }
  return undefined;
}
