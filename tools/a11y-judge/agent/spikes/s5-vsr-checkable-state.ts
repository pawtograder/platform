/**
 * Spike S5 (THROWAWAY): does the Virtual Screen Reader announce checkable
 * state changes on PLAIN native radios/checkboxes?
 *
 * Wave-2 live runs: Space/arrows really toggled SurveyJS controls (DB proves
 * it) but the VSR announced nothing and re-reads still said "not checked".
 * This isolates whether that is a VSR limitation or an app/SurveyJS issue.
 */
import { chromium } from "@playwright/test";
import { getVsrBundleSource, VSR_GLOBAL } from "../vsrBundle";

const HTML = `data:text/html,<main>
  <fieldset><legend>Pace</legend>
    <label><input type="radio" name="pace" value="slow">Too slow</label>
    <label><input type="radio" name="pace" value="right">Just right</label>
  </fieldset>
  <label><input type="checkbox" id="c1">Graphs</label>
</main>`;

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(getVsrBundleSource());
  // tsx compiles the evaluate callback with esbuild keepNames helpers.
  await page.addInitScript("globalThis.__name = globalThis.__name || ((f) => f);");
  await page.goto(HTML);

  const result = await page.evaluate(async (globalName) => {
    const v = (window as any)[globalName].virtual;
    const log: Array<[string, string]> = [];
    const snap = async (label: string) => log.push([label, await v.lastSpokenPhrase()]);

    await v.start({ container: document.body });
    // Walk to the first radio.
    for (let i = 0; i < 10; i++) {
      await v.next();
      if (/radio/.test(await v.lastSpokenPhrase())) break;
    }
    await snap("on radio");
    await v.interact();
    await snap("after interact");
    await v.press(" ");
    await snap("after Space (radio)");
    const radioChecked = (document.querySelector('input[value="slow"]') as HTMLInputElement).checked;
    // Re-read the same item.
    await v.previous();
    await v.next();
    await snap("re-read radio");
    await v.stopInteracting();

    // Walk to the checkbox.
    for (let i = 0; i < 10; i++) {
      await v.next();
      if (/checkbox/.test(await v.lastSpokenPhrase())) break;
    }
    await snap("on checkbox");
    await v.interact();
    await v.press(" ");
    await snap("after Space (checkbox)");
    const boxChecked = (document.getElementById("c1") as HTMLInputElement).checked;
    await v.previous();
    await v.next();
    await snap("re-read checkbox");

    // Also try press with the literal word the agent used.
    await v.interact();
    await v.press("Space");
    const boxAfterWordSpace = (document.getElementById("c1") as HTMLInputElement).checked;

    await v.stop();
    return { log, radioChecked, boxChecked, boxAfterWordSpace };
  }, VSR_GLOBAL);

  for (const [label, phrase] of result.log) console.log(`${label.padEnd(24)} ${phrase}`);
  console.log("radio DOM checked after ' ':", result.radioChecked);
  console.log("checkbox DOM checked after ' ':", result.boxChecked);
  console.log("checkbox DOM checked after press('Space') toggle:", result.boxAfterWordSpace);
  await browser.close();
}

run();
