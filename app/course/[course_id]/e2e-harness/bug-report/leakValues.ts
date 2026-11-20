/** The canary values the `leaks` fixture renders, passed as `?v=` JSON by the D tests. */
export type LeakValues = { name: string; otherName: string; email: string; handle: string };

export function parseLeakValues(raw: string | null | undefined): LeakValues | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LeakValues>;
    if ([v.name, v.otherName, v.email, v.handle].every((s) => typeof s === "string" && s.length > 0)) {
      return v as LeakValues;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Every component that carries `data-report-unmask`, rendered by the `leaks` fixture with
 * canary props. D15 fails when the source tree has an unmask component missing from this list.
 */
export const UNMASK_COMPONENT_FILES: readonly string[] = [
  "app/e2e-harness/bug-report-unmask/BugReportUnmaskHarness.tsx"
];
