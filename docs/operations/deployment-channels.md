# Deployment Channels (A/B by course)

Deployment channels let a **subset of courses** run a _different build_ of the
web app and edge functions against the **same** database as everyone else.
A course is pinned to a channel (a named build: `stable`, `canary`, or `team7`).
Its users are routed to that channel's host, while every other
course stays on stable.

This is distinct from **PR previews**: a preview is a full, isolated stack with
its **own** database (`pawtograder-preview-pr-*`). A channel shares the live
data plane. It only swaps the _code_ (web + edge-functions images) for the
courses that opt in. That makes it the mechanism for staged rollouts and for the
"dogfooding" case where a cohort develops Pawtograder while using it.

---

## Architecture

The stack splits into a shared **data plane** and a per-channel **code plane**:

| Layer                                                       | Stable                                               | Channel `<name>`                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| Postgres, GoTrue (auth), PostgREST, Realtime, Storage, Kong | shared, one set                                      | shared, same set                                                   |
| Web (Next.js)                                               | `pawtograder-web`                                    | `pawtograder-web-<name>`                                           |
| Edge functions (Deno)                                       | `pawtograder-functions`                              | `pawtograder-functions-<name>`                                     |
| Host                                                        | `<global.hostname>` (e.g. `staging.pawtograder.net`) | `<name>.<global.hostname>` (e.g. `canary.staging.pawtograder.net`) |

- Each channel is served on its **own single-label host** (`<name>.<hostname>`)
  with **path-based API** on that same host, so a single `*.<zone>` wildcard TLS
  cert covers every channel (a wildcard spans only one label, so `api.<name>.<zone>`
  would not be covered, hence path-based).
- **Kong** routes each channel host's `/functions/v1` to that channel's functions
  by `Host` header (`functions-v1-<name>` route). `/auth`, `/rest`, `/realtime`,
  `/storage` carry no host match and stay shared across all hosts.
- The **stable web middleware** (`utils/supabase/middleware.ts` +
  `utils/channels.ts`) reads the requested course's `classes.deployment_channel`
  and 307-redirects `/course/<id>` to the course's channel host. The auth cookie
  is scoped to the parent zone (`.<hostname>`) so the session is shared across
  hosts.

Chart templates: `charts/pawtograder/templates/{web-channels.yaml,
edge-functions-channels.yaml,ingress-channels.yaml,kong-config.yaml}` and the
shared workload partials `_web-workload.tpl` / `_edge-functions-workload.tpl`.

---

## Prerequisites (one-time per environment)

1. **`CHANNEL_HOST_SUFFIX` GitHub Actions repo variable**: set to the zone
   (e.g. `staging.pawtograder.net`). This is the master switch: it is baked into
   the **stable** image at build time as `NEXT_PUBLIC_CHANNEL_HOST_SUFFIX`, which
   turns on the middleware redirect + the cross-host cookie scope. Empty (unset)
   = channel routing disabled; stable behaves exactly as before.

   > ⚠️ `NEXT_PUBLIC_*` values are **inlined at build time** by Next.js. Setting
   > the repo variable only takes effect on the **next stable image build**. A
   > pod env override does nothing. To enable/disable routing you must rebuild
   > and redeploy stable (a normal push to `staging` does this automatically).

2. **Wildcard DNS + TLS** for the zone:
   - DNS `*.<zone>` points at the cluster ingress LB (e.g. `*.staging.pawtograder.net`).
   - A cert-manager `Certificate` for `*.<zone>` (DNS-01). On staging this is the
     `staging-wildcard` Certificate in namespace `pawtograder-staging`, producing
     the secret `staging-wildcard-tls`. Referenced by the chart as
     `channelWildcardTlsSecret`.

---

## Configuring channels (Helm values)

Channels are declared in the environment's values file (e.g.
`charts/pawtograder/examples/values-staging.yaml`). They are **not** set via a
one-off `helm --set`. The staging auto-deploy renders from the values file and
would drop anything not committed there.

```yaml
channels:
  - name: canary
    web:
      image:
        tag: canary-055b7e2 # REQUIRED: a channel must have its own tag
      replicas: 1
    edgeFunctions:
      image:
        tag: canary-055b7e2 # REQUIRED
      replicas: 1
    # tls:
    #   secretName: canary-own-tls   # optional: a dedicated per-channel cert instead of the *.<zone> wildcard

channelWildcardTlsSecret: staging-wildcard-tls
```

Notes:

- `web.image.tag` **and** `edgeFunctions.image.tag` are required per channel. The
  chart fails render otherwise (a channel without its own tag would silently run
  the stable image). Repository/pullPolicy default from `web.image` /
  `edgeFunctions.image`.
- An `edgeFunctions` block requires a `web` block (the web block owns the host's
  Ingress; functions are only reachable through it).
- **Pin to a known-good tag, not `<name>-latest`.** The staging auto-deploy runs
  `helm upgrade --wait`, which blocks on the channel's pods too. A broken
  channel image would turn an _ordinary_ stable deploy red.
- A channel's host is always `<name>.<global.hostname>`. The chart computes it
  and offers no per-channel host override. The `*.<zone>` wildcard covers every
  such single-label host. Set `channels[].tls.secretName` only to serve a channel
  from a dedicated per-channel certificate instead of the wildcard.

---

## Building a channel image

Channel images are built by `.github/workflows/release-images.yml` via
`workflow_dispatch`, from the branch holding the channel's code:

```bash
gh workflow run release-images.yml --ref <branch> -f channel=<name>
```

- Tags the image `<name>-<sha>` and `<name>-latest` (channel-named, not
  branch-named), baking `NEXT_PUBLIC_PAWTOGRADER_CHANNEL=<name>` and the channel
  routing config into the bundle.
- A cold `next build` runs ~18–20 min (differing `NEXT_PUBLIC_*` values bust the
  build cache).

---

## Pinning a course to a channel

`classes.deployment_channel` (text, default `stable`; DNS-1123-label CHECK
constraint) decides a course's channel. There is no UI yet, so set it via Studio
or SQL:

```sql
update public.classes set deployment_channel = 'canary' where id = <course_id>;
-- revert:
update public.classes set deployment_channel = 'stable' where id = <course_id>;
```

The redirect only fires for a user **enrolled** in the course: the middleware
reads `deployment_channel` through RLS _as that user_, so a non-member reads
`null`, treated as `stable`, so no redirect.

---

## Request lifecycle (how a redirect happens)

1. Enrolled user, signed in on stable, opens `GET /course/<id>`.
2. Stable middleware (gated on `NEXT_PUBLIC_CHANNEL_HOST_SUFFIX` being set) reads
   the course's `deployment_channel`.
3. If it differs from the build's own channel, it 307-redirects to
   `https://<channel>.<zone>/course/<id>...` (only GET navigations, since a redirect
   would replay a Server Action POST to the wrong origin).
4. On the channel host, the build's own channel matches, so it serves. The auth
   cookie (`Domain=.<zone>`) is readable on both hosts, so the session carries.
5. On a transient DB read error the middleware **fails closed** (stays put, logs
   to Sentry) rather than bouncing the user to the wrong host.

---

## Runbooks

### Enable channels on an environment (first time)

1. Set the `CHANNEL_HOST_SUFFIX` repo variable to the zone.
2. Ensure `*.<zone>` DNS + a `*.<zone>` cert-manager Certificate exist; note the
   secret name.
3. Add a channel + `channelWildcardTlsSecret` to the env values file (below) and
   merge to `staging`. The push rebuilds stable **with the suffix baked** and
   auto-deploys with the channel present.

> The stable rebuild changes the auth-cookie domain to `.<zone>`, so existing
> sessions must log in again once.

### Add a new channel

1. Build its image: `gh workflow run release-images.yml --ref <branch> -f channel=<name>`.
2. Add a `channels[]` entry pinned to the new `<name>-<sha>` tag; merge to `staging`.
3. Pin courses to it via SQL.

### Roll a channel forward

1. Rebuild from the updated branch (same `workflow_dispatch`).
2. Bump the pinned `web`/`edgeFunctions` `image.tag` in the values file, then merge.

### Remove a channel

1. Delete the `channels[]` entry (and reset any pinned courses' `deployment_channel`
   back to `stable`); merge. The channel's Deployments/Service/Ingress/Kong route
   are removed on the next deploy.

---

## Troubleshooting

**A pinned course doesn't redirect.**

- Is the stable image built _after_ `CHANNEL_HOST_SUFFIX` was set? Routing is
  build-time. The current stable image must have the suffix baked. Check the
  deployed `pawtograder-web` image tag corresponds to a post-variable build.
- Is the user **enrolled** in the course? (RLS, see above.)
- Is `deployment_channel` actually set on that course row?

**Session drops when crossing between hosts (e.g., canary-to-stable logout).**

- Almost always a **stale host-only** `sb-<ref>-auth-token` cookie from a login made
  _before_ the suffix was baked (host-only), conflicting with the newer
  `.<zone>` domain-scoped cookie after a token rotation on the other host.
- Fix: fully clear cookies for the zone and all channel subdomains, then log in
  fresh. Only affects sessions predating the suffix flip. Genuinely new sessions
  are unaffected.

**`deploy-staging` stuck / builds "killed" with empty logs.**

- The self-hosted `pawtograder-ci` ARC runners' `dind` init container can
  crash-loop (`docker info` startup probe, 1 s timeout, flaps cluster-wide under
  load), leaving jobs queued or failing with no step-level error. This is runner
  infra, not the chart. Check `kubectl -n arc-runners-pawtograder get pods` for
  `Init:*` with high restart counts.

---

## Known limitations

- **Edge-functions A/B is not yet exercised end-to-end.** A channel image built
  with `workflow_dispatch -f channel=<name>` (no `api_hostname`) bakes
  `NEXT_PUBLIC_SUPABASE_URL=https://api.<zone>`, the _stable_ API host, so the
  channel web's function calls hit **stable** functions; `functions-<name>` runs
  but receives no traffic (Kong only host-routes `<name>.<zone>/functions/v1` to
  `functions-<name>`). For true functions-level A/B, the channel build must bake
  its **own** host as `SUPABASE_URL` (or the web must call the API same-origin).
- **Deploy coupling:** because the staging auto-deploy `--wait`s on channel pods,
  a broken channel image can fail an otherwise-fine stable deploy. Mitigated by
  pinning known-good channel tags.
- **Session granularity:** routing is per-course via redirect, but the shared
  auth cookie spans the whole zone. A user in both stable and channel courses
  moves between hosts as they navigate; this is expected.
