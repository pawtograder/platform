# Course Gemini API key

Each course can store one Gemini API key. Active instructors manage the key through Course Settings; storing it does not validate it with Google or enable AI grading. Provider calls, worker credential retrieval, and grading are outside this feature's scope.

## Storage and access

The key is stored in Supabase Vault (`vault.secrets`). The private `course_secrets.course_gemini_api_keys` table maps a class to its Vault secret; its schema is not exposed through PostgREST, and client roles have no `USAGE` on it. Supabase Vault provides encrypted secret storage without introducing a separate application-managed encryption scheme. Vault does not enforce per-course authorization on its own: the private mapping and instructor-gated RPCs enforce that boundary, while privileged database operators remain inside the trust boundary.

Three `SECURITY DEFINER` RPCs with `search_path = ''` manage the key:

- `get_course_gemini_key_status` returns whether setup is enabled and whether a key is configured. It checks active instructor membership without taking a row lock.
- `set_course_gemini_key` saves or replaces the key. It rejects blank or overlong values and requires the course's `gemini-api-key-setup` feature flag.
- `remove_course_gemini_key` removes the stored key, succeeding even when none exists. Removal works when setup is disabled.

All three RPCs check active instructor membership via `authorizeforclassinstructor`; the mutators check it both before and after locking the class row. They return no key material or secret identifiers, and error messages are fixed rather than derived from supplied keys. `service_role` has `EXECUTE` grants but cannot use these RPCs without `auth.uid()`; calls as `service_role` return `42501 Access denied`.

## Key lifecycle

- The `gemini-api-key-setup` course flag defaults off. Instructors can enable it from the Feature flags page. It gates saving and replacing, not status checks or removal; it is not an operator kill switch.
- Save, replace, and remove operations lock the class row with `FOR NO KEY UPDATE`, serializing concurrent changes. Replacements update the existing Vault secret rather than creating another one.
- Deleting a mapping row removes its Vault secret through an `AFTER DELETE` trigger. Physical course deletion cascades through the mapping and deletes the secret in the same transaction; cleanup failure aborts deletion. Archiving a course preserves the key.
- `TRUNCATE` of the mapping is refused because it would bypass row-level cleanup. Removing a key from Pawtograder does not revoke it with Google or erase retained database backups.

## Operations and rollback

Pawtograder's migrations are forward-only. An app rollback leaves this additive schema in place; see [Rollback](operations/rollback.md#b-app-only-rollback-schema-stays-forward-additive-migration). Reverting the PR does not remove stored credentials or undo the migration.

To stop new saves and replacements, ship a forward migration:

```sql
REVOKE EXECUTE ON FUNCTION public.set_course_gemini_key(bigint, text) FROM authenticated;
```

Status and removal remain available; stored keys and deletion cleanup are unchanged. To stop all browser access, also revoke `get_course_gemini_key_status(bigint)` and `remove_course_gemini_key(bigint)` from `authenticated`. The feature flag alone cannot serve as an operator-controlled shutoff because instructors can enable it themselves.

## Privileged database tests

`tests/e2e/course-gemini-key-db.spec.ts` and `tests/e2e/course-gemini-key-rpc.spec.ts` connect as `postgres` and must run only against a disposable database. They refuse to run without the `byok-disposable-db-marker` Vault secret and matching `BYOK_TEST_DB_*` environment variables; on an unmarked local stack they fail rather than skip.

To run them locally:

1. Create the marker with the SQL in the `deploy.yml` step, using `vault.create_secret(<random hex>, 'byok-disposable-db-marker', ...)`.
2. Set `BYOK_TEST_DB_URL`, `BYOK_TEST_DB_FINGERPRINT` (SHA-256 of the marker), and `BYOK_TEST_DB_EXPECTED_PORT` for that disposable stack.

## PostgreSQL logging (accepted limitation)

With the current PostgreSQL configuration, a `set_course_gemini_key` call that takes at least one second can log the submitted key in its bind parameters. Changing `log_parameter_max_length` to suppress bind-parameter logging was considered and rejected because production Loki and Grafana access is restricted to trusted cluster operators, who already have access to Vault, and an exposed course-owned Gemini key can be rotated. Allowing anyone else to access production logs would first require a thorough audit of all logging; see the [review decision and rationale](https://github.com/pawtograder/platform/pull/1160#pullrequestreview-5792082037).

## Course Settings

**Course Settings → Gemini API Key** (`app/course/[course_id]/manage/course/gemini-api-key/page.tsx`) is available to instructors. It shows setup enabled/disabled separately from key configured/not configured; “configured” means stored, not validated with Google.

- An unreadable status shows as **unavailable**, not “not configured,” with a Retry option. Status reads have a deadline so a stalled refresh does not leave the form disabled indefinitely.
- A lost or unrecognized mutation response is an **unknown outcome**, not a success. The page attempts to refresh status before the instructor retries.
- The key input is cleared after each operation, including uncertain outcomes. Messages come from fixed strings in `lib/courseGeminiKey.ts`, never raw server messages. Initial status-read failures and manual Retry failures are announced to assistive technology; post-mutation refresh failures do not duplicate the mutation announcement.

### Browser password managers

The key input remains `type="password"` for native masking, accessibility, and session-recording safeguards, alongside `ph-no-capture`. Chrome offered to save the key as a password with `autocomplete="off"`; using `autocomplete="one-time-code"` avoided that prompt in the tested Chrome configuration without changing the input to plain text. This is a workaround, not a guarantee across browsers and password managers; browsers may also offer to autofill one-time codes in the field.
