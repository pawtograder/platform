# LTI 1.3 Integration

Pawtograder acts as an **LTI 1.3 Tool** that integrates with an LMS **Platform**
(Canvas, Moodle, Brightspace, Blackboard, etc.). It replaces two legacy roster
sync paths:

- The hand-rolled SIS proxy (`supabase/functions/course-import-sis`)
- The broken/unused Canvas REST sync (`supabase/functions/enrollments-sync-canvas`)

LTI 1.3 gives us three capabilities, all built on the same OAuth2 + JWT trust:

1. **LTI Resource Link Launch** (OIDC) — single sign-on from the LMS into a
   Pawtograder course/assignment.
2. **Names and Role Provisioning Services (NRPS)** — pull the course roster.
3. **Assignment and Grade Services (AGS)** — push assignments (line items) and
   grades (scores) back to the LMS gradebook.

Optionally **Deep Linking** lets an instructor select/create a Pawtograder
resource from inside the LMS course editor.

---

## Why Next.js route handlers (not Edge Functions)

LTI is browser-redirect heavy (OIDC login → launch → set session) and
server-to-server (NRPS/AGS need RSA signing + JWKS verification). Doing the
crypto in one runtime avoids duplicating signing/verification across Deno and
Node. So **all LTI logic lives in Next.js**:

- `lib/lti/**` — protocol core (runtime-agnostic, uses `jose`)
- `app/api/lti/**` — HTTP endpoints (redirects, JWKS, sync triggers)

Roster sync still reuses the existing atomic DB function
`public.sis_sync_enrollment(...)` so the enrollment/invitation semantics stay
identical to the SIS path. Grade push reads the existing gradebook
(`gradebook_column_students.score`).

Scheduled roster sync is driven by `pg_cron` calling the Next.js sync endpoint
with a shared-secret header (mirrors how `call_edge_function_internal` triggers
the SIS cron today), so we keep one hourly cadence.

---

## Trust model & key management

Two keypairs are involved per (tool, platform) relationship:

- **Platform keys** — the LMS publishes a JWKS URL. We fetch & cache it to verify
  the `id_token` on launch and (for some platforms) other signed messages.
- **Tool keys** — _we_ publish a JWKS at `/api/lti/jwks`. We sign the OAuth2
  client-credentials _client assertion_ (used to obtain access tokens for
  NRPS/AGS) with our private key. The platform verifies it against our JWKS.

Tool keypairs are RSA-2048, stored in `lti_tool_keys` (private key encrypted at
rest with `LTI_KEY_ENCRYPTION_SECRET` via AES-GCM). Multiple keys may exist to
support rotation; the newest non-retired key signs, all non-retired public keys
are published so in-flight tokens still verify.

Per-platform OAuth client secrets are not used (LTI 1.3 uses asymmetric JWT
client assertions, `client_assertion_type=...jwt-bearer`), so the only platform
secret we hold is the registration metadata, stored in `lti_platforms`.

### Replay / CSRF protection

- OIDC `state` is a signed, short-lived cookie+param pair.
- `nonce` from the login request must appear in the `id_token` and is single-use
  (`lti_nonces`, unique, TTL-pruned).
- `id_token` standard checks: `iss`, `aud` (our client_id), `exp`/`iat`,
  signature, deployment_id allow-list.

---

## Data model (migration `*_lti_1_3_integration.sql`)

| Table               | Purpose                                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lti_platforms`     | One row per registered LMS platform: `issuer`, `client_id`, `auth_login_url` (OIDC auth endpoint), `token_url`, `jwks_url`, `audience`, optional name/description. Platform-scoped (admin-managed).                                                              |
| `lti_deployments`   | `(platform_id, deployment_id)` — a deployment is an install of our tool in a platform account/course. Optionally bound to a Pawtograder `class_id`.                                                                                                              |
| `lti_tool_keys`     | Our RSA keypairs: `kid`, `public_jwk` (jsonb), `private_key_pem_encrypted`, `alg`, `retired_at`.                                                                                                                                                                 |
| `lti_context_links` | Maps an LTI `context_id` (a course/section in the LMS) + `deployment_id` to a Pawtograder `class_id`. Holds the NRPS `context_memberships_url` and AGS `lineitems` endpoint captured at launch. Enables `roster_sync_enabled` / `grade_sync_enabled` per course. |
| `lti_line_items`    | Maps a Pawtograder `assignment_id` / `gradebook_column_id` ↔ an AGS line item URL on the platform.                                                                                                                                                              |
| `lti_users`         | Maps an LTI `(platform_id, sub)` identity ↔ Pawtograder `user_id`, captured at launch. Used to resolve NRPS members and AGS score `userId`.                                                                                                                     |
| `lti_nonces`        | Single-use nonces for OIDC replay protection (TTL-pruned).                                                                                                                                                                                                       |

New columns:

- `class_sections.lti_context_id` / `lti_line_items` linkage (NRPS section mapping)
- Reuse `gradebook_columns.external_data` with `{ source: "lti", lineItemUrl }`

### Roster mapping note

`sis_sync_enrollment` keys members by integer `sis_user_id` + section CRN. NRPS
gives us a string `user_id` plus, on most platforms, `lis_person_sourcedid`
(institutional SIS id) and `email`. The NRPS sync maps:

1. numeric `lis_person_sourcedid` → `sis_user_id` (preferred), else
2. a stable surrogate integer derived from the LTI `sub` (stored on `lti_users`),
   with email carried for invitation creation.

This keeps the existing atomic enrollment logic unchanged while supporting
platforms that don't expose SIS ids.

---

## Endpoints (`app/api/lti`)

| Route                  | Method   | Purpose                                                                                                                                                     |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/lti/jwks`        | GET      | Publish our tool public JWKS.                                                                                                                               |
| `/api/lti/login`       | GET/POST | OIDC third-party login initiation → redirect to platform `auth_login_url` with `state` + `nonce`.                                                           |
| `/api/lti/launch`      | POST     | Receive `id_token`, validate, resolve context→class, upsert `lti_users`/`lti_context_links`, sign the user into Pawtograder, redirect to course/assignment. |
| `/api/lti/deep-link`   | POST     | Deep Linking response (instructor picks an assignment).                                                                                                     |
| `/api/lti/sync-roster` | POST     | Trigger NRPS roster pull for a class (UI button + cron, shared-secret).                                                                                     |
| `/api/lti/push-grades` | POST     | Trigger AGS line-item + score push for an assignment/class.                                                                                                 |

---

## Configuration (env)

```
LTI_KEY_ENCRYPTION_SECRET   # 32-byte base64, AES-GCM for tool private keys
LTI_TOOL_ISSUER             # our base URL, e.g. https://app.pawtograder.com
LTI_CRON_SHARED_SECRET      # header secret pg_cron uses to call sync endpoints
```

Per-platform metadata (issuer, client_id, endpoints) is **data**, configured by a
platform admin in `/admin/lti-platforms`, not env.

---

## Implementation status

- [x] Data model + RLS + RPCs (migration)
- [x] Protocol core (`lib/lti`)
- [x] HTTP endpoints (`app/api/lti`)
- [x] NRPS roster sync
- [x] AGS assignment + grade push
- [x] Admin + course config UI
- [x] Unit tests

### Follow-ups requiring a real LMS / deployment

- Configure env secrets in the deployment and register Pawtograder in the LMS
  developer key UI (client_id, redirect URIs, JWKS URL, login URL).
- End-to-end verification against a live Canvas/Moodle test instance.
- Decide cutover/removal timeline for `course-import-sis` and
  `enrollments-sync-canvas` once LTI roster sync is validated in production.
