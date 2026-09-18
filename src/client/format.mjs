/**
 * dsh-deepseek-usage — browser-half formatting helpers.
 *
 * Pure functions only: no DOM, no React, no network, no clock of their own
 * (`nowMs` is always passed in), so every branch is testable in plain node.
 * They turn the host's frozen balance envelope into the strings the sidebar row
 * shows. `tests/ui-row.test.mjs` asserts the values — never pixels.
 *
 * COMPOSITION NOTE: the browser bundle is a classic script and cannot use ESM,
 * so this module is inlined **verbatim** into `lib/client.js` (see the
 * `createClientHalf` slot there). Keep every `export ` at a line start — the
 * composer strips that keyword and nothing else — and let the equivalence test
 * in `tests/ui-row.test.mjs` prove the inlined copy has not drifted.
 *
 * @module dsh-deepseek-usage/client/format
 */

/** What every formatter returns for a missing or unusable value. */
export const EMPTY_VALUE = "—";

/** The row's placeholder while a read is in flight (visually distinct from {@link EMPTY_VALUE}). */
export const PENDING_VALUE = "…";

/**
 * Above this magnitude `Number.prototype.toFixed` switches to exponential
 * notation (`(1e21).toFixed(2) === "1e+21"`), which would smuggle an `e+21` into
 * a money string. Values at or above it are rendered as an explicit exponential.
 */
const EXPONENTIAL_THRESHOLD = 1e21;

/**
 * Symbol per ISO-4217 code, for the codes DeepSeek actually reports plus the
 * common ones. An unknown-but-valid code renders as `<amount> <CODE>`.
 */
const CURRENCY_SYMBOLS = Object.freeze({
  CNY: "¥",
  RMB: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  HKD: "HK$",
});

/** Matching unit ladder for {@link formatCompactNumber}, largest first. */
const COMPACT_UNITS = Object.freeze([
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
]);

/**
 * Coerce one envelope field to a finite number.
 * @param value - number, numeric string, or anything else.
 * @returns the finite number, or `null` when the value is unusable.
 */
export function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Group the integer part of a decimal string with thousands separators.
 * @param intText - digits without sign or separators.
 * @returns the grouped text.
 */
export function groupDigits(intText) {
  return intText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format a balance amount: grouping, fixed decimals, `EMPTY_VALUE` for junk.
 * @param value - the raw amount (number or numeric string).
 * @param decimals - decimal places (default 2; an out-of-range value falls back to 2).
 * @returns the formatted amount, or {@link EMPTY_VALUE}.
 */
export function formatAmount(value, decimals = 2) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return EMPTY_VALUE;
  const places = Number.isInteger(decimals) && decimals >= 0 && decimals <= 6 ? decimals : 2;
  if (Math.abs(numeric) >= EXPONENTIAL_THRESHOLD) return numeric.toExponential(places);
  const fixed = numeric.toFixed(places);
  // `(-0.001).toFixed(2)` is "-0.00": a rounded-away value must not keep the sign.
  const negative = fixed.startsWith("-") && Number(fixed) !== 0;
  const digits = fixed.startsWith("-") ? fixed.slice(1) : fixed;
  const dot = digits.indexOf(".");
  const integerPart = dot === -1 ? digits : digits.slice(0, dot);
  const fractionPart = dot === -1 ? "" : digits.slice(dot);
  const grouped = `${groupDigits(integerPart)}${fractionPart}`;
  return negative ? `-${grouped}` : grouped;
}

/**
 * Reduce a currency field to an uppercase three-letter code.
 * @param currency - the envelope's `currency` (e.g. `"CNY"`, `"rmb"`, `""`).
 * @returns the code, or `null` when the value is not a three-letter code.
 */
export function normalizeCurrency(currency) {
  if (typeof currency !== "string") return null;
  const trimmed = currency.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : null;
}

/**
 * Look up a currency symbol.
 * @param currency - any currency field value.
 * @returns the symbol, or `null` when the code is unknown/absent.
 */
export function currencySymbol(currency) {
  const code = normalizeCurrency(currency);
  if (code === null) return null;
  return Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code) ? CURRENCY_SYMBOLS[code] : null;
}

/**
 * Format an amount together with its currency.
 * @param value - the raw amount.
 * @param currency - the envelope's currency field.
 * @returns `¥12.34` / `12.34 XYZ` / `12.34` (no currency) / {@link EMPTY_VALUE}.
 */
export function formatMoney(value, currency) {
  const amount = formatAmount(value);
  if (amount === EMPTY_VALUE) return EMPTY_VALUE;
  const code = normalizeCurrency(currency);
  if (code === null) return amount;
  const symbol = currencySymbol(code);
  return symbol === null ? `${amount} ${code}` : `${symbol}${amount}`;
}

/**
 * Format a count (tokens, requests) compactly for narrow UI.
 * @param value - the raw count.
 * @returns `12.3k` / `1M` / `999,999` / {@link EMPTY_VALUE}.
 */
export function formatCompactNumber(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return EMPTY_VALUE;
  const abs = Math.abs(numeric);
  const sign = numeric < 0 ? "-" : "";
  if (abs < 1000) return `${sign}${formatAmount(abs, 0)}`;
  for (const [scale, suffix] of COMPACT_UNITS) {
    if (abs < scale) continue;
    const rounded = Math.round((abs / scale) * 10) / 10;
    // 999,999 must carry to "1M"-style units rather than printing "1000k".
    if (rounded >= 1000 && scale !== COMPACT_UNITS[0][0]) continue;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${sign}${text}${suffix}`;
  }
  return `${sign}${formatAmount(abs, 0)}`;
}

/**
 * Parse an ISO timestamp.
 * @param iso - the raw timestamp.
 * @returns epoch ms, or `null` when unparseable.
 */
export function toTimestamp(iso) {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pad a number to two digits.
 * @param value - the number.
 * @returns the padded text.
 */
function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Format an absolute local clock reading (`YYYY-MM-DD HH:mm`).
 * @param iso - the timestamp.
 * @returns the clock text, or {@link EMPTY_VALUE}.
 */
export function formatClock(iso) {
  const at = toTimestamp(iso);
  if (at === null) return EMPTY_VALUE;
  const date = new Date(at);
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Describe how fresh a snapshot is, relative to `nowMs`.
 * @param iso - the snapshot's `fetchedAt`.
 * @param nowMs - the caller's clock (epoch ms).
 * @returns `刚刚` / `3 分钟前` / an absolute clock reading beyond a day / {@link EMPTY_VALUE}.
 */
export function formatRelativeTime(iso, nowMs = Date.now()) {
  const at = toTimestamp(iso);
  if (at === null) return EMPTY_VALUE;
  const base = toFiniteNumber(nowMs);
  if (base === null) return EMPTY_VALUE;
  const delta = base - at;
  if (delta < 10_000) return "刚刚";
  if (delta < 60_000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return formatClock(iso);
}

/**
 * Build the row's text lookup: the slot's `t` seat when it resolves a key, the
 * built-in Simplified-Chinese dictionary otherwise. A `t` from an unregistered
 * locale namespace returns the key itself, which is exactly the fallback signal.
 * @param t - optional locale seat (`(key) => string`).
 * @param dictionary - the fallback dictionary (defaults to `{}`, i.e. keys).
 * @returns a `(key) => string` lookup that never throws.
 */
export function makeTextLookup(t, dictionary = {}) {
  return function text(key) {
    if (typeof t === "function") {
      try {
        const localized = t(key);
        if (typeof localized === "string" && localized !== "" && localized !== key) return localized;
      } catch {
        /* a broken locale seat must not blank the row */
      }
    }
    return Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key;
  };
}
