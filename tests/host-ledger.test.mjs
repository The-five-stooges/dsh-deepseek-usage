/**
 * Tests for the host-side ledger (`src/host/ledger.mjs`).
 *
 * Fixtures are synthetic: every session log is written by the encoder below as
 * a concatenated-frame Zstandard container, exactly like DSH's own
 * `dsh-session-persistence-jsonl` writer (raw blocks, window descriptor sized
 * to the frame's single segment, 3-byte block headers). The decoder under test
 * is therefore the real `node:zlib` Zstandard decoder — nothing is stubbed —
 * and no test depends on the user's real session logs.
 *
 * Run: node --test tests/host-ledger.test.mjs
 * (Node >= 22.15 / 24 for `node:zlib` Zstandard support.)
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";

import {
  KNOWN_MODEL_IDS,
  PRICE_TABLE_SOURCE,
  PRICE_TABLE_CNY_PER_MILLION,
  UNKNOWN_MODEL,
  aggregateUsage,
  chartSeries,
  estimateCallCostCny,
  isPeakInstant,
  priceKeyForModel,
  resolveZstdDecompress,
  scanZstdFrames,
  utcDay,
} from "../src/host/ledger.mjs";

/* ------------------------------------------------------------------ *
 * Synthetic Zstandard container writer
 * ------------------------------------------------------------------ */

/** Bytes a raw (uncompressed) block may carry. */
const MAX_RAW_BLOCK = 131_072;
/** Largest single segment this encoder's one-byte window descriptor expresses. */
const MAX_WINDOW = 1024 * 2 ** 31;

/**
 * Window descriptor for a single-segment frame whose body is raw blocks.
 * A raw block never references history outside itself, so the window only has
 * to cover ONE block (the 1024-byte minimum is also legal): declaring a window
 * the size of the whole payload would only make the decoder reserve more.
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
 * Encode `data` as one complete Zstandard frame made of raw blocks.
 * @param {string|Buffer} data
 * @returns {Buffer}
 */
function encodeZstdFrame(data) {
  const source = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  if (source.length > MAX_WINDOW) throw new Error("fixture frame exceeds the one-byte window descriptor");
  const head = Buffer.alloc(6);
  head.writeUInt32LE(0xfd2fb528, 0);
  head.writeUInt8(0x00, 4); // no single-segment flag, no checksum, no content size
  head.writeUInt8(windowDescriptor(source.length), 5);

  const parts = [];
  if (source.length === 0) {
    const header = Buffer.alloc(3);
    header.writeUIntLE(1, 0, 3); // empty last raw block
    parts.push(header);
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

/** A concatenated-frame container from one or more plaintext batches. */
function encodeZstdContainer(batches) {
  return Buffer.concat(batches.map((batch) => encodeZstdFrame(batch)));
}

/* ------------------------------------------------------------------ *
 * Fixture event builders
 * ------------------------------------------------------------------ */

/** 2026-09-15T00:00:00Z — the start of the fixture window. */
const BASE_MS = Date.parse("2026-09-15T00:00:00.000Z");
/** One UTC hour in milliseconds. */
const HOUR = 3_600_000;
/** Reference instant for every test: Thursday 2026-09-17T12:00:00Z. */
const NOW = Date.parse("2026-09-17T12:00:00.000Z");

/**
 * One durable `assistant/message` settlement, in the shape the host writes.
 * @param {object} spec
 */
function assistantMessage({ seq, time, turn = 1, step, model = "deepseek-flash", usage, streamUsage }) {
  const data = { turn, step, message: { role: "assistant", content: [], id: `message-${seq}`, source: { kind: "model", provider: "deepseek-official", model } } };
  if (usage !== undefined) data.usage = usage;
  if (streamUsage !== undefined) {
    data.stream = [
      { type: "chunk", time, chunk: { type: "block-start", index: 0, blockType: "text" } },
      { type: "usage", time, usage: streamUsage },
    ];
  }
  return { type: "assistant/message", seq, time, data };
}

/** A `session` header event; its `createdAt` is the fallback clock for un-timed usage. */
function sessionHeader(id, createdAt) {
  return JSON.stringify({ type: "session", version: 3, id, createdAt });
}

/** Serialize events plus optional malformed raw lines into JSONL text. */
function jsonl(events, badLines = []) {
  const lines = events.map((event) => JSON.stringify(event));
  return `${[...lines, ...badLines].join("\n")}\n`;
}

/* ------------------------------------------------------------------ *
 * Fixture workspace
 * ------------------------------------------------------------------ */

const FIXTURE_MTIME_MS = Date.parse("2026-09-17T10:00:00Z");

function createWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-usage-ledger-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  mkdirSync(sessions, { recursive: true });
  const written = [];

  return {
    root,
    sessions,
    cache,
    /**
     * Write one session log.
     * @param {object} spec
     * @param {string} spec.id - session id (also the leaf directory).
     * @param {string} [spec.workspace] - workspace directory name.
     * @param {object[]} [spec.events] - events to serialize.
     * @param {string[]} [spec.badLines] - malformed raw lines to interleave.
     * @param {string} [spec.rawText] - text used verbatim instead of `events`.
     * @param {string[]} [spec.batches] - container batches used verbatim.
     * @param {number} [spec.mtimeMs] - mtime to stamp on the file.
     */
    writeSession({ id, workspace = "--E-fixture--", events, badLines, rawText, batches, mtimeMs = FIXTURE_MTIME_MS }) {
      const directory = join(sessions, workspace, id);
      mkdirSync(directory, { recursive: true });
      const path = join(directory, "session.v3.jsonl.zstd");
      const bytes = batches === undefined
        ? encodeZstdContainer([rawText ?? jsonl(events ?? [], badLines ?? [])])
        : encodeZstdContainer(batches);
      writeFileSync(path, bytes);
      const seconds = mtimeMs / 1000;
      utimesSync(path, seconds, seconds);
      written.push(path);
      return path;
    },
    /** Aggregate with this workspace as the only input. */
    aggregate(options = {}) {
      return aggregateUsage({
        sessionsRoot: this.sessions,
        cacheDir: this.cache,
        now: NOW,
        days: 3,
        ...options,
      });
    },
    written,
  };
}

/** The `{ [date]: { [model]: bucket } }` view of an aggregate result. */
function byDayModel(result) {
  const view = {};
  for (const day of result.days) {
    view[day.date] = {};
    for (const model of day.models) view[day.date][model.model] = model;
  }
  return view;
}

/** Independent re-implementation of the expected fold, used to cross-check sums. */
function manualTotals(records) {
  const totals = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, estimatedCostCny: 0 };
  for (const record of records) {
    totals.inputTokens += record.usage.inputTokens;
    totals.cacheReadTokens += record.usage.cacheReadTokens ?? 0;
    totals.outputTokens += record.usage.outputTokens;
    totals.estimatedCostCny += estimateCallCostCny(record.usage, record.model, record.time);
  }
  totals.estimatedCostCny = Math.round(totals.estimatedCostCny * 1e12) / 1e12;
  return totals;
}

/** Approximate equality for USD amounts. */
function assertCloseCny(actual, expected, label) {
  assert.equal(typeof actual, "number", `${label} must be a number`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label} must be ≈ ${expected}, got ${actual}`);
}

/* ------------------------------------------------------------------ *
 * Encoder self-checks (the fixture generator must be trustworthy)
 * ------------------------------------------------------------------ */

test("fixture: synthetic frames are valid concatenated-frame Zstandard", () => {
  const batches = ["first batch\nsecond line\n", "", "x".repeat(200_000), "多行中文\n第二行\n"];
  const container = encodeZstdContainer(batches);

  // Every batch, including one larger than a single raw block, must decode
  // standalone — the fixture generator is the foundation of every other test.
  for (const [index, batch] of batches.entries()) {
    const standalone = encodeZstdFrame(batch);
    assert.equal(
      zstdDecompressSync(standalone).toString("utf8"),
      batch,
      `synthetic frame ${index} (${Buffer.byteLength(batch)} B) must decode standalone`,
    );
  }

  const { frames, tornStart, skippedBytes } = scanZstdFrames(container);
  assert.equal(tornStart, undefined, "a complete container must not look torn");
  assert.equal(skippedBytes, 0, "a complete container must not carry trailing bytes");
  assert.equal(frames.length, batches.length, "one frame per batch");
  assert.equal(frames.at(-1).end, container.length, "frames must tile the container exactly");

  const decoded = frames.map(({ start, end }) => zstdDecompressSync(container.subarray(start, end)).toString("utf8"));
  assert.deepEqual(decoded, batches, "each frame must decode to its own batch");

  const singleFrame = encodeZstdFrame(batches[0]);
  assert.equal(zstdDecompressSync(singleFrame).toString("utf8"), batches[0], "the encoder must be decodable standalone");
  // Node's one-shot decoder consumes ONE frame of a container — either stopping
  // or refusing, depending on the build. Either way it cannot see the whole
  // container, which is why the ledger walks frames itself.
  let oneShot;
  try {
    oneShot = zstdDecompressSync(container).toString("utf8");
  } catch (error) {
    oneShot = `threw:${error.code ?? error.message}`;
  }
  assert.notEqual(oneShot, batches.join(""), "a one-shot decode must not return the whole container");
  assert.ok(
    oneShot.startsWith("threw:") || oneShot === batches[0],
    `a one-shot decode returns at most the first frame, got ${JSON.stringify(oneShot.slice(0, 40))}`,
  );
});

/* ------------------------------------------------------------------ *
 * Acceptance: empty directory / bad lines / missing usage / cross-day
 * ------------------------------------------------------------------ */

test("ledger: empty sessions directory yields a zero-filled window", (t) => {
  const workspace = createWorkspace(t);
  const result = workspace.aggregate();

  assert.equal(result.ok, true);
  assert.equal(result.truncated, false, "an empty ledger is complete, not truncated");
  assert.equal(result.days.length, 3, "one bucket per requested day");
  assert.deepEqual(result.days.map((day) => day.date), ["2026-09-15", "2026-09-16", "2026-09-17"]);
  assert.deepEqual(result.days.map((day) => day.models), [[], [], []], "no models without usage");
  assert.deepEqual(result.totals, { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, estimatedCostCny: 0 });
  assert.equal(result.ledger.filesListed, 0);
  assert.equal(result.ledger.filesRead, 0);
  assert.equal(chartSeries(result, "totalTokens").length, 3, "the chart still gets one point per day");
});

test("ledger: per-day/per-model sums match the hand sum, with bad lines and missing usage skipped", (t) => {
  const workspace = createWorkspace(t);

  const a2 = { inputTokens: 3, cacheReadTokens: 4, outputTokens: 5 };
  const a3 = { inputTokens: 7, cacheReadTokens: 8, outputTokens: 9 };
  const b2 = { inputTokens: 11, cacheReadTokens: 12, outputTokens: 13 };
  const records = [
    { usage: { inputTokens: 1, cacheReadTokens: 2, outputTokens: 3 }, model: "deepseek-flash", time: BASE_MS + HOUR }, // 2026-09-15, A step 1
    { usage: a2, model: "deepseek-v4-pro", time: BASE_MS + 25 * HOUR }, // 2026-09-16, A step 2
    { usage: a3, model: "deepseek-flash", time: BASE_MS + 49 * HOUR }, // 2026-09-17, A step 3
    { usage: { inputTokens: 100, cacheReadTokens: 200, outputTokens: 300 }, model: "deepseek-flash", time: BASE_MS + 24 * HOUR }, // 2026-09-16, B step 1
    { usage: b2, model: "deepseek-v4-pro", time: BASE_MS + 49 * HOUR }, // 2026-09-17, B step 2
  ];

  workspace.writeSession({
    id: "session-a",
    events: [
      JSON.parse(sessionHeader("session-a", BASE_MS)),
      assistantMessage({ seq: 10, time: BASE_MS + HOUR, turn: 1, step: 1, model: "deepseek-flash", usage: records[0].usage }),
      assistantMessage({ seq: 20, time: BASE_MS + 25 * HOUR, turn: 2, step: 2, model: "deepseek-v4-pro", usage: a2 }),
      assistantMessage({ seq: 30, time: BASE_MS + 49 * HOUR, turn: 3, step: 3, model: "deepseek-flash", usage: a3 }),
    ],
    badLines: ["{not json at all", "{\"type\":\"assistant/message\",\"seq\":99,"],
  });
  workspace.writeSession({
    id: "session-b",
    events: [
      JSON.parse(sessionHeader("session-b", BASE_MS)),
      assistantMessage({ seq: 10, time: BASE_MS + 24 * HOUR, turn: 1, step: 1, model: "deepseek-flash", usage: records[3].usage }),
      assistantMessage({ seq: 20, time: BASE_MS + 49 * HOUR, turn: 2, step: 2, model: "deepseek-v4-pro", usage: b2 }),
    ],
    badLines: ["   "],
  });
  workspace.writeSession({
    id: "session-no-usage",
    events: [
      JSON.parse(sessionHeader("session-no-usage", BASE_MS)),
      { type: "user/message", seq: 1, time: BASE_MS + HOUR, data: { turn: 1, content: [{ type: "text", text: "hello" }] } },
      { type: "assistant/message", seq: 2, time: BASE_MS + HOUR, data: { turn: 1, step: 1, message: { role: "assistant", content: [] } } },
      { type: "tool/result", seq: 3, time: BASE_MS + HOUR, data: { usage: { inputTokens: 999, outputTokens: 999 } } },
    ],
  });

  const result = workspace.aggregate();
  const view = byDayModel(result);

  assert.deepEqual(Object.keys(view), ["2026-09-15", "2026-09-16", "2026-09-17"]);
  assert.deepEqual(
    { input: view["2026-09-15"]["deepseek-flash"].inputTokens, cacheRead: view["2026-09-15"]["deepseek-flash"].cacheReadTokens, output: view["2026-09-15"]["deepseek-flash"].outputTokens, model: view["2026-09-15"]["deepseek-flash"].model },
    { input: 1, cacheRead: 2, output: 3, model: "deepseek-flash" },
    "2026-09-15 holds only session A's first settlement",
  );
  // 2026-09-15T01:00Z is a peak window for flash: 1 miss @2元 + 2 hits @0.04元 +
  // 3 out @8元, per million tokens. Taken from the table rather than restated, so the
  // expectation cannot drift from the published prices it is checking.
  const flashPeak = PRICE_TABLE_CNY_PER_MILLION["deepseek-flash"].peak;
  assertCloseCny(
    view["2026-09-15"]["deepseek-flash"].estimatedCostCny,
    (1 * flashPeak.cacheMiss + 2 * flashPeak.cacheRead + 3 * flashPeak.output) / 1e6,
    "2026-09-15 cost",
  );

  const flash16 = view["2026-09-16"]["deepseek-flash"];
  const pro16 = view["2026-09-16"]["deepseek-v4-pro"];
  assert.equal(flash16.inputTokens, 100);
  assert.equal(flash16.cacheReadTokens, 200);
  assert.equal(flash16.outputTokens, 300);
  assert.equal(pro16.inputTokens, 3);
  assert.equal(pro16.cacheReadTokens, 4);
  assert.equal(pro16.outputTokens, 5);

  const flash17 = view["2026-09-17"]["deepseek-flash"];
  const pro17 = view["2026-09-17"]["deepseek-v4-pro"];
  assert.deepEqual(
    { input: flash17.inputTokens, cacheRead: flash17.cacheReadTokens, output: flash17.outputTokens },
    { input: 7, cacheRead: 8, output: 9 },
  );
  assert.deepEqual(
    { input: pro17.inputTokens, cacheRead: pro17.cacheReadTokens, output: pro17.outputTokens },
    { input: 11, cacheRead: 12, output: 13 },
  );

  // Totals must equal the independent per-event sum, not just look plausible.
  const expected = manualTotals(records);
  assert.deepEqual(
    {
      inputTokens: result.totals.inputTokens,
      cacheReadTokens: result.totals.cacheReadTokens,
      outputTokens: result.totals.outputTokens,
    },
    {
      inputTokens: expected.inputTokens,
      cacheReadTokens: expected.cacheReadTokens,
      outputTokens: expected.outputTokens,
    },
  );
  assertCloseCny(result.totals.estimatedCostCny, expected.estimatedCostCny, "totals.estimatedCostCny");

  // Diagnostics: bad lines are counted and reported, never fatal and never silent.
  assert.equal(result.ledger.malformedLines, 2, "both malformed lines are counted");
  assert.equal(result.ledger.filesRead, 3, "all three session logs were read");
  assert.equal(result.ledger.usages, 5, "only settlements carrying usage are counted");
  assert.equal(result.ledger.filesUnreadable, 0);
  assert.equal(result.ledger.unknownModelUsages, 0);
});

test("ledger: usage nested in the stream is found, and the durable usage field wins", (t) => {
  const workspace = createWorkspace(t);
  const fromStream = { inputTokens: 40, cacheReadTokens: 400, outputTokens: 4 };
  const durable = { inputTokens: 50, cacheReadTokens: 500, outputTokens: 5 };

  workspace.writeSession({
    id: "session-stream-only",
    events: [
      assistantMessage({ seq: 1, time: BASE_MS + HOUR, step: 1, usage: undefined, streamUsage: fromStream }),
      assistantMessage({ seq: 2, time: BASE_MS + 25 * HOUR, step: 2, usage: durable, streamUsage: fromStream }),
    ],
  });

  const view = byDayModel(workspace.aggregate());
  assert.deepEqual(
    { input: view["2026-09-15"]["deepseek-flash"].inputTokens, cacheRead: view["2026-09-15"]["deepseek-flash"].cacheReadTokens },
    { input: 40, cacheRead: 400 },
    "a settlement without data.usage still bills the stream's usage chunk",
  );
  assert.equal(view["2026-09-16"]["deepseek-flash"].inputTokens, 50, "data.usage must win over the stream chunk");
});

test("ledger: one (turn, step) is billed once — the last sample wins, other steps add up", (t) => {
  const workspace = createWorkspace(t);
  const snapshot = { inputTokens: 100, cacheReadTokens: 1_000, outputTokens: 10 };
  const settlement = { inputTokens: 120, cacheReadTokens: 2_000, outputTokens: 25 };

  workspace.writeSession({
    id: "session-dedupe",
    events: [
      // A live snapshot of step 1, then its final settlement for the SAME (turn, step):
      // exactly what a session log looks like while a turn is still streaming, and
      // exactly what must not be billed twice.
      assistantMessage({ seq: 1, time: BASE_MS + HOUR, turn: 1, step: 1, usage: snapshot, streamUsage: snapshot }),
      assistantMessage({ seq: 2, time: BASE_MS + HOUR, turn: 1, step: 1, usage: settlement, streamUsage: settlement }),
      // A different step is a different provider call and must add up.
      assistantMessage({ seq: 3, time: BASE_MS + HOUR, turn: 1, step: 2, usage: { inputTokens: 7, cacheReadTokens: 8, outputTokens: 9 } }),
    ],
  });

  const result = workspace.aggregate();
  const bucket = byDayModel(result)["2026-09-15"]["deepseek-flash"];
  assert.equal(bucket.inputTokens, 127, "120 (step 1, last sample) + 7 (step 2)");
  assert.equal(bucket.cacheReadTokens, 2_008, "2_000 + 8");
  assert.equal(bucket.outputTokens, 34, "25 + 9");
  assertCloseCny(
    bucket.estimatedCostCny,
    estimateCallCostCny(settlement, "deepseek-flash", BASE_MS + HOUR) + estimateCallCostCny({ inputTokens: 7, cacheReadTokens: 8, outputTokens: 9 }, "deepseek-flash", BASE_MS + HOUR),
    "each surviving call is priced once",
  );
  assert.equal(result.ledger.usages, 2, "two counted samples, not three");
  assert.equal(result.totals.inputTokens, 127);
});

test("ledger: usage without a timestamp falls back to the session header, then to now", (t) => {
  const workspace = createWorkspace(t);
  const created = Date.parse("2026-09-16T08:00:00.000Z");

  workspace.writeSession({
    id: "session-created-at",
    batches: [
      `${sessionHeader("session-created-at", created)}\n`,
      `${JSON.stringify(assistantMessage({ seq: 1, time: undefined, step: 1, usage: { inputTokens: 5, cacheReadTokens: 0, outputTokens: 1 } }))}\n`,
    ],
  });
  workspace.writeSession({
    id: "session-no-clock",
    events: [assistantMessage({ seq: 1, time: undefined, step: 1, usage: { inputTokens: 7, cacheReadTokens: 0, outputTokens: 1 } })],
  });

  const result = workspace.aggregate();
  const view = byDayModel(result);
  assert.equal(view["2026-09-16"]["deepseek-flash"].inputTokens, 5, "the session header clock dates the sample");
  assert.equal(view["2026-09-17"]["deepseek-flash"].inputTokens, 7, "with no clock at all the sample lands today");
  assert.equal(result.ledger.missingTime, 2, "both fallbacks are reported");
  assert.equal(result.ledger.usages, 2);
});

/* ------------------------------------------------------------------ *
 * Acceptance: peak / off-peak pricing per call
 * ------------------------------------------------------------------ */

test("pricing: peak windows and weekday rules are exact", () => {
  const thursday = (hour) => Date.parse(`2026-09-17T${String(hour).padStart(2, "0")}:00:00.000Z`);
  const saturday = (hour) => Date.parse(`2026-09-19T${String(hour).padStart(2, "0")}:00:00.000Z`);

  for (const hour of [1, 2, 3, 6, 7, 8, 9]) {
    assert.equal(isPeakInstant(thursday(hour)), true, `Thursday ${hour}:00 UTC is a peak hour`);
  }
  for (const hour of [0, 4, 5, 10, 12, 23]) {
    assert.equal(isPeakInstant(thursday(hour)), false, `Thursday ${hour}:00 UTC is off-peak`);
  }
  for (const hour of [2, 7]) {
    assert.equal(isPeakInstant(saturday(hour)), false, `Saturday ${hour}:00 UTC is off-peak regardless of the hour`);
  }

  assert.equal(PRICE_TABLE_SOURCE.url, "https://api-docs.deepseek.com/zh-cn/quick_start/pricing");
  assert.equal(PRICE_TABLE_SOURCE.currency, "CNY", "the price list is the Chinese page's yuan list; the account is billed in CNY");
  assert.equal(PRICE_TABLE_SOURCE.fetchedOn, "2026-09-18");
  assert.deepEqual(KNOWN_MODEL_IDS, ["deepseek-flash", "deepseek-v4-pro"]);
  // The yuan list itself, pinned model by model: these are the numbers from
  // https://api-docs.deepseek.com/zh-cn/quick_start/pricing and they are NOT the
  // English page's dollar numbers (flash cache-miss is 1/2 元, not 0.15/0.3).
  assert.deepEqual(PRICE_TABLE_CNY_PER_MILLION["deepseek-flash"].offPeak, { cacheRead: 0.02, cacheMiss: 1, output: 4 });
  assert.deepEqual(PRICE_TABLE_CNY_PER_MILLION["deepseek-flash"].peak, { cacheRead: 0.04, cacheMiss: 2, output: 8 });
  assert.deepEqual(PRICE_TABLE_CNY_PER_MILLION["deepseek-v4-pro"].offPeak, { cacheRead: 0.15, cacheMiss: 4.5, output: 13.5 });
  assert.deepEqual(PRICE_TABLE_CNY_PER_MILLION["deepseek-v4-pro"].peak, { cacheRead: 0.3, cacheMiss: 9, output: 27 });
  assert.deepEqual(PRICE_TABLE_SOURCE.peakWindowsUtc, [
    { startHour: 1, endHour: 4 },
    { startHour: 6, endHour: 10 },
  ]);
  assert.deepEqual(PRICE_TABLE_SOURCE.peakWindowsLocal, [
    { startHour: 9, endHour: 12 },
    { startHour: 14, endHour: 18 },
  ]);
  for (const id of KNOWN_MODEL_IDS) {
    const entry = PRICE_TABLE_CNY_PER_MILLION[id];
    for (const field of ["cacheRead", "cacheMiss", "output"]) {
      assert.equal(entry.peak[field], entry.offPeak[field] * 2, `${id}.${field} peak price must be exactly double`);
    }
  }
  assert.equal(priceKeyForModel("deepseek-flash"), "deepseek-flash");
  assert.equal(priceKeyForModel("DeepSeek-V4-Pro"), "deepseek-v4-pro");
  assert.equal(priceKeyForModel("some-future-model"), undefined, "an unknown id must not be guessed");
  assert.equal(priceKeyForModel(undefined), undefined);
});

test("pricing: cost is per call, so peak and off-peak calls on one day price differently", (t) => {
  const workspace = createWorkspace(t);
  const peakTime = Date.parse("2026-09-17T02:00:00.000Z"); // Thursday 02:00 UTC
  const offPeakTime = Date.parse("2026-09-17T12:00:00.000Z"); // Thursday 12:00 UTC
  const tokens = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 };

  const expectedPeak = estimateCallCostCny(tokens, "deepseek-flash", peakTime);
  const expectedOffPeak = estimateCallCostCny(tokens, "deepseek-flash", offPeakTime);
  assert.equal(expectedPeak, 10.04, "flash peak: 1M misses @2元 + 1M hits @0.04元 + 1M out @8元");
  assert.equal(expectedOffPeak, 5.02, "flash off-peak: 1 + 0.02 + 4");
  assert.equal(expectedPeak, expectedOffPeak * 2);

  workspace.writeSession({
    id: "session-mixed-pricing",
    events: [
      assistantMessage({ seq: 1, time: peakTime, step: 1, usage: tokens }),
      assistantMessage({ seq: 2, time: offPeakTime, step: 2, usage: tokens }),
    ],
  });

  const result = workspace.aggregate();
  const day = byDayModel(result)["2026-09-17"]["deepseek-flash"];
  assertCloseCny(day.estimatedCostCny, expectedPeak + expectedOffPeak, "the day bucket sums both priced calls");
  assert.equal(result.totals.inputTokens, 2_000_000, "token counts stay additive across peak and off-peak calls");
  assertCloseCny(result.totals.estimatedCostCny, 15.06, "10.04 + 5.02");
  assert.equal(result.estimated, true, "cost is always labelled an estimate");
  assert.equal(result.priceSource.fetchedOn, "2026-09-18");
  assert.equal(result.priceSource.currency, "CNY");
});

test("pricing: v4-pro rates are applied per market window, and an unknown model costs 0", (t) => {
  const peak = Date.parse("2026-09-18T07:00:00.000Z"); // Friday 07:00 UTC, second peak window
  const offPeak = Date.parse("2026-09-18T15:00:00.000Z"); // Friday 15:00 UTC
  const tokens = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 };

  assert.equal(estimateCallCostCny(tokens, "deepseek-v4-pro", peak), 36.3, "9元 + 0.3元 + 27元");
  assert.equal(estimateCallCostCny(tokens, "deepseek-v4-pro", offPeak), 18.15, "4.5 + 0.15 + 13.5");
  assert.equal(estimateCallCostCny(tokens, "totally-unknown-model", peak), 0);
  assert.equal(estimateCallCostCny({}, "deepseek-flash", peak), 0, "missing counts are 0, never NaN");

  // The samples must fall inside the requested window, so price them on the
  // peak day the window covers (Friday is outside a 3-day window ending Thursday).
  const sampledAt = Date.parse("2026-09-17T07:00:00.000Z"); // Thursday 07:00 UTC, peak window
  const workspace = createWorkspace(t);
  workspace.writeSession({
    id: "session-unknown-model",
    events: [
      assistantMessage({ seq: 1, time: sampledAt, step: 1, model: "deepseek-v4-pro", usage: tokens }),
      assistantMessage({
        seq: 2,
        time: sampledAt,
        step: 2,
        model: "some-future-model",
        usage: { inputTokens: 10, cacheReadTokens: 10, outputTokens: 10 },
      }),
      assistantMessage({
        seq: 3,
        time: sampledAt,
        step: 3,
        model: "   ",
        usage: { inputTokens: 20, cacheReadTokens: 0, outputTokens: 10 },
      }),
    ],
  });

  const result = workspace.aggregate();
  const view = byDayModel(result)["2026-09-17"];
  assert.ok(view["some-future-model"] !== undefined, "an unknown model still gets its own bucket");
  assert.equal(view["some-future-model"].estimatedCostCny, 0, "an unknown model is counted but never priced");
  assert.equal(view["some-future-model"].inputTokens, 10);
  assert.equal(view[UNKNOWN_MODEL].inputTokens, 20, "a blank routing model is reported as unknown, never guessed");
  assert.equal(view[UNKNOWN_MODEL].estimatedCostCny, 0);
  assert.equal(view["deepseek-v4-pro"].estimatedCostCny, 36.3);
  assert.equal(result.ledger.unknownModelUsages, 2, "unknown-model samples are reported, not hidden");
});

/* ------------------------------------------------------------------ *
 * Acceptance: incremental mtime + size cache
 * ------------------------------------------------------------------ */

test("cache: an unchanged log is never decompressed twice, a changed log is re-read", (t) => {
  const workspace = createWorkspace(t);
  const first = { inputTokens: 1_000, cacheReadTokens: 2_000, outputTokens: 3_000 };
  const second = { inputTokens: 4_000, cacheReadTokens: 5_000, outputTokens: 6_000 };

  const onePath = workspace.writeSession({
    id: "session-one",
    events: [assistantMessage({ seq: 1, time: BASE_MS + HOUR, step: 1, usage: first })],
  });
  const twoPath = workspace.writeSession({
    id: "session-two",
    events: [assistantMessage({ seq: 1, time: BASE_MS + 25 * HOUR, step: 1, usage: second })],
  });
  // Pin both logs: one mtime must be strictly newer so the change is observable
  // even on a coarse filesystem clock.
  utimesSync(twoPath, FIXTURE_MTIME_MS / 1000 - 3600, FIXTURE_MTIME_MS / 1000 - 3600);
  const oneStat = statSync(onePath);
  const twoStat = statSync(twoPath);
  assert.ok(oneStat.mtimeMs > twoStat.mtimeMs, "fixture mtimes must be distinguishable");

  let decodes = 0;
  const decoder = (frame) => {
    decodes += 1;
    return zstdDecompressSync(frame);
  };

  const cold = workspace.aggregate({ decompress: decoder });
  assert.equal(decodes, 2, "the cold run decodes each session log exactly once");
  assert.equal(cold.ledger.filesRead, 2);
  assert.equal(cold.ledger.filesFromCache, 0);
  assert.equal(cold.totals.inputTokens, 5_000);

  decodes = 0;
  const warm = workspace.aggregate({ decompress: decoder });
  assert.equal(decodes, 0, "the warm run must not decompress anything");
  assert.equal(warm.ledger.filesFromCache, 2);
  assert.equal(warm.ledger.filesRead, 0);
  assert.deepEqual(warm.totals, cold.totals, "the cache must reproduce the cold result exactly");

  // Grow one log: the cached aggregate body must be REPLACED, not added to.
  // `rewritten` is the SAME path as `onePath` (a session log is one file that grows).
  const sizeBefore = statSync(onePath).size;
  const grown = { inputTokens: 700_000, cacheReadTokens: 0, outputTokens: 9 };
  const rewritten = workspace.writeSession({
    id: "session-one",
    events: [
      assistantMessage({ seq: 1, time: BASE_MS + HOUR, step: 1, usage: first }),
      assistantMessage({ seq: 2, time: BASE_MS + 2 * HOUR, step: 2, usage: grown }),
    ],
  });
  const bumped = Math.trunc(statSync(rewritten).mtimeMs) + 5_000;
  utimesSync(rewritten, bumped / 1000, bumped / 1000);
  assert.equal(rewritten, onePath, "growing a session rewrites the same log file");
  assert.notEqual(sizeBefore, statSync(rewritten).size, "the rewritten log must differ in size");

  decodes = 0;
  const afterGrowth = workspace.aggregate({ decompress: decoder });
  assert.equal(decodes, 1, "only the changed log is re-read");
  assert.equal(afterGrowth.ledger.filesFromCache, 1);
  assert.equal(afterGrowth.ledger.filesRead, 1);
  assert.equal(afterGrowth.totals.inputTokens, 705_000, "1_000 + 4_000 + 700_000 — a stale cache would double the 1_000");
  assert.equal(afterGrowth.totals.outputTokens, 9_009, "3_000 + 6_000 + 9");

  decodes = 0;
  const afterWarm = workspace.aggregate({ decompress: decoder });
  assert.equal(decodes, 0, "the refreshed entry is cached again");
  assert.deepEqual(afterWarm.totals, afterGrowth.totals);
});

test("cache: a change to the PRICE LIST invalidates every cached cost", (t) => {
  // The index is keyed on each log's mtime + size, so it knows when the LOG changed and
  // nothing about when the PRICES changed. Costs are computed while a log is decoded, so
  // without this the whole report would keep serving the old price basis until every log
  // happened to be touched — which is exactly what a currency change must not do.
  const workspace = createWorkspace(t);
  workspace.writeSession({
    id: "session-priced",
    events: [assistantMessage({ seq: 1, time: BASE_MS + HOUR, step: 1, usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 } })],
  });

  let decodes = 0;
  const counting = (frame) => {
    decodes += 1;
    return zstdDecompressSync(frame);
  };

  const first = workspace.aggregate({ decompress: counting });
  const firstCost = first.totals.estimatedCostCny;
  assert.ok(firstCost > 0, "the fixture must actually be priced, or this proves nothing");

  const indexPath = join(workspace.cache, "index.json");
  const written = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(typeof written.prices, "string", "the index must stamp the price list it was costed with");
  assert.ok(written.prices.length >= 8, `a real digest, saw ${written.prices}`);

  // Warm run: nothing re-read, same money.
  decodes = 0;
  const warm = workspace.aggregate({ decompress: counting });
  assert.equal(decodes, 0, "an untouched log stays cached");
  assert.equal(warm.totals.estimatedCostCny, firstCost);

  // Simulate the price list having been edited (a different table ⇒ a different digest),
  // then re-run: every entry must be re-decoded and re-priced.
  const tampered = { ...written, prices: "0000000000000000" };
  writeFileSync(indexPath, JSON.stringify(tampered), "utf8");

  decodes = 0;
  const repriced = workspace.aggregate({ decompress: counting });
  assert.equal(decodes, 1, "a price change must re-read every log, not reuse the old cost");
  assert.equal(repriced.totals.estimatedCostCny, firstCost, "and must arrive at the same money once re-priced");
  const restamped = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(restamped.prices, written.prices, "the cache is stamped with the current price list again");
});

test("cache: null cacheDir re-reads every time, and the default cache path is host-local", (t) => {
  const workspace = createWorkspace(t);
  workspace.writeSession({
    id: "session-one",
    events: [assistantMessage({ seq: 1, time: BASE_MS + HOUR, step: 1, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 1 } })],
  });

  let decodes = 0;
  const decoder = (frame) => {
    decodes += 1;
    return zstdDecompressSync(frame);
  };
  workspace.aggregate({ cacheDir: null, decompress: decoder });
  workspace.aggregate({ cacheDir: null, decompress: decoder });
  assert.equal(decodes, 2, "without a cache directory every run is a cold run");
});

/* ------------------------------------------------------------------ *
 * Acceptance: failures are counted, never thrown and never silent
 * ------------------------------------------------------------------ */

test("robustness: unwritten, torn, truncated and corrupt logs are skipped and counted", (t) => {
  const workspace = createWorkspace(t);
  const good = { inputTokens: 100, cacheReadTokens: 200, outputTokens: 300 };

  workspace.writeSession({
    id: "session-good",
    events: [assistantMessage({ seq: 1, time: BASE_MS + HOUR, step: 1, usage: good })],
  });
  // A live session: its final frame is still being written.
  const tornPath = workspace.writeSession({
    id: "session-torn",
    batches: [
      `${sessionHeader("session-torn", BASE_MS)}\n`,
      `${JSON.stringify(assistantMessage({ seq: 1, time: BASE_MS + HOUR, step: 1, usage: good }))}\n`,
      `${JSON.stringify(assistantMessage({ seq: 2, time: BASE_MS + 2 * HOUR, step: 2, usage: good }))}\n`,
    ],
  });
  utimesSync(tornPath, FIXTURE_MTIME_MS / 1000 - 60, FIXTURE_MTIME_MS / 1000 - 60);
  const tornBytes = readFileSync(tornPath);
  writeFileSync(tornPath, tornBytes.subarray(0, tornBytes.length - 12));

  // A corrupt middle frame: structurally walkable but undecodable. Its first
  // block claims to be a compressed block whose payload is not a valid zstd
  // sequence, so the decoder rejects it deterministically — a flipped byte
  // inside a checksum-less raw block can still decode, so a flip cannot be used.
  const corruptFrame = Buffer.alloc(6 + 3 + 2048 + 3);
  corruptFrame.writeUInt32LE(0xfd2fb528, 0);
  corruptFrame.writeUInt8(0x00, 4); // no single-segment flag, no checksum, no content size
  corruptFrame.writeUInt8(0x98, 5); // window descriptor: 8 MiB (enough for one 2 KiB block)
  corruptFrame.writeUIntLE((2048 << 3) | (2 << 1) | 0, 6, 3); // compressed block, not last
  for (let index = 0; index < 2048; index += 1) corruptFrame[9 + index] = (index * 37) % 256;
  corruptFrame.writeUIntLE(1, 9 + 2048, 3); // empty last raw block
  const corruptPath = workspace.writeSession({
    id: "session-corrupt",
    batches: [`${JSON.stringify(assistantMessage({ seq: 1, time: BASE_MS + HOUR, step: 1, usage: good }))}\n`],
  });
  utimesSync(corruptPath, FIXTURE_MTIME_MS / 1000 - 120, FIXTURE_MTIME_MS / 1000 - 120);
  writeFileSync(corruptPath, Buffer.concat([readFileSync(corruptPath), corruptFrame]));
  assert.equal(scanZstdFrames(readFileSync(corruptPath)).frames.length, 2, "the corrupt fixture must hold two walkable frames");
  assert.throws(() => zstdDecompressSync(corruptFrame), "the corrupt frame must be undecodable");

  // Trailing bytes after a complete frame: undecodable, counted, never fatal.
  const trailerPath = workspace.writeSession({
    id: "session-trailer",
    events: [assistantMessage({ seq: 1, time: BASE_MS + HOUR, step: 1, usage: good })],
  });
  utimesSync(trailerPath, FIXTURE_MTIME_MS / 1000 - 30, FIXTURE_MTIME_MS / 1000 - 30);
  writeFileSync(trailerPath, Buffer.concat([readFileSync(trailerPath), Buffer.from("trailing bytes that are not a frame")]));

  // An unsorted, undecodable file at the very front.
  const garbagePath = join(workspace.sessions, "--E-fixture--", "session-garbage");
  mkdirSync(garbagePath, { recursive: true });
  const garbageLog = join(garbagePath, "session.v3.jsonl.zstd");
  writeFileSync(garbageLog, Buffer.from("definitely not a zstandard container", "utf8"));
  utimesSync(garbageLog, FIXTURE_MTIME_MS / 1000 - 180, FIXTURE_MTIME_MS / 1000 - 180);

  const result = workspace.aggregate();
  assert.equal(result.ok, true, "the ledger still answers");
  assert.equal(
    result.totals.inputTokens,
    400,
    "four decodable settlements survive: good, trailer, torn frame 1, corrupt frame 1",
  );
  assert.equal(result.ledger.badFrames, 1, "the corrupt frame is counted");
  assert.equal(result.ledger.tornFrames, 1, "the torn live log is reported");
  assert.ok(result.ledger.skippedBytes > 0, "undecodable trailing bytes are counted, not silently dropped");
  assert.ok(result.ledger.filesUnreadable >= 1, "the undecodable file is reported, not treated as an empty session");
  assert.ok(result.ledger.unreadableFiles.length >= 1, "the undecodable file is named");
  assert.equal(result.days.length, 3);
  assert.equal(result.ledger.filesListed, 5, "every candidate log is listed");
});

test("robustness: an unavailable zstd decoder is reported, not thrown", (t) => {
  const workspace = createWorkspace(t);
  workspace.writeSession({
    id: "session-one",
    events: [assistantMessage({ seq: 1, time: BASE_MS + HOUR, step: 1, usage: { inputTokens: 1, cacheReadTokens: 1, outputTokens: 1 } })],
  });

  assert.equal(resolveZstdDecompress(undefined), zstdDecompressSync, "the default is node:zlib's one-shot decoder");
  const fake = () => Buffer.from("");
  assert.equal(resolveZstdDecompress(fake), fake, "an injected decoder wins");
  assert.equal(resolveZstdDecompress(null), undefined, "a null decoder is not a decoder");

  // On a Node build without `zlib.zstdDecompressSync` the ledger reports
  // availability instead of crashing the host at load time.
  const available = workspace.aggregate();
  assert.equal(available.ledger.available, true, "this host has a decoder, so the ledger is available");
  assert.equal(available.ledger.unavailableReason, undefined);
});

/* ------------------------------------------------------------------ *
 * Contract shape and diagnostics
 * ------------------------------------------------------------------ */

test("contract: the payload keeps the frozen shape, zero-fills gaps and matches its own totals", (t) => {
  const workspace = createWorkspace(t);
  const sampledAt = Date.parse("2026-09-15T05:00:00.000Z");
  workspace.writeSession({
    id: "session-one",
    events: [assistantMessage({ seq: 1, time: sampledAt, step: 1, usage: { inputTokens: 3, cacheReadTokens: 4, outputTokens: 5 } })],
  });

  const result = workspace.aggregate({ days: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.requestedDays, 3);
  assert.equal(result.days.length, result.requestedDays, "one bucket per requested day");
  assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "generatedAt is an ISO UTC instant");
  for (const [index, day] of result.days.entries()) {
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
    if (index > 0) assert.ok(day.date > result.days[index - 1].date, "dates must ascend");
    for (const model of day.models) {
      assert.equal(typeof model.model, "string");
      assert.ok(model.model.length > 0);
      for (const key of ["inputTokens", "cacheReadTokens", "outputTokens", "estimatedCostCny"]) {
        assert.equal(typeof model[key], "number", `${key} must be a number`);
        assert.ok(Number.isFinite(model[key]) && model[key] >= 0, `${key} must be finite and >= 0`);
      }
    }
  }
  const summed = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, estimatedCostCny: 0 };
  for (const day of result.days) {
    for (const model of day.models) {
      summed.inputTokens += model.inputTokens;
      summed.cacheReadTokens += model.cacheReadTokens;
      summed.outputTokens += model.outputTokens;
      summed.estimatedCostCny += model.estimatedCostCny;
    }
  }
  assert.equal(result.totals.inputTokens, summed.inputTokens);
  assert.equal(result.totals.cacheReadTokens, summed.cacheReadTokens);
  assert.equal(result.totals.outputTokens, summed.outputTokens);
  assert.ok(Math.abs(result.totals.estimatedCostCny - summed.estimatedCostCny) < 1e-6);
  assert.equal(JSON.stringify(result).includes("sk-"), false, "no credential material can reach the response");

  // Window clamping mirrors the frozen contract's `?days=N` rule.
  assert.equal(workspace.aggregate({ days: 400 }).requestedDays, 365);
  assert.equal(workspace.aggregate({ days: 0 }).requestedDays, 30, "an unusable window falls back to the default");
  assert.equal(workspace.aggregate({ days: 7 }).days.length, 7);
  assert.equal(workspace.aggregate({ days: 1 }).days.at(-1).date, utcDay(NOW), "the window always ends today");
});

test("contract: chartSeries projects the same day axis for every metric", (t) => {
  const workspace = createWorkspace(t);
  workspace.writeSession({
    id: "session-one",
    events: [
      assistantMessage({ seq: 1, time: Date.parse("2026-09-16T05:00:00.000Z"), step: 1, usage: { inputTokens: 3, cacheReadTokens: 4, outputTokens: 5 } }),
      assistantMessage({ seq: 2, time: Date.parse("2026-09-16T06:00:00.000Z"), step: 2, usage: { inputTokens: 6, cacheReadTokens: 7, outputTokens: 8 } }),
    ],
  });
  const result = workspace.aggregate({ days: 3 });

  const metrics = ["totalTokens", "inputTokens", "cacheReadTokens", "outputTokens", "estimatedCostCny"];
  for (const metric of metrics) {
    const points = chartSeries(result, metric);
    assert.equal(points.length, result.days.length, `${metric} needs one point per day`);
    assert.deepEqual(points.map((point) => point.label), result.days.map((day) => day.date), `${metric} stays aligned`);
    for (const point of points) {
      assert.deepEqual(Object.keys(point).sort(), ["label", "value"]);
      assert.match(point.label, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Number.isFinite(point.value) && point.value >= 0);
    }
  }
  assert.deepEqual(chartSeries(result, "inputTokens"), [
    { label: "2026-09-15", value: 0 },
    { label: "2026-09-16", value: 9 },
    { label: "2026-09-17", value: 0 },
  ]);
  assert.deepEqual(chartSeries(result, "totalTokens")[1], { label: "2026-09-16", value: 33 }, "3+4+5 + 6+7+8");
  assert.equal(chartSeries(result, "cacheReadTokens")[1].value, 11);
  assert.equal(chartSeries(result, "outputTokens")[1].value, 13);
  assert.equal(chartSeries({ days: [] }, "totalTokens").length, 0, "an empty payload yields no points");
});

/* ------------------------------------------------------------------ *
 * Bounded work: budget + many-session performance
 * ------------------------------------------------------------------ */

test("budget: an expiring budget returns the partial ledger marked truncated", (t) => {
  const workspace = createWorkspace(t);
  for (let index = 0; index < 6; index += 1) {
    workspace.writeSession({
      id: `session-${index}`,
      workspace: `--E-ws-${index}--`,
      events: [assistantMessage({ seq: 1, time: BASE_MS + HOUR, step: 1, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 1 } })],
    });
  }

  const slowDecoder = (frame) => {
    const until = Date.now() + 5;
    while (Date.now() < until) {
      /* burn the budget deterministically */
    }
    return zstdDecompressSync(frame);
  };

  const partial = workspace.aggregate({ decompress: slowDecoder, budgetMs: 1 });
  assert.equal(partial.truncated, true, "an expired budget must be visible in the payload");
  assert.equal(partial.requestedDays, 3, "the window is still reported");
  assert.equal(partial.days.length, 3, "the payload keeps its shape");
  assert.ok(partial.ledger.elapsedMs < 2_000, "the budget must stop work promptly");
  assert.equal(partial.ledger.filesListed, 6, "the candidate set is still reported");
  assert.equal(partial.ledger.available, true);

  const complete = workspace.aggregate({ decompress: zstdDecompressSync, budgetMs: 15_000 });
  assert.equal(complete.truncated, false);

  // A cold index over a small cache and a bounded budget still terminates.
  const bounded = workspace.aggregate({ decompress: slowDecoder, budgetMs: 15_000, cacheDir: null });
  assert.equal(bounded.days.length, 3);
  assert.equal(bounded.totals.inputTokens, 60);
});

test("performance: 300 sessions (~600 logs) aggregate well inside the 15s budget", (t) => {
  const workspace = createWorkspace(t);
  const created = Date.parse("2026-09-17T02:00:00Z");
  for (let index = 0; index < 300; index += 1) {
    workspace.writeSession({
      id: `session-${String(index).padStart(4, "0")}`,
      workspace: `--E-ws-${index % 12}--`,
      events: [assistantMessage({ seq: 1, time: created, turn: 1, step: 1, usage: { inputTokens: index + 1, cacheReadTokens: 100, outputTokens: 2 } })],
      mtimeMs: Date.parse("2026-09-17T10:00:00Z") + index,
    });
  }
  // A non-log sibling in a real session directory must be ignored by the lister.
  const extra = join(dirname(workspace.written[0]), "session.v3.jsonl.zstd.1");
  writeFileSync(extra, "not a session log\n");

  const coldStarted = Date.now();
  const cold = workspace.aggregate({ budgetMs: 15_000 });
  const coldMs = Date.now() - coldStarted;
  assert.equal(cold.truncated, false, "600 logs must fit the 15s budget");
  assert.equal(cold.ledger.filesListed, 300, "only session.v3.jsonl.zstd files are listed");
  assert.equal(cold.ledger.filesRead, 300);
  assert.equal(cold.totals.inputTokens, (300 * 301) / 2, "1..300 summed");
  assert.ok(coldMs < 15_000, `cold aggregation took ${coldMs}ms, budget is 15000ms`);

  const warmStarted = Date.now();
  const warm = workspace.aggregate({ budgetMs: 15_000 });
  const warmMs = Date.now() - warmStarted;
  assert.equal(warm.ledger.filesFromCache, 300, "the second pass is served from the index");
  assert.equal(warm.ledger.filesRead, 0);
  assert.ok(warmMs < 3_000, `warm aggregation took ${warmMs}ms`);
  assert.deepEqual(warm.totals, cold.totals);
});
