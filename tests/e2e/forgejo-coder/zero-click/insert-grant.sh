#!/usr/bin/env bash
# Usage: insert-grant.sh <forgejo user id>
# Pre-approves Forgejo's "Coder" OAuth app for one user, as if they had clicked Authorize once.
set -euo pipefail
UID_="$1"
docker run --rm --volumes-from pawtograder-sso-e2e-forgejo-1 --entrypoint sh alpine:3.20 -c "
apk add -q sqlite >/dev/null
sqlite3 /var/lib/gitea/data/gitea.db \"
INSERT INTO oauth2_grant (user_id, application_id, counter, scope, nonce, created_unix, updated_unix)
SELECT $UID_, id, 1, 'read:repository write:repository read:user', '', strftime('%s','now'), strftime('%s','now')
FROM oauth2_application WHERE name = 'Coder' ORDER BY id DESC LIMIT 1;
SELECT 'grant', id, user_id, application_id, scope FROM oauth2_grant WHERE user_id = $UID_;\"
"
