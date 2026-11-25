/**
 * The What's New registry (lib/whatsNew/registry.ts) and the Node-safe id list (lib/whatsNew/ids.ts)
 * must agree. tests/e2e/TestingUtils.ts marks the ids in ids.ts as seen, so an entry missing from
 * that list would open its dialog in every unrelated e2e test and Argos screenshot.
 */
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { ALL_WHATS_NEW_IDS, WHATS_NEW_AUDIENCES, WHATS_NEW_PAGES } from "@/lib/whatsNew/ids";
import { WHATS_NEW_ENTRIES } from "@/lib/whatsNew/registry";

describe("What's New registry", () => {
  it("registers exactly the ids in WHATS_NEW_IDS, each once", () => {
    const registered = WHATS_NEW_ENTRIES.map((entry) => entry.id);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual([...ALL_WHATS_NEW_IDS].sort());
  });

  it.each(WHATS_NEW_ENTRIES.map((entry) => [entry.id, entry]))("%s is well formed", (_id, entry) => {
    expect(Object.keys(WHATS_NEW_PAGES)).toContain(entry.page);
    expect(WHATS_NEW_AUDIENCES).toContain(entry.audience);
    if (entry.feature) expect(Object.values(COURSE_FEATURES)).toContain(entry.feature);
    expect(entry.showUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(entry.showUntil))).toBe(false);
    expect(entry.title.trim()).not.toBe("");
    expect(entry.steps.length).toBeGreaterThan(0);
    for (const step of entry.steps) expect(step.title.trim()).not.toBe("");
  });
});
