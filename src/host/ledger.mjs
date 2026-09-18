/**
 * Host-side session-log ledger for dsh-deepseek-usage.
 *
 * Reads the concatenated-frame Zstandard session logs DSH writes under
 * `<DSH_HOME>/sessions/<workspace>/<session-id>/session.v3.jsonl.zstd`, extracts
 * provider-reported token usage from `assistant/message` settlements, and folds
 * them into per-(UTC day, model) buckets with an estimated USD cost.
 *
 * Contract (frozen by tests/contract.test.mjs) — `aggregateUsage` returns:
 *   { ok: true, days: [{ date, models: [{ model, inputTokens, cacheReadTokens,
 *     outputTokens, estimatedCostCny }] }], generatedAt, truncated, ... }
 * `days` is ALWAYS the ascending, zero-filled array of day buckets (one per
 * requested day, ending on the current UTC day); the echoed window size is
 * `requestedDays`. `chartSeries(payload, metric)` projects that array onto the
 * popover's `{ label, value }` points.
 *
 * Data-source facts verified on this host (2026-09-17):
 *   - The log is NOT a single frame: it is a container of concatenated,
 *     independently decodable Zstandard frames (266 in the session inspected),
 *     one per durable event batch. Node's one-shot `zstdDecompressSync` reads
 *     exactly ONE frame of such a container — it returns only the first frame's
 *     plaintext (measured: 277 B of a 592 KB log) and never yields the rest — so
 *     every frame boundary is resolved structurally (frame header + block
 *     headers, exactly like `@deepseek-ai/dsh-session-persistence-jsonl`'s
 *     `scanZstdFrames`) and each frame is decoded on its own. Frame boundaries
 *     are never guessed from magic-byte search, because compressed payloads can
 *     embed the magic (a naive scan found 286 "frames" where 266 were real).
 *   - `assistant/message` carries `data.usage` (TokenUsage:
 *     inputTokens/outputTokens required; cacheReadTokens, cacheWriteTokens,
 *     reasoningTokens optional) and the routing model at
 *     `data.message.source.model`. `@deepseek-ai/dsh-llm-deepseek`'s `mapUsage`
 *     folds DeepSeek's `prompt_cache_hit_tokens` into `cacheReadTokens` and
 *     subtracts it out of `inputTokens`, so the input/cache-read counts are
 *     already disjoint: inputTokens is the cache MISS side. `reasoningTokens` is
 *     a SUBSET of `outputTokens` on the wire, so it is never added again.
 *   - Usage is deduplicated per (session, turn, step) exactly like
 *     `dsh-token-meter`'s projection, so an in-progress turn's live snapshot,
 *     its final settlement, and a retried attempt are each billed once.
 *
 * This module imports only `node:*`. It never reads or returns credential
 * material, and never touches the official runtime packages.
 *
 * @module dsh-deepseek-usage/host/ledger
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
// Namespace import, not a named one: on a Node build without Zstandard the named
// export does not exist and a named import would make this whole module fail to
// LOAD, taking the host's plugin activation down with it. Reaching the decoder
// through the namespace turns that into the runtime `available: false` signal.
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ *
 * Pricing
 * ------------------------------------------------------------------ */

/**
 * Published DeepSeek prices in CNY (元) per 1,000,000 tokens, keyed by canonical
 * model id. `peak` is the price during the peak windows, `offPeak` outside
 * them; the published peak price is exactly twice the off-peak price.
 *
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing (fetched 2026-09-18).
 *
 * WHY CNY AND NOT THE ENGLISH PAGE'S USD: the two pages quote DIFFERENT numbers for
 * the same model. The Chinese page is the yuan list (flash: 0.02/0.04 元 cache hit,
 * 1/2 元 cache miss, 4/8 元 output; pro: 0.15/0.30, 4.5/9.0, 13.5/27.0) and the
 * English page is the dollar one (0.003/0.006, 0.15/0.3, 0.6/1.2; 0.022/0.044,
 * 0.66/1.32, 1.98/3.96). They are NOT the same magnitude — an earlier revision
 * copied the dollar numbers and labelled them as the yuan price, which understated
 * the estimate by roughly 3x against the official yuan list. The DeepSeek account
 * this plugin reports on is billed in CNY (the balance payload carries CNY and
 * `balance.mjs` prefers it), so the yuan list is the one that matches the bill.
 *
 * Every number here is an ESTIMATE input, not a billed amount: the host's own
 * invoice is authoritative, and an unknown model is priced at 0 rather than
 * guessed.
 */
export const PRICE_TABLE_CNY_PER_MILLION = Object.freeze({
  "deepseek-flash": Object.freeze({
    peak: Object.freeze({ cacheRead: 0.04, cacheMiss: 2, output: 8 }),
    offPeak: Object.freeze({ cacheRead: 0.02, cacheMiss: 1, output: 4 }),
  }),
  "deepseek-v4-pro": Object.freeze({
    peak: Object.freeze({ cacheRead: 0.3, cacheMiss: 9, output: 27 }),
    offPeak: Object.freeze({ cacheRead: 0.15, cacheMiss: 4.5, output: 13.5 }),
  }),
});

/** Where {@link PRICE_TABLE_CNY_PER_MILLION} came from, and when it was read. */
export const PRICE_TABLE_SOURCE = Object.freeze({
  url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
  fetchedOn: "2026-09-18",
  currency: "CNY",
  unit: "per 1,000,000 tokens",
  peakMultiplier: 2,
  // Beijing time 09:00-12:00 and 14:00-18:00 on weekdays, which is the SAME instant
  // as the English page's "01:00-04:00 and 06:00-10:00 UTC" — so the windows already
  // encoded below are unchanged; they stay in UTC because that is what the session
  // events carry.
  peakWindowsLocal: Object.freeze([
    Object.freeze({ startHour: 9, endHour: 12 }),
    Object.freeze({ startHour: 14, endHour: 18 }),
  ]),
  peakWindowsUtc: Object.freeze([
    Object.freeze({ startHour: 1, endHour: 4 }),
    Object.freeze({ startHour: 6, endHour: 10 }),
  ]),
  peakWeekdays: Object.freeze(["Mon", "Tue", "Wed", "Thu", "Fri"]),
});

/** Every model id the pricing table knows, canonical spelling first. */
export const KNOWN_MODEL_IDS = Object.freeze(Object.keys(PRICE_TABLE_CNY_PER_MILLION));

/**
 * Session events spell a model in more than one way (routing label vs. provider
 * id). Only exact, intended aliases are mapped; nothing is inferred from a
 * prefix or a fuzzy match.
 */
const MODEL_ALIASES = Object.freeze({
  "deepseek-flash": "deepseek-flash",
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-chat": "deepseek-flash",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-pro": "deepseek-v4-pro",
  "deepseek-reasoner": "deepseek-v4-pro",
});

/** Model bucket for an event whose routing model cannot be read. Never guessed. */
export const UNKNOWN_MODEL = "unknown";

/** Hard cap on the chart window, matching the frozen HTTP contract. */
export const MAX_DAYS = 365;

/** Default chart window in days, matching the frozen HTTP contract. */
export const DEFAULT_DAYS = 30;

/** Wall-clock budget for one aggregation; on expiry the partial result is marked truncated. */
export const DEFAULT_BUDGET_MS = 15_000;

/** Version tag of the on-disk incremental index; a mismatch re-reads from scratch. */
const CACHE_VERSION = 1;

/** Files whose session log is the ledger's only data source. */
const SESSION_LOG_FILENAME = "session.v3.jsonl.zstd";

/** Zstandard frame magic, little-endian on disk (0xFD2FB528). */
const ZSTD_MAGIC = 0xfd2fb528;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** UTC calendar day (`YYYY-MM-DD`) of an instant. */
export function utcDay(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** True when `day` is a well-formed `YYYY-MM-DD` whose canonical spelling is itself. */
function isCalendarDay(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed) && utcDay(parsed) === day;
}

/** `day` shifted by `delta` calendar days, computed in UTC. */
function shiftDay(day, delta) {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000);
}

/** Non-negative finite number, or `fallback` for anything else (including `NaN`). */
function count(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Stable short digest of a path, used to name one file's cache entry. */
function pathDigest(path) {
  return createHash("sha1").update(path).digest("hex").slice(0, 20);
}

/* ------------------------------------------------------------------ *
 * Cost estimation
 * ------------------------------------------------------------------ */

/** Peak pricing applies Mon-Fri, in [01:00,04:00) or [06:00,10:00) UTC. */
export function isPeakInstant(epochMs) {
  const at = new Date(epochMs);
  const weekday = at.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const hour = at.getUTCHours();
  for (const { startHour, endHour } of PRICE_TABLE_SOURCE.peakWindowsUtc) {
    if (hour >= startHour && hour < endHour) return true;
  }
  return false;
}

/** Canonical table key for a session-reported model, or `undefined` when unknown. */
export function priceKeyForModel(model) {
  if (typeof model !== "string") return undefined;
  const trimmed = model.trim().toLowerCase();
  if (trimmed === "") return undefined;
  return MODEL_ALIASES[trimmed];
}

/** The rates in force for one model at one instant, or `undefined` when unknown. */
export function ratesForModel(model, epochMs) {
  const key = priceKeyForModel(model);
  if (key === undefined) return undefined;
  const entry = PRICE_TABLE_CNY_PER_MILLION[key];
  if (entry === undefined) return undefined;
  return isPeakInstant(epochMs) ? entry.peak : entry.offPeak;
}

/**
 * Estimated USD cost of ONE provider call, priced by the instant it happened.
 * Peak status is per call, never per bucket: two calls on the same day-bucket
 * are priced separately when one lands inside a peak window and one outside.
 * @param {{inputTokens?: number, cacheReadTokens?: number, outputTokens?: number}} tokens
 *   Disjoint token counts (cache misses, cache hits, output).
 * @param {string} model - routing model as reported by the session.
 * @param {number} epochMs - when the call happened.
 * @returns {number} USD, or 0 for a model the pricing table does not know.
 */
export function estimateCallCostCny(tokens, model, epochMs) {
  const rates = ratesForModel(model, epochMs);
  if (rates === undefined) return 0;
  const miss = count(tokens?.inputTokens);
  const hit = count(tokens?.cacheReadTokens);
  const output = count(tokens?.outputTokens);
  return (miss * rates.cacheMiss + hit * rates.cacheRead + output * rates.output) / 1_000_000;
}

/* ------------------------------------------------------------------ *
 * Zstandard frame container reader
 * ------------------------------------------------------------------ */

/** Structural frame boundaries of a concatenated-frame Zstandard container. */
export function scanZstdFrames(buffer) {
  const frames = [];
  let tornStart;
  let skippedBytes = 0;
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.indexOf(ZSTD_MAGIC, offset) !== offset) {
      // Not a frame start: the final frame of a live-appended log can be torn,
      // and a foreign byte run can only be trailing garbage. Never guess a
      // boundary inside compressed payload.
      if (buffer.length - offset < 4) tornStart = start;
      else skippedBytes += buffer.length - offset;
      break;
    }
    const walked = walkFrame(buffer, start);
    if (walked === undefined) {
      tornStart = start;
      break;
    }
    frames.push({ start, end: walked });
    offset = walked;
  }

  return { frames, tornStart, skippedBytes };
}

/**
 * End offset of the structurally complete frame starting at `start`, or
 * `undefined` when the frame is torn or malformed.
 */
function walkFrame(buffer, start) {
  let offset = start + 4;
  if (offset >= buffer.length) return undefined;
  const descriptor = buffer.readUInt8(offset);
  offset += 1;
  if ((descriptor & 24) !== 0) return undefined;

  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (buffer.length - offset < remainingHeaderBytes) return undefined;
  offset += remainingHeaderBytes;

  for (;;) {
    if (buffer.length - offset < 3) return undefined;
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 3;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) return undefined;
    const payloadBytes = blockType === 1 ? 1 : blockSize;
    if (buffer.length - offset < payloadBytes) return undefined;
    offset += payloadBytes;
    if (lastBlock) break;
  }

  if (checksum) {
    if (buffer.length - offset < 4) return undefined;
    offset += 4;
  }
  return offset;
}

/** One-shot decoder shape this module needs (`zstdDecompressSync`). */
function isDecodingFunction(value) {
  return typeof value === "function";
}

/**
 * Decode a whole concatenated-frame container to UTF-8 text, counting the
 * frames and bytes that could not be decoded instead of throwing: one corrupt
 * batch must not hide the rest of a session.
 * @param {Buffer} buffer - raw container bytes.
 * @param {(frame: Buffer) => Buffer} decompress - single-frame decoder.
 * @returns {{text: string, frames: number, badFrames: number, skippedBytes: number, torn: boolean}}
 */
export function decodeZstdContainer(buffer, decompress) {
  const { frames, tornStart, skippedBytes } = scanZstdFrames(buffer);
  const parts = [];
  let badFrames = 0;
  for (const { start, end } of frames) {
    try {
      const decoded = decompress(buffer.subarray(start, end));
      parts.push(Buffer.isBuffer(decoded) ? decoded.toString("utf8") : String(decoded));
    } catch {
      badFrames += 1;
    }
  }
  return {
    text: parts.join(""),
    frames: frames.length,
    badFrames,
    skippedBytes,
    torn: tornStart !== undefined,
  };
}

/**
 * Resolve the decoder. Returns `undefined` when the running Node cannot decode
 * Zstandard (Node < 22.15 has no `node:zlib` zstd entry points), so callers can
 * report `zstd_unavailable` instead of crashing the host at load time.
 * @param {((frame: Buffer) => Buffer) | undefined} override - injected decoder.
 */
export function resolveZstdDecompress(override) {
  if (override !== undefined) return isDecodingFunction(override) ? override : undefined;
  return isDecodingFunction(zlib.zstdDecompressSync) ? zlib.zstdDecompressSync : undefined;
}

/* ------------------------------------------------------------------ *
 * Event parsing
 * ------------------------------------------------------------------ */

/** Numeric usage sample, or `undefined` when the value is not a usage report. */
function normalizeUsage(usage) {
  if (typeof usage !== "object" || usage === null) return undefined;
  if (typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") return undefined;
  if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return undefined;
  return Object.freeze({
    inputTokens: count(usage.inputTokens),
    cacheReadTokens: count(usage.cacheReadTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens),
    outputTokens: count(usage.outputTokens),
    reasoningTokens: count(usage.reasoningTokens),
  });
}

/** The last stream chunk of one type, searched from the end (streams are ordered). */
function lastStreamChunk(stream, type) {
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const entry = stream[index];
    if (typeof entry === "object" && entry !== null && entry.type === type) return entry;
  }
  return undefined;
}

/**
 * Usage of one assistant settlement: the durable `data.usage` when present,
 * otherwise the last usage chunk embedded in the stream — the same precedence
 * `@deepseek-ai/dsh-token-meter` uses.
 */
function usageOfEvent(event) {
  const data = event.data;
  if (typeof data !== "object" || data === null) return undefined;
  const direct = normalizeUsage(data.usage);
  if (direct !== undefined) return direct;
  return normalizeUsage(lastStreamChunk(data.stream, "usage")?.usage);
}

/**
 * Normalized usage sample of one session event, or `undefined` for any event
 * that reports no usage. Recognizes both `assistant/message` (the durable
 * settlement) and `assistant/attempt`.
 */
export function usageSampleOf(event) {
  if (typeof event !== "object" || event === null) return undefined;
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return undefined;
  const usage = usageOfEvent(event);
  if (usage === undefined) return undefined;

  const data = event.data ?? {};
  const message = typeof data.message === "object" && data.message !== null ? data.message : {};
  const source = typeof message.source === "object" && message.source !== null ? message.source : {};
  const rawModel = typeof source.model === "string" ? source.model.trim() : "";
  const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : undefined;
  const turn = Number.isInteger(data.turn) ? data.turn : undefined;
  const step = Number.isInteger(data.step) ? data.step : undefined;

  return Object.freeze({
    time,
    model: rawModel === "" ? UNKNOWN_MODEL : rawModel,
    turn,
    step,
    usage,
  });
}

/* ------------------------------------------------------------------ *
 * One session log -> running totals
 * ------------------------------------------------------------------ */

/**
 * Fold one decoded session log into running totals. Usage is deduplicated per
 * (turn, step) and the LAST sample wins, so a turn's live snapshot followed by
 * its final settlement is counted once; a session whose turn/step counters are
 * missing falls back to one sample per event.
 * @param {string} text - decoded JSONL text.
 * @param {{now?: number, stats: object}} options
 */
function foldSessionText(text, { now, stats }) {
  /** @type {Map<string, {date: string, model: string, usage: object, epochMs: number|undefined}>} */
  const byStep = new Map();
  const sequentials = [];
  let fallbackInstant;

  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") continue;
    stats.lines += 1;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      stats.malformedLines += 1;
      continue;
    }

    if (event?.type === "session" && typeof event.createdAt === "number" && fallbackInstant === undefined) {
      fallbackInstant = event.createdAt;
      continue;
    }

    const sample = usageSampleOf(event);
    if (sample === undefined) continue;

    // Dated by the event, else by the session header's clock, else by the run.
    // Counted as a fallback exactly once per sample.
    let epochMs = sample.time;
    if (epochMs === undefined || !Number.isFinite(epochMs)) {
      stats.missingTime += 1;
      epochMs = fallbackInstant ?? now;
    }
    if (!Number.isFinite(epochMs)) epochMs = now;

    const entry = { date: utcDay(epochMs), model: sample.model, usage: sample.usage, epochMs };
    if (sample.turn !== undefined && sample.step !== undefined) {
      byStep.set(`${sample.turn}:${sample.step}`, entry);
    } else {
      sequentials.push(entry);
    }
  }

  for (const entry of [...byStep.values(), ...sequentials]) {
    const { date, model, usage } = entry;
    stats.usages += 1;
    const cost = estimateCallCostCny(usage, model, entry.epochMs ?? now);
    if (priceKeyForModel(model) === undefined) stats.unknownModelUsages += 1;
    keyedBucket(stats.byDayModel, date, model, (bucket) => {
      bucket.inputTokens += usage.inputTokens;
      bucket.cacheReadTokens += usage.cacheReadTokens;
      bucket.cacheWriteTokens += usage.cacheWriteTokens;
      bucket.outputTokens += usage.outputTokens;
      bucket.reasoningTokens += usage.reasoningTokens;
      bucket.estimatedCostCny += cost;
    });
  }
}

/** Get-or-create a bucketed counter inside a two-level day/model map. */
function keyedBucket(map, day, model, mutate) {
  let models = map.get(day);
  if (models === undefined) {
    models = new Map();
    map.set(day, models);
  }
  let bucket = models.get(model);
  if (bucket === undefined) {
    bucket = {
      model,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedCostCny: 0,
      usages: 0,
    };
    models.set(model, bucket);
  }
  mutate(bucket);
  bucket.usages += 1;
  return bucket;
}

/** Plain, JSON-serializable day list from a day/model map (dates ascending). */
function daysFromMap(byDayModel) {
  return [...byDayModel.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, models]) => [
      date,
      [...models.values()]
        .sort((left, right) => (left.model < right.model ? -1 : left.model > right.model ? 1 : 0))
        .map((bucket) => ({ ...bucket })),
    ]);
}

/** Merge serialized `[[date, [bucket, ...]], ...]` day lists into a day/model map. */
function mergeDayLists(target, lists) {
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const pair of list) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [day, buckets] = pair;
      if (!isCalendarDay(day) || !Array.isArray(buckets)) continue;
      for (const bucket of buckets) {
        if (typeof bucket !== "object" || bucket === null || typeof bucket.model !== "string") continue;
        keyedBucket(target, day, bucket.model, (into) => {
          into.inputTokens += count(bucket.inputTokens);
          into.cacheReadTokens += count(bucket.cacheReadTokens);
          into.cacheWriteTokens += count(bucket.cacheWriteTokens);
          into.outputTokens += count(bucket.outputTokens);
          into.reasoningTokens += count(bucket.reasoningTokens);
          into.estimatedCostCny += count(bucket.estimatedCostCny);
          into.usages += count(bucket.usages);
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Incremental index (mtime + size keyed)
 * ------------------------------------------------------------------ */

/**
 * Directory of the on-disk incremental index for one host.
 *
 * The location is `%DSH_HOME%\storages\<plugin>\ledger-cache` — the host's designated
 * home for plugin state — and the fallback (no `DSH_HOME`: a bare script, a test run)
 * is the OS temp home. Both halves matter:
 *
 *  - an earlier revision returned `%DSH_HOME%\plugins\dsh-deepseek-usage\.ledger-cache`.
 *    That looks external, but a plugin INSTALLED at `%DSH_HOME%\plugins\<name>` makes it
 *    the package directory itself, so the cache landed inside the installed tree — the
 *    exact thing `plugin.mjs#defaultLedgerCacheDir` documents as forbidden, and which
 *    `tests/host-integration.test.mjs` asserts against with a temp home;
 *  - the fallback must not resolve relative to the process CWD either, for the same
 *    reason (the host's CWD is typically the package or a parent of it).
 *
 * This mirrors `plugin.mjs#defaultLedgerCacheDir` exactly; the two are the same ruling
 * stated twice because neither module may import the other's default.
 *
 * @param env - environment to read (`DSH_HOME` locates the host home).
 * @returns the absolute cache directory for the ledger index.
 */
export function defaultCacheDir(env = process.env) {
  const configured = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  const home = configured === "" ? join(tmpdir(), "dsh-home") : configured;
  return join(home, "storages", "dsh-deepseek-usage", "ledger-cache");
}

/** `<DSH_HOME>/sessions` for this host. */
export function defaultSessionsRoot(env = process.env) {
  const home = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "sessions");
}

/** Recursively collect `session.v3.jsonl.zstd` files, tolerating unreadable directories. */
export function listSessionLogs(root) {
  const found = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === SESSION_LOG_FILENAME) found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

/**
 * Stable fingerprint of the published price list (model ids, window names and rates).
 *
 * WHY THIS EXISTS: the on-disk index is keyed on each session log's `mtimeMs` + `size`,
 * so it knows when the LOG changed but nothing about when the PRICES changed. Costs are
 * computed while a log is decoded, which means editing {@link PRICE_TABLE_CNY_PER_MILLION}
 * — or the currency it is denominated in — left every already-indexed log serving its old
 * cost for as long as its file stayed untouched. That is exactly what happened when the
 * table moved from the English page's dollars to the Chinese page's yuan: the figures
 * stayed at the old basis until the cache was invalidated. Folding this digest into the
 * cache makes a price change self-invalidating.
 *
 * @returns a short, stable digest string.
 */
function priceDigest() {
  const parts = [];
  for (const id of Object.keys(PRICE_TABLE_CNY_PER_MILLION)) {
    const entry = PRICE_TABLE_CNY_PER_MILLION[id];
    for (const windowName of Object.keys(entry)) {
      const rates = entry[windowName];
      parts.push(`${id}|${windowName}|${rates.cacheRead}|${rates.cacheMiss}|${rates.output}`);
    }
  }
  parts.push(`currency=${PRICE_TABLE_SOURCE.currency}`);
  return `${createHash("sha256").update(parts.join(";")).digest("hex").slice(0, 16)}`;
}

/**
 * On-disk index for one host: one JSON document per session log, keyed by the
 * log's `mtimeMs` + `size`, plus the price list's own fingerprint so a price change
 * invalidates every entry (see {@link priceDigest}).
 */
function createIndex(cacheDir) {
  /** @type {Map<string, object>} */
  const records = new Map();
  const prices = priceDigest();

  const read = () => {
    const indexPath = join(cacheDir, "index.json");
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
      if (parsed?.version !== CACHE_VERSION || typeof parsed.files !== "object" || parsed.files === null) return;
      // A cache written under a different price list describes different money: treat
      // the whole index as empty rather than mixing two price bases in one report.
      if (parsed.prices !== prices) return;
      for (const [path, record] of Object.entries(parsed.files)) {
        if (record === null || typeof record !== "object") continue;
        const digest = pathDigest(path);
        const aggregatePath = join(cacheDir, `${digest}.json`);
        try {
          const stored = JSON.parse(readFileSync(aggregatePath, "utf8"));
          if (stored?.version !== CACHE_VERSION) continue;
          records.set(path, {
            mtimeMs: count(record.mtimeMs),
            size: count(record.size),
            lines: count(record.lines),
            decode: {
              frames: count(record.frames),
              badFrames: count(record.badFrames),
              skippedBytes: count(record.skippedBytes),
              torn: record.torn === true,
              malformedLines: count(record.malformedLines),
              missingTime: count(record.missingTime),
            },
            days: Array.isArray(stored.days) ? stored.days : [],
          });
        } catch {
          // A missing or unreadable aggregate body is a cache miss, never a failure.
        }
      }
    } catch {
      // A missing index is simply an empty cache.
    }
  };

  const write = (observedAt) => {
    try {
      mkdirSync(cacheDir, { recursive: true });
    } catch {
      return;
    }
    const files = {};
    for (const [path, record] of records) {
      const digest = pathDigest(path);
      const aggregatePath = join(cacheDir, `${digest}.json`);
      // Prune entries whose session disappeared: keeping them would make the
      // ledger report usage for logs the user deleted.
      if (!existsSync(path)) {
        records.delete(path);
        try {
          writeFileSync(join(cacheDir, `${digest}.json`), "", "utf8");
        } catch {
          // Best effort; a stale aggregate body is ignored on the next read.
        }
        continue;
      }
      files[path] = {
        mtimeMs: record.mtimeMs,
        size: record.size,
        lines: record.lines,
        frames: record.decode.frames,
        badFrames: record.decode.badFrames,
        skippedBytes: record.decode.skippedBytes,
        torn: record.decode.torn,
        malformedLines: record.decode.malformedLines,
        missingTime: record.decode.missingTime,
        seenAt: observedAt,
        digest,
      };
      try {
        writeFileSync(aggregatePath, JSON.stringify({ version: CACHE_VERSION, path, days: record.days }), "utf8");
      } catch {
        // Best effort: an unwritable body just means this file re-reads next time.
      }
    }
    try {
      writeFileSync(join(cacheDir, "index.json"), JSON.stringify({ version: CACHE_VERSION, prices, files }), "utf8");
    } catch {
      // Best effort: an unwritable index just means a full re-read next time.
    }
  };

  return { records, read, write };
}

/** Stat one candidate log; `undefined` when it vanished between listing and stat. */
function safeStat(path) {
  try {
    const info = statSync(path);
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size, mtimeMsInt: Math.trunc(info.mtimeMs) } : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Public aggregation entry point
 * ------------------------------------------------------------------ */

/** The day/model buckets of one session log, as stored in the cache. */
function readSessionLog(path, { decompress, now }) {
  const raw = readFileSync(path);
  const decoded = decodeZstdContainer(raw, decompress);
  const stats = {
    lines: 0,
    malformedLines: 0,
    missingTime: 0,
    usages: 0,
    unknownModelUsages: 0,
    byDayModel: new Map(),
  };
  foldSessionText(decoded.text, { now, stats });
  return {
    decode: {
      frames: decoded.frames,
      badFrames: decoded.badFrames,
      skippedBytes: decoded.skippedBytes,
      torn: decoded.torn,
      malformedLines: stats.malformedLines,
      missingTime: stats.missingTime,
    },
    usages: stats.usages,
    unknownModelUsages: stats.unknownModelUsages,
    days: daysFromMap(stats.byDayModel),
  };
}

/**
 * Aggregate local session-log usage into per-(day, model) buckets with an
 * estimated USD cost.
 *
 * Unchanged logs are served from the incremental index (keyed by mtime + size)
 * and never re-decompressed; a log that grew or was rewritten is re-read whole,
 * because its per-(turn, step) samples are deduplicated within the file.
 *
 * @param {object} [options]
 * @param {number} [options.days] - window size; defaults to 30, capped at 365.
 * @param {string} [options.sessionsRoot] - `<DSH_HOME>/sessions` by default.
 * @param {string|null} [options.cacheDir] - incremental index directory; `null`
 *   disables disk caching and re-reads every log.
 * @param {number} [options.now] - reference instant (tests); defaults to `Date.now()`.
 * @param {number} [options.budgetMs] - wall-clock budget; on expiry the partial
 *   result carries `truncated: true` instead of throwing.
 * @param {(frame: Buffer) => Buffer} [options.decompress] - injected single-frame
 *   decoder (tests); defaults to `node:zlib`'s `zstdDecompressSync`.
 * @param {(root: string) => string[]} [options.listFiles] - injected log lister.
 * @returns {object} the frozen `/usage` payload shape plus ledger diagnostics.
 */
export function aggregateUsage(options = {}) {
  const {
    days: rawDays = DEFAULT_DAYS,
    sessionsRoot = defaultSessionsRoot(),
    cacheDir = defaultCacheDir(),
    now = Date.now(),
    budgetMs = DEFAULT_BUDGET_MS,
    decompress: decompressOption,
    listFiles = listSessionLogs,
  } = options;

  const requestedDays = Math.max(1, Math.min(MAX_DAYS, Math.trunc(Number(rawDays)) || DEFAULT_DAYS));
  const today = utcDay(now);
  const windowStart = shiftDay(today, -(requestedDays - 1));
  // A log touched before the window cannot contribute an in-window sample
  // (event time never trails its own file mtime by more than a session's life),
  // so old history is skipped without being opened.
  const candidateFloor = Date.parse(`${windowStart}T00:00:00.000Z`) - 2 * 86_400_000;
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, budgetMs);

  const stats = {
    usages: 0,
    unknownModelUsages: 0,
    malformedLines: 0,
    missingTime: 0,
    badFrames: 0,
    skippedBytes: 0,
    tornFrames: 0,
    filesListed: 0,
    filesSkippedOld: 0,
    filesRead: 0,
    filesFromCache: 0,
    filesUnreadable: 0,
    unreadableFiles: [],
  };
  const byDayModel = new Map();

  const decompress = resolveZstdDecompress(decompressOption);
  let truncated = false;
  let unavailableReason;

  if (decompress === undefined && decompressOption === undefined) {
    unavailableReason = "this Node build exposes no node:zlib Zstandard decoder";
  }

  const index = cacheDir === null || cacheDir === undefined ? undefined : createIndex(resolve(cacheDir));
  index?.read();

  /** Fold one session log's stored day list into the result and the diagnostics. */
  const absorb = (record) => {
    mergeDayLists(byDayModel, [record.days]);
    stats.badFrames += count(record.decode.badFrames);
    stats.skippedBytes += count(record.decode.skippedBytes);
    stats.malformedLines += count(record.decode.malformedLines);
    stats.missingTime += count(record.decode.missingTime);
    if (record.decode.torn) stats.tornFrames += 1;
  };

  if (unavailableReason === undefined) {
    const logs = listFiles(sessionsRoot);
    stats.filesListed = logs.length;

    for (const path of logs) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      const info = safeStat(path);
      if (info === undefined) {
        stats.filesUnreadable += 1;
        continue;
      }
      if (info.mtimeMs < candidateFloor) {
        stats.filesSkippedOld += 1;
        continue;
      }

      const cached = index?.records.get(path);
      if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        stats.filesFromCache += 1;
        absorb(cached);
        continue;
      }

      let record;
      try {
        record = readSessionLog(path, { decompress, now });
      } catch (error) {
        // One unreadable or undecodable log must not fail the whole ledger.
        stats.filesUnreadable += 1;
        if (stats.unreadableFiles.length < 8) stats.unreadableFiles.push({ file: basename(path), reason: String(error?.message ?? error) });
        continue;
      }
      if (record.decode.frames === 0) {
        // Nothing decoded at all: either the file is not a Zstandard container or
        // its only frame was torn before any plaintext. Report it instead of
        // pretending the session contributed nothing.
        stats.filesUnreadable += 1;
        if (stats.unreadableFiles.length < 8) {
          stats.unreadableFiles.push({ file: basename(path), reason: "no decodable Zstandard frame" });
        }
        index?.records.delete(path);
        continue;
      }

      stats.filesRead += 1;
      stats.usages += record.usages;
      stats.unknownModelUsages += record.unknownModelUsages;
      record.mtimeMs = info.mtimeMs;
      record.size = info.size;
      record.lines = record.decode.malformedLines;
      index?.records.set(path, record);
      absorb(record);
    }
  }

  if (index !== undefined) index.write(Date.now());

  // Window + zero-fill: exactly one bucket per requested day, ascending, ending today.
  const dayBuckets = [];
  for (let offset = 0; offset < requestedDays; offset += 1) {
    const date = shiftDay(windowStart, offset);
    const models = [...(byDayModel.get(date) ?? new Map()).values()].sort((left, right) =>
      left.model < right.model ? -1 : left.model > right.model ? 1 : 0,
    );
    dayBuckets.push({
      date,
      models: models.map((bucket) => ({
        model: bucket.model,
        inputTokens: bucket.inputTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        outputTokens: bucket.outputTokens,
        estimatedCostCny: roundCostCny(bucket.estimatedCostCny),
      })),
    });
  }

  const totals = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, estimatedCostCny: 0 };
  for (const day of dayBuckets) {
    for (const model of day.models) {
      totals.inputTokens += model.inputTokens;
      totals.cacheReadTokens += model.cacheReadTokens;
      totals.outputTokens += model.outputTokens;
      totals.estimatedCostCny += model.estimatedCostCny;
    }
  }
  totals.estimatedCostCny = roundCostCny(totals.estimatedCostCny);

  return {
    ok: true,
    requestedDays,
    days: dayBuckets,
    generatedAt: new Date(now).toISOString(),
    truncated,
    totals,
    estimated: true,
    priceSource: PRICE_TABLE_SOURCE,
    ledger: {
      sessionsRoot: resolve(sessionsRoot),
      windowStart,
      windowEnd: today,
      elapsedMs: Date.now() - startedAt,
      filesListed: stats.filesListed,
      filesRead: stats.filesRead,
      filesFromCache: stats.filesFromCache,
      filesSkippedOld: stats.filesSkippedOld,
      filesUnreadable: stats.filesUnreadable,
      unreadableFiles: stats.unreadableFiles,
      usages: stats.usages,
      unknownModelUsages: stats.unknownModelUsages,
      malformedLines: stats.malformedLines,
      missingTime: stats.missingTime,
      badFrames: stats.badFrames,
      tornFrames: stats.tornFrames,
      skippedBytes: stats.skippedBytes,
      available: unavailableReason === undefined,
      unavailableReason,
    },
  };
}

/** Costs are estimates; 12 decimal places is far below a cent and keeps sums stable. */
function roundCostCny(value) {
  return Math.round(value * 1e12) / 1e12;
}

/**
 * Project an {@link aggregateUsage} payload onto the popover chart's point
 * shape: exactly one `{ label, value }` per day bucket, ascending.
 * @param {object} payload - an `aggregateUsage` result.
 * @param {"totalTokens"|"inputTokens"|"cacheReadTokens"|"outputTokens"|"estimatedCostCny"} [metric]
 */
export function chartSeries(payload, metric = "totalTokens") {
  const days = Array.isArray(payload?.days) ? payload.days : [];
  return days.map((day) => {
    const models = Array.isArray(day?.models) ? day.models : [];
    let value = 0;
    for (const model of models) {
      if (metric === "totalTokens") {
        value += count(model.inputTokens) + count(model.cacheReadTokens) + count(model.outputTokens);
      } else if (metric === "estimatedCostCny") {
        value += count(model.estimatedCostCny);
      } else {
        value += count(model[metric]);
      }
    }
    return { label: day.date, value: metric === "estimatedCostCny" ? roundCostCny(value) : value };
  });
}

export default aggregateUsage;
