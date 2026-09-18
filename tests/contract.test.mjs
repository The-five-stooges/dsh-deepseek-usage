/**
 * Frozen HTTP contract for dsh-deepseek-usage.
 *
 * This file is the SINGLE SOURCE OF TRUTH for the two endpoints the host half
 * (T2/T3, `src/host/*`) serves and the browser half (T4/T5, `src/client/*`)
 * consumes. Changing a response shape, a metric key, or the chart projection
 * means changing THIS FILE in the same change — never only the producer or only
 * the consumer.
 *
 * Endpoints
 *   GET /api/dsh-deepseek-usage/balance[?force=1]
 *   GET /api/dsh-deepseek-usage/usage?days=N
 *
 * Naming decision (recorded because the task statement uses `days` twice):
 * the response's `days` field is the ARRAY of day buckets — the detailed
 * spelling, and the one the chart/table consumers read. The echoed request
 * window is `requestedDays` (number). Producers must emit `days` as an array;
 * `days` is never a number.
 *
 * HTTP STATUS RULING (captain's decision, plan §6.6 — read this before writing
 * a producer or a consumer):
 *
 *   【队长裁决·以真实状态码为准】成功 200 + `{ok:true}`；错误一律返回
 *   **真实 HTTP 状态码** + `{ok:false,error:{code,message}}`：
 *     非法 `?days=`            → 400 `bad_request`
 *     未配置 key               → 503 `no_api_key`
 *     上游非 2xx（含 429）     → 502 `unauthorized` / `rate_limited` / `upstream_error`
 *     网络失败                 → 502 `network_error`
 *     响应体不可用             → 502 `bad_response`
 *     超时                     → 504 `timeout`
 *     台账不可用               → 503 `ledger_unavailable`
 *     内部错误                 → 500 `internal`
 *   客户端**必须先看 HTTP 状态、再解析 body 取闭集错误码**，不得依赖 `res.ok`
 *   单独判断（失败不是 200，`res.ok` 也就不能作为「有没有数据」的唯一依据）。
 *   围栏 403 / 方法 405 在信封之外，不属于本表。
 *
 *   ⚠️ T7 验收提示：**未配置 key 导致 `/balance` 返回 503 是合规的降级态**，
 *   不得据此判 A 项失败；活体检查按下面的 {@link assertLiveEnvelope} 判定。
 *
 * 闭集错误码共 10 个：no_api_key / unauthorized / rate_limited / timeout /
 * network_error / upstream_error / bad_response / bad_request / ledger_unavailable /
 * internal。本文件外的实现常量应与它一致（`src/host/balance.mjs`
 * `BALANCE_ERROR_CODES` / `ERROR_STATUS`）。
 *
 * 文档编号：本文件与 `docs/load-path.md` 沿用**计划文档**的阶段编号 T1–T9；
 * **团队任务表**用 t1–t12。对照：T1≈t1、T2≈t2、T3≈t3、T4≈t4/t11、T5≈t5、T6≈t6、T7≈t7。
 *
 * Run: node --test tests/contract.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

// The implementation's own closed set and status table. Importing them is
// deliberate: the contract is canonical, so the producer must MATCH it — a
// drift (a code added to one side only, which once made `balanceFailure` throw
// for `ledger_unavailable` at request time) now fails this file loudly.
import {
  BALANCE_ERROR_CODES,
  ERROR_STATUS as HOST_ERROR_STATUS,
  balanceFailure,
} from "../src/host/balance.mjs";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Route family base (loopback-trusted, host-side only; never carries the API key). */
const ROUTE_BASE = "/api/dsh-deepseek-usage";

/** Error codes the client may render. Anything else is a contract violation. */
const ERROR_CODES = Object.freeze([
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
  // local reader/handler failure (the catch-all, never a silent 200)
  "internal",
]);

/**
 * HTTP status per error code — the ruling above as data, so a producer, the
 * live check, and T7 all read the same table. `README.md` mirrors this table.
 */
const ERROR_STATUS = Object.freeze({
  bad_request: 400,
  no_api_key: 503,
  unauthorized: 502,
  rate_limited: 502,
  upstream_error: 502,
  network_error: 502,
  bad_response: 502,
  timeout: 504,
  ledger_unavailable: 503,
  internal: 500,
});

/**
 * The ruled HTTP status for one error code.
 * @param code - a code from {@link ERROR_CODES}.
 * @returns the status; an unknown code degrades to 500 (never 200).
 */
function statusForErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_STATUS, code) ? ERROR_STATUS[code] : 500;
}

/** Window accepted by `?days=N`: integer within [1, 365]; absent means 30. */
const DAYS_DEFAULT = 30;
const DAYS_MIN = 1;
const DAYS_MAX = 365;

/** Metrics the chart can plot from one day bucket. */
const CHART_METRICS = Object.freeze([
  "totalTokens",
  "inputTokens",
  "cacheReadTokens",
  "outputTokens",
  "estimatedCostCny",
]);

/* ------------------------------------------------------------------ *
 * Shape assertions (the contract itself)
 * ------------------------------------------------------------------ */

/** ISO-8601 UTC instant, e.g. 2026-09-17T16:05:51.000Z. */
function assertIsoInstant(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(
    value,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    `${label} must be an ISO-8601 UTC instant`,
  );
}

/** Calendar day, e.g. 2026-09-17. */
function assertIsoDate(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/, `${label} must be a YYYY-MM-DD calendar day`);
}

/** Non-negative finite number. */
function assertCount(value, label) {
  assert.equal(typeof value, "number", `${label} must be a number`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  assert.ok(value >= 0, `${label} must be >= 0`);
}

/**
 * Assert the `/balance` success payload.
 * Numbers, not the official API's decimal strings: the host half parses
 * `balance_infos[0].{total,granted,topped_up}_balance` before responding.
 * @param payload - decoded JSON body.
 */
function assertBalancePayload(payload) {
  assert.equal(typeof payload, "object", "balance payload must be an object");
  assert.notEqual(payload, null, "balance payload must not be null");
  assert.equal(payload.ok, true, "balance payload.ok must be true on success");
  assert.equal(typeof payload.currency, "string", "balance payload.currency must be a string");
  assert.match(payload.currency, /^[A-Z]{3}$/, "balance payload.currency must be a 3-letter code");
  assertCount(payload.totalBalance, "balance payload.totalBalance");
  assertCount(payload.grantedBalance, "balance payload.grantedBalance");
  assertCount(payload.toppedUpBalance, "balance payload.toppedUpBalance");
  assert.equal(typeof payload.isAvailable, "boolean", "balance payload.isAvailable must be a boolean");
  assertIsoInstant(payload.fetchedAt, "balance payload.fetchedAt");
  assert.equal(typeof payload.cached, "boolean", "balance payload.cached must be a boolean");
  return true;
}

/**
 * Assert the `/usage` success payload.
 * @param payload - decoded JSON body.
 */
function assertUsagePayload(payload) {
  assert.equal(typeof payload, "object", "usage payload must be an object");
  assert.notEqual(payload, null, "usage payload must not be null");
  assert.equal(payload.ok, true, "usage payload.ok must be true on success");
  assert.equal(typeof payload.requestedDays, "number", "usage payload.requestedDays must be a number");
  assert.ok(Number.isInteger(payload.requestedDays), "usage payload.requestedDays must be an integer");
  assert.ok(
    payload.requestedDays >= DAYS_MIN && payload.requestedDays <= DAYS_MAX,
    `usage payload.requestedDays must be within [${DAYS_MIN}, ${DAYS_MAX}]`,
  );
  assertIsoInstant(payload.generatedAt, "usage payload.generatedAt");
  assert.equal(typeof payload.truncated, "boolean", "usage payload.truncated must be a boolean");
  assert.ok(Array.isArray(payload.days), "usage payload.days must be an array of day buckets");
  assert.equal(
    payload.days.length,
    payload.requestedDays,
    "usage payload.days must contain exactly one bucket per requested day (zero-filled, no gaps)",
  );

  let previousDate;
  for (const [index, day] of payload.days.entries()) {
    const label = `usage payload.days[${index}]`;
    assert.equal(typeof day, "object", `${label} must be an object`);
    assert.notEqual(day, null, `${label} must not be null`);
    assertIsoDate(day.date, `${label}.date`);
    if (previousDate !== undefined) {
      assert.ok(day.date > previousDate, `${label}.date must ascend (${previousDate} -> ${day.date})`);
    }
    previousDate = day.date;
    assert.ok(Array.isArray(day.models), `${label}.models must be an array`);

    for (const [modelIndex, model] of day.models.entries()) {
      const modelLabel = `${label}.models[${modelIndex}]`;
      assert.equal(typeof model, "object", `${modelLabel} must be an object`);
      assert.notEqual(model, null, `${modelLabel} must not be null`);
      assert.equal(typeof model.model, "string", `${modelLabel}.model must be a string`);
      assert.ok(model.model.length > 0, `${modelLabel}.model must not be empty`);
      assertCount(model.inputTokens, `${modelLabel}.inputTokens`);
      assertCount(model.cacheReadTokens, `${modelLabel}.cacheReadTokens`);
      assertCount(model.outputTokens, `${modelLabel}.outputTokens`);
      assertCount(model.estimatedCostCny, `${modelLabel}.estimatedCostCny`);
    }
  }

  const totals = payload.totals;
  assert.equal(typeof totals, "object", "usage payload.totals must be an object");
  assert.notEqual(totals, null, "usage payload.totals must not be null");
  assertCount(totals.inputTokens, "usage payload.totals.inputTokens");
  assertCount(totals.cacheReadTokens, "usage payload.totals.cacheReadTokens");
  assertCount(totals.outputTokens, "usage payload.totals.outputTokens");
  assertCount(totals.estimatedCostCny, "usage payload.totals.estimatedCostCny");

  const summed = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, estimatedCostCny: 0 };
  for (const day of payload.days) {
    for (const model of day.models) {
      summed.inputTokens += model.inputTokens;
      summed.cacheReadTokens += model.cacheReadTokens;
      summed.outputTokens += model.outputTokens;
      summed.estimatedCostCny += model.estimatedCostCny;
    }
  }
  assert.equal(totals.inputTokens, summed.inputTokens, "totals.inputTokens must equal the day/model sum");
  assert.equal(totals.cacheReadTokens, summed.cacheReadTokens, "totals.cacheReadTokens must equal the day/model sum");
  assert.equal(totals.outputTokens, summed.outputTokens, "totals.outputTokens must equal the day/model sum");
  assert.ok(
    Math.abs(totals.estimatedCostCny - summed.estimatedCostCny) < 1e-6,
    "totals.estimatedCostCny must equal the day/model sum",
  );
  return true;
}

/**
 * Assert the `{ ok: false, error }` failure payload shared by both endpoints.
 * @param payload - decoded JSON body.
 */
function assertErrorPayload(payload) {
  assert.equal(typeof payload, "object", "error payload must be an object");
  assert.notEqual(payload, null, "error payload must not be null");
  assert.equal(payload.ok, false, "error payload.ok must be false");
  assert.equal(typeof payload.error, "object", "error payload.error must be an object");
  assert.notEqual(payload.error, null, "error payload.error must not be null");
  assert.ok(ERROR_CODES.includes(payload.error.code), `error payload.error.code must be one of ${ERROR_CODES.join(", ")}`);
  assert.equal(typeof payload.error.message, "string", "error payload.error.message must be a string");
  assert.ok(payload.error.message.length > 0, "error payload.error.message must not be empty");
  assert.ok(
    !/sk-[A-Za-z0-9]/.test(JSON.stringify(payload)),
    "no API key material may appear in a response body",
  );
  return true;
}

/**
 * Project one usage payload onto chart points: exactly one `{ label, value }`
 * per day, ascending, numeric. This is the shape the popover's SVG chart
 * consumes (T5) and the shape this contract test freezes.
 * @param payload - a payload accepted by {@link assertUsagePayload}.
 * @param metric - one of {@link CHART_METRICS}.
 * @returns `{ label, value }[]`, one entry per day bucket.
 */
function chartPoints(payload, metric) {
  assert.ok(CHART_METRICS.includes(metric), `chart metric must be one of ${CHART_METRICS.join(", ")}`);
  return payload.days.map((day) => {
    let value;
    switch (metric) {
      case "totalTokens":
        value = day.models.reduce(
          (sum, model) => sum + model.inputTokens + model.cacheReadTokens + model.outputTokens,
          0,
        );
        break;
      case "estimatedCostCny":
        value = day.models.reduce((sum, model) => sum + model.estimatedCostCny, 0);
        break;
      default:
        value = day.models.reduce((sum, model) => sum + model[metric], 0);
        break;
    }
    return { label: day.date, value };
  });
}

/**
 * Assert the chart-ready point list: one point per day, ascending labels,
 * numeric non-negative values.
 * @param points - output of {@link chartPoints}.
 * @param expectedCount - number of day buckets in the payload.
 */
function assertChartPoints(points, expectedCount) {
  assert.ok(Array.isArray(points), "chart points must be an array");
  assert.equal(points.length, expectedCount, "chart points must be exactly one per day");
  let previous;
  for (const [index, point] of points.entries()) {
    assert.equal(typeof point, "object", `chart point[${index}] must be an object`);
    assert.notEqual(point, null, `chart point[${index}] must not be null`);
    assert.deepEqual(Object.keys(point).sort(), ["label", "value"], `chart point[${index}] must be exactly { label, value }`);
    assertIsoDate(point.label, `chart point[${index}].label`);
    assertCount(point.value, `chart point[${index}].value`);
    if (previous !== undefined) assert.ok(point.label > previous, "chart point labels must ascend");
    previous = point.label;
  }
  return true;
}

/**
 * Normalize the `?days=N` query value. Producers turn a throw into
 * `400 { ok: false, error: { code: "bad_request" } }`.
 * @param raw - raw query value (`undefined` when absent, `string[]` when repeated).
 * @returns the effective window.
 */
function normalizeDays(raw) {
  if (raw === undefined) return DAYS_DEFAULT;
  assert.equal(typeof raw, "string", "days must be a single query value");
  assert.match(raw, /^\d+$/, "days must be a decimal integer");
  const value = Number(raw);
  assert.ok(value >= DAYS_MIN && value <= DAYS_MAX, `days must be within [${DAYS_MIN}, ${DAYS_MAX}]`);
  return value;
}

/* ------------------------------------------------------------------ *
 * Frozen sample payloads (the shapes T2/T3 must produce)
 * ------------------------------------------------------------------ */

const BALANCE_SAMPLE = {
  ok: true,
  currency: "CNY",
  totalBalance: 12.02,
  grantedBalance: 0,
  toppedUpBalance: 12.02,
  isAvailable: true,
  fetchedAt: "2026-09-17T16:05:51.000Z",
  cached: false,
};

const USAGE_SAMPLE = {
  ok: true,
  requestedDays: 3,
  generatedAt: "2026-09-17T16:05:51.000Z",
  truncated: false,
  days: [
    { date: "2026-09-15", models: [] },
    {
      date: "2026-09-16",
      models: [
        { model: "deepseek-flash", inputTokens: 1200, cacheReadTokens: 4800, outputTokens: 640, estimatedCostCny: 0.000976 },
        { model: "deepseek-v4-pro", inputTokens: 300, cacheReadTokens: 900, outputTokens: 220, estimatedCostCny: 0.001567 },
      ],
    },
    {
      date: "2026-09-17",
      models: [{ model: "deepseek-flash", inputTokens: 250, cacheReadTokens: 1500, outputTokens: 130, estimatedCostCny: 0.000213 }],
    },
  ],
  totals: {
    inputTokens: 1750,
    cacheReadTokens: 7200,
    outputTokens: 990,
    estimatedCostCny: 0.002756,
  },
};

const ERROR_SAMPLE = {
  ok: false,
  error: { code: "no_api_key", message: "DEEPSEEK_API_KEY is not configured for this host" },
};

/** Deep clone so a negative test cannot corrupt another test's fixture. */
const clone = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test("contract: route base and query surface", () => {
  assert.equal(ROUTE_BASE, "/api/dsh-deepseek-usage");
  assert.equal(normalizeDays(undefined), DAYS_DEFAULT);
  assert.equal(normalizeDays("7"), 7);
  assert.throws(() => normalizeDays("0"), /within \[1, 365\]/);
  assert.throws(() => normalizeDays("366"), /within \[1, 365\]/);
  assert.throws(() => normalizeDays("7.5"), /decimal integer/);
  assert.throws(() => normalizeDays("abc"), /decimal integer/);
  assert.throws(() => normalizeDays(["-1"]), /single query value/);
  assert.throws(() => normalizeDays(""), /decimal integer/);
});

test("contract: /balance success payload shape", () => {
  assert.equal(assertBalancePayload(BALANCE_SAMPLE), true);
});

test("contract: /balance rejects drift", () => {
  const missingCurrency = clone(BALANCE_SAMPLE);
  delete missingCurrency.currency;
  assert.throws(() => assertBalancePayload(missingCurrency), /currency/);

  const stringBalance = clone(BALANCE_SAMPLE);
  stringBalance.totalBalance = "12.02";
  assert.throws(() => assertBalancePayload(stringBalance), /totalBalance must be a number/);

  const cachedString = clone(BALANCE_SAMPLE);
  cachedString.cached = "false";
  assert.throws(() => assertBalancePayload(cachedString), /cached must be a boolean/);

  const badInstant = clone(BALANCE_SAMPLE);
  badInstant.fetchedAt = "2026-09-17 16:05:51";
  assert.throws(() => assertBalancePayload(badInstant), /ISO-8601/);

  const droppedOk = clone(BALANCE_SAMPLE);
  delete droppedOk.ok;
  assert.throws(() => assertBalancePayload(droppedOk), /ok must be true/);
});

test("contract: /usage success payload shape and zero-filled window", () => {
  assert.equal(assertUsagePayload(USAGE_SAMPLE), true);
  assert.equal(USAGE_SAMPLE.days.length, USAGE_SAMPLE.requestedDays);
});

test("contract: /usage rejects drift", () => {
  const daysAsNumber = clone(USAGE_SAMPLE);
  daysAsNumber.days = 3;
  assert.throws(() => assertUsagePayload(daysAsNumber), /days must be an array/);

  const gappedWindow = clone(USAGE_SAMPLE);
  gappedWindow.days = gappedWindow.days.slice(0, 2);
  assert.throws(() => assertUsagePayload(gappedWindow), /exactly one bucket per requested day/);

  const descending = clone(USAGE_SAMPLE);
  descending.days.reverse();
  assert.throws(() => assertUsagePayload(descending), /ascend/);

  const missingTokens = clone(USAGE_SAMPLE);
  delete missingTokens.days[1].models[0].cacheReadTokens;
  assert.throws(() => assertUsagePayload(missingTokens), /cacheReadTokens must be a number/);

  const badModelCost = clone(USAGE_SAMPLE);
  badModelCost.days[1].models[1].estimatedCostCny = -1;
  assert.throws(() => assertUsagePayload(badModelCost), /estimatedCostCny must be >= 0/);

  const mismatchedTotals = clone(USAGE_SAMPLE);
  mismatchedTotals.totals.outputTokens = 1;
  assert.throws(() => assertUsagePayload(mismatchedTotals), /totals.outputTokens must equal/);

  const missingTruncated = clone(USAGE_SAMPLE);
  delete missingTruncated.truncated;
  assert.throws(() => assertUsagePayload(missingTruncated), /truncated must be a boolean/);
});

test("contract: chart points are one { label, value } per day", () => {
  const points = chartPoints(USAGE_SAMPLE, "totalTokens");
  assert.equal(assertChartPoints(points, USAGE_SAMPLE.requestedDays), true);
  assert.deepEqual(points, [
    { label: "2026-09-15", value: 0 },
    { label: "2026-09-16", value: 8060 },
    { label: "2026-09-17", value: 1880 },
  ]);
});

test("contract: every chart metric projects over the same day axis", () => {
  for (const metric of CHART_METRICS) {
    const points = chartPoints(USAGE_SAMPLE, metric);
    assertChartPoints(points, USAGE_SAMPLE.requestedDays);
    assert.deepEqual(
      points.map((point) => point.label),
      USAGE_SAMPLE.days.map((day) => day.date),
      `metric ${metric} must stay aligned with the day buckets`,
    );
  }
  assert.deepEqual(chartPoints(USAGE_SAMPLE, "estimatedCostCny").map((point) => point.value), [
    0,
    0.002543,
    0.000213,
  ]);
  assert.throws(() => chartPoints(USAGE_SAMPLE, "promptTokens"), /chart metric must be one of/);
});

test("contract: error payload shape and closed error-code set", () => {
  assert.equal(assertErrorPayload(ERROR_SAMPLE), true);
  assert.equal(ERROR_CODES.length, 10, "the closed code set is explicit: 9 endpoint codes + internal");
  assert.ok(ERROR_CODES.includes("internal"), "the catch-all code is part of the frozen set");
  for (const code of ERROR_CODES) {
    const payload = clone(ERROR_SAMPLE);
    payload.error.code = code;
    assert.equal(assertErrorPayload(payload), true);
  }
  const unknownCode = clone(ERROR_SAMPLE);
  unknownCode.error.code = "boom";
  assert.throws(() => assertErrorPayload(unknownCode), /error.code must be one of/);

  const keyLeak = clone(ERROR_SAMPLE);
  keyLeak.error.message = "upstream said sk-1234567890 is invalid";
  assert.throws(() => assertErrorPayload(keyLeak), /no API key material/);
});

test("contract: usage response carries no API key material", () => {
  assert.ok(!/sk-[A-Za-z0-9]/.test(JSON.stringify(USAGE_SAMPLE)));
  assert.ok(assertUsagePayload(clone(USAGE_SAMPLE)));
});

/**
 * Judge one live response against the status ruling: `200` must carry the
 * `ok:true` envelope; every other status must carry the `ok:false` envelope
 * whose code maps back to exactly that status.
 *
 * A degraded answer is a PASS here — an unconfigured key (`503 no_api_key`) or
 * an unreadable ledger (`503 ledger_unavailable`) is a legitimate contract
 * answer, not a broken deployment. Only a *silent* failure (a non-200 status
 * with `ok:true`, or a 200 with `ok:false`) is a violation.
 *
 * @param response - fetch Response (or a `{ status, json() }` stand-in).
 * @param label - diagnostic prefix.
 * @param validateSuccess - assertion run against an `ok:true` body.
 * @returns `{ degraded, body }`.
 */
async function assertLiveEnvelope(response, label, validateSuccess) {
  const status = response.status;
  const body = await response.json();
  if (status === 200) {
    assert.equal(body.ok, true, `${label}: HTTP 200 must carry an ok:true envelope, not a silent failure`);
    validateSuccess(body);
    return { degraded: false, body };
  }
  assert.equal(body.ok, false, `${label}: HTTP ${status} must carry an ok:false envelope`);
  assertErrorPayload(body);
  assert.equal(
    status,
    statusForErrorCode(body.error.code),
    `${label}: code ${body.error.code} must answer HTTP ${statusForErrorCode(body.error.code)}, got ${status}`,
  );
  return { degraded: true, body };
}

test("contract: implementation and frozen contract agree on codes and statuses", () => {
  assert.deepEqual(
    [...BALANCE_ERROR_CODES].sort(),
    [...ERROR_CODES].sort(),
    "src/host/balance.mjs BALANCE_ERROR_CODES drifted from the frozen closed set",
  );
  assert.deepEqual({ ...HOST_ERROR_STATUS }, { ...ERROR_STATUS }, "the host status table drifted from the ruling");
  assert.equal(Object.keys(HOST_ERROR_STATUS).length, ERROR_CODES.length, "every closed code needs exactly one ruled status");

  for (const code of ["internal", "ledger_unavailable"]) {
    assert.ok(ERROR_CODES.includes(code), `${code} must be part of the frozen closed set`);
    const envelope = balanceFailure(code, `${code} demo`);
    assert.equal(envelope.ok, false, `${code} must build an envelope instead of throwing out of the guard`);
    assert.deepEqual(envelope.error, { code, message: `${code} demo` });
  }
  assert.equal(statusForErrorCode("internal"), 500);
  assert.equal(statusForErrorCode("ledger_unavailable"), 503, "an unreadable local ledger is Service Unavailable, not a bad upstream");
  assert.equal(statusForErrorCode("bad_request"), 400);
});

test("contract: the live check accepts real status codes and rejects a silent 200", async () => {
  const fake = (status, body) => ({ status, async json() { return body; } });
  const errorBody = (code) => ({ ok: false, error: { code, message: `${code} case` } });

  const okCase = await assertLiveEnvelope(fake(200, BALANCE_SAMPLE), "fake 200", assertBalancePayload);
  assert.equal(okCase.degraded, false);
  assert.equal(okCase.body.totalBalance, 12.02);

  const degraded = await assertLiveEnvelope(fake(503, errorBody("no_api_key")), "fake 503", assertBalancePayload);
  assert.equal(degraded.degraded, true, "a keyless host must pass as a degraded answer, not fail A2");
  assert.equal(degraded.body.error.code, "no_api_key");

  await assert.rejects(
    () => assertLiveEnvelope(fake(200, ERROR_SAMPLE), "silent 200", assertBalancePayload),
    /HTTP 200 must carry an ok:true envelope/,
  );
  await assert.rejects(
    () => assertLiveEnvelope(fake(503, BALANCE_SAMPLE), "wrong pair", assertBalancePayload),
    /HTTP 503 must carry an ok:false envelope/,
  );
  await assert.rejects(
    () => assertLiveEnvelope(fake(500, errorBody("no_api_key")), "status/code mismatch", assertBalancePayload),
    /must answer HTTP 503, got 500/,
  );
  await assert.rejects(
    () => assertLiveEnvelope(fake(502, errorBody("boom")), "unknown code", assertBalancePayload),
    /error.code must be one of/,
  );

  for (const code of ERROR_CODES) {
    const status = statusForErrorCode(code);
    const result = await assertLiveEnvelope(fake(status, errorBody(code)), `fake ${code}`, assertBalancePayload);
    assert.equal(result.degraded, true, `${code} at HTTP ${status} must be a degraded answer, not a failure`);
  }
  assert.equal(statusForErrorCode("not_a_code"), 500, "an unknown code must never map back to 200");
  assert.equal(statusForErrorCode("bad_request"), 400);
});

test("contract: live endpoints (opt-in via DSH_DEEPSEEK_USAGE_BASE_URL)", async (t) => {
  const base = process.env.DSH_DEEPSEEK_USAGE_BASE_URL;
  if (base === undefined || base === "") {
    t.skip("set DSH_DEEPSEEK_USAGE_BASE_URL (e.g. http://127.0.0.1:3080) to check a live host");
    return;
  }

  const balance = await assertLiveEnvelope(await fetch(`${base}${ROUTE_BASE}/balance`), "live /balance", assertBalancePayload);
  t.diagnostic(`live /balance → ${balance.degraded ? `degraded ${statusForErrorCode(balance.body.error.code)} ${balance.body.error.code}` : "200 ok:true"}`);

  const usage = await assertLiveEnvelope(await fetch(`${base}${ROUTE_BASE}/usage?days=7`), "live /usage", (body) => {
    assertUsagePayload(body);
    assertChartPoints(chartPoints(body, "totalTokens"), body.requestedDays);
  });
  t.diagnostic(`live /usage → ${usage.degraded ? `degraded ${statusForErrorCode(usage.body.error.code)} ${usage.body.error.code}` : "200 ok:true"}`);
});
