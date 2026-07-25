# a11y-judge — LLM-as-Judge WCAG 2.1 AA Testing Beyond axe-core

Automated testing for the WCAG success criteria that rule-based scanners (axe-core)
**cannot** decide: reading order, focus order, focus visibility, error identification,
accessible-name quality, status-message announcement, alt-text adequacy, and
heading/label descriptiveness. It works in two phases:

1. **Evidence collection (deterministic, no API key).** Playwright collectors drive a
   page and write a content-hashed _evidence bundle_ per (page, criterion): structured
   JSON probes (tab-order traces with geometry and DOM-order flags, live computed focus
   styles, DOM-order text serializations, aria snapshots, accessible-name dumps,
   live-region mutation timelines, error-flow transcripts) plus labeled screenshots.
2. **LLM judging (on-demand).** A CLI feeds each bundle + a per-criterion rubric
   (distilled from the W3C Understanding documents) to Claude with structured outputs,
   producing verdicts: `pass | fail | needs_human`, confidence, findings with severity,
   **evidence citations validated against the manifest** (hallucinated citations are
   rejected and counted), suggested fixes, and `evidenceGaps`/`requestedProbes` for
   honest abstention. Verdicts are cached by content hash — unchanged evidence never
   re-bills. N samples + majority vote handle judge stochasticity; per-criterion
   self-consistency is reported.

The frozen evidence bundle is the unit of science: a human auditor annotates the same
artifacts the judge sees, reruns replay identical inputs, and a wrong verdict decomposes
into "evidence was insufficient" vs "judge misjudged".

## Directory map

| Path                 | What                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `schema/evidence.ts` | Evidence bundle + probe schemas, canonical content hash              |
| `schema/verdict.ts`  | Verdict schema (structured-outputs compatible)                       |
| `collect/`           | Playwright collectors — depend only on a `Page` and an output dir    |
| `rubrics/`           | Per-criterion judge rubrics (see `rubrics/README.md` for provenance) |
| `mutations/`         | Seeded-defect injectors for gauntlet/validation runs                 |
| `judge/`             | Claude client, verdict cache, CLI (`run.ts`), Batches mode           |
| `report/render.ts`   | Single self-contained HTML report (matrix + verdict cards)           |

## Usage (in this repo)

```bash
# 1. Collect evidence (local stack on :3001; no API key needed)
BASE_URL=http://localhost:3001 npm run a11y:collect

# 2. Judge it. Backend auto-detects: with ANTHROPIC_API_KEY set it calls the API
#    directly (~$4–7 per full sweep at claude-opus-4-8 rates); without one it runs
#    `claude -p` over the machine's standing Claude Code OAuth session (subscription
#    usage, no API bill). Force with --backend api|cli.
npm run a11y:judge                 # or: npm run a11y:judge:batch  (50% off; api backend only)

# 3. Render the report (open a11y-verdicts/latest/report.html)
npm run a11y:report

# Optional: plant a known defect and confirm the judge catches it
A11Y_MUTATION=247-outline-none A11Y_RUN_ID=gauntlet-247 BASE_URL=http://localhost:3001 npm run a11y:collect
npm run a11y:judge -- --evidence a11y-evidence/gauntlet-247
```

Judge CLI flags: `--evidence <dir>` `--pages <csv>` `--criteria <csv>` `--samples <n>`
`--batch` `--force` (bypass cache).

## Using it on another project

The core is repo-independent: collectors take `(page: Page, outDir)`; the judge and
report read only the evidence/verdict directories. To adopt it elsewhere:

1. Copy `tools/a11y-judge/` and add deps: `@anthropic-ai/sdk`, `zod >= 3.25`, `tsx`,
   `@playwright/test` (dotenv optional, only for `run.ts` env loading).
2. Write a small driver spec for your app: navigate to each page you care about,
   call the collectors, write bundles with `EvidenceBundleWriter` — mirror
   `tests/e2e/a11y-evidence.spec.ts` in this repo (~1 page of code per target page).
3. Run the judge + report exactly as above.

What is repo-specific and stays behind: seeding/login fixtures, page waits, and the
mutation injectors' selectors (they target this app's widgets).

## Agent mode (v2): drive the app with a screen reader + keyboard

The static judge above scores _frozen evidence_: it can only see what the
collectors thought to capture. Agent mode closes that gap by letting an LLM
**drive the app itself** through a screen-reader/keyboard channel and _nothing
else_ — no DOM, no screenshots, no mouse — attempting realistic student tasks.

- **AT harness** (`agent/atHarness.ts`): injects `@guidepup/virtual-screen-reader`
  into the page (`addInitScript`, so it survives navigation and the app CSP) and
  exposes a screen-reader command surface — `next/previous/readNext`,
  `moveToNextHeading/Landmark`, `act/interact/type/press`, raw `pressKey` — plus
  a truthful `checkableState` the simulator itself omits. Every result is
  `{spokenSinceLastAction, currentItem, domFocus}`.
- **Bridge + runner** (`agent/bridge.ts`, `agent/agentRunner.ts`): an in-process
  HTTP MCP server (token-guarded, 127.0.0.1) hands those commands to a spawned
  `claude -p` agent restricted to `mcp__at__*`. The agent's every tool call is
  recorded host-side into a content-hashed **trajectory** — it cannot misreport
  what it did. It ends with an `AgentVerdict` (outcome, `taskAnswer`, barriers
  with WCAG mapping + trajectory-step citations, validated like the static judge).
- **Machine-checked tasks** (`agent/tasks.ts`): success is never self-reported —
  write-tasks verify DB state, read-tasks compare `taskAnswer` to seed-derived
  ground truth.
- **Generated regression tests** (`agent/generateSpec.ts`): a successful
  trajectory is distilled into a deterministic Playwright spec under
  `tests/e2e/a11y-tasks/` that replays the SR/keyboard sequence with normalized
  milestone assertions — **no LLM at replay time**. These stay green on fresh
  seeds and go red under the seeded mutations.

```bash
npm run a11y:agent            # A11Y_AGENT_SAMPLES / A11Y_AGENT_TASKS / A11Y_MUTATION
npm run a11y:agent:report     # a11y-trajectories/latest/report.html
npm run a11y:generate-specs   # trajectories -> deterministic replay specs
npm run a11y:tasks            # run the generated specs (no LLM); --workers=1
npm run a11y:tasks:video      # same specs + video recording -> a11y-videos/latest/index.html
npm run a11y:agent:eval -- --clean <run> --gauntlet <run> ...   # scorecard
```

### Coverage

Nine seeded student pages: survey-taking, autograder-results, grade-summary,
gradebook, discussion, assignments-list, submission-files (Monaco code viewer),
regrade-requests, office-hours — ten agent tasks (discussion carries two). The
read-only Monaco viewer is configured for AT (ariaLabel, accessibilitySupport
"on", tabFocusMode so Tab exits) and is **in scope** for axe scans; the
submission-files read-task requires the agent to reach a marker comment inside
the code through the SR channel.

## Keyboard-navigation videos (auditor handoff)

`npm run a11y:tasks:video` re-runs the deterministic replay specs with
`A11Y_VIDEO=1`: Playwright records each journey while an in-page overlay draws
a highlight box tracking the SR cursor and a caption bar with the command +
spoken phrases, at watchable pacing. A post-run collector writes
`a11y-videos/<runId>/<pageId>__<taskId>.webm` plus a self-contained
`index.html` gallery (task prompt, machine-verified PASS/FAIL, step count) — a
reviewer can watch keyboard-only task completion without running anything. The
overlay lives outside `document.body` (the VSR's traversal root) and is
aria-hidden + inert, so the screen reader can never announce it; without the
env var the specs are byte-identical to the plain replay.

## Honest limitations

- Verdicts on judgment-call criteria are advisory: `needs_human` is a first-class
  outcome, and the judge cannot probe interactively (it records `requestedProbes`
  where it wanted more evidence).
- Screenshot bytes differ run-to-run, so cache hits require unchanged probe JSON
  _and_ unchanged attachment bytes; expect re-judging after any visual change.
- The judge is stochastic (no temperature control on current models); use
  `--samples 3` and read the unanimity markers in the report.
- Agent mode inherits the virtual screen reader's fidelity: it is a simulator,
  not NVDA/VoiceOver (impossible on this Linux CI box). Real-AT coverage now
  exists as a validated lane: `vo/` replays the promoted task plans through
  real macOS VoiceOver + real Safari on a dedicated Mac runner (`npm run
a11y:vo`, dispatched via `.github/workflows/a11y-voiceover.yml`, setup in
  `docs/a11y-voiceover-mac-runbook.md`) — full suite green against a live
  deploy preview (9/9, 2026-07-25). VSR→real-VO phrasing drift is absorbed by
  the `VO_*` normalizer lists + alternate item renderings in `vo/voHarness.ts`
  and bounded bidirectional/unstick resyncs in `agent/replay.ts` (all
  logged); `--calibrate` remains the tuning tool when promoting new plans.
  Purely visual criteria (e.g. 2.4.7 focus-outline loss) are outside the
  spoken channel by construction, so the agent legitimately will not "see"
  them; that is a scope boundary, not a miss, and the static judge covers
  them.
- The `claude -p` CLI can drop a structured-output property that follows a long
  string after ~100-turn sessions; the agent schema keeps the long `narrative`
  last and encodes barriers as a JSON string, with a salvage fallback.
