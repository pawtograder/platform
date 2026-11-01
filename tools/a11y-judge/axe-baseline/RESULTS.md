# axe-core baseline for the seeded mutations

This is the "axe baseline comparison (run axe with `exclude: []`)" item from `tools/a11y-judge/PROGRESS.md`. It measured, on 2026-09-24, which of the eight seeded mutations axe-core catches on the nine student pages the judge covers. The code under test was `pawtograder/platform` main at `e97e7a87` on a local Supabase stack, scanned with Chromium and axe-core 4.11.3.

## Method

`tests/e2e/a11y-axe-baseline.spec.ts` seeds the same course, survey, submission, regrade request, help request, and discussion thread as `tests/e2e/a11y-evidence.spec.ts`. It then scans every page under ten variants. The two clean runs, `clean-a` and `clean-b`, measure the noise floor. The other eight each apply one mutation exactly as the evidence driver does: `addInitScript` before login, limited to the mutation's `pageIds`. Every page is scanned after load. The survey is also scanned in its invalid-submit error state (3.3.1) and after the autosave interaction the evidence driver records for 4.1.3.

Each scan runs axe three ways:

| Config       | Rules                                                                                    | Excludes           |
| ------------ | ---------------------------------------------------------------------------------------- | ------------------ |
| gate         | WCAG 2.1 A/AA tags plus `heading-order`, as `assertStudentPageAccessible` enforces in CI | `DEFAULT_EXCLUDES` |
| full         | every rule axe enables by default, including best-practice                               | none               |
| experimental | axe's experimental rules only                                                            | none               |

A mutation counts as caught when a scan reports a violation node that appears in neither clean run. React `useId` tokens are normalized out of selectors first, since they change between loads. The two clean runs agreed on every node, so the noise floor is zero. Each scan also records a DOM footprint, such as the count of `img[alt="image"]` or of elements with a positive `tabindex`, to confirm the mutation was present when axe ran. Without that check, a miss could simply mean the injector did nothing.

`tools/a11y-judge/axe-baseline/analyze.ts` does the diff and writes `report.md` and `summary.json` next to the scans.

## Results

The judge column is copied from the Round 1 gauntlet scorecard in `PROGRESS.md`, which ran in July 2026 on five pages and counted a catch when at least two of three samples failed. The judge was not re-run for this comparison.

| Mutation                         | SC    | Present at scan | axe, gate                        | axe, full                          | axe, experimental | Static judge (July) |
| -------------------------------- | ----- | --------------- | -------------------------------- | ---------------------------------- | ----------------- | ------------------- |
| 111-alt-degrade                  | 1.1.1 | 9/9 pages       | missed                           | missed                             | missed            | fail 3/3            |
| 132-survey-options-first         | 1.3.2 | 1/1             | missed                           | missed                             | missed            | fail 3/3            |
| 243-tabindex-shuffle             | 2.4.3 | 0/9             | missed                           | missed                             | missed            | fail 3/3            |
| 243, re-applied after page ready | 2.4.3 | 9/9             | missed                           | caught (`tabindex`, best-practice) | missed            | not run             |
| 246-headings-generic             | 2.4.6 | 8/9             | missed                           | missed                             | missed            | fail 3/3            |
| 247-outline-none                 | 2.4.7 | 9/9             | missed                           | missed                             | missed            | fail 15/15          |
| 331-hide-error-text              | 3.3.1 | 2/9             | missed                           | missed                             | missed            | fail 3/3            |
| 412-strip-labels                 | 4.1.2 | 9/9             | caught (`button-name`, 71 nodes) | caught (`button-name`, 71 nodes)   | missed            | fail 3/3            |
| 413-silent-toast                 | 4.1.3 | 9/9             | missed                           | missed                             | missed            | needs_human 3/3     |

The CI gate config catches one of the eight defects. Running every rule with no excludes adds the tabindex reorder, but only once the reorder is actually on the page. Every axe detection points at an element the mutation changed: all 71 `button-name` nodes are buttons whose labels were stripped, and all 132 `tabindex` nodes carry a positive `tabindex`. Axe reported no new violation for any mutation it missed. That matches the profile He, Huq and Malek report for axe-core in FSE 2025: perfect precision and the lowest recall of the tools they compared. The pattern of misses also matches their explanation. Axe decides whether an attribute exists, so it flags a button with no name and a positive `tabindex`. It cannot decide whether alt text that says "image", or a page whose headings all say "Section", describes anything.

Focus visibility is the one place the Pawtograder judge goes past the paper. GenA11y cannot detect SC 2.4.7 because it only reads a static page, and axe missed 247 here too. The judge caught it 15/15 because its collector records live computed focus styles at each tab stop.

## Findings to follow up

1. The student regrade-requests table fails WCAG 1.4.3 on main. `app/course/[course_id]/RegradeRequestsTable.tsx:87` renders the assignment title in `blue.500` (#3b82f6) on white, which is 3.67:1 against the 4.5:1 minimum. CI misses it because the smoke test `regrade requests page passes axe` in `tests/e2e/a11y-smoke.test.tsx` scans as soon as `main` is visible, before the client-side fetch fills the table. The smoke test passes as written, and it fails with this violation once it waits for the seeded assignment title to render.
2. The CI gate config cannot catch a positive-tabindex reorder. The only axe rule for it, `tabindex`, is tagged best-practice, and the gate runs WCAG tags plus `heading-order` only.
3. The 243 injector no longer plants its defect on main. It shuffles `tabindex` once at `DOMContentLoaded`, before the client-rendered content mounts, and no element had a positive `tabindex` when the scan ran on any page. The judge's July 3/3 on 243 predates this and should be re-checked.
4. On the survey, 331 removes the `aria-describedby` link to the error, but the error text stays visible. SurveyJS does not render its error box as `role="alert"`, so the half of the injector that empties alert text has nothing to act on.
5. With best-practice rules on, `page-has-heading-one` fires on discussion, office-hours, and survey-taking in both clean runs. Office hours has no headings at all.

## Limits

The judge results come from a different date, a different page set, and older code, so the two columns are not a controlled comparison. Re-running the static judge on today's mutated evidence would make them one. The analysis also counts any new violation node as a detection instead of checking that axe pointed at the element the mutation changed, though every detection in this run did. Everything ran on one browser and one seed.

## Rerun

```bash
A11Y_AXE_BASELINE=1 A11Y_RUN_ID=<run> BASE_URL=http://localhost:3001 \
  npx playwright test tests/e2e/a11y-axe-baseline.spec.ts --project=chromium --workers=1
npx tsx tools/a11y-judge/axe-baseline/analyze.ts --run a11y-axe-baseline/<run>
```

`A11Y_AXE_VARIANTS` and `A11Y_AXE_PAGES` take comma-separated lists to narrow a run. A full run is 82 page scans and took 16 minutes locally. The after-ready 243 variant ran separately with its own two clean runs, so that its clean baselines come from the same seeded course.
