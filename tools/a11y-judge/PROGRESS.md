# a11y-judge — Progress Tracker

## 2026-07-23 work cycle: fixes landed + coverage grind + Monaco + videos

All four previously-found app defects are **fixed on this branch** (same PR as the tool):

- ✅ like-button accName "0" — dynamic aria-label in `components/ui/discussion-post-summary.tsx`
  and `app/course/[course_id]/discussion/discussion_thread.tsx` (PostRow pattern).
- ✅ "Search posts" invisible focus ring — explicit 2px `_focusVisible` outline in
  `components/discussion/DiscussionSearch.tsx`.
- ✅ toast announced ~15× — `<Toaster />` was mounted 32× against one shared store (every mount
  is its own live region); now a singleton in `app/layout.tsx`, 31 mounts removed.
- ✅ survey autosave data-loss race — debounced autosave + submit-guards + never-downgrade in
  `app/course/[course_id]/surveys/[survey_id]/page.tsx`; `replayBlockedBy` removed from
  `SURVEY_COMPLETE_TASK`, the 1500ms replay workaround pauses dropped, survey spec regenerated
  without `test.fixme`.

Coverage: **9 pages / 10 tasks** (added assignments-list, submission-files, regrade-requests,
office-hours). New `insertHelpRequest` seed helper (TestingUtils); shared `A11Y_CODE_FILES`
fixture with an in-code marker comment the submission-files read-task must reach through the SR
channel. Seeded axe-smoke block covers the 4 new pages.

Monaco: read-only viewer configured (`ariaLabel`, `accessibilitySupport:"on"`,
`accessibilityPageSize:100`, `tabFocusMode:true`) and **removed from the axe exclude list** —
violations inside Monaco internals get narrow, documented re-excludes only if a scan proves them.

Video pipeline (`npm run a11y:tasks:video`): replay specs record keyboard-only journeys with an
SR-cursor highlight + spoken-caption overlay (outside `document.body`, invisible to the VSR),
sidecar meta per test, post-run collector → `a11y-videos/<runId>/` + gallery `index.html` for
async auditor review.

## V2: Agentic SR-driving (approved 2026-07-14, plan `~/.claude/plans/glowing-sparking-turtle.md`)

An LLM agent drives the app using ONLY a screen-reader view (@guidepup/virtual-screen-reader
injected via addInitScript) + keyboard, attempting realistic student tasks; successful
trajectories get distilled into deterministic Playwright tests. Round 1 stays intact as the
baseline/ablation. Locked: tests are artifacts first (promoted after a determinism gate);
task success is machine-checked (DB predicates / taskAnswer vs seed ground truth), never
self-reported; no verdict cache for agent runs; trajectories recorded host-side at the MCP
handler.

### V2 build status

| Wave | Package                                                                  | Status  | Gate result                                                                                          |
| ---- | ------------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------- |
| 0-S2 | `claude -p` ⇄ in-process HTTP MCP round-trip (OAuth, no stdio proxy)     | ✅ done | echo tool + structured output first try; ~$0.21; transport locked: HTTP (`--mcp-config` type:http)  |
| 0-S1 | VSR injection + scripted (no-LLM) survey completion, SR commands only    | ✅ done | survey submitted (DB-verified); avg 6ms/cmd, Monaco start() 45ms — perf concern retired             |
| 0-S3 | Spoken-phrase stability across two seeds                                 | ✅ done | normalized logs identical; rules: seed-binding substitution + noise drop + {{number/date/time}}     |
| 1    | AT harness core (vsrBundle/atHarness/pageReady extraction, unit tests)   | ✅ done | scripted survey via real API 3× green, pairwise logs identical; R1 a11y:collect green post-extract  |
| 2    | Bridge + agent runner + survey task live                                 | ✅ done | 26/26 unit; 2-sample gate: both success/completed, predicate green, 44–57 turns, ~$1.1–1.2/run      |
| 3    | Full 6-task suite + reporting                                            | ✅ done | clean sweep 6/6: all completed + predicate green, 0 errors/salvages, 15–37 turns, ~$4.1, 11.8 min   |
| 4    | Deterministic spec generation (artifact→promote)                         | ✅ done | 5 promoted specs green 3× on fresh seeds (no LLM); red under 246→grade, 412→discussion-reply         |
| 5    | Evaluation: clean 6×3 + agent mutation gauntlet + ablation vs R1         | ✅ done | clean 18/18 predicate-pass; gauntlet 6 mutations ×3; complementarity ablation (below)                |

### V2 evaluation results (run `a11y-trajectories/eval-clean/eval.md`)

**Clean reliability:** 6 tasks × 3 samples = 18/18 predicate-pass, 0 errors, 0 salvages;
15–37 steps/task, ~$0.4–1.1/task.

**Mutation gauntlet — agent detection (blocked OR barrier with matching WCAG SC) vs the R1 static judge:**

| Mutation | SC | agent detection | R1 static judge | reading |
| --- | --- | --- | --- | --- |
| 246-headings-generic | 2.4.6 | 100% | fail 3/3 | both catch |
| 132-survey-options-first | 1.3.2 | 67% | fail 3/3 | both catch |
| 413-silent-toast | 4.1.3 | 67% | needs_human 3/3 (**unreachable**) | **agent uniquely reaches** — completes the survey but hears no submit confirmation |
| 412-strip-labels | 4.1.2 | 33% | fail 3/3 | static judge stronger (agent completes via position/context) |
| 111-alt-degrade | 1.1.1 | 0% | fail 3/3 | static judge stronger |
| 247-outline-none | 2.4.7 | 0% | fail 15/15 | **honest scope boundary** — SR cannot perceive a visual focus outline |

**Thesis (complementarity, not redundancy):** agent mode scores *task-level* barriers a real
screen-reader user hits and uniquely reaches 413 (visible-but-unannounced, which frozen
evidence cannot manifest); the static judge uniquely catches visual-only (247) and
name-quality (412/111) defects a user can complete the task despite. Neither dominates —
the argument for running both.

### V2 findings so far

- **APP FINDING (agent-discovered, live run):** on survey submit, the "Survey Submitted"
  confirmation is announced ~15 identical times through the polite live region (duplicate
  toast/live-region spam; 4.1.3-adjacent, sev 2). Verify + fix separately.
- **VSR limitation (spike s5, plain native inputs):** checkable toggles are neither announced
  nor reflected on re-read ("not checked" forever) even though the DOM toggles fine. The
  harness compensates with a truthful `checkableState` field on every observation, and the
  charter tells the agent not to report missing check announcements as app barriers.
  Pre-fix, the agent filed false sev-5 "radios unusable" barriers — the fix-the-harness loop
  from R1 carries over intact.
- **CLI structured-output reliability:** after ~100-turn sessions the CLI drops the one
  array-of-objects property from StructuredOutput params (5/5 retries, subtype
  `error_max_structured_output_retries`); short sessions are fine (spike s4). Fix: barriers
  travel as a JSON-encoded string (`barriersJson`), parsed + zod-validated host-side.

- **APP DEFECT (data loss, pre-LLM discovery):** the survey page autosaves on every value
  change with no debounce; the blur-triggered autosave (`is_submitted:false`) races the
  Complete upsert (`is_submitted:true`) and can land last — a submitted survey is silently
  reverted (observed: `submitted_at` set, `is_submitted=false`, writes <1ms apart). Found by
  the scripted task predicate before any LLM ran. Fix in
  `app/course/[course_id]/surveys/[survey_id]/page.tsx` (separate PR).
- addInitScript wraps sources in a function scope: esbuild IIFE globals need an explicit
  `;window.__X = __X;` suffix or they silently vanish.
- esbuild cannot be imported under Jest (jsdom); `vsrBundle.ts` lazy-requires it.
- `@modelcontextprotocol/sdk` is ESM-only and fails under Jest CJS: the tool surface lives
  in `agent/toolSurface.ts` (SDK-free) so the runner/unit tests never load the SDK.

## Round 1 (frozen baseline)

> Living document — update per work cycle. Not committed yet (whole tool is uncommitted on
> `a11y/wcag-aa-student-pages`). Approved plan:
> `~/.claude/plans/partitioned-hopping-mountain.md`. Last updated: **2026-07-14**.

## Goal recap

Automated WCAG 2.1 AA testing beyond axe-core using an LLM judge over frozen evidence
bundles; doubles as an ICST submission. Locked decisions: student pages only; judge is an
on-demand npm script (never blocking CI); evaluation claims = **beats-axe coverage** vs
auditor ground truth + **judge reliability** + **generalizability**; seeded mutations are
an internal hardening gate, not the headline.

## Build status (plan waves)

| Wave | Package                                                                                                  | Status  | Gate result                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1A   | Evidence kit core (schemas, canonical hash, bundle writer, promoted tabOrder/focusIndicator)             | ✅ done | Hash canonicalization unit tests green; probe-JSON stable across back-to-back runs (attachment bytes differ, expected) |
| 1B   | 8 criterion rubrics from W3C Understanding docs                                                          | ✅ done | VPAT quarantine observed; **never edited since authoring** (`promptVersion r1.0` frozen)                               |
| 2C   | Page drivers — 5 seeded student pages, env-gated spec                                                    | ✅ done | Clean collection green: 36 bundles / 5 pages                                                                           |
| 2D   | Judge CLI (`@anthropic-ai/sdk`, structured outputs, verdict cache, batch mode)                           | ✅ done | Micro-fixture judged correctly; cache hit on rerun                                                                     |
| 2D+  | **`claude -p` backend** (standing OAuth session; `--backend api\|cli\|auto`; cache namespace `r1.0+cli`) | ✅ done | Live micro-fixture: fail/high; cache hit verified                                                                      |
| 2E   | Mutation injectors (8) + HTML report renderer                                                            | ✅ done | 10/10 unit tests; renderer verified against real sweep after object-bug fix                                            |
| 3    | Integration: npm scripts, gitignore, mutation wiring, gauntlet, dry run                                  | ✅ done | See scorecard below                                                                                                    |

## Mutation gauntlet scorecard (gate: fail in ≥2/3 samples)

| Mutation                 | Criterion | Result                                 | Notes                                                                                                                                                                                                               |
| ------------------------ | --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 247-outline-none         | 2.4.7     | ✅ 15/15 fail (all 5 pages, unanimous) | first try                                                                                                                                                                                                           |
| 412-strip-labels         | 4.1.2     | ✅ 3/3 fail                            | first try                                                                                                                                                                                                           |
| 243-tabindex-shuffle     | 2.4.3     | ✅ 3/3 fail                            | first try                                                                                                                                                                                                           |
| 111-alt-degrade          | 1.1.1     | ✅ 3/3 fail                            | first try                                                                                                                                                                                                           |
| 331-hide-error-text      | 3.3.1     | ✅ 3/3 fail                            | first try                                                                                                                                                                                                           |
| 132-survey-options-first | 1.3.2     | ✅ 3/3 fail                            | after injector fix (SurveyJS header/content are siblings)                                                                                                                                                           |
| 246-headings-generic     | 2.4.6     | ✅ 3/3 fail                            | after mutation-tolerant driver waits                                                                                                                                                                                |
| 413-silent-toast         | 4.1.3     | ⬜ **unreachable mutant**              | aria-independent visible-status recorder proved NO status message ever appears during survey autosave → "visible but unannounced" cannot manifest; judge abstained 3/3 with precise evidenceGaps (correct behavior) |

**Key methodological point:** every gauntlet iteration was fixed on the _collector/injector/driver_
side — the rubrics were never touched.

## Clean-app sweep (run-2026-07-14T04-15-46-172Z, report.html inside)

- 36 (page × criterion) verdicts, 108 samples, 0 errors; ~$15 API-equivalent (subscription-covered).
- **Self-consistency: 32/36 unanimous**; all 4 disagreements are pass↔needs_human, never pass↔fail.
- **Independent rediscovery of a VPAT-class defect** (rubrics were quarantined): discussion
  main-pane like button's accessible name is the bare numeral **"0"** — unanimous fail under
  4.1.2 and 2.4.6, sev 3, concrete fix suggested. Also re-flagged under 1.1.1 by one sample.
- Additional real lead: discussion "Search posts" input has a 1px focus outline identical to
  its own border color (2.4.7 needs_human with pixel-level rationale).
- survey 1.3.2 = pass — correct; that VPAT finding was fixed on this branch before the project.

## Abstention feedback loop — demonstrated

`needs_human` + `evidenceGaps` → targeted collector enrichment → abstentions become decisions:

1. 4.1.3: judge said it couldn't compare visible vs announced status → added before/after
   interaction screenshots + aria-independent `visibleStatusEvents` recorder (which then
   proved the 413 mutant unreachable).
2. 1.1.1: judge said the images probe lacked the enclosing button's name → added
   `interactiveAncestor {tag, role, accName, nameSource, iconOnly}` → gradebook flipped
   needs_human → unanimous pass; all 5 pages now decidable.

## Fixed defects in the tool itself

- Report matrix rendered `[object Object]`: judge writes majority `verdict` as the full
  object, renderer typed it as string (parallel-agent contract drift). Normalizer added;
  unit test now uses the real shape and asserts no `[object Object]`.
- `elementPointer` objects now render as compact text in finding cards.
- NUL bytes in render.ts (map-key separators) made grep treat the source as binary → `|`.

## Cost & reliability snapshot

- ~$0.15–0.50 API-equivalent per judgment; full sweep ≈ $15 (Batches would halve API cost);
  all zero marginal cost via `claude -p` on the standing OAuth session.
- Hallucinated-citation post-validation active; rejection events logged per sample
  (tally pending in eval script).

## Remaining work

- [ ] **Final frozen sweep** for auditor handoff (task #7): fresh collection (picks up
      enriched 4.1.3 + 1.1.1 evidence) → full `--samples 3` sweep (~3 h, new screenshots
      miss cache) → `a11y:report`.
- [ ] Hand `report.html` + evidence bundles to the human auditor: re-audit of the 5 pages +
      per-verdict adjudication (agree / disagree / evidence-insufficient).
- [ ] `eval/groundTruth.ts` metrics script (needs auditor adjudication): per-criterion P/R vs
      auditor, axe baseline comparison (run axe with `exclude: []`), Cohen's κ judge–human,
      Fleiss' κ self-consistency, needs_human rate, citation-rejection rate, cost/latency.
- [ ] Generalizability demo: run collectors against one non-Pawtograder page (README smoke
      case); pitch tool to auditor for their other projects.
- [x] Fix the app defects the tool found — DONE 2026-07-23, same PR (see top section).
- [ ] Commit the tool (`tools/a11y-judge/`, `tests/e2e/a11y-evidence.spec.ts`, unit tests,
      package.json/.gitignore changes) when ready.
- [ ] Round 2 / paper future work: agentic judge (quantify via logged `requestedProbes`),
      4.1.3 flow with a real status message (e.g. survey Complete toast), webkit project,
      Batches nightly workflow.

## Runbook

```bash
BASE_URL=http://localhost:3001 npm run a11y:collect        # Phase A (no API key)
npm run a11y:judge                                          # auto backend: api iff ANTHROPIC_API_KEY, else claude -p
npm run a11y:report                                         # open a11y-verdicts/latest/report.html
A11Y_MUTATION=<id> A11Y_RUN_ID=gauntlet-<id> npm run a11y:collect   # plant a defect
```

## Data locations (gitignored)

- Evidence: `a11y-evidence/` — `2026-07-13T23-41-04-138Z` (clean, pre-enrichment),
  `clean-2026-07-14-v2` (enriched images probe), `gauntlet-*` (per-mutation).
- Verdicts + cache: `a11y-verdicts/` — sweep `run-2026-07-14T04-15-46-172Z` (report.html),
  per-gauntlet runs, `.cache/` (replayable without any API access).
