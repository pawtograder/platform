"use client";

/** Renders a person's name as unmasked text, which the taint trace must reject (test I3). */
export default function BugReportUnmaskHarness({ name }: { name: string }) {
  return (
    <main>
      <h1>Unmask harness</h1>
      <p data-report-unmask="" data-testid="unmask-harness-name">
        {name}
      </p>
    </main>
  );
}
