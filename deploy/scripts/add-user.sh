#!/usr/bin/env bash
# Give someone an account on Forgejo and Coder, with one generated password
# kept in Secret user-<username> (keys username, email, password). Re-runnable:
# an existing Secret's password is reused and existing accounts are left as
# they are, apart from granting admin when --admin is passed.
#
# Hand the person this to read their password:
#   kubectl get secret user-<username> -o jsonpath='{.data.password}' | base64 -d
#
# Usage: deploy/scripts/add-user.sh <environment> <username> <email> [--admin]
set -euo pipefail

[ $# -ge 3 ] || { sed -n '2,10p' "$0" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/environments/$1.yaml"
username="$2"; email="$3"; admin=false
[ "${4:-}" = --admin ] && admin=true
val() { yq -r "$1" "$ENV_FILE"; }
k() { kubectl --context "$(val .kubeContext)" -n "$(val .namespace)" "$@"; }
secret() { k get secret "$1" -o "jsonpath={.data.$2}" | base64 -d; }

case "$username" in *[!a-z0-9._-]*|'') echo "username: lowercase letters, digits, . _ - only" >&2; exit 1 ;; esac

if ! k get secret "user-$username" >/dev/null 2>&1; then
  k create secret generic "user-$username" \
    --from-literal=username="$username" \
    --from-literal=email="$email" \
    --from-literal=password="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-24)" >/dev/null
  k label secret "user-$username" app.kubernetes.io/part-of=pawtograder-stack >/dev/null
fi
password="$(secret "user-$username" password)"

# Request bodies go over stdin so passwords stay out of the process list.
json() { python3 -c 'import json,sys; print(json.dumps(dict(a.split("=",1) for a in sys.argv[1:])))' "$@"; }
fix_bools() { sed -e 's/"false"/false/g; s/"true"/true/g'; }

# --- Forgejo ----------------------------------------------------------------
if [ "$(val .forgejo.enabled)" = true ]; then
  f_url="https://$(val .forgejo.host)"
  f_auth="$(secret forgejo-admin username):$(secret forgejo-admin password)"
  f() { curl -sS -u "$f_auth" -H 'Content-Type: application/json' -o /dev/null -w '%{http_code}' "$@"; }
  code="$(json username="$username" email="$email" password="$password" must_change_password=false \
    | fix_bools | f -X POST --data-binary @- "$f_url/api/v1/admin/users")"
  case "$code" in
    201) echo "forgejo: created $username" ;;
    422) echo "forgejo: $username already exists" ;;
    *) echo "forgejo: create failed (HTTP $code)" >&2; exit 1 ;;
  esac
  if $admin; then
    code="$(json login_name="$username" source_id=0 admin=true | sed 's/"0"/0/' | fix_bools \
      | f -X PATCH --data-binary @- "$f_url/api/v1/admin/users/$username")"
    [ "$code" = 200 ] && echo "forgejo: $username is admin" || { echo "forgejo: admin grant failed (HTTP $code)" >&2; exit 1; }
  fi
fi

# --- Coder --------------------------------------------------------------------
if [ "$(val .workspaces.enabled)" = true ]; then
  c_url="https://$(val .workspaces.host)"
  token="$(json email="$(secret coder-admin email)" password="$(secret coder-admin password)" \
    | curl -fsS -X POST -H 'Content-Type: application/json' --data-binary @- "$c_url/api/v2/users/login" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["session_token"])')"
  c() { curl -sS -H "Coder-Session-Token: $token" -H 'Content-Type: application/json' "$@"; }
  org="$(c "$c_url/api/v2/organizations/default" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  code="$(json email="$email" username="$username" password="$password" login_type=password \
    | sed "s/}\$/, \"organization_ids\": [\"$org\"]}/" \
    | c -o /dev/null -w '%{http_code}' -X POST --data-binary @- "$c_url/api/v2/users")"
  case "$code" in
    201) echo "coder: created $username" ;;
    409) echo "coder: $username already exists" ;;
    *) echo "coder: create failed (HTTP $code)" >&2; exit 1 ;;
  esac
  if $admin; then
    code="$(echo '{"roles":["owner"]}' | c -o /dev/null -w '%{http_code}' -X PUT --data-binary @- \
      "$c_url/api/v2/users/$username/roles")"
    [ "$code" = 200 ] && echo "coder: $username is owner" || { echo "coder: owner grant failed (HTTP $code)" >&2; exit 1; }
  fi
fi

echo "password: kubectl get secret user-$username -o jsonpath='{.data.password}' | base64 -d"
