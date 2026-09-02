# a11y-judge — Progress Tracker

## 2026-08-03 work cycle: NVDA (Windows) real-AT lane — enforcing, 9/9

`tools/a11y-judge/nvda/` mirrors `vo/` on a Windows runner (Proxmox VM 9001; provisioning in
the ops vault, `ops/ripley-cluster.md` → "Windows screen-reader runner"). Base lane
`4c6ddcb3`. Detailed handoff, including runner gotchas, corrections and open questions:
`~/a11y-nvda-HANDOFF.md`.

**Status: green in ENFORCE mode, 9/9** (runs `30776973574` + rerun; a third confirming run was in
flight at the time of writing). Zero degraded type steps. Doctor 7/7 on the runner. Enforce checks
what calibrate never did: the DB write predicate per write task, a task failure for any typing that
fell back to `hostSetValue`, a task failure for any state-changing step where NVDA's own cursor
contradicted the plan, and a thrown `ReplayMilestoneError` on an unmatched milestone instead of a
recorded miss. The 6 read tasks pass at 0 resyncs; the 3 write tasks need 3–6 resyncs and land at
3-of-4 / 3-of-5 / 3-of-5 cursor agreement, which is the honest half of the headline (below).
**VoiceOver stays 9/9 in enforce** (run `30778249419`) with all of the shared-code changes in
place, confirming on the runner that the new hooks are inert where they are not implemented.

**The structural gotcha that invalidated the first round of results:** guidepup's
`nvda.itemText()` is an **alias for `lastSpokenPhrase()`**
(`@guidepup/guidepup/lib/windows/NVDA/NVDA.js:527-532`; `itemTextLog()` aliases
`spokenPhraseLog()` at `:621-626`), unlike VoiceOver's genuine caption read. No guidepup accessor
reports the review cursor, so `milestoneMatches` and the resync/needle sweeps in `agent/replay.ts`
match a **speech-log tail** on this lane: a stale utterance satisfies a milestone and the ladder
never engages. Run `30682097759` measured the damage — 11 of 14 state-changing steps fired on
elements the plan never recorded while all three write tasks reported success.

**NVDA can be asked, and that is what closed the lane.** `reportCurrentObject` (NVDA-NumPad5)
speaks the navigator object on demand; probe run `30681006352` measured that the answer tracks the
cursor, repeats when the cursor holds still, and survives a poisoned speech tail. Three pieces:

- **Record** (`NvdaCursorCheck`/`takeCursorChecks`): every state-changing step carrying a milestone
  is checked, with five verdicts, because "the oracle can't say" and "the oracle disagrees" are
  different findings. Recording alone changed nothing — nothing consulted it in time.
- **Gate** (`AtDriver.verifyCursor` + `createMilestoneGate` in `agent/replay.ts`): asked one layer
  earlier, where `contradicted` means the milestone is UNMET and the ladder keeps searching, with no
  proceed-anyway fallback. `abstained` never blocks (NVDA collapses plain text to a bare role).
- **Bounds:** a consultation is a ~1.5–2.5 s round trip (~8.4 s worst case), spent only on an
  already-claimed match, memoized per `(milestone, speechItem)`, and capped at
  `MAX_CURSOR_VERIFICATIONS_PER_STEP = 8`.

**Turning the gate on exposed two matching/navigation defects the stale speech had been hiding:**

- **Head-anchored matching vs mid-line names.** NVDA speaks a browse line as one comma-joined run
  and buries the name mid-line (`"Like (0 likes), button, Edit, button, Reply"`), so a milestone it
  speaks anywhere but first can never match. `nvdaLineSegmentAlternates` offers comma-aligned
  SUFFIXES as `currentItemAlternates` (one degree of freedom, not containment; suffixes starting on
  role/state words dropped). Replaying all 193 distinct items of run `30702006927` against the write
  plans' 13 milestones flips exactly 9 verdicts, each one the item's own accessible name.
- **`next`/`previous` move by LINE.** They are ArrowDown/ArrowUp, so they cannot rest on one of
  three buttons sharing a coalesced line (run `30760469666`: every press rested on Like while the
  milestone was Reply). `AtDriver.moveToControl` adds a control-level rung, NVDA-implemented as
  quick-nav `B`/`Shift-B`. `CONTROL_SWEEP_LIMIT = 32` is measured, not guessed: run `30775582313`
  showed a budget of 8 consumed entirely by seven header buttons before the discussion region.

**Two evidence-integrity fixes to the lane itself** (both bit us, both are the "fix-the-harness"
loop again):

- `--calibrate` skips the write predicate (`run.ts`, `plan.taskKind === "write" && !args.calibrate`),
  so a green calibrate on a write task means "nothing timed out", not "the text landed".
- Rung 4 of the type ladder (`hostSetValue`) writes the field value from the DOM, bypassing the
  keyboard entirely, and until `199f686d` that only reached `debug()` — the step recorded clean
  and the task went green. Per-type-step `TypeStepFidelity` is now recorded, drained per task,
  and surfaced in console/`summary.md`/junit; enforce fails a degraded step, calibrate warns.
  Verification also now requires whole-text EQUALity (`0306599e`): containment matching had
  passed survey-taking with a field holding 64 chars of doubled text for 32 expected.

**Fixes landed.** Write path: `f1a95bc6` focus-routing ladder before typing (the port had dropped
VoiceOver's `voHarness.ts:500` rung; adds a foreground guard, probe-first, AT-native routing, and a
single-character safety valve because in NVDA browse mode a stray letter is quick-nav, so a
mis-routed 68-char string is 68 caret jumps) · `199f686d` typing fidelity · `955edbf6` `interact`
guarded on both sides + speech-loss detect/recover/fail-fast (`interact` on a landmark makes NVDA
stop speaking: `item=""` for ~270 consecutive commands, ~10 min/attempt) · `0306599e` exact
verification + deterministic host-clear. Cursor oracle: `b6ce02f9` milestone threaded to drivers via
optional `AtStepContext` (the type path's only non-speech label source) · `0f803b40` oracle as record
· `f548098b` oracle as gate · `1806be51` comma-aligned segment alternates · `5abea7b4` control-level
hop · `50b3ff13` sweep budget 8 → 32. All three `AtDriver` hooks (`unstick`, `verifyCursor`,
`moveToControl`) are optional and guarded at their call sites, which is why the VO lane is untouched.

**Limitations to state plainly, alongside the 9/9:** (1) the recorded plans still do not walk
cleanly on NVDA — the lane now CORRECTS drift rather than the drift being fixed at source, and the
3-of-5 cursor-agreement ratios are the visible evidence; (2) the oracle abstains on prose
(`reportCurrentObject` gives name+role for controls, a bare `"paragraph"` for text), so it
corroborates the speech tail rather than replacing it; (3) unfixed app finding — `ThreadActions`
(`app/course/[course_id]/discussion/[root_id]/page.tsx`) renders a flat run of icon-only buttons
that NVDA coalesces into one browse line, so arrow keys cannot reach them individually (Tab does,
and VoiceOver walks them as three items, so it is not a clear WCAG violation); (4) `calibratePlan`
records a milestone miss and runs the step anyway, and changing it to record-and-skip would affect
the VO lane too, so it is undecided; (5) `vo/run.ts`'s `calibratePlan` still calls
`milestoneMatches` directly rather than the shared gate — identical behavior today, since VO
supplies no `verifyCursor`, but an inconsistency.

**Environment note:** the NVDA lane must run against a PR preview built from the branch, never
staging — staging lacks 15+ of this branch's app-side a11y fixes (incl. `177ebb67` office-hours
render-phase `redirect()` crash) and the replay hits a client-side exception page. Earlier
"calibrate clean" numbers were collected on staging and are measuring the wrong build.
`workflow_dispatch` on `a11y-nvda.yml` becomes available once the workflow reaches the default
branch; until then the lane is dispatched from wherever the workflow lives.

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

### Verification (2026-07-23, local stack, prod build on :3001)

- 12 a11y unit suites: 100/100 green. tsc clean for all touched files (25 pre-existing error
  lines on HEAD unchanged).
- Replay specs: **6/6 green ×3 on fresh seeds** (determinism gate) — including
  survey-complete at full speed with `test.fixme` removed (autosave-race fix holds); specs
  promoted (`git add -f`).
- Seeded axe smoke: 4/4 new pages pass, **Monaco fully in scope — zero re-excludes needed**.
  Full smoke+keyboard+reflow: 28/28.
- Evidence collection: 9/9 pages × 7 bundles (office-hours driver needed a named-region ready
  locator — hidden-node getByText timeout).
- Video mode: 6/6 videos + gallery (`a11y-videos/verify-videos/`); frame-checked — highlight
  box + caption bar render correctly. Collector falls back to the sidecar's sibling
  `video.webm` (Playwright moves the file from the promised artifacts path on context close).

### Live efficacy evaluation (2026-07-23 evening — LLM runs)

**Agent, 5 tasks exercised (1 sample + 2 office-hours retries): 5/5 predicate-green final.**
6–90 steps, 0.7–8.4 min/task. assignments-overview & regrade-status clean; code-marker
completed WITH a sev-4 finding (below); survey-complete green; help-request blocked twice →
diagnosed (seeding had no active queue staff → New Request disabled; + silent SPA navigation
misread as no-op) → seeding fixed (`insertHelpQueueAssignment`) + charter a1.2
(re-orient after activation before concluding failure) → completed, DB predicate green.

**Deterministic specs:** 4 generated from the new trajectories; assignments-overview,
regrade-status, help-request passed the 3× gate and are promoted (+ survey regenerated, green).
code-marker FAILED the gate (read-needle never heard on replay — the recorded flow toggles a
per-user preference; left unpromoted, exactly what the artifact-first policy is for).

**Static judge, 28 cells on the 4 new pages (1 sample, cli backend):** 22 pass / 5
needs_human (honest, precise gaps) / 1 fail. ~1.5 min & ~$0.20 API-equiv per judgment
(subscription-covered). The one fail (assignments-list 2.4.3, high confidence) was a
**collector false positive**: blur() does not reset the sequential-focus-navigation starting
point, and the focus-indicator collector leaves it mid-page → the tab walk started mid-document
and the rotation read as a tabindex scramble. Ground-truthed in a real browser (order correct),
collector now anchors the start point + records `revisited` flags; re-judge → pass (high).
Rubric untouched. A 2.4.7 needs_human pointed at a REAL recurrence of the invisible-focus-ring
defect on the assignments search input (raw Chakra Input) — fixed.

**New APP FINDINGS from the live runs (leads for follow-up):**

- Client-side navigation is silent: `/office-hours` auto-redirects to the queue page and
  view/tab/New-Request-form switches announce nothing (4.1.3, sev 3, agent-experienced twice).
- Help-request submit failure announces only the bare word "Error" — no description (3.3.1, sev 3).
- Monaco exposes no code content to the virtual SR even with accessibilitySupport:"on" (content
  is caret-navigation-only); agent completed the read-task only via the "New editor view"
  toggle. Toggle now announces the accessible alternative; **real-AT (NVDA/VoiceOver) validation
  of Monaco caret reading is owed** before filing as a WCAG failure.
- Disabled "New Request" button offers no accessible explanation of why/how to enable (3.3.2).

**VSR fidelity issues found & compensated (fix-the-harness loop):** re-announcement spam
(14× for one DOM mutation — MutationObserver ground truth; harness now collapses consecutive
repeats to "(announced N×)", charter a1.1) and silent-SPA re-orientation (charter a1.2).
Judge CLI gained per-judgment progress logging + incremental sample persistence (a silent
multi-hour serial loop was indistinguishable from a hang and lost samples when killed).

**Toast fix verified at DOM level:** exactly one toast region, one "Survey Submitted" text
mutation per submit. The agent's residual repeat-report was the VSR artifact above.

**Still owed:** judge sweep over the 5 original pages' fresh evidence + samples-3 unanimity
on the new pages (nightly candidate); real-AT spot check for Monaco; auditor adjudication
packet (now including the keyboard-nav video gallery).

## V2: Agentic SR-driving (approved 2026-07-14, plan `~/.claude/plans/glowing-sparking-turtle.md`)

An LLM agent drives the app using ONLY a screen-reader view (@guidepup/virtual-screen-reader
injected via addInitScript) + keyboard, attempting realistic student tasks; successful
trajectories get distilled into deterministic Playwright tests. Round 1 stays intact as the
baseline/ablation. Locked: tests are artifacts first (promoted after a determinism gate);
task success is machine-checked (DB predicates / taskAnswer vs seed ground truth), never
self-reported; no verdict cache for agent runs; trajectories recorded host-side at the MCP
handler.

### V2 build status

| Wave | Package                                                                | Status  | Gate result                                                                                        |
| ---- | ---------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| 0-S2 | `claude -p` ⇄ in-process HTTP MCP round-trip (OAuth, no stdio proxy)   | ✅ done | echo tool + structured output first try; ~$0.21; transport locked: HTTP (`--mcp-config` type:http) |
| 0-S1 | VSR injection + scripted (no-LLM) survey completion, SR commands only  | ✅ done | survey submitted (DB-verified); avg 6ms/cmd, Monaco start() 45ms — perf concern retired            |
| 0-S3 | Spoken-phrase stability across two seeds                               | ✅ done | normalized logs identical; rules: seed-binding substitution + noise drop + {{number/date/time}}    |
| 1    | AT harness core (vsrBundle/atHarness/pageReady extraction, unit tests) | ✅ done | scripted survey via real API 3× green, pairwise logs identical; R1 a11y:collect green post-extract |
| 2    | Bridge + agent runner + survey task live                               | ✅ done | 26/26 unit; 2-sample gate: both success/completed, predicate green, 44–57 turns, ~$1.1–1.2/run     |
| 3    | Full 6-task suite + reporting                                          | ✅ done | clean sweep 6/6: all completed + predicate green, 0 errors/salvages, 15–37 turns, ~$4.1, 11.8 min  |
| 4    | Deterministic spec generation (artifact→promote)                       | ✅ done | 5 promoted specs green 3× on fresh seeds (no LLM); red under 246→grade, 412→discussion-reply       |
| 5    | Evaluation: clean 6×3 + agent mutation gauntlet + ablation vs R1       | ✅ done | clean 18/18 predicate-pass; gauntlet 6 mutations ×3; complementarity ablation (below)              |

### V2 evaluation results (run `a11y-trajectories/eval-clean/eval.md`)

**Clean reliability:** 6 tasks × 3 samples = 18/18 predicate-pass, 0 errors, 0 salvages;
15–37 steps/task, ~$0.4–1.1/task.

**Mutation gauntlet — agent detection (blocked OR barrier with matching WCAG SC) vs the R1 static judge:**

| Mutation                 | SC    | agent detection | R1 static judge                   | reading                                                                            |
| ------------------------ | ----- | --------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| 246-headings-generic     | 2.4.6 | 100%            | fail 3/3                          | both catch                                                                         |
| 132-survey-options-first | 1.3.2 | 67%             | fail 3/3                          | both catch                                                                         |
| 413-silent-toast         | 4.1.3 | 67%             | needs_human 3/3 (**unreachable**) | **agent uniquely reaches** — completes the survey but hears no submit confirmation |
| 412-strip-labels         | 4.1.2 | 33%             | fail 3/3                          | static judge stronger (agent completes via position/context)                       |
| 111-alt-degrade          | 1.1.1 | 0%              | fail 3/3                          | static judge stronger                                                              |
| 247-outline-none         | 2.4.7 | 0%              | fail 15/15                        | **honest scope boundary** — SR cannot perceive a visual focus outline              |

**Thesis (complementarity, not redundancy):** agent mode scores _task-level_ barriers a real
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
