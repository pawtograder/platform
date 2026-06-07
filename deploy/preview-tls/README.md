# Preview TLS: shared wildcard cert

Replaces the per-PR Let's Encrypt cert (one per preview, rate-limit-prone) with
a single reflected wildcard cert for `*.preview.pawtograder.net`.

See `wildcard-certificate.yaml` for the full rationale. TL;DR: LE caps certs at
**5 per exact identifier set / week** and **50 per registered domain / week**;
per-PR issuance bumps into both under churn (it took down `pr-821`'s SSL on
2026-06-07). One shared wildcard issued once = no per-PR issuance = limit never
touched.

## How it fits together

1. `letsencrypt-prod` (existing) already has a Cloudflare **DNS-01** solver for
   the `pawtograder.net` zone — required for wildcards.
2. `wildcard-certificate.yaml` issues `*.preview.pawtograder.net` once into the
   `cert-manager` namespace as Secret `pawtograder-preview-wildcard-tls`.
3. **Reflector** copies that Secret into every `pawtograder-preview-*` namespace
   (and into new ones as they're created) and keeps copies in sync on renewal.
4. The preview chart (`examples/values-preview.yaml`) points
   `ingress.tls.secretName` at the reflected Secret and drops the
   `cert-manager.io/cluster-issuer` annotation, so previews consume the shared
   cert instead of minting their own.
5. Previews serve the Supabase API **same-origin** (`global.apiOnSeparateHost:
   false`) so there's a single hostname per preview, fully covered by the
   wildcard. (A TLS wildcard spans one label, so it could never cover the old
   two-label `api.pr-N.preview.pawtograder.net` host.)

## Rollout (run in order; merge the chart change LAST)

```bash
# 1. Install reflector (one-time; ~1 small controller pod)
helm repo add emberstack https://emberstack.github.io/helm-charts
helm upgrade --install reflector emberstack/reflector \
  --namespace reflector --create-namespace

# 2. Issue the wildcard cert + reflection config
kubectl apply -f deploy/preview-tls/wildcard-certificate.yaml
kubectl -n cert-manager wait --for=condition=Ready certificate/pawtograder-preview-wildcard --timeout=300s

# 3. Confirm reflection lands in a live preview namespace
kubectl -n cert-manager get secret pawtograder-preview-wildcard-tls
#   open a PR / redeploy one, then:
kubectl -n pawtograder-preview-pr-<N> get secret pawtograder-preview-wildcard-tls
```

Only after steps 1–3 succeed, merge this PR (the `values-preview.yaml` change)
**and** apply the `preview.yml` companion change below — they must land together
or previews break.

## Required companion change in `.github/workflows/preview.yml`

Switching to same-origin API means the web app must be **built** to call the
API on the main host (Next.js bakes `NEXT_PUBLIC_*` at build time). This file
is a GitHub Actions workflow, which the automation token here can't push — apply
it by hand:

```diff
   build-args: |
     NEXT_PUBLIC_PAWTOGRADER_WEB_URL=https://${{ needs.meta.outputs.hostname }}
-    NEXT_PUBLIC_SUPABASE_URL=https://${{ needs.meta.outputs.api_hostname }}
+    NEXT_PUBLIC_SUPABASE_URL=https://${{ needs.meta.outputs.hostname }}
     ...
-    SUPABASE_URL=https://${{ needs.meta.outputs.api_hostname }}
+    SUPABASE_URL=https://${{ needs.meta.outputs.hostname }}
```

(`api_hostname`/the `api.` host can then be dropped from the `meta` job and the
PR-comment "API:" line, but that's cosmetic — leaving them is harmless.)

## Rollback

Revert the `values-preview.yaml` change and restore the two `preview.yml` lines;
previews go back to per-PR issuance. The wildcard cert + reflector can stay (they
do no harm) or be removed with `kubectl delete -f wildcard-certificate.yaml` and
`helm uninstall -n reflector reflector`.
