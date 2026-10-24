"""Disable the Cloud Vision API when its budget is exhausted.

Cloud Vision bills after the fact and has no daily quota, so a budget alone only sends email.
This function subscribes to the budget's Pub/Sub topic and, once the reported cost reaches the
budget amount, disables vision.googleapis.com on the project. Every Vision call then fails (and
the exam worker dead-letters), which is the point: the spend stops.

Budget data lags actual usage by hours, so this is a near cap, not an exact one.

Re-enable after raising the budget or at the start of the next month:
    gcloud services enable vision.googleapis.com --project <project>
"""

import base64
import json
import os

import functions_framework
import google.auth
import google.auth.transport.requests

PROJECT_ID = os.environ["TARGET_PROJECT"]
BUDGET_NAME = os.environ["BUDGET_DISPLAY_NAME"]
SERVICE = "vision.googleapis.com"
BASE = f"https://serviceusage.googleapis.com/v1/projects/{PROJECT_ID}/services/{SERVICE}"


def _session():
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    return google.auth.transport.requests.AuthorizedSession(creds)


@functions_framework.cloud_event
def cap_vision(cloud_event):
    payload = json.loads(base64.b64decode(cloud_event.data["message"]["data"]).decode())
    name = payload.get("budgetDisplayName")
    cost = float(payload.get("costAmount", 0))
    budget = float(payload.get("budgetAmount", 0))

    # The topic is ours, but check anyway: acting on some other budget's message would disable
    # Vision for the wrong reason.
    if name != BUDGET_NAME:
        print(f"ignoring notification for budget {name!r}")
        return
    if budget <= 0 or cost < budget:
        print(f"{name}: {cost:.2f} of {budget:.2f}; under budget, nothing to do")
        return

    session = _session()
    state = session.get(BASE, timeout=30)
    state.raise_for_status()
    if state.json().get("state") == "DISABLED":
        print(f"{name}: {cost:.2f} of {budget:.2f}; {SERVICE} already disabled")
        return

    # SKIP the recent-usage check: the API has usage by definition, which is why we are here.
    resp = session.post(
        f"{BASE}:disable",
        json={"disableDependentServices": False, "checkIfServiceHasUsage": "SKIP"},
        timeout=60,
    )
    resp.raise_for_status()
    print(f"{name}: {cost:.2f} of {budget:.2f}; disabled {SERVICE} on {PROJECT_ID}")
