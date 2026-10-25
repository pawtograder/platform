#!/usr/bin/env bash
# Near-hard monthly cap on exam OCR spend (Cloud Vision + Gemini) for one project.
#
# Cloud Vision is postpaid with only per-minute quotas, and Gemini is on postpay as well, so
# nothing native stops a leaked key from running up a bill. This wires one budget covering both
# APIs to a Pub/Sub topic and a Cloud Run function (main.py) that disables both once the budget
# is reached. Every API key in the project (CI's, the students') draws on that one budget.
#
# Usage: scripts/gcp/vision-budget-cap/setup.sh <project-id> <billing-account-id> [monthly-usd]
# Requires: gcloud authed as a project owner who is also billing admin on the account.
# Idempotent: re-running redeploys the function and brings the budget's name, services and
# topic up to date (the amount is only set on creation; change it in the console).
set -euo pipefail

PROJECT="${1:?usage: $0 <project-id> <billing-account-id> [monthly-usd]}"
BILLING="${2:?usage: $0 <project-id> <billing-account-id> [monthly-usd]}"
AMOUNT="${3:-10}"
REGION=us-east1
TOPIC=vision-budget-cap
SA_NAME=vision-budget-cap
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
ROLE_ID=visionBudgetCap
BUDGET_NAME="Exam OCR cap (${PROJECT})"
OLD_BUDGET_NAME="Cloud Vision cap (${PROJECT})" # Vision-only predecessor; renamed in place
# Cloud Billing catalog ids: "Cloud Vision API" and "Gemini API"
BILLING_SERVICES=services/C08E-37B9-80D3,services/AEFD-7695-64FA
CAPPED_SERVICES="vision.googleapis.com;generativelanguage.googleapis.com"
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
    --display-name "Disables exam OCR APIs when their budget is spent"
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
  --set-env-vars "TARGET_PROJECT=${PROJECT},BUDGET_DISPLAY_NAME=${BUDGET_NAME},CAPPED_SERVICES=${CAPPED_SERVICES}" \
  --memory 256Mi --max-instances 1 --timeout 120s --quiet

EXISTING=$(gcloud billing budgets list --billing-account "$BILLING" --billing-project "$PROJECT" \
  --format='csv[no-heading](name,displayName)' |
  awk -F, -v a="$BUDGET_NAME" -v b="$OLD_BUDGET_NAME" '$2 == a || $2 == b { print $1; exit }')
if [ -n "$EXISTING" ]; then
  gcloud billing budgets update "$EXISTING" --billing-account "$BILLING" --billing-project "$PROJECT" \
    --display-name "$BUDGET_NAME" \
    --filter-projects "projects/${PROJECT}" \
    --filter-services "$BILLING_SERVICES" \
    --notifications-rule-pubsub-topic "projects/${PROJECT}/topics/${TOPIC}"
else
  gcloud billing budgets create --billing-account "$BILLING" --billing-project "$PROJECT" \
    --display-name "$BUDGET_NAME" \
    --budget-amount "${AMOUNT}USD" \
    --filter-projects "projects/${PROJECT}" \
    --filter-services "$BILLING_SERVICES" \
    --calendar-period month \
    --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0 \
    --notifications-rule-pubsub-topic "projects/${PROJECT}/topics/${TOPIC}"
fi
echo "Done: Vision and Gemini on ${PROJECT} are disabled once this month's combined spend reaches the budget."
