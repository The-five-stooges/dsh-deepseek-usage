/**
 * dsh-deepseek-usage — real-browser stylesheet probe (test helper).
 *
 * The `node --test` suite runs in-process, where `getComputedStyle` does not exist.
 * That is exactly how a broken stylesheet shipped with 211 green tests: the source
 * contained `flex:1 0 100%` on the row, nothing executed it, and the live row still
 * shared a line (the container rule that was supposed to enable wrapping never
 * matched). Layout rules have to be MEASURED by a layout engine.
 *
 * This helper drives the machine's installed Edge over the Chrome DevTools Protocol
 * (no npm dependency) and reports the geometry of the plugin's real `ROW_CSS` applied
 * to a DOM shaped like the live sidebar footer.
 *
 * Usage:
 *   node tools/visual/row-wrap-probe.mjs --css-file <path to ROW_CSS text> [--port 9223]
 *   node tools/visual/row-wrap-probe.mjs --css "<css>" [--port 9223]
 *
 * Prints one JSON object on stdout and exits 0 whenever the browser ran, even if the
 * layout is wrong — the caller decides what the numbers mean. Exits 2 when no browser
 * is available (the caller should then skip, not fail).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/**
 * Read one `--flag value` argument.
 * @param flag - the flag name, e.g. `--port`.
 * @param fallback - the value when the flag is absent.
 * @returns the argument value.
 */
function arg(flag, fallback) {
  const at = process.argv.indexOf(flag);
  return at > -1 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

const port = Number(arg("--port", "9223"));
const cssFile = arg("--css-file", null);
const css = cssFile !== null ? readFileSync(cssFile, "utf8") : arg("--css", "");
if (css === "") {
  console.error("row-wrap-probe: no CSS given (--css-file or --css)");
  process.exit(2);
}
/**
 * Which of the component's three roots the fixture renders. The collapsed sidebar uses
 * `-rail` instead of `-row`, and the whole point of the container rule is that it must
 * reach whichever root is mounted — so the probe has to be able to mount each of them.
 */
const root = arg("--root", "dsh-deepseek-usage-row");
if (!/^dsh-deepseek-usage-(row|block|rail)$/.test(root)) {
  console.error(`row-wrap-probe: unknown root ${root}`);
  process.exit(2);
}

const browser = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
if (browser === undefined) {
  console.error("row-wrap-probe: no Chromium-family browser found");
  process.exit(2);
}

const profile = join(tmpdir(), `dsh-row-wrap-probe-${port}`);
const child = spawn(
  browser,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=800,600",
    "about:blank",
  ],
  { stdio: "ignore", detached: false },
);

/**
 * Wait for the DevTools HTTP endpoint to answer.
 * @returns the page target, or `undefined` on timeout.
 */
async function findPageTarget() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page !== undefined) return page;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

/**
 * Stop the browser and clean its temporary profile.
 * @param ws - the open websocket, if any.
 */
function shutdown(ws) {
  try {
    ws?.close();
  } catch {
    // ignore
  }
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch {
    // ignore
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

let ws = null;
try {
  const target = await findPageTarget();
  if (target === undefined) {
    console.error("row-wrap-probe: the DevTools endpoint never came up");
    shutdown(ws);
    process.exit(2);
  }

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
    setTimeout(() => reject(new Error("websocket open timeout")), 15_000);
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  const send = (method, params = {}, timeoutMs = 30_000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };

  await send("Page.enable");

  /**
   * The markup mirrors the measured live DOM:
   * `footerActions > [display:contents wrapper] > (another plugin's chip, our row)`.
   * The wrapper is the whole point — it is why a direct-child rule cannot match.
   * The container also carries the shell's build-hashed class name
   * (`hHd-Xa_footerActions`), because `ROW_CSS` matches it by SUBSTRING; a fixture
   * without it would silently never exercise the rule.
   */
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:13px sans-serif}
.case{width:256px;margin:12px;border:1px solid #999}
.hHd-Xa_footerActions{display:flex}
.chip{flex:1 0 100%;background:#ddd;height:24px}
${css}
</style></head><body>
<div class="case"><div class="hHd-Xa_footerActions" id="fa"><div style="display:contents"><div class="chip" id="chip">other plugin</div><div class="${root}" id="row">row</div></div></div></div>
</body></html>`;

  await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(html) });
  await new Promise((r) => setTimeout(r, 900));

  const measured = await evaluate(`(() => {
    const fa = document.getElementById('fa');
    const row = document.getElementById('row');
    const chip = document.getElementById('chip');
    const fr = fa.getBoundingClientRect(), rr = row.getBoundingClientRect(), cr = chip.getBoundingClientRect();
    return {
      containerDisplay: getComputedStyle(fa).display,
      containerFlexWrap: getComputedStyle(fa).flexWrap,
      containerWidth: Math.round(fr.width),
      rowDisplay: getComputedStyle(row).display,
      rowFlexBasis: getComputedStyle(row).flexBasis,
      rowWidth: Math.round(rr.width),
      rowTop: Math.round(rr.top),
      chipTop: Math.round(cr.top),
      rowOnOwnLine: Math.round(rr.top) > Math.round(cr.top),
      rowIsDirectChildOfContainer: row.parentElement === fa,
    };
  })()`);

  console.log(JSON.stringify({ browser, cssLength: css.length, port, root, ...measured }, null, 2));
  shutdown(ws);
  process.exit(0);
} catch (error) {
  console.error("row-wrap-probe: " + (error instanceof Error ? error.message : String(error)));
  shutdown(ws);
  process.exit(2);
}
