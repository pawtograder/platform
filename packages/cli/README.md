# @pawtograder/cli

Command-line tool for [Pawtograder](https://pawtograder.com) course operations: assignments, rubrics, submissions, reviews, help requests, and student repositories.

For instructors and site admins. Every command runs against a Pawtograder deployment over an API token.

## Install

Run it without installing:

```bash
npx @pawtograder/cli --help
```

Or install globally to get the `pawtograder` command:

```bash
npm install -g @pawtograder/cli
pawtograder --help
```

Requires Node.js 20 or later.

## Authenticate

Create an API token in the web app under **Settings → API Tokens**. Give it the `cli` scopes (`cli:read` for read commands, `cli:write` for commands that change data), then:

```bash
pawtograder login
```

The token is stored in `~/.pawtograder/credentials.json` with mode `0600`. `pawtograder whoami` shows who you are; `pawtograder logout` deletes the local file.

### Self-hosted deployments

Point `--url` at your deployment's **API gateway origin**, not the web host:

```bash
pawtograder login --url https://api.your-school.edu
```

The web host serves the application; the CLI talks to the `cli` Edge Function behind the API origin. Passing the web host produces an HTML response and the CLI will tell you so.

## Commands

`pawtograder <group> <action>`. Add `--help` to any group or action for its options.

### Reading data

| Command                                       | Purpose                                           |
| --------------------------------------------- | ------------------------------------------------- |
| `classes list` / `classes show <id>`          | Classes your token can see                        |
| `assignments list` / `assignments show <id>`  | Assignments in a class                            |
| `submissions list -c <class> -a <assignment>` | Roster with active submission and scores          |
| `reviews list -c <class> -a <assignment>`     | Review assignments and completion state           |
| `discussions list -c <class>`                 | Discussion topics with thread and question counts |
| `help-requests list -c <class>`               | Office-hours help queue                           |
| `rubrics list` / `rubrics export`             | Rubrics, and YAML export                          |
| `flashcards list`                             | Flashcard decks                                   |
| `repos list -c <class> -a <assignment>`       | Student repositories for an assignment            |

Every `list` command accepts `--json`, so output can be piped into `jq`:

```bash
pawtograder submissions list -c cs3500-fall-2026 -a hw-1 --json | jq '.submissions[] | select(.total_score == null)'
```

### Changing data

| Command                                   | Purpose                                            |
| ----------------------------------------- | -------------------------------------------------- |
| `assignments copy` / `assignments delete` | Copy an assignment between classes; delete one     |
| `reviews assign`                          | Create review assignments across graders           |
| `help-requests close --id <id>`           | Close or resolve a help request (instructors only) |
| `rubrics import`                          | Import a rubric from YAML                          |
| `flashcards copy` / `surveys copy`        | Copy decks or surveys between classes              |
| `submissions comments import` / `sync`    | Batch comment ingestion                            |
| `submissions artifacts import`            | Import artifact blobs from a manifest              |

Commands that write accept `--dry-run` where a preview is meaningful.

### Assigning grading work

`reviews assign` spreads submissions across active graders and instructors, balancing on how much each already holds. It honors `grading_conflicts` and never assigns someone their own submission.

```bash
# Preview a balanced split, one assignment per submission
pawtograder reviews assign -c cs3500-fall-2026 -a hw-1 --due-date 2026-09-15 --dry-run

# One assignment per rubric part instead
pawtograder reviews assign -c cs3500-fall-2026 -a hw-1 --due-date 2026-09-15 --by-part

# Restrict the pool
pawtograder reviews assign -c cs3500-fall-2026 -a hw-1 --due-date 2026-09-15 --grader <profile-id> --grader <profile-id>
```

For allocations the round-robin cannot express, supply them yourself:

```json
[{ "assignee_profile_id": "…", "submission_id": 123, "rubric_part_id": 45 }]
```

```bash
pawtograder reviews assign -c cs3500-fall-2026 -a hw-1 --due-date 2026-09-15 --file drafts.json
```

Re-running is safe: existing assignments are reused rather than duplicated, and work already assigned is left alone. An assignment covering the whole rubric counts as covering each of its parts, so `--by-part` will not re-deal work that someone already holds.

A bare `--due-date` is the **end of that day in the class's time zone** — `2026-09-15` for a New York course means 23:59:59 Eastern, not midnight UTC. Append a time (`2026-09-15T17:00`) for something specific, or pass a timestamp with an offset to bypass the class zone entirely.

Explicit manifests are held to the same rules as the round-robin: a `--file` entry that would assign someone their own submission, or a student they have a `grading_conflicts` entry for, is rejected rather than written.

### Bulk export

`submissions export` and `assessment export` stream large snapshots to a directory. Both gate personally identifying information behind an explicit `--i-understand-pii` flag and default to tokenized identifiers. See `--help` for the identity modes.

### Student repositories

`repos sync-grade-workflow` and `repos copy-after-source-due` run **git on your machine over SSH**, not on the server, so they need a writable `--workdir` and working GitHub SSH access:

```bash
pawtograder repos sync-grade-workflow -c cs3500-fall-2026 -a hw-1 --workdir ~/tmp/sync --dry-run
```

## Environment variables

All optional.

| Variable                      | Effect                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PAWTOGRADER_HTTP_TIMEOUT_MS` | Abort requests after this many milliseconds. Unset means no timeout. Raise it for large artifact imports. |
| `PAWTOGRADER_VERBOSE=1`       | Log each request and its timing to stderr.                                                                |
| `DEBUG=1`                     | Same as above, plus stack traces on unexpected errors.                                                    |

This CLI does not read `.env` files.

## License

GPL-3.0-only. Source: <https://github.com/pawtograder/platform>
