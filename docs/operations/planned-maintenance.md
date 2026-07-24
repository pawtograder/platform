# Planned Maintenance — serving the maintenance page

> **Note:** the broader planned-maintenance runbook (the full-downtime bounce, the
> Postgres PDB, scheduling, verification) is added by the operations-docs PR that
> introduces this file's companion sections. This section documents the
> **styled maintenance page** mechanism (chart `maintenance.*` +
> `pawtograder-maintenance` Service) and the exact ingress swap/revert. When both
> land, this becomes step 1 ("put up the maintenance page") of that runbook.

During a planned window the web host serves a styled **HTTP 503** page (matching
the app's in-app error boundary) instead of the app. It is a tiny static nginx
Deployment (`maintenance.enabled`) fronted by the `pawtograder-maintenance`
Service; the window is opened by repointing the web-host ingress backend to it,
and closed by pointing it back.

## Prerequisite: deploy the page BEFORE patching the ingress

Enabling `maintenance.enabled` only **creates** the Deployment/Service — it does
**not** reroute anything. Roll it out first, so the Service has ready endpoints
before you repoint the ingress:

```bash
helm upgrade pawtograder <chart> -n pawtograder-prod --reuse-values \
  --set maintenance.enabled=true \
  --set maintenance.eta="6:15pm ET"   # optional; message/title also overridable
kubectl -n pawtograder-prod rollout status deploy/pawtograder-maintenance
```

## Swap the web host onto the maintenance page

The primary ingress is named `pawtograder` (the Helm fullname). Its **first
rule** (`rules[0]`) is the web host; with the API on its own host (prod default),
that rule's **first path** (`paths[0]`) is the web backend. Confirm the rule is
the web host, then repoint its backend:

```bash
# Verify rules[0] is the WEB host (not the api host) before patching:
kubectl -n pawtograder-prod get ingress pawtograder \
  -o jsonpath='{.spec.rules[0].host}{"\n"}'
# → app.pawtograder.net (the web host)

# Repoint web host → maintenance page:
kubectl -n pawtograder-prod patch ingress pawtograder --type=json -p \
  '[{"op":"replace","path":"/spec/rules/0/http/paths/0/backend/service","value":{"name":"pawtograder-maintenance","port":{"number":8080}}}]'
```

Users on the web host now get the styled 503. **This reroutes the web host
only** — the API/kong host is a separate rule and stays open — so the page is a
user-facing banner, **not** a write fence. Scaling the writer tiers to 0 (or
otherwise fencing writes) remains the actual protection during the window.

## Revert when the window closes

Point the web-host backend back to the app, then (optionally) tear the page down:

```bash
kubectl -n pawtograder-prod patch ingress pawtograder --type=json -p \
  '[{"op":"replace","path":"/spec/rules/0/http/paths/0/backend/service","value":{"name":"pawtograder-web","port":{"number":3000}}}]'

# Optional: remove the maintenance Deployment/Service again.
helm upgrade pawtograder <chart> -n pawtograder-prod --reuse-values \
  --set maintenance.enabled=false
```

Verify the web host serves the app again (a smoke check) before announcing the
window closed.

## Customizing the page

`maintenance.title`, `maintenance.message`, and `maintenance.eta` (rendered only
when set) are substituted into the bundled page; `maintenance.retryAfterSeconds`
sets both the `Retry-After` header and the page's auto-refresh. To replace the
whole body, set `maintenance.html` (raw HTML, rendered through `tpl`).
