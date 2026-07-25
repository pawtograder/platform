# a11y VoiceOver Mac runner — operator runbook

One-time setup of the out-of-cluster Mac that runs the
[`a11y VoiceOver (real Safari)`](../.github/workflows/a11y-voiceover.yml)
workflow: real VoiceOver + real Safari replaying the promoted SR task plans
(`tests/e2e/a11y-tasks/`) against a PR's deploy preview.

The Mac hosts **no dev stack**. It runs the browser + VoiceOver and talks to
the remote preview (`pr-<id>.preview.pawtograder.net`), pulling the preview's
e2e env from OpenBao (published there by `preview.yml`).

Design/architecture background: `tools/a11y-judge/README.md`.

## 1. Machine prep

VoiceOver only runs in a logged-in GUI (aqua) session — never headless/SSH.

- Create a dedicated macOS account (e.g. `pawtograder-vo`) and enable
  **auto-login** for it (System Settings ▸ Users & Groups). Auto-login
  requires FileVault to be off (or unlocked at boot by other means).
- Keep the machine awake and unlocked:
  ```sh
  sudo pmset -a sleep 0 displaysleep 0 disablesleep 1
  ```
  System Settings ▸ Lock Screen: screen saver **never**, require password
  **never**. Disable Power Nap.
- Mute output volume (spoken-phrase capture is via API, not audio) and set a
  fast VoiceOver speech rate (VoiceOver Utility ▸ Speech) so runs aren't gated
  on speech synthesis.
- Cut VoiceOver's automatic chatter — it feeds guidepup's phrase-capture
  polling and slows every command: VoiceOver Utility ▸ Web ▸ Page Loading:
  uncheck "Automatically speak the webpage"; Verbosity ▸ Speech: set to Low.
  (The runner's capture mode defaults to guidepup's bounded "initial"; only
  set `A11Y_VO_CAPTURE=full` for diagnosis — on chatty pages full capture
  waits for speech to stabilize and can hang every command.)

## 2. Software

```sh
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@22 openbao jq git
```

## 3. VoiceOver AppleScript control + TCC grants

```sh
npx @guidepup/setup
```

This enables VoiceOver's AppleScript control (and the keyboard Commander the
landmark commands need). Then, in System Settings ▸ Privacy & Security, grant:

- **Accessibility**: Terminal (for manual runs) AND the runner's
  `Runner.Listener` binary (after §5).
- **Automation**: allow the same processes to control **Safari**,
  **System Events**, and **VoiceOver**.

Verify with `npm run a11y:vo:doctor` (from a repo checkout). ⚠️ TCC grants are
per-binary and **reset on macOS upgrades** — see §8.

### VoiceOver navigation settings

The harness routes keyboard focus to the VO cursor (VO+Cmd+F5) before every
`type`/`press`, so no VoiceOver Utility navigation setting is load-bearing —
but keeping VoiceOver Utility ▸ Navigation ▸ "Keyboard focus follows
VoiceOver cursor" **enabled** reduces focus/cursor divergence between
commands.

## 4. Safari

- Settings ▸ Advanced: **Show Develop menu**.
- Develop ▸ **Allow JavaScript from Apple Events** (the host channel's
  readiness polling depends on it).
- Settings ▸ AutoFill: **everything off** (logins are magic-link, no
  passwords — keep it that way).
- Do **NOT** enable Develop ▸ Allow Remote Automation: safaridriver's
  "remotely controlled" glass pane terminates the session on VoiceOver-driven
  keystrokes. The runner uses AppleScript on purpose.

## 5. GitHub self-hosted runner

Repo ▸ Settings ▸ Actions ▸ Runners ▸ New self-hosted runner (macOS), then:

```sh
./config.sh --url https://github.com/<org>/<repo> --token <reg-token> \
  --labels self-hosted,macOS,voiceover
./svc.sh install && ./svc.sh start
```

`svc.sh` installs a **LaunchAgent** under `~/Library/LaunchAgents` — correct:
it runs inside the aqua session. The account from §1 must stay logged in at
the console. Re-grant §3's TCC entries for `Runner.Listener` once it exists.

## 6. OpenBao client

The Mac reads per-PR e2e bundles from
`kv/apps/pawtograder/preview-e2e/pr-<id>` (published by `preview.yml`, deleted
on preview destroy) via `scripts/export-preview-e2e-from-bao.sh`.

On the Mac:

```sh
echo 'export BAO_ADDR=https://bao.work.ripley.cloud' >> ~/.zshenv
# Human bootstrap / spot checks:
bao login -method=oidc
# Standing runner credentials (from the admin, below):
mkdir -p ~/.config/pawtograder/bao
echo '<role_id>'   > ~/.config/pawtograder/bao/role_id
echo '<secret_id>' > ~/.config/pawtograder/bao/secret_id
chmod 700 ~/.config/pawtograder/bao && chmod 600 ~/.config/pawtograder/bao/*
```

### Admin-side provisioning (once per cluster)

```sh
# Policies
bao policy write pawtograder-preview-e2e-writer - <<'EOF'
path "kv/data/apps/pawtograder/preview-e2e/*"     { capabilities = ["create", "update"] }
path "kv/metadata/apps/pawtograder/preview-e2e/*" { capabilities = ["delete"] }
EOF

bao policy write pawtograder-preview-e2e-reader - <<'EOF'
path "kv/data/apps/pawtograder/preview-e2e/*" { capabilities = ["read"] }
# staging read for local dry-runs on the Mac (export-staging-env.sh):
path "kv/data/apps/pawtograder-staging/jwt"   { capabilities = ["read"] }
path "kv/data/apps/pawtograder-staging/e2e"   { capabilities = ["read"] }
EOF

bao auth enable approle 2>/dev/null || true

# CI writer (used by preview.yml's publish + destroy-cleanup steps)
bao write auth/approle/role/pawtograder-preview-e2e-publisher \
  token_policies=pawtograder-preview-e2e-writer token_ttl=15m token_max_ttl=30m
bao read -field=role_id auth/approle/role/pawtograder-preview-e2e-publisher/role-id
bao write -f -field=secret_id auth/approle/role/pawtograder-preview-e2e-publisher/secret-id

# Mac reader
bao write auth/approle/role/pawtograder-mac-voiceover \
  token_policies=pawtograder-preview-e2e-reader token_ttl=30m token_max_ttl=1h
bao read -field=role_id auth/approle/role/pawtograder-mac-voiceover/role-id
bao write -f -field=secret_id auth/approle/role/pawtograder-mac-voiceover/secret-id
```

### GitHub-side configuration

- Repo **variable** `BAO_ADDR` = `https://bao.work.ripley.cloud`
- Repo **secrets** `BAO_PUBLISHER_ROLE_ID` / `BAO_PUBLISHER_SECRET_ID`
  (the publisher AppRole above)

The Mac's reader credentials live only in `~/.config/pawtograder/bao/` —
never in GitHub.

## 7. Validation

```sh
git clone <repo> && cd platform && npm ci
npm run a11y:vo:doctor                       # all checks green
./scripts/export-preview-e2e-from-bao.sh <pr> --shell   # against a live preview

# Staging dry-run (needs the reader policy's staging paths):
eval "$(./scripts/export-staging-env.sh --shell)"
BASE_URL=https://staging.pawtograder.net npm run a11y:vo -- --filter assignments-list --calibrate
```

Then dispatch the workflow against a real preview with `task_filter` set to a
single read task before running the full suite. Promotion bar for enforcing
(non-calibrate) runs: 3× consecutive green on staging.

## 8. Maintenance

- **After every macOS update**: re-run `npx @guidepup/setup`, re-grant the §3
  TCC entries, re-check §4's Safari settings, run the doctor.
- **secret_id rotation** (quarterly, or on suspicion): admin mints a new
  secret-id (§6), replace `~/.config/pawtograder/bao/secret_id`.
- **Stuck concurrency queue** (`a11y-voiceover-mac`): cancel the wedged run in
  the Actions UI; if VoiceOver itself is wedged on the Mac, `pkill VoiceOver`
  and re-run the doctor.
- Artifacts land in the workflow's `a11y-vo-pr-<id>` upload (spoken logs,
  junit, summary, `.mov` recordings); the local copy is `a11y-vo-artifacts/`.
