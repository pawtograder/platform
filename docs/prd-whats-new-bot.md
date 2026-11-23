# PRD: What's New suggestion bot

Status: build steps 1 and 2 are built (see Build plan). Steps 3 and 4 are open for feedback. Owner: Rishi Dilip.

## Problem

Features reach users with no in-app explanation. When a merged PR changes what staff or students see, the only record is the PR description, which users never read. #1261 added the first "What's new" walkthrough (ticket escalation in Office Hours), but it was hand-written for one feature, and nothing reminds the next author to write one.

## Goals

- Every merged PR that changes what users see or do gets a decision on whether it needs a walkthrough, without the author having to remember.
- When it does, the author starts from a generated draft in the shared template, not a blank file.
- Walkthroughs reach production in the same build as their feature.

## Non-goals

- Publishing walkthroughs without a person reviewing them. The bot only suggests.
- Generating the UI previews inside each step. Those need someone who knows the real controls, as in the escalation tour.
- Release notes or announcements outside the app (Discord, email).
- Replacing CodeRabbit's review. This bot runs once, after merge, and answers one question.

## Prerequisite: a What's New registry

The bot fills in a template, so the template has to exist first. This is a refactor of the escalation tour from #1261:

- `lib/whatsNew/entries/<slug>.tsx`, one file per walkthrough, each exporting `defineWhatsNew({ id, page, audience, feature?, showUntil, title, intro, steps })`.
- A generic `<WhatsNew page="office-hours" />` component with the escalation tour's dialog, intro prompt, step dots, and Back, Next and Done buttons. It reads the user's rows in `user_whats_new_seen` with one query and opens the first unseen entry that matches the page, the audience and the course feature flag.
- `markWhatsNewSeen` in `tests/e2e/TestingUtils.ts` marks every registered ID, so a new walkthrough cannot block clicks in unrelated e2e tests or Argos screenshots.

`user_whats_new_seen` already stores one row per user per item string, so new walkthroughs need no migration.

## How the bot works

### Trigger

`.github/workflows/whats-new-suggest.yml` runs on `pull_request_target` with type `closed`, only when `merged == true` and the base branch is `staging`. Running after merge means the job checks out code that has already been reviewed and merged, so it can hold an API key without running a fork's code. `workflow_dispatch` with a PR number reruns it by hand.

### Step 1: pre-filter

A script decides without a model call whether the PR could need a walkthrough. It skips the PR when any of these hold:

- The title starts with `fix`, `chore`, `test`, `docs`, `ci`, `refactor`, `build` or `perf`.
- No changed file matches `app/`, `components/`, `hooks/` or `lib/courseFeatures.ts` (test files excluded).
- The PR has the `no-whats-new` label.
- The PR already adds or changes a file under `lib/whatsNew/entries/`.

### Step 2: model decision

`scripts/whats-new/suggest.ts` sends the PR title, body and the diff of the matched files to `claude-sonnet-5-5`, using the same `messages.parse` and zod pattern as `tools/a11y-judge/judge/client.ts`. The system prompt contains the rubric, `WRITING.md` and the escalation entry as an example. The response follows this schema:

```ts
{
  significant: boolean,
  reason: string,                       // one or two sentences, quoted in the comment
  audience: "staff" | "students" | "everyone",
  page: string,                         // a key the <WhatsNew page=…> component knows
  feature: string | null,               // COURSE_FEATURES key when the change is behind a flag
  title: string,
  intro: string,
  steps: { title: string, points: string[], previewOf: string | null }[]
}
```

Rubric for `significant`:

- Yes: a new button, page, dialog or workflow that existing users will run into, or a change to how an existing action behaves that would surprise someone used to the old behavior. #1261's change to Resolve is the reference case.
- No: bug fixes that restore expected behavior, wording and layout tweaks, performance, infrastructure, and changes visible only to admins.

When the answer is no, the bot posts nothing.

### Step 3: generate the entry file

The script renders `lib/whatsNew/entries/<slug>.tsx` from a fixed template using the JSON. The model writes text only, never JSX, so the generated file always compiles. Each step's preview becomes a `TODO` stub that names `previewOf`, the component from the diff that the author should copy into the preview. `showUntil` defaults to 60 days after the merge.

### Step 4: post

The bot does two things:

1. Pushes branch `whats-new/pr-<number>` with the generated file and opens a draft PR into `staging`, assigned to the original author.
2. Comments on the merged PR with the reason, the step titles and a link to the draft, and adds the `whats-new-pending` label.

A comment alone would not be enough. GitHub's "Commit suggestion" button works only on lines in an open PR's diff, and a new file in a merged PR has neither. The draft PR gives the author something to check out and finish.

The draft has to merge before the next merge from `staging` to `main`, which is how code reaches production. The `whats-new-pending` label lists the drafts still open, and whoever runs the production merge checks it.

Example comment:

> This PR changes how staff close tickets, so it may need a What's new walkthrough: Resolve now starts a 10-minute student check-in, and End ticket is new.
>
> Draft: #NNNN (4 steps, staff, Office Hours). The previews are TODO. If no walkthrough is needed, close the draft and add `no-whats-new`.

## Dry run of the pre-filter

The step 1 rules were run on the last 40 PRs merged into `staging` (#1243 to #1352). The `lib/courseFeatures.ts` path was not in the first version of the rules. It was added after this run, which is how #1351 was missed.

| Outcome                | Count | Examples                                                                   |
| ---------------------- | ----- | -------------------------------------------------------------------------- |
| Sent to the model      | 8     | #1334 escalation alerts, #1287 queue health cards, #1313 host picker       |
| Skipped, title prefix  | 22    | #1342, #1322, #1352                                                        |
| Skipped, no UI files   | 8     | #1335 metrics, #1328 CLI, #1314 backups                                    |
| Missed, now fixed      | 1     | #1351 added a Feature flags toggle by editing only `lib/courseFeatures.ts` |
| Missed, still possible | 1     | #1286 changed what instructors can edit, through a migration only          |

With the fixed rules the model would see 9 of the 40 merged PRs, so the bot makes one model call for about one PR in five. #1286 shows the limit of a path-based filter. A change made only in the database can still change what users see. Rerunning the bot by hand covers those cases.

## Security

- The diff and the PR body are untrusted text, and a PR could contain instructions aimed at the model. The model's output only becomes a comment and a draft PR that a person reviews before merging, and the job has no other secrets.
- Job permissions: `contents: write` (to push the draft branch) and `pull-requests: write`. Nothing else.
- `ANTHROPIC_API_KEY` lives in a GitHub environment restricted to `staging`, as `MINTLIFY_*` does for `update-docs.yml`. The repository has no such secret yet.
- A PR opened with the default `GITHUB_TOKEN` does not trigger other workflows, so lint and E2E would not run on the draft. The bot either uses a GitHub App token or leaves CI to start on the author's first push.

## Build plan

1. The registry and generic component, moving the escalation tour over with no change in behavior. Its existing unit tests keep passing. Built:
   - Each entry's `id` comes from `WHATS_NEW_IDS` in `lib/whatsNew/ids.ts`, which has no React imports, so `tests/e2e/TestingUtils.ts` can mark every id seen. `tests/unit/whats-new-registry.test.ts` fails when that list and `lib/whatsNew/registry.ts` disagree. `loginAsUser(..., { showWhatsNew })` takes `true` or a list of ids to leave unseen.
   - A step is `{ title, body }`, where `body` is any React node. `Preview` and `Points` from `lib/whatsNew/define.tsx` give the usual layout.
   - The first unseen entry for the page opens on its own until its `showUntil` date. The header button opens the newest entry for the page. A list of older walkthroughs is not built.
2. `scripts/whats-new/suggest.ts` with `--pr <n> --dry-run`, printing the decision and the generated file without posting. Tune the rubric on the 8 PRs above until #1334 and #1287 come back significant and #1245 does not. Built, except the tuning: the pre-filter (`scripts/whats-new/prefilter.ts`) and the entry renderer (`scripts/whats-new/render.ts`, which builds step 3's file from the JSON) have unit tests, and the model call (`scripts/whats-new/model.ts`) was checked only against a local stub of the API, because no API key was available. It falls back to `claude-sonnet-5` when `claude-sonnet-5-5` declines a request.
3. The workflow, posting comments only.
4. The draft follow-up PR and the `whats-new-pending` label.

## Questions for reviewers

1. After merge or before? Running when a PR is marked ready for review would put the walkthrough in the same PR, at the cost of running on code that has not been reviewed. The fork trust gate in `_trust-gate.yml` would then apply.
2. Is 60 days right for `showUntil`? After it passes, the walkthrough stops opening on its own and stays in the What's new list.
3. Should anyone besides the author be able to rerun the bot with a `/whats-new` comment, for cases such as #1286?
4. Who checks `whats-new-pending` before a production merge?
