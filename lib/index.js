/**
 * dsh-deepseek-usage — host-half entry (thin assembly layer).
 *
 * This file is the *only* thing the DSH loader mounts for the host half
 * (`package.json` → `exports["."]`). It carries no feature logic: it assembles
 * the cordis plugin face from `../src/host/plugin.mjs`, which is delivered by
 * task T2/T3 (`src/host/plugin.mjs`: credentials, official balance endpoint,
 * cached refresh, and the `/api/dsh-deepseek-usage/*` route family).
 *
 * Frozen composition contract for `src/host/plugin.mjs`:
 *   - default-exports ONE cordis plugin object `{ name, inject, apply }`
 *   - `apply(ctx, config)` performs the host-side wiring
 *   - `inject` is optional (omit it when the half needs no injected services)
 *
 * Import failures are deliberately not swallowed: a missing or misshapen
 * module throws at activation, which the boot activation audit reports loudly
 * instead of mounting a half-broken row.
 *
 * @module dsh-deepseek-usage/host
 */

import hostPlugin from "../src/host/plugin.mjs";

const PACKAGE_NAME = "dsh-deepseek-usage";

if (hostPlugin === null || typeof hostPlugin !== "object" || typeof hostPlugin.apply !== "function") {
  const got =
    hostPlugin === null
      ? "null"
      : typeof hostPlugin === "object"
        ? `an object without an apply() function (keys: ${Object.keys(hostPlugin).join(", ") || "none"})`
        : typeof hostPlugin;
  throw new Error(
    `${PACKAGE_NAME}: src/host/plugin.mjs must default-export a cordis plugin object ` +
      `{ name, inject?, apply(ctx, config) }; got ${got}`,
  );
}

/** Cordis plugin name; the row id from cordis.patch.yml wins when this is absent. */
export const name = typeof hostPlugin.name === "string" && hostPlugin.name !== "" ? hostPlugin.name : PACKAGE_NAME;

/** Optional injected-service list, passed through untouched. */
export const inject = hostPlugin.inject;

/**
 * Forward the cordis activation to the host half.
 * @param ctx - cordis context of the mounted row.
 * @param config - row config from cordis.patch.yml (absent here).
 * @returns whatever the host half's `apply` returns (a promise is awaited by cordis).
 */
export function apply(ctx, config) {
  return hostPlugin.apply(ctx, config);
}

export default hostPlugin;
