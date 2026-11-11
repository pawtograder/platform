# Zero-click Forgejo link probe

Checks whether Pawtograder can link a student's Forgejo account in Coder with one redirect chain and no
clicks. Spec: `tests/e2e/sso/zero-click-link.forgejo-coder.spec.ts`.

```bash
FIRST_PARTY=1 KEEP_UP=1 SKIP_TESTS=1 tests/e2e/forgejo-coder/run-e2e.sh   # lane up, consent auto-approves Forgejo and Coder
tests/e2e/forgejo-coder/zero-click/setup-ext-auth.sh false              # Forgejo OAuth app "Coder" + Coder's gitea provider
docker exec pawtograder-sso-e2e-forgejo-1 mkdir -p /var/lib/gitea/custom/templates/custom
docker cp tests/e2e/forgejo-coder/zero-click/header.tmpl \
  pawtograder-sso-e2e-forgejo-1:/var/lib/gitea/custom/templates/custom/header.tmpl
docker restart pawtograder-sso-e2e-forgejo-1 && curl -s -o /dev/null http://127.0.0.1:3100/user/oauth2/pawtograder  # PKCE warm-up
GRANT_SCRIPT=$PWD/tests/e2e/forgejo-coder/zero-click/insert-grant.sh ONLY=1 \
  tests/e2e/forgejo-coder/run-e2e.sh tests/e2e/sso/zero-click-link.forgejo-coder.spec.ts
```

Each piece removes one stop:

| Stop                                                   | Fix used here                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Pawtograder consent for Coder and Forgejo              | `OAUTH_FIRST_PARTY_CLIENT_IDS` auto-approves those client ids                                                                         |
| Forgejo login page ("Sign in with pawtograder" button) | `header.tmpl` follows the only SSO link on `/user/login` (`?local=1` keeps the page)                                                  |
| Forgejo "Authorize Coder" screen                       | an `oauth2_grant` row for the student and the Coder app; Forgejo 15 has no skip-consent setting                                       |
| Return to Pawtograder                                  | Coder keeps only the path of an absolute `redirect`, so the chain runs in a popup that Pawtograder closes once Coder reports the link |

`forgejo-no-internal-signin.override.yml` (`ENABLE_INTERNAL_SIGNIN=false`) was tried first. It hides the
password form but still shows the button, so the template is what removes that stop.
