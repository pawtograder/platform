/**
 * Preflight for the real-NVDA rig — run before the suite (CI step). The
 * Windows/NVDA counterpart of vo/doctor.ts. Verifies each control surface with
 * an actionable message; no app secrets required.
 *
 * Starts with self-healing: kill any wedged NVDA instance and dismiss a stray
 * credential dialog. The navigation round-trip drives real NVDA through the
 * harness's focus path (Alt+Esc app-switch + browse mode) against a Chromium
 * probe page, so a hang here surfaces before it would mid-login.
 *
 *   Usage: tsx tools/a11y-judge/nvda/doctor.ts
 */
import { execFile, execFileSync } from "node:child_process";
import { ChromeHost } from "./chromeHost";
import { NvdaHarness } from "./nvdaHarness";

interface Check {
  name: string;
  hint: string;
  run: () => Promise<void>;
}

const DOCTOR_PAGE =
  "data:text/html," +
  encodeURIComponent(
    "<!doctype html><html lang=en><head><meta charset=utf-8><title>a11y doctor</title></head>" +
      "<body><h1>a11y doctor</h1><p>probe one</p><p>probe two</p><a href='#'>probe link</a></body></html>"
  );

/** Best-effort machine self-healing before any check runs. */
function selfHeal(): void {
  for (const [cmd, argv] of [
    ["taskkill", ["/im", "nvda.exe", "/f"]],
    ["taskkill", ["/im", "PickerHost.exe", "/f"]]
  ] as const) {
    try {
      execFileSync(cmd, argv, { stdio: "pipe" });
    } catch {
      /* not running — fine */
    }
  }
}

const checks: Check[] = [
  {
    name: "Windows host",
    hint: "real NVDA only exists on Windows — this runner must be the Windows box (labels: self-hosted, Windows, nvda)",
    run: async () => {
      if (process.platform !== "win32") throw new Error(`platform is ${process.platform}`);
    }
  },
  {
    name: "Interactive console session",
    hint: "NVDA speech needs a logged-in, unlocked interactive desktop — not a detached RDP session. Set auto-login + no lock (ops/ripley-cluster.md → Windows screen-reader runner)",
    run: async () => {
      // Best-effort: `query session` marks the active console "Active".
      let out = "";
      try {
        out = execFileSync("query", ["session"], { stdio: "pipe" }).toString();
      } catch {
        try {
          out = execFileSync("qwinsta", [], { stdio: "pipe" }).toString();
        } catch {
          console.log("   (query session unavailable — skipping; NVDA round-trip still gates interactivity)");
          return;
        }
      }
      if (!/\bActive\b/i.test(out)) throw new Error("no Active session — desktop may be locked or detached");
    }
  },
  {
    name: "NVDA controllable (guidepup)",
    hint: "install NVDA via `npx @guidepup/setup install nvda` from a project with @guidepup/guidepup; ensure it launches in the interactive session",
    run: async () => {
      const { nvda } = await import("@guidepup/guidepup");
      if (!nvda.detect()) throw new Error("guidepup does not detect NVDA support");
      await nvda.start();
      try {
        const phrase = await nvda.lastSpokenPhrase();
        if (typeof phrase !== "string") throw new Error("no spoken phrase captured");
      } finally {
        await nvda.stop().catch(() => {});
      }
    }
  },
  {
    name: "Chromium + host channel (Playwright)",
    hint: "run `npx playwright install chromium`; ensure headed Chromium can launch on the interactive desktop",
    run: async () => {
      const chrome = new ChromeHost();
      await chrome.launch();
      try {
        await chrome.openUrl(DOCTOR_PAGE);
        const result = await chrome.evalJs("1 + 1");
        if (Number(result) !== 2) throw new Error(`evalJs returned ${JSON.stringify(result)}`);
      } finally {
        await chrome.close();
      }
    }
  },
  {
    name: "Clipboard (paste-based type retry)",
    hint: "the type retry pastes via the Windows clipboard — ensure PowerShell Set-Clipboard/Get-Clipboard work in this session",
    run: async () => {
      const chrome = new ChromeHost();
      await chrome.launch();
      try {
        const probe = `a11y-nvda-doctor-${Date.now()}`;
        await chrome.setClipboard(probe);
        const got = execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"], {
          stdio: "pipe"
        })
          .toString()
          .trim();
        if (got !== probe) throw new Error(`clipboard round-trip mismatch: got ${JSON.stringify(got.slice(0, 40))}`);
      } finally {
        await chrome.close();
      }
    }
  },
  {
    name: "NVDA navigation round-trip",
    hint: "an NVDA move failed — check the session is unlocked/awake, NVDA isn't wedged (taskkill nvda.exe, re-run), and no credential dialog holds the foreground",
    run: async () => {
      const chrome = new ChromeHost();
      const harness = new NvdaHarness({ pageTitle: () => chrome.evalJs("document.title") });
      await chrome.launch();
      await chrome.openUrl(DOCTOR_PAGE);
      await harness.start();
      try {
        await harness.focusWebArea(async () => {}); // data: probe page has no #main-content
        const obs = await Promise.race([
          harness.run("next"),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("nvda next() hung for 20s")), 20_000))
        ]);
        console.log(`   (cursor on: ${JSON.stringify((obs.currentItem || "").slice(0, 80))})`);
        if (!obs.currentItem && obs.spokenSinceLastAction.length === 0) {
          throw new Error("NVDA produced no item/speech — browser may not have foreground focus");
        }
      } finally {
        await harness.stop();
        await chrome.close();
      }
    }
  },
  {
    name: "OpenBao client",
    hint: "install the bao/vault CLI on PATH; set BAO_ADDR and place AppRole creds at %USERPROFILE%\\.config\\pawtograder\\bao\\",
    run: async () => {
      const ok = await new Promise<boolean>((resolve) => {
        execFile("bao", ["--version"], (err) => {
          if (!err) return resolve(true);
          execFile("vault", ["--version"], (err2) => resolve(!err2));
        });
      });
      if (!ok) throw new Error("neither `bao` nor `vault` CLI found on PATH");
      if (!process.env.BAO_ADDR) throw new Error("BAO_ADDR is not set");
    }
  }
];

async function main(): Promise<void> {
  selfHeal();
  let failures = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`✅ ${check.name}`);
    } catch (e) {
      failures++;
      console.error(`❌ ${check.name}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      if (e instanceof Error && e.cause) {
        const c = e.cause;
        console.error(`   cause: ${c instanceof Error ? c.message : String(c)}`);
      }
      console.error(`   → ${check.hint}`);
    }
  }
  if (failures > 0) {
    console.error(`\n[a11y:nvda:doctor] ${failures}/${checks.length} checks failed`);
    process.exit(1);
  }
  console.log(`\n[a11y:nvda:doctor] all ${checks.length} checks passed`);
}

main().catch((e) => {
  console.error(`[a11y:nvda:doctor] fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
