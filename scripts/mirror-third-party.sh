#!/usr/bin/env bash
#
# Copies the charts and images listed in .github/mirror.yaml into DEST, skipping
# any that are already there. Run by .github/workflows/mirror-third-party.yml.
#
#   DEST=ghcr.io/pawtograder/mirror scripts/mirror-third-party.sh [list]
#   DRY_RUN=1 ...    # print what would be copied, push nothing
#
# Requires: helm 3.8+, docker buildx, yq v4. Log in to DEST's registry first.

set -euo pipefail

LIST="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/mirror.yaml}"
DEST="${DEST:?set DEST, e.g. ghcr.io/pawtograder/mirror}"
DRY_RUN="${DRY_RUN:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

run() { if [ -n "$DRY_RUN" ]; then echo "  would run: $*"; else "$@"; fi; }

n=$(yq '.charts | length' "$LIST")
for ((i = 0; i < n; i++)); do
  name=$(yq ".charts[$i].name" "$LIST")
  repo=$(yq ".charts[$i].repository" "$LIST")
  version=$(yq ".charts[$i].version" "$LIST")
  dst="oci://$DEST/charts/$name"
  if helm show chart "$dst" --version "$version" >/dev/null 2>&1; then
    echo "chart $name $version: already in $dst"
    continue
  fi
  echo "chart $name $version: $repo -> $dst"
  mkdir -p "$TMP/$name"
  case "$repo" in
    oci://*) helm pull "$repo/$name" --version "$version" -d "$TMP/$name" ;;
    *) helm pull "$name" --repo "$repo" --version "$version" -d "$TMP/$name" ;;
  esac
  run helm push "$TMP/$name"/*.tgz "oci://$DEST/charts"
done

for src in $(yq '.images[]' "$LIST"); do
  case "${src%%/*}" in
    *.*|*:*) ;;
    *) echo "image $src: name the registry (e.g. docker.io/$src)" >&2; exit 1 ;;
  esac
  path="${src#*/}"
  dst="$DEST/$path"
  if docker buildx imagetools inspect "$dst" >/dev/null 2>&1; then
    echo "image $src: already at $dst"
    continue
  fi
  echo "image $src -> $dst"
  # Copies the manifest list as-is, so every platform and the upstream digest carry over.
  run docker buildx imagetools create --tag "$dst" "$src"
done
