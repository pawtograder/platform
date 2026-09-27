# Vendored JSON Schemas

These schemas drive live validation and autocomplete in the in-app config editor
(`components/github/RepoFileEditor.tsx`). They are **vendored copies**, not fetched at runtime:
`configureMonacoYaml` is called with `enableSchemaRequest: false`, so the yaml worker has no
schema-request service and never makes a network call. That keeps the editor working on
restricted networks and keeps validation independent of GitHub availability.

## `pawtograder.schema.json`

Verbatim copy of [`pawtograder.schema.json` from
`pawtograder/assignment-action`](https://github.com/pawtograder/assignment-action/blob/main/pawtograder.schema.json),
generated in that repo from its TypeScript config types.

|               |                                                                    |
| ------------- | ------------------------------------------------------------------ |
| Vendored from | tag `v4` (`refs/tags/v4`)                                          |
| sha256        | `1568357c69ebb7076f12675af609d59dfcaff2bfb222d46c910840ab1c203840` |

To resync, copy the file from a checkout of assignment-action at the tag the platform targets:

```bash
cp ../assignment-action/pawtograder.schema.json lib/schemas/pawtograder.schema.json
# or, without a checkout:
curl -o lib/schemas/pawtograder.schema.json \
  https://raw.githubusercontent.com/pawtograder/assignment-action/refs/tags/v4/pawtograder.schema.json
```

Then update the table above and the version check in `isKnownSchemaUrl` (see below).

### Why the vendored version matters

Instructor `pawtograder.yml` files carry a schema modeline naming the version they target:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/pawtograder/assignment-action/refs/tags/v4/pawtograder.schema.json
```

The yaml language server resolves that modeline **in preference to** the editor's own `fileMatch`
association, and resolution goes through the schema-request service — which is disabled. So
`RepoFileEditor` registers the bundled schema a second time under the modeline's own URL, putting
it in the worker's schema cache so the modeline resolves with no request.

That substitution is only sound when the bundled copy describes the same config shape the file
targets, so `isKnownSchemaUrl` accepts only `v4*` and `main` refs. v4 diverges from v3 in ways that
would produce bogus diagnostics on a v3 file:

- v4 requires top-level `grader` (`"overlay"`), `build`, and `submissionFiles`; `gradedParts` is
  optional. v3 has no `grader` key.
- v4 sets `additionalProperties: false` throughout, so unknown keys are errors.
- `build.linter.policy` is `fail | ignore` in v4; v3 also allowed `warn`.

A modeline pointing at any other ref (v3 and earlier) or host is left unresolved. The editor
reports that as a **non-blocking** notice ("Schema could not be loaded") and still allows
committing — the file may well be valid for the version it targets. `validatePawtograderConfig`
(`components/ui/autograder-configuration.tsx`) still runs as a save-time structural guard in that
case, as it does for every `pawtograder.yml`.

Note that guard is independent of this schema and currently requires `gradedParts`, which v4 makes
optional. A v4 overlay config with no graded parts validates against the schema but is still
rejected by the guard.

## `github-workflow.schema.json`

Copy of [`github-workflow.json` from SchemaStore](https://json.schemastore.org/github-workflow.json),
used for `.github/workflows/*.yml`. Same substitution applies: a modeline whose filename is
`github-workflow.json` resolves to this copy.
