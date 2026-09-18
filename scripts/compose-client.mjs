#!/usr/bin/env node
/**
 * dsh-deepseek-usage — compose `lib/client.js` from `src/client/*.mjs`.
 *
 * WHY THIS EXISTS
 * The browser half is served as a CLASSIC script (`<script src>` with no
 * `type=module`) by `@deepseek-ai/dsh-client-modules`, and the `/plugins` route
 * only serves registered bundle URLs — never arbitrary files inside the package.
 * So the browser half cannot `import` its own modules at runtime: every source
 * module must be INLINED into one closure. This script is that inlining step,
 * and `lib/client.js` is its generated output.
 *
 * THE TRANSFORMATION (must stay identical to `flattenSource` in
 * `tests/ui-row.test.mjs`, which is the machine-checked statement of this rule):
 *   1. drop a sibling `import … from "./x.mjs";` line — the modules become one
 *      closure, so sibling references resolve to in-closure declarations;
 *   2. strip a line-start `export ` / `export default ` keyword;
 *   3. join the six module bodies under their section markers.
 * Sibling modules must NOT be turned into `require("./x.mjs")`: that URL is not
 * served and not in the module table, so the browser would throw at runtime.
 * Only the shell's seed modules (`react`, `@deepseek-ai/dsh-client-ui-primitives`)
 * stay as `require(...)` calls inside the module bodies.
 *
 * USAGE
 *   node scripts/compose-client.mjs            # rewrite lib/client.js
 *   node scripts/compose-client.mjs --check    # fail if it would change (CI)
 *
 * After running this, `node --test` (from the package root) must stay green:
 * `bundle: every source module is inlined byte-for-byte` and
 * `bundle: every exported function of every module is the composed one` prove
 * the copy still equals the sources, and `bundle: the classic script parses…`
 * proves the envelope survives.
 *
 * @module dsh-deepseek-usage/scripts/compose-client
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_PATH = join(PACKAGE_ROOT, "lib", "client.js");
const SOURCE_DIR = join(PACKAGE_ROOT, "src", "client");

/** Source modules in section order — the same order `CLIENT_SOURCES` asserts. */
const MODULES = Object.freeze([
  "format.mjs",
  "service.mjs",
  "row.mjs",
  "index.mjs",
  "chart.mjs",
  "modal.mjs",
]);

const MARKER = (() => {
  const bars = "=".repeat(20);
  return {
    begin: (name) => `  /* ${bars} begin: src/client/${name} ${bars} */`,
    end: (name) => `  /* ${bars} end: src/client/${name} ${bars} */`,
    wiringBegin: `  /* ${bars} begin: composition wiring (assembly layer, not a source module) ${bars} */`,
    wiringEnd: `  /* ${bars} end: composition wiring ${bars} */`,
  };
})();

/**
 * The wiring block: it publishes the popover FACTORY rather than the opener,
 * because at classic-script evaluation time `factory(require)` has not run yet,
 * so React and the service do not exist. `installComposedModal` (index.mjs)
 * calls the factory from `apply(ctx)` and installs the returned opener.
 */
const WIRING = [
  MARKER.wiringBegin,
  "  // Publish the popover FACTORY, not the opener: at classic-script evaluation time",
  "  // `factory(require)` has not run, so React and the service do not exist yet.",
  "  // `installComposedModal` (index.mjs) calls this from `apply(ctx)` with the",
  "  // activation-time runtime and installs the returned opener on the row's seat.",
  "  setModalFactory(function (runtime) {",
  "    return createUsageModalOpener(runtime);",
  "  });",
  MARKER.wiringEnd,
].join("\n");

/** The envelope tail: registers the composed half with the client module system. */
const REGISTRATION = [
  "  return createClientHalf;",
  "})();",
  "",
  '(function registerClientBundle(root) {',
  '  "use strict";',
  "",
  '  var ID = "dsh-deepseek-usage";',
  "",
  "  var loader = root.__ModuleLoader__;",
  "  if (loader === undefined || loader === null || typeof loader.load !== \"function\") {",
  "    throw new Error(",
  "      ID + \": window.__ModuleLoader__ is missing — this bundle must be loaded through the DSH web shell\",",
  "    );",
  "  }",
  "",
  "  loader.load({",
  "    id: ID,",
  "    factory: function (require) {",
  '      if (typeof createClientHalf !== "function") {',
  "        throw new Error(",
  "          ID +",
  "            \": browser half is not composed — inline src/client/index.mjs into the createClientHalf slot of lib/client.js (see docs/load-path.md)\",",
  "        );",
  "      }",
  "      return createClientHalf(require);",
  "    },",
  "  });",
  "})(globalThis);",
].join("\n");

/**
 * Apply the inlining transformation to one source module.
 * @param {string} text - raw module source.
 * @returns {string} the module body as it appears inside the composed closure.
 */
function flattenSource(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^import\s.*from\s+"\.\/[A-Za-z0-9_.-]+\.mjs";\s*$/.test(line))
    .map((line) => line.replace(/^export\s+(default\s+)?/, ""))
    .join("\n");
}

/**
 * The file header: the bundle's leading block comment, preserved verbatim so
 * hand-maintained prose never has to be duplicated in this script. The header is
 * the FIRST `/** … *&#47;` block of the current bundle — anchoring on the first
 * comment (not the last one before the envelope, which is the envelope's own
 * one-line comment) is what makes this stable.
 * @returns {string} the header comment, without a trailing newline.
 */
function readHeader() {
  const current = readFileSync(BUNDLE_PATH, "utf8");
  if (!current.startsWith("/**")) {
    throw new Error(`${BUNDLE_PATH}: expected the file to start with a block comment`);
  }
  const end = current.indexOf("*/");
  if (end === -1) {
    throw new Error(`${BUNDLE_PATH}: unterminated header comment`);
  }
  return current.slice(0, end + 2);
}

/** Compose the whole bundle text. */
function compose() {
  const sections = [];
  for (const name of MODULES) {
    const source = readFileSync(join(SOURCE_DIR, name), "utf8");
    // A section is: begin marker, the flattened module body, a blank line, the
    // end marker — the exact shape the guard's byte-for-byte check expects.
    sections.push(
      [MARKER.begin(name), flattenSource(source).trimEnd(), "", MARKER.end(name)].join("\n"),
    );
  }
  return [
    readHeader(),
    "",
    "/** The composed browser half: same call shape the envelope always used. */",
    "var createClientHalf = (function () {",
    '  "use strict";',
    "",
    sections.join("\n\n"),
    "",
    WIRING,
    "",
    REGISTRATION,
    "",
  ].join("\n");
}

const composed = compose();
const previous = readFileSync(BUNDLE_PATH, "utf8");

if (process.argv.includes("--print")) {
  process.stdout.write(composed);
  process.exit(0);
}

if (process.argv.includes("--check")) {
  if (composed === previous) {
    console.log("lib/client.js is in sync with src/client/*.mjs");
    process.exit(0);
  }
  console.error("lib/client.js has DRIFTED from src/client/*.mjs — run: node scripts/compose-client.mjs");
  process.exit(1);
}

if (composed === previous) {
  console.log(`lib/client.js already in sync (${Buffer.byteLength(composed)} bytes, ${MODULES.length} modules)`);
  process.exit(0);
}

writeFileSync(BUNDLE_PATH, composed, "utf8");
console.log(`composed lib/client.js from ${MODULES.length} modules (${Buffer.byteLength(composed)} bytes)`);
