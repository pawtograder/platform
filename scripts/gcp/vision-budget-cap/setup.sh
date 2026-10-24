#!/usr/bin/env bash
# Near-hard monthly cap on Cloud Vision spend for one project.
#
# Cloud Vision is postpaid and has only per-minute quotas, so nothing native stops a leaked key
# from running up a bill. This wires a Vision-only budget to a Pub/Sub topic and a Cloud Run
# function (main.py) that disables vision.googleapis.com once the budget is reached.
#
# Usage: scripts/gcp/vision-budget-cap/setup.sh <project-id> <billing-account-id> [monthly-usd]
# Requires: gcloud authed as a project owner who is also billing admin on the account.
# Idempotent: re-running redeploys the function and leaves existing resources alone.
set -euo pipefail

PROJECT="${1:?usage: $0 <project-id> <billing-account-id> [monthly-usd]}"
BILLING="${2:?usage: $0 <project-id> <billing-account-id> [monthly-usd]}"
AMOUNT="${3:-10}"
REGION=us-east1
TOPIC=vision-budget-cap
SA_NAME=vision-budget-cap
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
ROLE_ID=visionBudgetCap
BUDGET_NAME="Cloud Vision cap (${PROJECT})"
VISION_BILLING_SERVICE=services/C08E-37B9-80D3 # "Cloud Vision API" in the Cloud Billing catalog
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

gcloud services enable billingbudgets.googleapis.com pubsub.googleapis.com \
  cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com eventarc.googleapis.com serviceusage.googleapis.com \
  --project "$PROJECT"

gcloud pubsub topics describe "$TOPIC" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud pubsub topics create "$TOPIC" --project "$PROJECT"

# The function may read and disable services, and nothing else.
gcloud iam roles describe "$ROLE_ID" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam roles create "$ROLE_ID" --project "$PROJECT" \
    --title "Vision budget cap" \
    --description "Disable a service when its budget is exhausted" \
    --permissions serviceusage.services.get,serviceusage.services.disable
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT" \
    --display-name "Disables Cloud Vision when its budget is spent"
gcloud projects add-iam-policy-binding "$PROJECT" --condition=None \
  --member "serviceAccount:${SA}" --role "projects/${PROJECT}/roles/${ROLE_ID}" >/dev/null
# Eventarc delivers the Pub/Sub message by invoking the function as this account.
gcloud projects add-iam-policy-binding "$PROJECT" --condition=None \
  --member "serviceAccount:${SA}" --role roles/run.invoker >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" --condition=None \
  --member "serviceAccount:${SA}" --role roles/eventarc.eventReceiver >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" \
  --member "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role roles/iam.serviceAccountTokenCreator >/dev/null

gcloud functions deploy vision-budget-cap --gen2 --project "$PROJECT" --region "$REGION" \
  --runtime python312 --source "$HERE" --entry-point cap_vision \
  --trigger-topic "$TOPIC" --service-account "$SA" --trigger-service-account "$SA" \
  --set-env-vars "TARGET_PROJECT=${PROJECT},BUDGET_DISPLAY_NAME=${BUDGET_NAME}" \
  --memory 256Mi --max-instances 1 --timeout 120s --quiet

if gcloud billing budgets list --billing-account "$BILLING" --billing-project "$PROJECT" \
  --format='value(displayName)' | grep -qxF "$BUDGET_NAME"; then
  echo "Budget '${BUDGET_NAME}' already exists; leaving it (edit the amount in the console)."
else
  gcloud billing budgets create --billing-account "$BILLING" --billing-project "$PROJECT" \
    --display-name "$BUDGET_NAME" \
    --budget-amount "${AMOUNT}USD" \
    --filter-projects "projects/${PROJECT}" \
    --filter-services "$VISION_BILLING_SERVICE" \
    --calendar-period month \
    --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0 \
    --notifications-rule-pubsub-topic "projects/${PROJECT}/topics/${TOPIC}"
fi
echo "Done: Vision on ${PROJECT} is disabled once this month's Vision spend reaches \$${AMOUNT}."
