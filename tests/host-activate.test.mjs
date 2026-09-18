/**
 * T14 — host activation smoke: the host half must survive activation inside a
 * REAL cordis context, not just inside hand-built context doubles.
 *
 * Why this file exists. The first live boot of this plugin crashed the whole
 * plugin tree, then the server, then the browser that was waiting for it
 * ("拒绝连接"). Root cause: `serviceOf()` read the service as
 * `ctx.get(key) ?? ctx[key]`. The second half is a *bare property read*, and on
 * a real cordis context that read is inject-gated:
 *
 *   @deepseek-ai/cordis/lib/index.js:672-698 (ReflectService.handler.get)
 *     - own/inherited properties and declared accessors resolve directly,
 *     - everything else walks the fiber ancestry and, when the name is not in
 *       the reading fiber's `inject`, throws
 *       `cannot get property "<name>" without inject` (:675, enhanced at :686).
 *
 * This row declares `inject = []`, and at boot `webServer` is not provisioned
 * yet — exactly the "service not up yet" probe the function exists to answer
 * with `undefined`. `ctx.get()` answers it; `ctx[key]` throws instead.
 *
 * Why the existing host-half suite could not see it. Every test in
 * `tests/host-balance.test.mjs` drives `apply()` with a hand-built context
 * double (`{ get: ..., logger: ... }` or a bare object), and a bare object has
 * no proxy trap: `ctx[key]` is just `undefined`. The bug lives in the shape of
 * a *real* context, so only a real context can catch it. Two further traps that
 * this file avoids on purpose:
 *
 *   1. calling `apply(rootContext)` does NOT reproduce it either — a runtime-less
 *      root fiber takes the `!ctx.fiber.runtime` branch (:679) and degrades to a
 *      non-throwing read. The plugin is therefore always activated through the
 *      real registry (`ctx.plugin(...)`), which is what the DSH loader does.
 *   2. an `internal/get` listener that forgets to call `next()` vetoes the
 *      resolution walk (:317-325) and turns a throw into `undefined` — turning
 *      the tripwire below into the always-green decoration it must not be. The
 *      observer here is a pass-through and is itself exercised by
 *      "the regression tripwire is itself real".
 *
 * Assertions therefore carry two jobs: activate the shipped plugin object inside
 * a real `Context` and prove it emits no un-declared service read while doing
 * so. A re-introduced bare read fails here even when the service happens to be
 * registered at that moment (that read emits `internal/get`), and it fails
 * loudly — not silently — when it is not.
 *
 * Resolution: `@deepseek-ai/cordis` comes from the plugin's own `node_modules`
 * junction into the runtime (`…\runtime\node_modules`). If that runtime is
 * absent the import fails on purpose: a smoke test that cannot reach the real
 * framework must not report green.
 *
 * Run with the host's own Node (the PATH Node may differ):
 *   C:\Users\Administrator\AppData\Local\DSH-Portable\node\node.exe --test tests/host-activate.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import hostPlugin, { createHostPlugin } from "../src/host/plugin.mjs";
import { HEALTH_ALIAS, PLUGIN_NAME, ROUTES } from "../src/host/routes.mjs";

/** The cordis error a bare read of a non-injected service raises. */
const WITHOUT_INJECT = /cannot get property ".*" without inject/;

/** Paths the host half must register, in registration order (alias last). */
const EXPECTED_ROUTE_PATHS = [ROUTES.balance, ROUTES.health, ROUTES.usage, HEALTH_ALIAS];

/**
 * Record every service name resolved through cordis' `internal/get` waterfall.
 *
 * Any entry in the result is a read that went through the inject gate — i.e. a
 * bare `ctx.<name>` access rather than `ctx.get(name)`/`ctx.inject(...)`. The
 * gate is reached for declared and undeclared names alike when the read is a
 * bare property access, which is why callers filter against the plugin's
 * `inject` before judging the trace.
 *
 * @param ctx - a real cordis context.
 * @returns the live list of observed property names.
 */
function observeServiceReads(ctx) {
  const seen = [];
  // The listener must forward to `next()`: `waterfall()` returns the outermost
  // listener's return value, so a listener that returns without calling `next()`
  // vetoes the built-in walk and the read yields that value instead of throwing.
  // Such a listener would both hide the crash and disarm this observer's
  // negative control (see "the regression tripwire is itself real").
  ctx.on("internal/get", (_subject, prop, _error, next) => {
    seen.push(String(prop));
    return next();
  });
  return seen;
}

/**
 * Service names a plugin declares in `inject`, in cordis' two accepted shapes.
 *
 * @param plugin - cordis plugin object.
 * @returns the declared names.
 */
function declaredServices(plugin) {
  const inject = plugin?.inject;
  if (inject === undefined || inject === null) return new Set();
  return new Set(Array.isArray(inject) ? inject : Object.keys(inject));
}

/**
 * Activate a plugin through the real cordis registry, exactly like the loader.
 *
 * `ctx.plugin()` records an `apply()` throw on the fiber and rethrows it from
 * the awaited fiber (`Fiber._reload` → `await()`), which is the path that made
 * the whole plugin tree fail at boot.
 *
 * @param ctx - real cordis context.
 * @param plugin - cordis plugin object.
 * @returns the settled fiber (state 2 = loaded and active).
 */
async function activate(ctx, plugin) {
  const fiber = ctx.plugin(plugin);
  await fiber;
  return fiber;
}

/**
 * Assert two path lists hold the same paths, order-insensitively.
 *
 * Order is deliberately not asserted: neither the plugin's route list nor
 * cordis' disposal order is a contract. Registration follows the list it is
 * given, and disposers run in reverse creation order (`effect()`,
 * lib/index.js:1174-1183). What the plugin does promise is that all four paths
 * are registered by its fiber — and withdrawn by that same fiber, which is what
 * keeps a host reload from colliding on a duplicate route.
 *
 * @param actual - observed paths.
 * @param expected - expected paths.
 * @param message - assertion message.
 */
function assertSamePaths(actual, expected, message) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);
}

/**
 * Wait for a condition with a short poll; used where cordis finishes wiring on
 * a later microtask/tick (the `ctx.inject(["webServer"], …)` path).
 *
 * @param predicate - condition to satisfy.
 * @param label - failure label.
 */
async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

/**
 * A web-server stand-in provided as the real `webServer` service. `register`
 * returns a disposer, because cordis validates every effect body's return value
 * (`_execute`, lib/index.js:1134-1166) and `WebServer.register` is documented to
 * return one.
 *
 * @returns `{ routes, unregistered, plugin }`.
 */
function makeWebServerStub() {
  const routes = [];
  const unregistered = [];
  const plugin = {
    name: "web-server-stub",
    inject: [],
    apply(ctx) {
      ctx.provide("webServer", {
        register(route) {
          routes.push(route.path);
          return () => {
            unregistered.push(route.path);
          };
        },
      });
    },
  };
  return { routes, unregistered, plugin };
}

test("activate: the shipped plugin face still matches what the loader mounts", () => {
  assert.equal(hostPlugin.name, PLUGIN_NAME);
  assert.equal(typeof hostPlugin.apply, "function");
  // The incident's precondition: this row declares no injected service, so any
  // bare `ctx.<service>` read on its activation path is inject-gated.
  assert.ok(Array.isArray(hostPlugin.inject), "inject must be an array");
  assert.deepEqual([...hostPlugin.inject], []);
  assert.notEqual(createHostPlugin(), hostPlugin, "createHostPlugin() must build a fresh face");
  // cordis accepts `inject` as an array or as a name → config map; the observer's
  // filter must read both shapes, or a declared read would be flagged and — worse
  // — an undeclared one could slip through.
  assert.deepEqual([...declaredServices({ inject: { webServer: null } })], ["webServer"]);
  assert.deepEqual([...declaredServices({ inject: ["a", "b"] })], ["a", "b"]);
  assert.deepEqual([...declaredServices({})], []);
});

test("activate: the host half activates inside a real Context with no services provided", async () => {
  const ctx = new Context();
  assert.equal(Context.is(ctx), true, "the fixture must be a real cordis context");

  const reads = observeServiceReads(ctx);
  const fiber = await activate(ctx, hostPlugin);

  assert.equal(fiber.state, 2, "the fiber must settle loaded/active (2), not error (3) or disposed (4)");
  const declared = declaredServices(hostPlugin);
  assert.deepEqual(
    reads.filter((name) => !declared.has(name)),
    [],
    "activation read a service by bare property access; use ctx.get(name) (or declare it in inject) — " +
      "on a real context a bare read of an undeclared service throws and takes the plugin tree down",
  );
});

test("activate: the regression tripwire is itself real (a bare read throws, ctx.get does not)", async () => {
  // Negative control #1 — the false-green trap this file must avoid: a
  // runtime-less root fiber degrades bare reads to `undefined` (:679), so
  // `apply(rootContext)` would never have reproduced the incident.
  const root = new Context();
  assert.equal(root.webServer, undefined, "a runtime-less root read must not throw (it is why root-level tests lie)");
  assert.equal(typeof root.get, "function", "real contexts always expose ctx.get — the fix's whole premise");

  // Negative control #2 — inside a plugin fiber with `inject: []`, the same read
  // throws and `ctx.get` answers undefined. This is the incident, reproduced.
  const ctx = new Context();
  const observed = [];
  await activate(ctx, {
    name: "bare-read-probe",
    inject: [],
    apply(c) {
      assert.equal(c.get("webServer"), undefined, "ctx.get must answer undefined while webServer is absent");
      assert.throws(() => c.webServer, WITHOUT_INJECT);
      observed.push(typeof c.get);
      assert.equal(typeof c.inject, "function");
    },
  });
  assert.deepEqual(observed, ["function"]);

  // Negative control #3 — the pre-fix formulation must fail right here. This is
  // the in-suite half of the fault-injection proof; the manual half (reverting
  // src/host/plugin.mjs) is recorded in the task's completion output.
  const regressed = new Context();
  const fiber = regressed.plugin({
    name: "regressed-service-probe",
    inject: [],
    apply(c) {
      // The exact shape that crashed: `ctx.get(key) ?? ctx[key]`.
      return c.get("webServer") ?? c.webServer;
    },
  });
  await assert.rejects(async () => fiber, WITHOUT_INJECT);

  // Negative control #4 — the shape that does NOT throw, and the reason the
  // observer above is not decoration. `provide()` fills the global store, but
  // the inject gate walks *fiber* stores: a bare read still throws for a plain
  // child of the root (control #2), yet resolves as soon as an ancestor fiber
  // declares the inject (`_checkImpl` fills that fiber's store, :684-685). A
  // naive `if (ctx.webServer) mount(ctx)` gate would therefore look correct in
  // one boot order and break in another — the host's row context sits under
  // ancestors that do declare injects, so this is the realistic shape. Only an
  // `internal/get` trace can see such a read, so the trace must record it.
  const provided = new Context();
  await activate(provided, makeWebServerStub().plugin);
  const resolvingReads = observeServiceReads(provided);
  const resolved = [];
  await activate(provided, {
    name: "injecting-parent-probe",
    inject: ["webServer"],
    apply(c) {
      c.plugin({
        name: "resolving-bare-read-probe",
        inject: [],
        apply(inner) {
          resolved.push(inner.webServer === undefined ? "undefined" : "resolved");
        },
      });
    },
  });
  await waitFor(() => resolved.length === 1, "the child's bare read to run");
  assert.deepEqual(resolved, ["resolved"], "a bare read resolves once an ancestor fiber declares the inject");
  assert.ok(
    resolvingReads.includes("webServer"),
    "the observer must flag a bare service read that resolves instead of throwing",
  );
});

test("activate: built-in context members are not inject-gated service reads", async () => {
  // src/host reads `ctx.logger` (plugin.mjs) and `ctx.inject` (withWebServer) as
  // plain properties. Both are built-in context members — `logger` is an own
  // property of the root Context installed by cordis' constructor, and
  // `inject`/`effect`/`get` are ReflectService mixin accessors — so the trap
  // resolves them before the inject gate. This test pins that property: if a
  // future cordis moves any of them behind a service, activation would start
  // throwing and this file must say so before a user's boot does.
  const ctx = new Context();
  const reads = observeServiceReads(ctx);
  const results = [];
  await activate(ctx, {
    name: "infra-read-probe",
    inject: [],
    apply(c) {
      for (const key of ["logger", "inject", "effect", "get", "fiber", "reflect", "registry", "events", "root"]) {
        assert.notEqual(c[key], undefined, `built-in context member ${key} must resolve`);
      }
      results.push(
        typeof c.logger?.warn,
        typeof c.inject,
        typeof c.effect,
      );
    },
  });
  assert.deepEqual(results, ["function", "function", "function"]);
  assert.deepEqual(reads, [], "built-in members must not travel through internal/get");
});

test("activate: with webServer already provided, the four routes register on the plugin fiber", async () => {
  const ctx = new Context();
  const { routes, unregistered, plugin: stub } = makeWebServerStub();
  await activate(ctx, stub);

  const reads = observeServiceReads(ctx);
  const fiber = await activate(ctx, hostPlugin);

  assert.equal(fiber.state, 2);
  assertSamePaths(routes, EXPECTED_ROUTE_PATHS, "all four paths must be registered while webServer is present");
  // Second net, not the primary one: in this fixture the plugin's fiber is a
  // plain child of the root, where a bare read throws outright (test 1/control
  // #2). The trace matters for the real host, whose row context sits under
  // ancestors that declare injects — there a bare read would resolve silently.
  assert.deepEqual(
    reads.filter((name) => !declaredServices(hostPlugin).has(name)),
    [],
    "the route-registration path must not read services by bare property access either",
  );

  // Route ownership: registration goes through `webCtx.effect`, so the fiber
  // that registered them also withdraws them (this is what makes a host reload
  // safe rather than a duplicate-route boot failure).
  await fiber.dispose();
  assertSamePaths(unregistered, EXPECTED_ROUTE_PATHS, "disposing the fiber must withdraw every route it added");
});

test("activate: with webServer arriving later, the ctx.inject fallback registers the same routes", async () => {
  const ctx = new Context();
  const { routes, plugin: stub } = makeWebServerStub();
  const fiber = await activate(ctx, hostPlugin);
  assert.equal(fiber.state, 2, "the row must load inert rather than fail when no web server exists yet");
  assert.deepEqual(routes, [], "no routes before a web server exists");

  await activate(ctx, stub);
  await waitFor(() => routes.length === EXPECTED_ROUTE_PATHS.length, "the deferred route registration");
  assertSamePaths(routes, EXPECTED_ROUTE_PATHS, "the deferred path must register the same four routes");
});
