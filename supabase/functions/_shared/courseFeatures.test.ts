/**
 * Unit tests for courseFeatureEffectiveEnabled, the Deno copy of lib/courseFeatures.ts's.
 *
 * Run from supabase/functions:  deno test _shared/courseFeatures.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { CLOUD_WORKSPACES_FEATURE, courseFeatureEffectiveEnabled } from "./courseFeatures.ts";

const on = (features: unknown) => courseFeatureEffectiveEnabled(features, CLOUD_WORKSPACES_FEATURE, false);

Deno.test("absent: no entry, an empty list, a null or non-array column", () => {
  assertEquals(on([{ name: "discussion", enabled: true }]), false);
  assertEquals(on([]), false);
  assertEquals(on(null), false);
  assertEquals(on(undefined), false);
  assertEquals(on({ name: CLOUD_WORKSPACES_FEATURE, enabled: true }), false);
  assertEquals(courseFeatureEffectiveEnabled(null, "discussion", true), true, "the default decides");
});

Deno.test("false", () => {
  assertEquals(on([{ name: CLOUD_WORKSPACES_FEATURE, enabled: false }]), false);
});

Deno.test("a truthy non-boolean is not true", () => {
  for (const enabled of ["true", 1, {}, [true]]) {
    assertEquals(on([{ name: CLOUD_WORKSPACES_FEATURE, enabled }]), false, JSON.stringify(enabled));
  }
  assertEquals(on([{ name: CLOUD_WORKSPACES_FEATURE }]), false);
});

Deno.test("true", () => {
  assertEquals(
    on([null, "x", { name: "discussion", enabled: false }, { name: CLOUD_WORKSPACES_FEATURE, enabled: true }]),
    true
  );
});

Deno.test("two entries: the first decides", () => {
  assertEquals(
    on([
      { name: CLOUD_WORKSPACES_FEATURE, enabled: false },
      { name: CLOUD_WORKSPACES_FEATURE, enabled: true }
    ]),
    false
  );
  assertEquals(
    on([
      { name: CLOUD_WORKSPACES_FEATURE, enabled: true },
      { name: CLOUD_WORKSPACES_FEATURE, enabled: false }
    ]),
    true
  );
  assertEquals(
    on([
      { name: CLOUD_WORKSPACES_FEATURE, enabled: "true" },
      { name: CLOUD_WORKSPACES_FEATURE, enabled: true }
    ]),
    false,
    "a malformed first entry still decides, as in the trigger"
  );
});
