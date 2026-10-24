#!/usr/bin/env bash
# Create a restricted Google API key for the exam OCR CI lane (.github/workflows/exam-vision-e2e.yml)
# and store it as the GOOGLE_API_KEY secret on the GitHub repo. The key never touches stdout or disk.
#
# Usage: scripts/provision-exam-vision-ci-key.sh <gcp-project-id> [github-repo]
#
# Prereqs:
#   * gcloud, authenticated (`gcloud auth login`) as someone who can enable services and create
#     API keys in the project (roles/serviceusage.serviceUsageAdmin + roles/serviceusage.apiKeysAdmin)
#   * billing enabled on the project -- Cloud Vision refuses requests from an unbilled project
#   * gh, authenticated with admin on the repo (to set secrets)
#
# Use a CI-only project rather than the production one: CI spend and quota exhaustion then cannot
# affect real exam processing, and the key can be rotated without touching prod.
#
# Re-running creates a new key and overwrites the secret; delete the old key afterwards with
#   gcloud services api-keys list --project <id> --filter='displayName=pawtograder-exam-vision-ci'
#   gcloud services api-keys delete <uid> --project <id>
set -euo pipefail

PROJECT="${1:?usage: $0 <gcp-project-id> [github-repo]}"
REPO="${2:-pawtograder/platform}"
DISPLAY_NAME="pawtograder-exam-vision-ci"

command -v gcloud >/dev/null || { echo "gcloud not found" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }

echo "Enabling Vision, Generative Language and API Keys services on ${PROJECT}..."
gcloud services enable \
  vision.googleapis.com \
  generativelanguage.googleapis.com \
  apikeys.googleapis.com \
  --project "$PROJECT"

echo "Creating API key '${DISPLAY_NAME}' restricted to those two APIs..."
# --api-target restricts the key to these services; a leaked key cannot call anything else.
KEY_NAME=$(gcloud services api-keys create \
  --project "$PROJECT" \
  --display-name "$DISPLAY_NAME" \
  --api-target service=vision.googleapis.com \
  --api-target service=generativelanguage.googleapis.com \
  --format 'value(response.name)')
[ -n "$KEY_NAME" ] || { echo "key creation returned no name" >&2; exit 1; }
echo "Created ${KEY_NAME}"

echo "Storing it as GOOGLE_API_KEY on ${REPO}..."
gcloud services api-keys get-key-string "$KEY_NAME" --format 'value(keyString)' |
  gh secret set GOOGLE_API_KEY --repo "$REPO"

cat <<EOF
Done. Recommended next step: cap spend in the console, since an API key cannot carry a budget.
  * Quotas: https://console.cloud.google.com/apis/api/vision.googleapis.com/quotas?project=${PROJECT}
    and   https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas?project=${PROJECT}
  * Budget alert: https://console.cloud.google.com/billing/budgets
A run of the suite makes ~6 Vision calls and ~10 Gemini calls.
Then trigger a run:  gh workflow run exam-vision-e2e.yml --repo ${REPO} --ref <branch>
EOF
