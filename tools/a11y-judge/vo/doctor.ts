/**
 * Preflight for the real-VoiceOver rig — run before the suite (CI step) and
 * after any macOS update (TCC grants are per-binary and reset on upgrades).
 * Verifies each permission/control surface with an actionable message; no
 * app secrets required.
 *
 *   Usage: tsx tools/a11y-judge/vo/doctor.ts
 */
import { execFileSync } from "node:child_process";
import { SafariHost } from "./safari";

interface Check {
  name: string;
  hint: string;
  run: () => Promise<void>;
}

const safari = new SafariHost();

const checks: Check[] = [
  {
    name: "macOS host",
    hint: "real VoiceOver only exists on macOS — this runner must be the Mac (labels: self-hosted, macOS, voiceover)",
    run: async () => {
      if (process.platform !== "darwin") throw new Error(`platform is ${process.platform}`);
    }
  },
  {
    name: "VoiceOver AppleScript control",
    hint: "run `npx @guidepup/setup`, then re-grant Accessibility + Automation in System Settings ▸ Privacy & Security (runbook §3)",
    run: async () => {
      // Lazy: @guidepup/guidepup throws at import time off-macOS.
      const { voiceOver } = await import("@guidepup/guidepup");
      if (!voiceOver.detect()) throw new Error("guidepup does not detect VoiceOver support");
      await voiceOver.start();
      try {
        const phrase = await voiceOver.lastSpokenPhrase();
        if (typeof phrase !== "string") throw new Error("no spoken phrase captured");
      } finally {
        await voiceOver.stop().catch(() => {});
      }
    }
  },
  {
    name: "VoiceOver navigation round-trip",
    hint: "a VO move command hung — check VoiceOver Utility isn't showing a first-run dialog, and that speech isn't wedged (pkill VoiceOver, re-run)",
    run: async () => {
      const { voiceOver } = await import("@guidepup/guidepup");
      await voiceOver.start({ capture: "initial" });
      try {
        // Exercise the real command path (keystroke → capture polling); a
        // hang here would otherwise surface as a 30s timeout mid-login.
        await Promise.race([
          voiceOver.next({ capture: "initial" }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("vo.next() hung for 15s")), 15_000))
        ]);
        const item = await voiceOver.itemText();
        console.log(`   (cursor on: ${JSON.stringify(item.slice(0, 80))})`);
      } finally {
        await voiceOver.stop().catch(() => {});
      }
    }
  },
  {
    name: "Safari AppleScript automation",
    hint: "grant Automation (Safari) to the runner process in System Settings ▸ Privacy & Security ▸ Automation (runbook §3)",
    run: async () => {
      await safari.openUrl("about:blank");
    }
  },
  {
    name: "Safari JavaScript from Apple Events",
    hint: "enable Safari ▸ Develop ▸ Allow JavaScript from Apple Events (runbook §4)",
    run: async () => {
      const result = await safari.evalJs("1 + 1");
      // Safari on macOS 26+ stringifies the numeric result as "2.0"; older
      // Safari returns "2". Compare numerically so the capability check isn't
      // gated on the OS's number-to-string formatting.
      if (Number(result) !== 2) throw new Error(`evalJs returned ${JSON.stringify(result)}`);
    }
  },
  {
    name: "OpenBao client",
    hint: "brew install openbao; set BAO_ADDR and place AppRole creds at ~/.config/pawtograder/bao/ (runbook §6)",
    run: async () => {
      execFileSync("bao", ["--version"], { stdio: "pipe" });
      if (!process.env.BAO_ADDR) throw new Error("BAO_ADDR is not set");
    }
  }
];

async function main(): Promise<void> {
  let failures = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`✅ ${check.name}`);
    } catch (e) {
      failures++;
      console.error(`❌ ${check.name}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      // Surface the underlying cause — guidepup wraps the real failure (e.g. an
      // AppleScript permission error or waitForRunning timeout) as `cause`.
      if (e instanceof Error && e.cause) {
        const c = e.cause;
        console.error(`   cause: ${c instanceof Error ? c.message : String(c)}`);
      }
      console.error(`   → ${check.hint}`);
    }
  }
  await safari.closeAllWindows();
  if (failures > 0) {
    console.error(`\n[a11y:vo:doctor] ${failures}/${checks.length} checks failed`);
    process.exit(1);
  }
  console.log(`\n[a11y:vo:doctor] all ${checks.length} checks passed`);
}

main().catch((e) => {
  console.error(`[a11y:vo:doctor] fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
