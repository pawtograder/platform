/**
 * Magic-link login in real Chromium, driven through NVDA — the Windows/NVDA
 * counterpart of vo/login.ts. Mint an admin magic link with the service-role
 * client, open the verification URL, click "Sign in with magic link" through
 * the NVDA cursor (so login is part of the real-AT evidence), wait for the
 * /course redirect. No passwords → no credential prompts.
 */
import { generateMagicLinkWithRetry, type TestingUser } from "../../../tests/e2e/TestingUtils";
import type { ChromeHost } from "./chromeHost";
import type { NvdaHarness } from "./nvdaHarness";
import { waitForPageReady } from "./ready";

const SIGN_IN_MATCH = /sign in with magic/i;
const MAX_ATTEMPTS = 4;
const MAX_CURSOR_HOPS = 40;
/** Consecutive identical items = cursor parked on the page's last element. */
const STUCK_CURSOR_LIMIT = 5;

const TIMEZONE_PREFERENCE_KEY = "pawtograder-timezone-pref";
const TIMEZONE_PREFERENCE_VALUE = "course";

type Debug = (stage: string, detail?: Record<string, unknown>) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pre-seed the timezone preference so its dialog never mounts (host duty). */
export async function seedTimezonePreference(chrome: ChromeHost): Promise<void> {
  await chrome
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

/** Host-side focus assist for NvdaHarness.focusWebArea. */
export function focusMainContent(chrome: ChromeHost): () => Promise<void> {
  return async () => {
    await chrome.evalJs(
      `(() => {
        const el = document.querySelector('#main-content, main, body');
        if (el) { el.setAttribute('tabindex', '-1'); el.focus(); }
        return 'true';
      })()`
    );
  };
}

/** One line of host-side page state for the debug log — never secret-bearing. */
async function pageState(chrome: ChromeHost): Promise<Record<string, unknown>> {
  const url = await chrome.currentUrl().catch((e) => `error:${e}`);
  const readyState = await chrome.evalJs("document.readyState").catch((e) => `error:${e}`);
  const title = await chrome.evalJs("document.title").catch(() => "?");
  return { url, readyState, title };
}

export async function loginWithNvda(
  chrome: ChromeHost,
  harness: NvdaHarness,
  student: TestingUser,
  baseUrl: string,
  debug: Debug = () => {}
): Promise<void> {
  const attemptOutcomes: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    debug(`login attempt ${attempt}/${MAX_ATTEMPTS}`);
    if (attempt > 1) {
      // Fresh single-use link per attempt is the real safeguard; the httpOnly
      // session cookie survives in the browser context regardless.
      await chrome.openUrl(baseUrl);
      await chrome
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
      await chrome.openUrl(`${baseUrl}/auth/magic-link?token_hash=${tokenHash}`);
      await seedTimezonePreference(chrome);
      const loaded = await chrome.waitForJs(`String(document.readyState === 'complete')`, 15_000);
      debug("login: magic-link page opened", { loaded, ...(await pageState(chrome)) });

      // Drive the confirmation click through NVDA: cursor into the web area,
      // then linear navigation to the sign-in button.
      await harness.focusWebArea(focusMainContent(chrome));
      let clicked = false;
      let lastItem = "";
      let stuckCount = 0;
      for (let hop = 0; hop < MAX_CURSOR_HOPS; hop++) {
        const obs = await harness.run(hop === 0 ? "observe" : "next");
        const heard = [obs.currentItem, ...obs.spokenSinceLastAction].join(" | ");
        if (SIGN_IN_MATCH.test(heard)) {
          debug("login: sign-in button under cursor — acting", { hop, heard });
          await harness.run("act");
          clicked = true;
          break;
        }
        stuckCount = obs.currentItem === lastItem ? stuckCount + 1 : 0;
        lastItem = obs.currentItem;
        if (stuckCount >= STUCK_CURSOR_LIMIT) {
          debug("login: cursor parked on the page's last element — ending scan early", { hop, item: lastItem });
          break;
        }
      }
      if (!clicked) {
        attemptOutcomes.push("button-not-found-under-nvda-cursor");
        debug("login: button never reached", await pageState(chrome));
        continue;
      }

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const url = await chrome.currentUrl().catch(() => "");
        if (/\/course(\/|$)/.test(url)) {
          debug("login: /course redirect confirmed", { url });
          await waitForPageReady(chrome);
          return;
        }
        await sleep(500);
      }
      attemptOutcomes.push(`no-course-redirect(${await chrome.currentUrl().catch(() => "?")})`);
      debug("login: no /course redirect", await pageState(chrome));
    } catch (e) {
      attemptOutcomes.push(`exception:${e instanceof Error ? e.message : String(e)}`);
      debug("login: exception", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  throw new Error(`NVDA login failed after ${MAX_ATTEMPTS} attempts: ${attemptOutcomes.join(" | ")}`);
}
