# Forgejo onboarding POC

This is a proof of concept for hosting assignment repos on Pawtograder's own Forgejo instead of GitHub. It is not production code. It exists to show the student flow and to check the parts we were unsure about.

## Forgejo is chosen per assignment

`assignments.git_provider` (`github` by default) picks the host, so a class is never locked in. An instructor can try Forgejo on one assignment, keep GitHub for the others, and go back for the next one. The class only stores which Forgejo org to use (`classes.forgejo_org`, falling back to the class slug).

- **The choice is fixed once repos exist.** A trigger rejects changing an assignment's `git_provider` after it has repositories, because those repos would be stranded on the old host.
- **GitHub never touches Forgejo assignments.** All GitHub repo creation in SQL goes through `enqueue_github_create_repo`, and all permission sync through `enqueue_github_sync_repo_permissions`. Each is renamed to `*_unguarded` and fronted by a same-named guard that skips Forgejo assignments and repos. The edge functions that call GitHub `createRepo` directly (`assignment-create-all-repos`, `autograder-create-repos-for-student`, `github-user-sync`) and the stuck-repo alert in `github-repo-reconciler` filter on `git_provider = 'github'`. Checked locally: the guards return null for a Forgejo assignment or repo and still enqueue for GitHub ones.
- **GitHub prompts depend on the assignment.** A Forgejo assignment's page never asks the student to link GitHub or accept an invite. Course-wide pages ask only while some assignment still gets GitHub repos, or while there are no repo assignments yet.

## The flow it demonstrates

A GitHub assignment asks a student to create a GitHub account, link it, accept an org invitation, and set up a personal access token or SSH key. A Forgejo assignment asks for none of that:

1. The instructor provisions the assignment (`forgejo-provision`). Pawtograder creates a Forgejo account for each enrolled person who lacks one, adds them to the course org's `students` or `staff` team directly, and creates each student's private repo from the template. A repo is marked ready only after Forgejo reports the student's `write` access back.
2. The student opens the assignment. There is no "link your GitHub account" banner and no invitation banner. The **Work on your own computer** panel links to the repo on Forgejo.
3. The student clicks **Set up git on this computer** and pastes one command:

   ```sh
   curl -fsSL <functions>/git-setup/<code> | sh                  # macOS / Linux
   irm "<functions>/git-setup/<code>?shell=ps1" | iex             # Windows
   ```

   The script stores a push/pull-only token in the credential helper git already has (Keychain on macOS, Git Credential Manager on Windows, git's `store` on Linux, scoped to the Forgejo host) and clones the repo. If git has no name or email at all, it sets them in that repo only. Nothing gets installed.

   It leaves GitHub alone. The only global change is a `[credential "https://<forgejo-host>"]` block, which holds the username, plus `helper = store` when there was no helper or only the 15-minute `cache` one. Saved `github.com` logins and the global `user.name`/`user.email` are never touched. This was checked in clean containers for three cases: a student already set up for GitHub, a brand-new git install, and a `cache`-only helper.

Workspaces are not required. A Coder workspace can run the same setup URL in its startup script, so laptops and workspaces share one auth path.

## Why the setup command is safe to paste

- The code in the URL is single-use and expires after ten minutes. Only its SHA-256 is stored (`git_setup_codes`). The token itself never appears on screen or in shell history.
- Each setup rotates the student's `pawtograder-local` token, so running it again revokes the previous one.
- The token has the `write:repository` scope only. It cannot create tokens or read account settings.
- `/git-setup/preview` shows the script with the token left out, and fetching it does not use up a code.

## What was checked against the team Forgejo (15.0.9)

| Check                                           | Result                                                                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin creates a token for another user          | Works with admin **Basic auth** (`201`). An admin _token_ gets `401 auth method not allowed`, which is what the provisioning spike saw. No CLI or pod exec is needed. |
| Admin lists and revokes a user's tokens         | `200` / `204`                                                                                                                                                         |
| Template copy into the course org, then a retry | `201`, then `409`, which is adopted rather than failing                                                                                                               |
| Student `write` collaborator, read back         | `write`                                                                                                                                                               |
| Setup command on macOS (isolated `HOME`)        | Clones, stores the credential, pushes                                                                                                                                 |
| Setup command on clean Alpine Linux             | Falls back to `store` for this host only; sets name and email                                                                                                         |
| Setup command in PowerShell 7.4 (Linux, arm64)  | Clones, stores the credential with no stray CR, fetches                                                                                                               |
| Code reused                                     | Refused with a readable message                                                                                                                                       |
| Token from an earlier setup after a new one     | `Authentication failed`                                                                                                                                               |
| Student clones another student's repo           | `not found`                                                                                                                                                           |
| Token mints a new token / reads `/user/emails`  | `403` / `403`                                                                                                                                                         |

Not checked: Windows PowerShell 5.1 or Git Credential Manager on real Windows, and the macOS Keychain path (the test used `store` to keep the real Keychain untouched).

## What this POC does not do

- **SSO into Forgejo.** GoTrue `v2.186.0` serves OIDC discovery, but its OAuth server is not enabled in the team namespace, and Pawtograder has no consent page for it yet. Accounts are therefore created with a random password nobody knows (`source_id = 0`). Setting `FORGEJO_AUTH_SOURCE_ID` binds new accounts to the login source once it exists, using the Pawtograder user ID as the login name.
- **Forgejo hardening.** The intended settings are `DISABLE_REGISTRATION = true` (already set), `ENABLE_INTERNAL_SIGNIN = false` once SSO works, and `[admin] EXTERNAL_USER_DISABLE_FEATURES` without `manage_ssh_keys`. `ENABLE_BASIC_AUTHENTICATION` must stay on, because token minting uses admin Basic auth. Students have no usable password, so in practice only the admin can use it.
- **The async worker.** Provisioning is one synchronous instructor call. In production it belongs in the existing queue, driven by enrollment and release triggers.
- **Group repos, handout sync, grading, webhooks.** Individual assignments only.
- **One token per device.** A second computer's setup revokes the first computer's token. Naming tokens per device would remove that, at the cost of more tokens to clean up.
- **The bare `owner/repo` unique index.** `repositories.git_provider` is added, but `unique_repo_name` still spans both providers.

## Running it locally

1. Add to `.env.local`: `FORGEJO_URL`, `NEXT_PUBLIC_FORGEJO_URL`, `FORGEJO_ADMIN_USERNAME`, `FORGEJO_ADMIN_PASSWORD` (the admin secret in the team namespace).
2. `npx supabase start`, `npx supabase functions serve --env-file .env.local`, `npm run seed`, `npm run dev`.
3. Switch one individual assignment to Forgejo and point it at a Forgejo template (set `forgejo_org` only if the org isn't the class slug):

   ```sql
   update classes set forgejo_org = '<org>' where id = <class>;
   update assignments set git_provider = 'forgejo', template_repo = '<org>/<template>' where id = <assignment>;
   ```

4. As an instructor, `POST /functions/v1/forgejo-provision` with `{ "class_id": <class>, "assignment_id": <assignment> }`.
5. Sign in as a student and open the assignment.
