# WCAG Judge Rubrics

Per-criterion decision rubrics that form the **criterion-specific portion of the
LLM judge's system prompt** (paired with the judge charter). One markdown file per
WCAG 2.1 Success Criterion the judge evaluates — the eight judgment-call criteria
that `axe-core` cannot decide.

## Provenance & quarantine

Authored **2026-07-13** exclusively from the **W3C "Understanding SC x.x.x"
documents (WCAG 2.1)**, fetched from `w3.org/WAI/WCAG21/Understanding/`. WCAG 2.2
SC 2.4.11 Focus Appearance is referenced in the 2.4.7 rubric as *informative*
guidance only; the normative bar throughout is **WCAG 2.1 Level AA**.

**VPAT quarantine observed.** The project's human-auditor conformance report and any
auditor-findings artifacts were deliberately NOT read during authorship. This is a
ground-truth-contamination control for the research study: rubrics encode only the
public normative standard, never the specific defects the auditor found, so the
judge's coverage of those findings is an independent result.

## Criteria covered

| File | SC | Level | Judgment focus |
|---|---|---|---|
| `1.1.1-non-text-content.md` | 1.1.1 | A | alt-text *quality/adequacy* in context (presence is axe's job) |
| `1.3.2-meaningful-sequence.md` | 1.3.2 | A | DOM/reading order vs. visual order where order carries meaning |
| `2.4.3-focus-order.md` | 2.4.3 | A | tab order preserves meaning & operability |
| `2.4.6-headings-and-labels.md` | 2.4.6 | AA | descriptiveness of headings/labels present |
| `2.4.7-focus-visible.md` | 2.4.7 | AA | perceivable keyboard focus indicator |
| `3.3.1-error-identification.md` | 3.3.1 | A | error identified + described in text |
| `4.1.2-name-role-value.md` | 4.1.2 | A | correct name/role/value (present-but-wrong, not just missing) |
| `4.1.3-status-messages.md` | 4.1.3 | AA | status programmatically determinable without focus |

Each rubric follows the same 8-section structure: normative text · what the evidence
looks like · decision procedure · pass exemplars · fail exemplars · needs_human
triggers · known evidence limits · severity guidance.

## Shared verdict vocabulary

The judge emits, per (page, criterion) evidence bundle, a structured verdict:

- **`verdict`** — `pass` | `fail` | `needs_human`.
  `needs_human` is an honest abstention: static evidence cannot decide (see each
  rubric's *needs_human triggers*). It is not a soft fail.
- **`confidence`** — `low` | `med` | `high`.
- **`findings[]`** — `{ summary, severity (1–5), evidenceRefs[], elementPointer,
  suggestedFix }`. Every `evidenceRef`/selector must resolve to the bundle manifest;
  hallucinated citations are rejected in post-validation.
- **`severity` 1–5** — 5 = blocks task completion for the affected user group;
  1 = cosmetic. See each rubric's *severity guidance* for the per-criterion mapping.
- **`evidenceGaps[]`** — what the evidence could not show (collector-hardening feedback).
- **`requestedProbes[]`** — specific additional probes that would let the judge
  decide (quantifies where an agentic judge would help; round-2 material).

## Versioning & cache invalidation

Each rubric file's **content hash participates in the verdict cache key**
(`sha256(evidenceHash + rubricHash + promptVersion + model + sampleIndex)`). Editing
a rubric changes only *that criterion's* `rubricHash`, so it invalidates only that
criterion's cached verdicts — every other criterion's cache stays warm. Bump the
global `promptVersion` only when the shared judge charter (not a single rubric)
changes. Rubrics are frozen alongside `promptVersion` before the evaluation sweep so
reruns replay identical inputs.
