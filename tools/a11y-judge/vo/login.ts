/**
 * Magic-link login in real Safari, driven through VoiceOver.
 *
 * Mirrors signInWithMagicLinkAndRetry (tests/e2e/TestingUtils.ts): mint an
 * admin magic link with the service-role client, open the verification URL,
 * click "Sign in with magic link", wait for the /course redirect — but the
 * click itself goes through the VoiceOver cursor, so login is part of the
 * real-AT evidence. No passwords → no Safari AutoFill/keychain prompts.
 *
 * Every stage reports into the run's debug log (debug.ts) — this flow is the
 * rig's first full VO round-trip and historically where new-machine issues
 * surface (TCC, capture hangs, cursor stuck in browser chrome).
 */
import { generateMagicLinkWithRetry, type TestingUser } from "../../../tests/e2e/TestingUtils";
import { templateMatches } from "../agent/normalize";
import type { SafariHost } from "./safari";
import type { VoHarness } from "./voHarness";
import { waitForPageReady } from "./ready";

const SIGN_IN_BUTTON = "sign in with magic link";
const MAX_ATTEMPTS = 4;
const MAX_CURSOR_HOPS = 40;

const TIMEZONE_PREFERENCE_KEY = "pawtograder-timezone-pref";
const TIMEZONE_PREFERENCE_VALUE = "course";

type Debug = (stage: string, detail?: Record<string, unknown>) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Replicates ensureTimeZonePreferenceInitialized: pre-seed the preference so
 * the timezone dialog never mounts. Must run on the app origin (host duty).
 */
export async function seedTimezonePreference(safari: SafariHost): Promise<void> {
  await safari
    .evalJs(
      `(() => {
        try {
          if (!localStorage.getItem(${JSON.stringify(TIMEZONE_PREFERENCE_KEY)})) {
            localStorage.setItem(${JSON.stringify(TIMEZONE_PREFERENCE_KEY)}, ${JSON.stringify(TIMEZONE_PREFERENCE_VALUE)});
          }
        } catch {}
        return 'true';
      })()`
    )
    .catch(() => {});
}

/** Host-side focus assist for VoHarness.focusWebArea. */
export function focusMainContent(safari: SafariHost): () => Promise<void> {
  return async () => {
    await safari.evalJs(
      `(() => {
        const el = document.querySelector('#main-content, main, body');
        if (el) { el.setAttribute('tabindex', '-1'); el.focus(); }
        return 'true';
      })()`
    );
  };
}

/** One line of host-side page state for the debug log — never secret-bearing. */
async function pageState(safari: SafariHost): Promise<Record<string, unknown>> {
  const url = await safari.currentUrl().catch((e) => `error:${e}`);
  const readyState = await safari.evalJs("document.readyState").catch((e) => `error:${e}`);
  const title = await safari.evalJs("document.title").catch(() => "?");
  return { url, readyState, title };
}

export async function loginWithVoiceOver(
  safari: SafariHost,
  harness: VoHarness,
  student: TestingUser,
  baseUrl: string,
  debug: Debug = () => {}
): Promise<void> {
  const attemptOutcomes: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    debug(`login attempt ${attempt}/${MAX_ATTEMPTS}`);
    if (attempt > 1) {
      // Best-effort browser-state reset. Unlike Playwright we cannot clear
      // httpOnly cookies from JS; a fresh single-use link per attempt is the
      // real safeguard (matches the retried unit in TestingUtils).
      await safari.openUrl(baseUrl);
      await safari
        .evalJs(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return 'true'; })()`)
        .catch(() => {});
    }

    try {
      const { data, error } = await generateMagicLinkWithRetry(student.email);
      if (error || !data?.properties?.hashed_token) {
        attemptOutcomes.push(`gen-error:${error?.message ?? "missing hashed_token"}`);
        debug("login: magic-link mint failed", { error: error?.message });
        continue;
      }
      debug("login: magic link minted");
      const tokenHash = encodeURIComponent(data.properties.hashed_token);
      await safari.openUrl(`${baseUrl}/auth/magic-link?token_hash=${tokenHash}`);
      await seedTimezonePreference(safari);
      const loaded = await safari.waitForJs(`String(document.readyState === 'complete')`, 15_000);
      debug("login: magic-link page opened", { loaded, ...(await pageState(safari)) });

      // Drive the confirmation click through VoiceOver: cursor into the web
      // area, then linear navigation to the sign-in button.
      await harness.focusWebArea(focusMainContent(safari));
      let clicked = false;
      for (let hop = 0; hop < MAX_CURSOR_HOPS; hop++) {
        const obs = await harness.run(hop === 0 ? "observe" : "next");
        if (templateMatches(SIGN_IN_BUTTON, obs.currentItem, {})) {
          debug("login: sign-in button under cursor — acting", { hop });
          await harness.run("act");
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        attemptOutcomes.push("button-not-found-under-vo-cursor");
        debug("login: button never reached", await pageState(safari));
        continue;
      }

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const url = await safari.currentUrl().catch(() => "");
        if (/\/course(\/|$)/.test(url)) {
          debug("login: /course redirect confirmed", { url });
          await waitForPageReady(safari);
          return;
        }
        await sleep(500);
      }
      attemptOutcomes.push(`no-course-redirect(${await safari.currentUrl().catch(() => "?")})`);
      debug("login: no /course redirect", await pageState(safari));
    } catch (e) {
      attemptOutcomes.push(`exception:${e instanceof Error ? e.message : String(e)}`);
      debug("login: exception", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  throw new Error(`VoiceOver login failed after ${MAX_ATTEMPTS} attempts: ${attemptOutcomes.join(" | ")}`);
}
