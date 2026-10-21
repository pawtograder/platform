#!/usr/bin/env bash
set -uo pipefail

SA=/var/run/secrets/kubernetes.io/serviceaccount
NS=$(cat "$SA/namespace")
KAPI="https://kubernetes.default.svc/api/v1/namespaces/$NS"
FAPI="$FORGEJO_URL/api/v1"
SELECTOR="pawtograder.net/forgejo-job=$PREFIX"

kube() { curl -sS --fail-with-body --cacert "$SA/ca.crt" -H "Authorization: Bearer $(cat "$SA/token")" -H 'Content-Type: application/json' "$@"; }
# Basic auth stops working once the admin enrolls 2FA.
if [ -n "${FORGEJO_TOKEN:-}" ]; then FJ_AUTH=(-H "Authorization: token $FORGEJO_TOKEN"); else FJ_AUTH=(-u "$FORGEJO_USER:$FORGEJO_PASSWORD"); fi
fj() { curl -sS --fail-with-body "${FJ_AUTH[@]}" -H 'Content-Type: application/json' "$@"; }

spawn() {
  local id=$1 handle=$2 reg uuid rid token name pod uid
  reg=$(jq -n --arg n "$PREFIX-job-$id" '{name: $n, ephemeral: true}' | fj -X POST "$FAPI/admin/actions/runners" --data-binary @-) || return 1
  uuid=$(jq -r .uuid <<<"$reg"); rid=$(jq -r .id <<<"$reg"); token=$(jq -r .token <<<"$reg")
  name="$PREFIX-job-$id-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  pod=$(jq --arg n "$name" --arg h "$handle" --arg u "$uuid" --arg r "$rid" --arg j "$id" '
      .metadata.name = $n
    | .metadata.annotations += {"pawtograder.net/job-handle": $h, "pawtograder.net/runner-id": $r, "pawtograder.net/job-id": $j}
    | .spec.volumes |= map(if .name == "token" then .secret.secretName = $n else . end)
    | .spec.containers[0].env += [{name: "RUNNER_UUID", value: $u}, {name: "JOB_HANDLE", value: $h}]
    ' /etc/dispatcher/job-pod.json | kube -X POST "$KAPI/pods" --data-binary @-) \
    || { fj -o /dev/null -X DELETE "$FAPI/admin/actions/runners/$rid"; return 1; }
  uid=$(jq -r .metadata.uid <<<"$pod")
  jq -n --arg n "$name" --arg u "$uid" --arg t "$token" --arg s "$PREFIX" '{
      apiVersion: "v1", kind: "Secret",
      metadata: {name: $n, labels: {"pawtograder.net/forgejo-job": $s},
                 ownerReferences: [{apiVersion: "v1", kind: "Pod", name: $n, uid: $u}]},
      stringData: {token: $t}}' | kube -o /dev/null -X POST "$KAPI/secrets" --data-binary @- \
    || { kube -o /dev/null -X DELETE "$KAPI/pods/$name"; return 1; }
  echo "job $id: pod $name"
}

while true; do
  sleep "$POLL_INTERVAL"
  pods=$(kube "$KAPI/pods?labelSelector=$SELECTOR") || continue
  for p in $(jq -r '.items[] | select(.status.phase == "Succeeded" or .status.phase == "Failed") | .metadata.name' <<<"$pods"); do
    kube -o /dev/null -X DELETE "$KAPI/pods/$p" && echo "reaped $p"
  done
  active=$(jq '[.items[] | select(.status.phase != "Succeeded" and .status.phase != "Failed")] | length' <<<"$pods")
  claimed=$(jq -c '[.items[] | select(.status.phase != "Succeeded" and .status.phase != "Failed") | .metadata.annotations["pawtograder.net/job-handle"]]' <<<"$pods")

  jobs=$(fj "$FAPI/admin/actions/runners/jobs?labels=$LABELS") || continue
  # The list is null, not [], when nothing matches.
  for row in $(jq -r --argjson c "$claimed" '(. // [])[] | select(.status == "waiting") | select(.handle as $h | $c | index($h) | not) | "\(.id),\(.handle)"' <<<"$jobs"); do
    [ "$active" -lt "$CAPACITY" ] || break
    spawn "${row%%,*}" "${row#*,}" && active=$((active + 1))
  done

  # Forgejo deletes an ephemeral runner once it has run its job; these never got that far.
  pods=$(kube "$KAPI/pods?labelSelector=$SELECTOR") || continue
  live=$(jq -c '[.items[] | select(.status.phase != "Succeeded" and .status.phase != "Failed") | .metadata.annotations["pawtograder.net/runner-id"]]' <<<"$pods")
  runners='[]' page=1
  while batch=$(fj "$FAPI/admin/actions/runners?limit=50&page=$page") && [ "$(jq '(. // []) | length' <<<"$batch")" -gt 0 ]; do
    runners=$(jq -c --argjson b "$batch" '. + $b' <<<"$runners"); page=$((page + 1))
  done
  for rid in $(jq -r --arg p "$PREFIX-job-" --argjson l "$live" '.[] | select(.ephemeral and (.name | startswith($p))) | (.id | tostring) | select(. as $i | $l | index($i) | not)' <<<"$runners"); do
    fj -o /dev/null -X DELETE "$FAPI/admin/actions/runners/$rid" && echo "removed unused runner $rid"
  done
done
