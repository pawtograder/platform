#!/usr/bin/env bash
# Build this environment's web image and push it. Same build args as the
# "Build & push web" step of .github/workflows/preview.yml: Next.js compiles
# NEXT_PUBLIC_* (our hostnames and the anon key) into the client bundle, so a
# ghcr.io/pawtograder/web image built for staging can't serve another host.
#
# Builds the commit in pawtograder.imageRef, the one the migrations and
# edge-functions images come from, so web and schema match. Re-run after
# changing imageRef or recreating pawtograder-jwt.
#
# Needs docker buildx and a `docker login` to the environment's registry.
# Usage: deploy/scripts/build-web-image.sh [environment]   (default: sandbox)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/environments/${1:-sandbox}.yaml"
[ -f "$ENV_FILE" ] || { echo "no such environment: $ENV_FILE" >&2; exit 1; }
val() { yq -r "$1" "$ENV_FILE"; }

web_host="$(val .pawtograder.host)"
# global.apiHostnameFlatten: <first-label>-api.<rest>
api_host="${web_host%%.*}-api.${web_host#*.}"
ref="$(val .pawtograder.imageRef)"
image="$(val .pawtograder.webImageRepository):$(val .pawtograder.imageTag)"

anon_key="$(kubectl --context "$(val .kubeContext)" -n "$(val .namespace)" \
  get secret pawtograder-jwt -o 'jsonpath={.data.ANON_KEY}' | base64 -d)"
[ -n "$anon_key" ] || { echo "pawtograder-jwt has no ANON_KEY; run create-secrets.sh" >&2; exit 1; }

git -C "$ROOT" cat-file -e "$ref^{commit}" 2>/dev/null || git -C "$ROOT" fetch --quiet origin "$ref"
src="$(mktemp -d)"
trap 'rm -rf "$src"' EXIT
git -C "$ROOT" archive "$ref" | tar -x -C "$src"

echo "Building $image from ${ref:0:7} for https://$web_host (API https://$api_host)"
# Cluster nodes are x86_64; on Apple Silicon this builds under emulation.
docker buildx build \
  --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_PAWTOGRADER_WEB_URL="https://$web_host" \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="https://$api_host" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$anon_key" \
  --build-arg NEXT_PUBLIC_GIT_COMMIT_SHA="$ref" \
  --build-arg NEXT_PUBLIC_ENABLE_SIGNUPS=true \
  --build-arg SUPABASE_URL="https://$api_host" \
  --tag "$image" \
  --push \
  "$src"
