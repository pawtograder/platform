/** Debug: does the VSR IIFE bundle load in a bare Chromium page? */
import { buildSync } from "esbuild";
import { chromium } from "@playwright/test";

async function tryBundle(define: Record<string, string> | undefined, label: string) {
  const result = buildSync({
    entryPoints: [require.resolve("@guidepup/virtual-screen-reader")],
    bundle: true,
    format: "iife",
    globalName: "__VSR",
    platform: "browser",
    write: false,
    logLevel: "silent",
    define
  });
  // addInitScript evaluates the source inside a function scope, so the IIFE's
  // top-level `var __VSR` is not a window global — export it explicitly.
  const src = result.outputFiles[0].text + "\n;window.__VSR = __VSR;";
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(src);
  await page.goto("data:text/html,<main><h1>Hello</h1><button>Go</button></main>");
  const probe = await page.evaluate(async () => {
    const w = window as any;
    if (!w.__VSR) return { global: false };
    const v = w.__VSR.virtual;
    await v.start({ container: document.body });
    await v.next();
    const item = await v.itemText();
    const log = await v.spokenPhraseLog();
    await v.stop();
    return { global: true, keys: Object.keys(w.__VSR), item, log };
  });
  console.log(`[${label}] bundle=${(src.length / 1024).toFixed(0)}KB`, JSON.stringify(probe));
  if (errors.length) console.log(`[${label}] page errors:`, errors.slice(0, 3));
  await browser.close();
}

(async () => {
  await tryBundle(undefined, "no-define");
  await tryBundle({ "process.env.NODE_ENV": '"production"', global: "globalThis" }, "with-define");
})();
