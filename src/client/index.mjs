/**
 * dsh-deepseek-usage — browser half (client plugin entry).
 *
 * Registers exactly one occupant on the sidebar's list slot
 * `sidebar.footer.action`, which the sidebar shell renders in its `footArea`
 * immediately BEFORE the `sidebar.settings` seat — hence "the balance row above
 * the Settings row" without touching the sidebar shell, the layout, or any
 * shipped package.
 *
 * Composition contract (see `docs/load-path.md` §3 and `README.md`):
 * the browser module system loads this package's bundle as a CLASSIC
 * `<script src="/plugins/dsh-deepseek-usage/client.js">` and needs
 * `factory(require)` to return exports SYNCHRONOUSLY, so this file is authored as
 * ESM but is inlined verbatim into `lib/client.js`'s `createClientHalf` slot.
 * Therefore:
 *
 *  - the default export is a FUNCTION OF `require`, not a module that imports
 *    React itself — everything the browser shell owns (React, the primitive kit)
 *    arrives through the factory's synchronous `require`, which also keeps this
 *    module importable by plain node for tests;
 *  - the only `import` statements are the three sibling modules that the composer
 *    flattens into the same closure (those lines are dropped, the declarations
 *    remain);
 *  - nothing here touches an API key. The browser half talks only to this
 *    origin's `/api/dsh-deepseek-usage/*` through `service.mjs`.
 *
 * @module dsh-deepseek-usage/client
 */

import { createBalanceService } from "./service.mjs";
import { ROW_ID, ROW_LOCALE_NAMESPACE, ROW_ORDER, ROW_SLOT, createBalanceRow, rowText } from "./row.mjs";

/** Plugin id (the bundle's module-table id and this plugin's cordis name). */
export const PLUGIN_NAME = "dsh-deepseek-usage";

/** Services this client plugin waits for before applying. */
export const PLUGIN_INJECT = Object.freeze(["slots"]);

/** Specifier of the shared UI primitive kit inside the browser module table. */
export const PRIMITIVES_SPECIFIER = "@deepseek-ai/dsh-client-ui-primitives";

/** React specifier handed to the bundle factory by the shell. */
export const REACT_SPECIFIER = "react";

/**
 * Well-known global an independently-bundled popover can publish its opener on
 * (`{ open(snapshot) }`). The in-bundle path is {@link setModalOpener}; this is
 * only the second resolution step, so T6 can wire either way.
 */
export const MODAL_GLOBAL_KEY = "__DSH_DEEPSEEK_USAGE_MODAL__";

/** Holder for the popover opener composed into this bundle (T6: `src/client/modal.mjs`). */
let modalOpener;

/**
 * Holder for a composed popover FACTORY: `(runtime) => opener`.
 *
 * A factory exists because `setModalOpener` runs at CLASSIC-SCRIPT evaluation
 * time, when `factory(require)` has not been called yet and no React is reachable —
 * so a composed peer cannot build elements there. A factory is called once from
 * {@link createClientHalf}'s `apply` with the activation-time runtime
 * (`{ React, primitives, icons, Tooltip, service, text, slot }`), and whatever
 * opener it returns is installed through {@link setModalOpener}.
 */
let modalFactory;

/**
 * Publish the popover opener (T6 calls this at composition time).
 * @param opener - `(view) => void`; pass `undefined` to clear.
 * @returns the previously installed opener.
 */
export function setModalOpener(opener) {
  const previous = modalOpener;
  modalOpener = typeof opener === "function" ? opener : undefined;
  return previous;
}

/**
 * Publish the popover factory (T6's wiring line; alternative to {@link setModalOpener}).
 * @param factory - `(runtime) => opener`; pass `undefined` to clear.
 * @returns the previously installed factory.
 */
export function setModalFactory(factory) {
  const previous = modalFactory;
  modalFactory = typeof factory === "function" ? factory : undefined;
  return previous;
}

/**
 * Build the activation-time runtime handed to a composed popover factory.
 * @param runtime - the activation-time collaborators.
 * @returns the frozen runtime object.
 */
export function createModalRuntime(runtime) {
  return Object.freeze({
    React: runtime.React,
    primitives: runtime.primitives,
    icons: runtime.icons,
    Tooltip: runtime.Tooltip,
    service: runtime.service,
    text: runtime.text,
    slot: ROW_SLOT,
  });
}

/**
 * Install the composed factory's opener, when one is composed.
 *
 * Failures degrade loudly-but-safely: the row then shows its "popover not
 * composed" hint instead of breaking activation.
 *
 * @param runtime - activation-time collaborators (see {@link createModalRuntime}).
 * @returns the installed opener, or `undefined`.
 */
export function installComposedModal(runtime) {
  if (typeof modalFactory !== "function" || getModalOpener() !== undefined) return undefined;
  let opener;
  try {
    opener = modalFactory(createModalRuntime(runtime));
  } catch (error) {
    warnUnavailable(`the composed popover factory threw: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (typeof opener !== "function") {
    if (opener !== undefined) warnUnavailable("the composed popover factory returned no opener function");
    return undefined;
  }
  setModalOpener(opener);
  return opener;
}

/**
 * Resolve the popover opener: the composed one first, then the well-known global.
 * @param root - global object to consult (defaults to `globalThis`).
 * @returns the opener, or `undefined` when no popover is composed.
 */
export function getModalOpener(root) {
  if (typeof modalOpener === "function") return modalOpener;
  const host = root === undefined ? globalThis : root;
  const published = host === undefined || host === null ? undefined : host[MODAL_GLOBAL_KEY];
  if (published === null || published === undefined) return undefined;
  return typeof published === "function" ? published : typeof published.open === "function" ? published.open : undefined;
}

/**
 * Require an optional shell module without failing the whole bundle.
 * @param require - the factory's synchronous require.
 * @param specifier - module id.
 * @returns the exports, or `undefined` when the module table has no such id.
 */
export function optionalRequire(require, specifier) {
  try {
    return require(specifier);
  } catch {
    return undefined;
  }
}

/**
 * The icon set pulled from the primitive kit (each may be missing; the row falls
 * back to a text glyph).
 * @param primitives - the kit's exports.
 * @returns `{ refresh, loading, warning, balance }`.
 */
export function pickIcons(primitives) {
  const kit = primitives !== null && typeof primitives === "object" ? primitives : {};
  return {
    refresh: kit.IconRefreshOutline14 ?? kit.IconRefreshOutline16,
    loading: kit.IconLoadingOutline16,
    warning: kit.IconWarningOutline16,
    balance: kit.IconGaugeOutline16 ?? kit.IconDataOutline16,
  };
}

/**
 * Warn once, loudly enough to be findable, naming the plugin and the seat.
 * @param message - the diagnostic.
 */
export function warnUnavailable(message) {
  try {
    if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(`${PLUGIN_NAME}: ${message}`);
  } catch {
    /* a broken console must not break activation */
  }
}

/**
 * Build the client half.
 *
 * @param require - the bundle factory's synchronous `require` (module table).
 * @returns the cordis client plugin: `{ name, inject, apply, setModalOpener, getModalOpener }`.
 */
export default function createClientHalf(require) {
  if (typeof require !== "function") {
    throw new Error(`${PLUGIN_NAME}: the browser bundle factory must supply require (module table)`);
  }
  const React = require(REACT_SPECIFIER);
  if (React === null || React === undefined || typeof React.createElement !== "function") {
    throw new Error(`${PLUGIN_NAME}: require("react") returned no usable React — the shell's module table must supply it`);
  }
  const primitives = optionalRequire(require, PRIMITIVES_SPECIFIER);
  const icons = pickIcons(primitives);
  const Tooltip = primitives !== undefined && primitives !== null ? primitives.Tooltip : undefined;
  const text = rowText(undefined);

  /**
   * Register the row on the sidebar foot slot.
   * @param ctx - the client cordis context (`slots` is injected).
   * @returns the balance service (T6's popover reuses it).
   */
  function apply(ctx) {
    const service = createBalanceService({});
    const slots = ctx !== null && ctx !== undefined ? ctx.slots : undefined;
    // The seat is declared by the sidebar shell, and `inject: ["slots"]` normally
    // guarantees the service — but `dsh.client.inject` is only an ordering hint
    // (README: "informational ordering hint, not a capability declaration"), so the
    // absence of the slot service degrades EXPLICITLY instead of rendering nothing.
    if (slots === null || slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") {
      warnUnavailable(`the client slot service is unavailable (ctx.slots) — "${ROW_SLOT}" was not mounted`);
      return service;
    }
    const BalanceRow = createBalanceRow({
      React,
      service,
      icons,
      Tooltip,
      document: typeof document === "undefined" ? undefined : document,
      now: () => Date.now(),
      resolveModal: () => getModalOpener(),
    });
    installComposedModal({ React, primitives, icons, Tooltip, service, text });
    slots.inject(ROW_SLOT, () => {
      try {
        return slots.register(
          {
            name: ROW_SLOT,
            id: ROW_ID,
            order: ROW_ORDER,
            locale: ROW_LOCALE_NAMESPACE,
            label: () => text("row.label"),
          },
          BalanceRow,
        );
      } catch (error) {
        // The shell's own slot error boundary is the second line of defense; this
        // line makes the reason findable ("slot undeclared / shell without the seat").
        warnUnavailable(
          `registering on "${ROW_SLOT}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    });
    return service;
  }

  return {
    name: PLUGIN_NAME,
    inject: PLUGIN_INJECT,
    apply,
    setModalOpener,
    getModalOpener,
  };
}
