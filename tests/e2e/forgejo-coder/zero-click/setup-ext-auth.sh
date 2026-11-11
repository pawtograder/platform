#!/usr/bin/env bash
# Usage: setup-ext-auth.sh <skip_consent:true|false>
# Registers Forgejo's OAuth app for Coder and recreates Coder with the gitea-type provider (#1234's settings).
set -euo pipefail
ZC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERE="$(dirname "$ZC")"
OVR="$ZC/.coder-ext-auth.override.yml" # holds the client secret; gitignored
FJ=http://127.0.0.1:3100
CODER=http://127.0.0.1:7080
SKIP="${1:-true}"
A=(-u forgejo-admin:forgejo-e2e-admin-pw -H 'Content-Type: application/json')

# Fresh app each run, so the setting under test is the only variable.
for id in $(curl -fsS "${A[@]}" "$FJ/api/v1/user/applications/oauth2" | jq -r '.[] | select(.name=="Coder") | .id'); do
  curl -fsS "${A[@]}" -X DELETE "$FJ/api/v1/user/applications/oauth2/$id"
done
APP="$(curl -fsS "${A[@]}" -X POST "$FJ/api/v1/user/applications/oauth2" \
  -d "{\"name\":\"Coder\",\"confidential_client\":true,\"skip_secondary_authorization\":$SKIP,\"redirect_uris\":[\"$CODER/external-auth/forgejo/callback\"]}")"
echo "$APP" | jq '{id,name,confidential_client,skip_secondary_authorization,redirect_uris}'

cat >"$OVR" <<YML
services:
  coder:
    environment:
      CODER_EXTERNAL_AUTH_0_ID: forgejo
      CODER_EXTERNAL_AUTH_0_TYPE: gitea
      CODER_EXTERNAL_AUTH_0_DISPLAY_NAME: Forgejo
      CODER_EXTERNAL_AUTH_0_CLIENT_ID: "$(echo "$APP" | jq -r .client_id)"
      CODER_EXTERNAL_AUTH_0_CLIENT_SECRET: "$(echo "$APP" | jq -r .client_secret)"
      CODER_EXTERNAL_AUTH_0_AUTH_URL: "$FJ/login/oauth/authorize"
      CODER_EXTERNAL_AUTH_0_TOKEN_URL: "$FJ/login/oauth/access_token"
      CODER_EXTERNAL_AUTH_0_VALIDATE_URL: "$FJ/api/v1/user"
      CODER_EXTERNAL_AUTH_0_REGEX: '^http://127\.0\.0\.1:3100(/.*)?\$\$'
      CODER_EXTERNAL_AUTH_0_SCOPES: "read:repository write:repository read:user"
YML

cenv() { docker inspect pawtograder-sso-e2e-coder-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^$1=//p"; }
export SB_API_PORT=56321 SB_ISSUER=http://127.0.0.1:56321/auth/v1
export CODER_OIDC_CLIENT_ID CODER_OIDC_CLIENT_SECRET
CODER_OIDC_CLIENT_ID="$(cenv CODER_OIDC_CLIENT_ID)"
CODER_OIDC_CLIENT_SECRET="$(cenv CODER_OIDC_CLIENT_SECRET)"
docker compose -f "$HERE/docker-compose.yml" -f "$OVR" up -d --force-recreate --no-deps coder >/dev/null
for _ in $(seq 60); do curl -fsS -o /dev/null "$CODER/healthz" 2>/dev/null && break; sleep 2; done
echo "coder env:"
cenv CODER_EXTERNAL_AUTH_0_REGEX
cenv CODER_EXTERNAL_AUTH_0_SCOPES
