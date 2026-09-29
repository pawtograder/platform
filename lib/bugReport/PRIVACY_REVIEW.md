# Reviewing the privacy classification (HU6)

`privacy.ts` is a generated draft. It assigns a privacy kind to every value the browser can receive from Supabase, and the bug reporter redacts values of every kind except `none` from a recording before upload. Nothing in the draft is approved until a human reviews it (HU6 in the bug reporter spec). This guide covers how the draft was made, which entries are guesses, and where to look first.

## How the draft was made

`scripts/bugReport/generatePrivacyDraft.ts` writes `privacy.ts` from four sources, in this order of precedence:

1. **Hand overrides** (`scripts/bugReport/privacyOverrides.ts`), for columns the rules get wrong, and every edge-function wrapper.
2. **RPC return shapes read from SQL** (`scripts/bugReport/rpcReturnReview.json`). This covers the 58 functions whose SQL return type is Json, text, or a record. Each entry records the shape, whether the browser calls the function, and a reason when the reading was a guess.
3. **Column-name rules** (`scripts/bugReport/columnHeuristics.ts`). These are the patterns from the spec (`name`, `sortable_name`, `email`, `*_username`, `score*`, `body`, `message`, and more) plus the columns listed in `docs/operations/data-retention.md` §"PII / grades". Foreign-key and id columns are `none`. When a rule is unsure it picks a PII kind.
4. **Generated return types** for the remaining RPCs. Boolean, number, and void returns are `none`. `SETOF` a table becomes `{ $table }`, and `RETURNS TABLE(...)` columns go through the column rules.

Entries the draft was unsure about carry a `// UNCERTAIN: <reason>` comment. Entries added after a schema change carry `// DRAFT`. Delete the comment once you have decided.

| Section        | Entries | Non-`none` | `// UNCERTAIN` |
| -------------- | ------- | ---------- | -------------- |
| COLUMNS        | 1793    | 213        | 64             |
| RPCS           | 326     | 50         | 23             |
| EDGE_FUNCTIONS | 54      | 45\*       | 5              |

\* Every wrapper that invokes an edge function maps `$.error` to `free_text`, because the error bodies from `wrapRequestHandler` often quote usernames, emails, or repository names; 30 of them also have PII beyond the error body. The 9 wrappers that only call RPCs map `$` to `none`, and their results are classified under RPCS.

Columns by kind: 1580 `none`, 102 `free_text`, 46 `grade`, 34 `handle`, 24 `name`, 7 `email`.

## What the kinds mean here

- `name`: a person's name, including generated pseudonyms (the public `profiles.name`) and git commit author names. The taint set also matches first and last tokens and "Last, First".
- `email`: addresses. The taint set also matches the local part.
- `handle`: anything that identifies a person outside Pawtograder: GitHub and Discord usernames and ids, SIS, Canvas, and LTI ids, IP addresses, avatar URLs, and **student repository names**, which embed the GitHub username.
- `grade`: scores, points awarded, score overrides, karma, and **extension hours and late tokens**. Grades are never string-matched; package 3 blocks the components that render them.
- `free_text`: anything a user typed, plus error and sync messages from upstream services, plus Json blobs whose shape is unknown.
- `none`: ids, timestamps, enums, counts, and course content that staff write for the whole class.

## Decisions to confirm

These choices affect many entries. The draft makes a call on each, and a reviewer should confirm or reverse it.

1. **Course content is `none`.** This covers assignment titles and descriptions, rubric names and text, class, section, and help queue names, survey definitions, flashcard prompts, and poll questions. The draft assumes staff-authored text for the whole class names no student. If that is wrong, these become `free_text`, and package 3 would block every component that renders them.
2. **Unknown Json blobs are `free_text`.** Examples are `audit.old`/`new`, GitHub webhook payloads, DLQ envelopes, and `repository_check_runs.status`. `free_text` taints every string inside the blob, including enum values such as `"open"` or `"submitted"`. Those strings would then be redacted wherever they appear in unmasked text. The ingest phase may need to skip short or enum-like values from these sources; that is a product decision.
3. **Error and sync messages are `free_text`.** GitHub, Discord, and Canvas errors often quote a username. Most of these columns are readable only by admins, so the cost is small.
4. **Extensions and late tokens are `grade`**, because they can reveal an accommodation.
5. **Secrets are `free_text`**, although they are not PII. These are `get_assessment_export_pepper`, the MCP token returned on creation, and `lti_tool_keys.private_key_pem_encrypted`. There is no `secret` kind, and `free_text` keeps them out of a replay.

## Rows to look at first

- **Guesses about names on unfamiliar relations.** `calendar_events.title`, `description`, and `location` are `free_text` because staff calendars often name a TA. `lab_sections.name` and `class_sections.name` are `none`, but hand-made section names can name their leader. Student-chosen names are `free_text`: `assignment_groups.name`, `tags.name`, `submission_files.name`, and branch names (`head_branch`).
- **`get_gradebook_records_for_all_students_array`.** Each entry is a positional array that mixes scores with the free-text `score_override_note` at index 9. The JSONPath subset cannot address an index, so the whole array is `grade`. The note is therefore protected only by blocking, never by matching.
- **`custom_access_token_hook`.** The SQL passes the auth event through unchanged, so its classification describes the usual Supabase claims rather than anything read from code.
- **`bulk_csv_import_enrollment.$.errors[*].identifier`.** It holds an email or a SIS id, depending on the import mode, and is classified as `email`.
- **`getPrBaseFiles` and `pr_base_tree_cache.files`** are `none` on the assumption that the upstream base is the instructor's handout code.
- **`repositoriesForClass` and `repositoryListCommits`.** Only the name, login, email, and avatar fields of the Octokit objects are classified. URL fields embed those values and rely on substring matching.

## Known gaps

- `app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/files/page.tsx` calls the `submission-serve-artifact` edge function directly, not through a wrapper in `lib/edgeFunctions.ts`. The select parser reports its response as unclassified.
- JSONPath cannot express keys of dynamic objects, such as objects keyed by student id. Such values are classified through their parent path.

## Keeping it current

`npm run client` and `npm run client-local` fail when the schema gains a column, view field, or RPC that `privacy.ts` lacks, or when `lib/edgeFunctions.ts` gains a wrapper; the unit test `tests/unit/bugReport/privacyExhaustive.test.ts` fails in CI for the same reasons. To fix either, run `npx tsx scripts/bugReport/generatePrivacyDraft.ts`. It keeps every existing entry, including hand edits, adds `// DRAFT` entries for new keys, and drops entries for keys that no longer exist. Review the new entries, then rerun `npm run client-local`. `--fresh` rebuilds every entry from the sources above and discards hand edits.

## Checking the classification against real traffic (package 2a)

The taint trace runs the E2E suite with synthetic canary data and records where each canary actually arrives in the browser and where it renders. Its two outputs are committed next to the classification:

- `generated/privacy.observed.json` lists every observed flow as `{source, key, kind, firstSeenIn, test}`. `source` is how the value arrived (`rest:<relation>`, `rpc:<function>`, `edge:<wrapper>`, `realtime:<table>`, `rsc:<route>`, `api:<route>`), `key` is the `table.column` or JSONPath that carried it, and `kind` is the kind of the canary seen there.
- `generated/pii-sinks.json` maps each route pattern to the components (by `data-sentry-component`) that rendered a canary, with the kinds they rendered. A component key ending in `[data-report-unmask by X]` means the text was inside an unmasked element.

`npx tsx scripts/bugReport/checkTrace.ts` and `tests/unit/bugReport/traceCheck.test.ts` fail when an observed flow has no classification, when it is classified `none`, or when PII rendered inside `data-report-unmask`. Text that a server component renders straight into the RSC payload is reported as a warning: `privacy.ts` can't classify it, and its route needs a taint block (`ssrTaint`) before it may record.

To regenerate both files, build with the full Sentry profile (`SENTRY_BUILD_PROFILE=full` and any DSN, so components are annotated) and run the suite with `BUG_REPORT_TRACE=1`. `BUG_REPORT_TRACE_MERGE=1` adds a partial run to the committed files instead of replacing them; `BUG_REPORT_TRACE_STRICT=1` fails each test that observes a problem. `tests/e2e/bugReport/traceFixture.ts` has the details.
