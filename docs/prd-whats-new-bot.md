# PRD: What's New suggestion script

Status: built. Authors run the script on their own Claude Code login, because the project has no shared Anthropic API key. The automatic bot in the first draft of this document is not planned (see Build plan). Owner: Rishi Dilip.

## Problem

Features reach users with no in-app explanation. When a merged PR changes what staff or students see, the only record is the PR description, which users never read. #1261 added the first "What's new" walkthrough (ticket escalation in Office Hours), but it was hand-written for one feature, and nothing reminds the next author to write one.

## Goals

- The author of a PR that changes what users see or do can get a decision on whether it needs a walkthrough with one command.
- When it does, the author starts from a generated draft in the shared template, not a blank file.
- Walkthroughs reach production in the same build as their feature.

## Non-goals

- Publishing walkthroughs without a person reviewing them. The script only drafts: the author decides whether to use the draft, draws the previews and checks the text, and the walkthrough goes through PR review like any other code. Jon agreed on Nov 23 that user-facing text should keep a person in the loop.
- Generating the UI previews inside each step. Those need someone who knows the real controls, as in the escalation tour.
- Release notes or announcements outside the app (Discord, email).
- Replacing CodeRabbit's review. The script answers one question when its author runs it.

## Prerequisite: a What's New registry

The script fills in a template, so the template has to exist first. This is a refactor of the escalation tour from #1261:

- `lib/whatsNew/entries/<slug>.tsx`, one file per walkthrough, each exporting `defineWhatsNew({ id, page, audience, feature?, showUntil, title, intro, steps })`.
- A generic `<WhatsNew page="office-hours" />` component with the escalation tour's dialog, intro prompt, step dots, and Back, Next and Done buttons. It reads the user's rows in `user_whats_new_seen` with one query and opens the first unseen entry that matches the page, the audience and the course feature flag.
- `markWhatsNewSeen` in `tests/e2e/TestingUtils.ts` marks every registered ID, so a new walkthrough cannot block clicks in unrelated e2e tests or Argos screenshots.

`user_whats_new_seen` already stores one row per user per item string, so new walkthroughs need no migration.

## How the script works

### Who runs it

The PR's author, on their own machine, when the PR adds something users will notice:

```bash
npm run whats-new                  # the PR for the current branch
npm run whats-new -- --pr 1287     # any PR, open or merged
npm run whats-new -- --write       # also save the draft under lib/whatsNew/entries/
npm run whats-new -- --force       # ask Claude even when the pre-filter would skip the PR
```

It needs the `gh` CLI and Claude Code (`claude`), both signed in. The Claude call runs on the author's own Claude Code login, because the project has no shared Anthropic API key, so a GitHub workflow can't make the call. Running it before merge lets the walkthrough ship in the same PR as the feature.

### Step 1: pre-filter

The script decides without calling Claude whether the PR could need a walkthrough. It skips the PR when any of these hold:

- The title starts with `chore`, `test`, `docs`, `ci`, `refactor`, `build` or `perf`. A `fix` title is not skipped: a fix can make a feature visible for the first time. Until #1166, the office hours OP badge only showed on a new request after a reload, so many students had never seen it.
- No changed file matches `app/`, `components/`, `hooks/` or `lib/courseFeatures.ts` (test files excluded).
- The PR has the `no-whats-new` label.
- The PR already adds or changes a file under `lib/whatsNew/entries/`.

### Step 2: model decision

`scripts/whats-new/suggest.ts` sends the PR title, body and the diff of the matched files to `claude-sonnet-5-5` with `claude -p`, as `tools/a11y-judge/judge/cliBackend.ts` does. `--json-schema` makes the answer follow the schema below. The call has no tools and no MCP servers, and runs outside the repository so the project's `CLAUDE.md` and settings stay out of the prompt. The system prompt contains the rubric, `WRITING.md` and the escalation entry as an example. The response follows this schema:

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
- Yes, also: a fix that makes something visible to users for the first time, such as the OP badge after #1166. The PR body usually says what users will now see.
- No: bug fixes that restore behavior users already knew, wording and layout tweaks, performance, infrastructure, and changes visible only to admins.

When the answer is no, the script prints the reason and stops.

### Step 3: generate the entry file

The script renders `lib/whatsNew/entries/<slug>.tsx` from a fixed template using the JSON. The model writes text only, never JSX, so the generated file always compiles. Each step's preview becomes a `TODO` stub that names `previewOf`, the component from the diff that the author should copy into the preview. `showUntil` defaults to 60 days after the merge, or after today for a PR that hasn't merged.

### Step 4: save the draft

Without `--write`, the script prints the file. With `--write`, it saves the file under `lib/whatsNew/entries/` and lists what is left: adding the id to `WHATS_NEW_IDS`, adding the entry to `WHATS_NEW_ENTRIES`, and replacing each `TODO` preview with a static copy of the real control. The author then reviews the walkthrough with the rest of the PR.

## Dry run of the pre-filter

The step 1 rules were run with `scripts/whats-new/prefilter.ts` on the 47 PRs merged into `staging` from #1243 to #1352.

| Outcome                | Count | Examples                                                                      |
| ---------------------- | ----- | ----------------------------------------------------------------------------- |
| Sent to Claude         | 22    | #1334 escalation alerts, #1287 queue health cards, #1351 Feature flags toggle |
| Skipped, title prefix  | 5     | #1352 (`test`), #1327 (`docs`)                                                |
| Skipped, no UI files   | 20    | #1335 metrics, #1328 CLI, #1314 backups                                       |
| Missed, still possible | 2     | #1286 and #1275, both changes made only in the database                       |

Sending `fix` titles to the model (suggested in review) accounts for 10 of the 22, such as #1342 and #1322. With `fix` skipped, 12 would reach the model. So about one PR in two reaches Claude, up from one in four. #1351 reaches the model only because `lib/courseFeatures.ts` is on the path list: it added a Feature flags toggle by editing that file alone.

#1286 and #1275 show the limit of a path-based filter. #1286 changed what instructors can edit, and #1275 made a new request's students show up for staff, both through migrations only. A change made only in the database can still change what users see. Their authors can run the script with `--force`, which asks Claude whatever the pre-filter says.

## Results from Claude

On Nov 23 the script ran on six PRs with `claude-sonnet-5-5`:

| PR    | Change                                     | Decision        | As expected |
| ----- | ------------------------------------------ | --------------- | ----------- |
| #1169 | Ticket escalation, Resolve check-in        | significant     | Yes         |
| #1287 | Queue health cards                         | significant     | Yes         |
| #1261 | The escalation walkthrough itself          | not significant | Yes         |
| #1245 | SSO consent page skipped                   | not significant | Yes         |
| #1334 | Browser alerts for escalations, flag off   | not significant | No          |
| #1275 | Roster changes reach staff, with `--force` | not significant | Unclear     |

For #1334, Claude reasoned that passive alerts behind a flag that defaults to off give a tour nothing to show. That is a fair reading, so the rubric is unchanged. For #1275, Claude saw a fix that makes the page show what it was already supposed to show, which the rubric excludes. Boris's OP badge point argues the other way, so it is a judgment call for the author. The #1287 draft compiled once its id was added, with the right page, audience and feature flag. Its title differed between two runs, so authors should expect to edit the text.

## Security

- The diff and the PR body are untrusted text, and a PR could contain instructions aimed at Claude. The call has no tools, so the most such text can do is change the printed draft, which the author reads before using it.
- No secret is stored anywhere. Each author's Claude Code login makes the call.

## Build plan

1. The registry and generic component, moving the escalation tour over with no change in behavior. Its existing unit tests keep passing. Built:
   - Each entry's `id` comes from `WHATS_NEW_IDS` in `lib/whatsNew/ids.ts`, which has no React imports, so `tests/e2e/TestingUtils.ts` can mark every id seen. `tests/unit/whats-new-registry.test.ts` fails when that list and `lib/whatsNew/registry.ts` disagree. `loginAsUser(..., { showWhatsNew })` takes `true` or a list of ids to leave unseen.
   - A step is `{ title, body }`, where `body` is any React node. `Preview` and `Points` from `lib/whatsNew/define.tsx` give the usual layout.
   - The first unseen entry for the page opens on its own until its `showUntil` date. The header button opens the newest entry for the page. A list of older walkthroughs is not built.
2. `npm run whats-new` (`scripts/whats-new/suggest.ts`). Built and run against Claude (see Results from Claude). The pre-filter (`prefilter.ts`), the entry renderer (`render.ts`) and the `claude -p` arguments and output parsing (`model.ts`) have unit tests.
3. Not planned: a workflow that runs the script after each merge, comments on the PR and opens a draft follow-up PR. It needs a shared API key, which the project doesn't have. If one becomes available, the same script can run in a `pull_request_target` job on merged PRs.

## Questions for reviewers

1. Is 60 days right for `showUntil`? After it passes, the walkthrough stops opening on its own, and the header button still opens it while it is the newest one for its page.
2. How do authors remember to run it? A line in the PR description template or in `AGENTS.md` would be a cheap reminder.
