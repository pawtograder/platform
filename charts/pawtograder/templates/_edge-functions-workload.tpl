{{/*
Edge functions (Deno edge-runtime) Service + Deployment, parameterized so the
stable channel, any extra deployment channels (.Values.channels) and any extra
ISOLATION TIER (.Values.edgeFunctions.workerTier) render from one definition.

Usage:
  {{ include "pawtograder.edgeFunctions.workload" (dict "ctx" . "component" "functions" "image" .Values.edgeFunctions.image "replicas" .Values.edgeFunctions.replicas "autoscaling" .Values.edgeFunctions.autoscaling.enabled) }}

Args:
  ctx          root context (.)
  component    component label + name suffix: "functions" for stable, "functions-<channel>" for a channel, "functions-workers" for the worker tier
  image        image dict ({ repository, tag, pullPolicy })
  replicas     replica count (used when autoscaling is false)
  autoscaling  when true, omit replicas (an HPA owns it — stable only)
  overrides    OPTIONAL dict merged over .Values.edgeFunctions for this workload only
  tier         OPTIONAL values-block name ("workerTier") used in budget-failure messages

Two dimensions, deliberately different:
  * A CHANNEL differs only by name, labels, image and replicas. It serves the
    same function set with the same isolation config, is reached by HOST, and
    passes no `overrides`.
  * A TIER differs by isolation config (policy, maxParallelism, the memory
    budget) and is reached by PATH — Kong routes specific function NAMES to it
    (see templates/kong-config.yaml). It passes `overrides`.

Everything not overridden comes from .Values.edgeFunctions, and every workload
targets the same Postgres/auth/storage.
*/}}
{{/*
Guardrail: the edge-function container memory budget is a SUM, and every
production incident on this tier has come from reconciling fewer than three of
them. 2026-08-11 counted only the isolates (maxParallelism x per-isolate limit)
and OOM-killed 21 of 24 pods. 2026-08-19 counted isolates + host but not the
demuxer's eszip cache, which grows to eszipCacheMaxMb, and OOM-killed pods again.

So the sum is asserted at render time rather than documented and hoped for:

    eszipCacheMaxMb + eszipColdLoadHeadroomMb
      + (maxParallelism x worker.memoryLimitMb) + ~90Mi host
      <= resources.limits.memory

The host term is measured, not guessed: a freshly started pod with an empty
cache sits at ~87Mi.

The cold-load term covers bundle buffers that residentBytes does NOT count: a
bundle being read for a cache miss, and one the LRU evicted or refused while a
worker creation still holds it. main.ts narrows that window to the duration of
create(), but it cannot be zero, and a burst of cold requests for distinct
functions is exactly when it is largest.

maxParallelism is REQUIRED rather than defaulted-to-zero. Left unset the runtime
derives it from CPU count, which cannot be known at render time; treating that as
zero made this assertion accept the very combinations the values documentation
says it rejects, which is worse than not having it.

One deliberate gap remains: a limit that is not an integer number of Gi/Mi is
skipped rather than mis-parsed -- a guardrail that silently computes the wrong
number is worse than one that admits it cannot.
*/}}
{{- define "pawtograder.edgeFunctions.assertMemoryBudget" -}}
{{- $ef := .cfg -}}
{{/* Which values block this failure is about. Every tier renders from one
     definition and each has its OWN budget, so a message that always said
     "edgeFunctions.*" would send a reader to the wrong block -- and the whole
     value of this assertion is that it names the knob to change. */}}
{{- $p := ternary "edgeFunctions" (printf "edgeFunctions.%s" .tier) (empty .tier) -}}
{{- $limit := "" -}}
{{- if $ef.resources -}}
{{- if $ef.resources.limits -}}
{{- $limit = $ef.resources.limits.memory | default "" | toString -}}
{{- end -}}
{{- end -}}
{{- $limitMi := 0 -}}
{{- if hasSuffix "Gi" $limit -}}
{{- $limitMi = mul (trimSuffix "Gi" $limit | int) 1024 -}}
{{- else if hasSuffix "Mi" $limit -}}
{{- $limitMi = trimSuffix "Mi" $limit | int -}}
{{- end -}}
{{- $cacheMi := $ef.eszipCacheMaxMb | int -}}
{{- if le $cacheMi 0 -}}
{{- fail (printf "%s.eszipCacheMaxMb must be a positive number of MiB (got %v). Zero or negative would be counted as-is by this assertion while main.ts substitutes its own 512Mi default, so the process would reserve memory the budget never accounted for." $p $ef.eszipCacheMaxMb) -}}
{{- end -}}
{{/* Every one of these is rendered into the environment AND has a fallback in
     main.ts of the shape `Number(env) || default`. A zero, negative or
     non-numeric value therefore renders as configured, is counted as configured
     (or as nothing) here, and is then silently replaced by the runtime with its
     own default -- so the process runs on a number this assertion never saw.
     worker.memoryLimitMb is the one that breaks the memory budget directly: at
     0 the isolate term vanishes from the sum while eight workers still reserve
     8 x 256Mi. The other four are not budget terms, but the same divergence
     makes them worth rejecting in the same place rather than leaving one
     validated knob beside four unvalidated ones. */}}
{{- range $knob, $value := dict "worker.memoryLimitMb" $ef.worker.memoryLimitMb "worker.timeoutMs" $ef.worker.timeoutMs "worker.cpuSoftMs" $ef.worker.cpuSoftMs "worker.cpuHardMs" $ef.worker.cpuHardMs "worker.lowMemoryMultiplier" $ef.worker.lowMemoryMultiplier -}}
{{- if le ($value | int) 0 -}}
{{- fail (printf "%s.%s must be a positive number (got %v). main.ts falls back to its own default for anything non-positive, so the container would run on a value this budget assertion never counted." $p $knob $value) -}}
{{- end -}}
{{- end -}}
{{- $perIsolateMi := $ef.worker.memoryLimitMb | int -}}
{{- $par := $ef.maxParallelism | toString -}}
{{- if or (eq $par "") (le ($par | int) 0) -}}
{{- fail (printf "%s.maxParallelism must be set to a positive integer (got %q). Left unset the runtime derives it from CPU count, which cannot be known at render time -- so the isolate term of the memory budget could not be checked and this assertion would pass configurations it documents as rejected. Set it explicitly; 8 is the chart default and what production runs." $p $par) -}}
{{- end -}}
{{- $isolatesMi := mul ($par | int) $perIsolateMi -}}
{{/* 600, not 90. The 90 came from "a freshly started pod with an empty cache sits
     at ~87Mi", which is the host cost at t=0 -- but this budget is checked against
     a HARD cgroup limit, so what has to fit is the CONVERGED steady state, not the
     first minute. #949 measured that baseline at ~600Mi and load-independent, and
     the same values.yaml has been carrying both numbers since: ~90Mi here and
     ~600Mi in the HPA-sizing notes.

     Under-counting by ~510Mi is not academic on a tier this size: it is most of
     the worker tier's apparent slack, and this assertion exists precisely because
     twice (2026-08-11, 2026-08-19) a term was left out of the sum and production
     OOMed. Raising it can only make the guard REFUSE more configurations -- it
     cannot permit an OOM -- and every overlay in this repo still renders. */}}
{{- $hostMi := 600 -}}
{{- $coldMi := $ef.eszipColdLoadHeadroomMb | int -}}
{{- if le $coldMi 0 -}}
{{- fail (printf "%s.eszipColdLoadHeadroomMb must be a positive number of MiB (got %v). Same reason as eszipCacheMaxMb: main.ts would substitute its own 256Mi default and the process would reserve memory this assertion did not count." $p $ef.eszipColdLoadHeadroomMb) -}}
{{- end -}}
{{/* The cold-load semaphore charges a bundle's FULL size, so an allowance smaller
     than the largest bundle in the image cannot bound it -- an oversized bundle is
     admitted alone and overshoots by (size - allowance). 64Mi covers the largest
     bundle measured in this image (48.6MiB, autograder-create-submission,
     re-measured 2026-09-01 -- the 58.4MiB this note used to quote predates the
     @sentry/deno pin). If the bundles grow past 64MiB, this minimum and the
     sizing note in values.yaml both need revisiting. */}}
{{- $minColdMi := 64 -}}
{{- if lt $coldMi $minColdMi -}}
{{- fail (printf "%s.eszipColdLoadHeadroomMb is %dMi, below the %dMi needed to cover the largest bundle in the image (48.6MiB measured 2026-09-01). Below that the cold-load semaphore cannot enforce the ceiling this assertion certifies: the read allocates the whole bundle regardless of the allowance." $p $coldMi $minColdMi) -}}
{{- end -}}
{{/* Extra assertions that apply only to a ROUTED tier -- one Kong sends a known,
     fixed set of function names to. The stable tier serves all 58 bundles and has
     no route list, so `functions` is empty there and neither of these fires. */}}
{{- if $ef.functions -}}
{{- $routed := len $ef.functions -}}
{{/* A routed tier exists partly so it never evicts: it serves a handful of
     bundles, all of them hot, so the cache should hold the whole routed set.

     Sized off the MEDIAN bundle (36.1MiB measured 2026-09-01, rounded to 37),
     and this is the opposite of the rule for the stable tier's cache -- worth
     saying why, because the reasoning does not transfer. The stable tier caches
     an UNKNOWN subset of 58 bundles, so a median is not a bound there and
     averaging is how the 2026-08-19 OOM happened. A routed tier's set is KNOWN
     at render time and small, so what matters is its actual total, and charging
     the largest bundle for every member systematically over-requires: the four
     workers measure 90.3MiB together while 4 x the 48.6MiB largest would demand
     196MiB. That is not conservative, it is wrong in a way that forces an
     oversized cache -- and it would reject this chart's own 192Mi default.

     Still a real guard: it refuses a cache that cannot plausibly hold the set
     (128Mi for four bundles), which is the mistake worth catching. It cannot be
     exact, because the chart does not know its image's bundle inventory.

     THE ROUTED LIST IS NOT THE WHOLE HOT SET. `metrics` is hot on every tier and
     appears in no route list: the ServiceMonitor scrapes /metrics on each pod,
     the demuxer resolves that by first path segment like any other request, and
     the `metrics` function's bundle is therefore loaded and kept hot on this tier
     at the scrape interval (30s). Counting only `functions` would accept a cache
     between routed x 37Mi and (routed + 1) x 37Mi that then evicts and reloads a
     bundle every scrape -- passing a guard whose own stated model is "hold every
     hot bundle". So the metrics bundle is counted unconditionally rather than
     gated on monitoring.enabled: it is one 37Mi allowance, this assertion cannot
     see .Values.monitoring from here, and over-counting by one bundle on a tier
     that is not scraped is the harmless direction. */}}
{{- $hot := add1 $routed -}}
{{- $cacheNeed := mul $hot 37 -}}
{{- if lt $cacheMi $cacheNeed -}}
{{- fail (printf "%s.eszipCacheMaxMb is %dMi, below the %dMi needed to hold all %d hot bundles (%d routed + the `metrics` bundle that /metrics scrapes keep hot, x 37Mi median). A routed tier that evicts re-reads a bundle it will need again seconds later, which is the opposite of why the tier exists -- either raise the cache or shorten `functions`." $p $cacheMi $cacheNeed $hot $routed) -}}
{{- end -}}
{{/* Under per_worker an isolate is REUSED across requests, so a routed tier needs
     one resident isolate per routed function -- doubled, because beforeUnload
     recycling holds the retiring and the replacement isolate for the same
     function at the same time. Below that, a poke for one worker queues behind
     another until --request-wait-timeout (which this chart does not set, so the
     runtime default applies).

     This is checkable here and NOT on the stable tier precisely because a routed
     tier's distinct-function count is known at render time. On the stable tier
     the same reasoning would need a bound on "distinct functions served
     concurrently", which is up to 58 and unknowable -- so what
     (maxParallelism x worker.memoryLimitMb) means under per_worker is an open
     question there. See issue #926; measure it on this tier first.

     `metrics` is counted in the CACHE requirement above but deliberately not
     here. The difference is lifetime: its bundle stays resident once scraped, so
     it occupies cache permanently, but its isolate is transient and the x2 for
     recycling already leaves slack for one. Adding it here would instead force
     maxParallelism past the default purely to run the per_worker experiment. */}}
{{- if eq ($ef.policy | toString) "per_worker" -}}
{{- $slotsNeed := mul 2 $routed -}}
{{- if lt ($par | int) $slotsNeed -}}
{{- fail (printf "%s.maxParallelism is %s but this tier routes %d functions under policy per_worker, which needs at least %d admission slots: one resident isolate per routed function, doubled because beforeUnload recycling holds the retiring and the replacement isolate at once. Raise maxParallelism (and re-check the memory budget, which counts it) or shorten `functions`." $p $par $routed $slotsNeed) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $needMi := add $cacheMi $coldMi $isolatesMi $hostMi -}}
{{- if and (gt $limitMi 0) (gt $needMi $limitMi) -}}
{{- fail (printf "%s memory budget does not fit inside resources.limits.memory (%s = %dMi): eszipCacheMaxMb %dMi + eszipColdLoadHeadroomMb %dMi + isolates %dMi (maxParallelism %s x worker.memoryLimitMb %dMi) + ~%dMi Deno host = %dMi. Raise the limit, or lower eszipCacheMaxMb / maxParallelism. This exact sum is what OOM-killed production on 2026-08-11 and again on 2026-08-19; see the notes above these values." $p $limit $limitMi $cacheMi $coldMi $isolatesMi (or $par "unset") $perIsolateMi $hostMi $needMi) -}}
{{- end -}}
{{- end -}}

{{/*
Validate a tier's override keys against an ALLOWLIST.

This exists because of one specific Sprig behaviour: `mergeOverwrite` is mergo
with `WithOverride`, and mergo SKIPS EMPTY SOURCE VALUES -- `false`, `0`, `""`,
`{}`, `[]`. So an override of `verifyJwt: false` against a base of `true`, or
`envFromSecrets: []` against a non-empty base, renders as the BASE value with no
error at all. A silently-ignored override on this tier is exactly the class of
bug the memory-budget assertion exists to prevent: the config a reviewer reads
is not the config the container runs.

So every key that CANNOT merge correctly is kept out of the surface entirely,
and anything unrecognised is refused rather than ignored. That also turns a typo
(`polciy: oneshot`) into a render error instead of a no-op.

Allowed keys are maps (merge key-by-key), non-empty lists (replaced wholesale,
matching channels[].image semantics), strings, or positive numbers that
assertMemoryBudget already rejects at <= 0.

`enabled`, `replicas` and `functions` are allowed through but are read from the
RAW tier block by the caller, never from the merged result -- they are the keys
that need `false`/`0`/absent to mean something.

The chart already works around this family of footgun elsewhere:
edge-functions-channels.yaml uses hasKey+ternary rather than `default 1` so
`replicas: 0` works, and _helpers.tpl uses `dig` rather than `default`.
*/}}
{{/*
Refuse an empty value ANYWHERE inside a tier override, not just at the top level.

mergeOverwrite skips empty source values at every depth, so a non-empty map with
an empty child is the same silent-inherit bug wearing a disguise:
`resources: {limits: {memory: ""}}` merges the map, drops the empty leaf, and the
tier runs the BASE's limit while the values file says otherwise. A top-level-only
check passes that, which is why this recurses.

Recursion is by self-include, which Helm supports. Lists are treated as leaves:
an empty list is refused, but elements are not descended into -- our allowlisted
lists (envFromSecrets, tolerations) hold scalars, and an empty element there is
not a merge hazard.
*/}}
{{- define "pawtograder.edgeFunctions.assertNoEmptyLeaves" -}}
{{- $path := .path -}}
{{/* `empty` FIRST, then recurse. The other order is a real bug and I shipped it
     briefly: an empty map IS empty, but `kindIs "map"` is also true for it, so
     testing map-ness first sends `nodeSelector: {}` into a loop over zero keys
     and it passes -- silently inheriting, which is the exact thing being
     guarded. Caught by the empty-map guardrail. */}}
{{- if empty .value -}}
{{- fail (printf "%s is empty (%v). Sprig's mergeOverwrite (mergo) SKIPS empty source values at every depth, so this would silently render the value from edgeFunctions instead of the empty one you asked for -- the tier would keep the base's setting while the values file said otherwise. Remove the key to inherit deliberately, or set a non-empty value. (enabled/replicas/functions are exempt: they are read from the raw tier block, so false and 0 work there.)" $path .value) -}}
{{- else if kindIs "map" .value -}}
{{- range $k, $v := .value -}}
{{- include "pawtograder.edgeFunctions.assertNoEmptyLeaves" (dict "value" $v "path" (printf "%s.%s" $path $k)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "pawtograder.edgeFunctions.assertTierOverrides" -}}
{{- $tier := .tier -}}
{{/* `spreadAcrossNodes` was here and is deliberately NOT: it is a boolean, and
     the whole point of this allowlist is that mergeOverwrite cannot carry a
     `false`. Allowing it meant `workerTier.spreadAcrossNodes: false` against a
     base of `true` silently left the anti-affinity in place -- accepting a
     setting and then ignoring it, which is the exact failure this list exists to
     prevent. It is shared from edgeFunctions; a tier that genuinely needs
     different placement has `nodeSelector`, `tolerations` and `affinity`. */}}
{{- $allowed := list
      "enabled" "replicas" "functions"
      "policy" "maxParallelism" "beforeUnload" "worker"
      "eszipCacheMaxMb" "eszipColdLoadHeadroomMb" "resources"
      "envFromSecrets" "gracefulExitTimeoutSeconds" "preStopSleepSeconds"
      "terminationGracePeriodSeconds" "nodeSelector" "tolerations" "affinity"
      "priorityClassName" "updateStrategy" -}}
{{/* An EMPTY allowlisted value is the same bug as a disallowed key, just harder
     to see: mergeOverwrite skips empty source values, so `envFromSecrets: []`,
     `tolerations: []`, `nodeSelector: {}` or `priorityClassName: ""` on a tier
     render as the BASE's value with no error at all. An operator clearing the
     integration secrets off the worker tier would get every one of them anyway.
     Refuse it, because "you cannot express that here" is a far better outcome
     than silently running the opposite configuration.

     `enabled`, `replicas` and `functions` are exempt: callers read those from
     the RAW tier block (hasKey/ternary), so `false` and `0` do reach the render
     -- which is exactly why they are handled outside the merge. */}}
{{- range $k, $v := .overrides -}}
{{- if not (has $k $allowed) -}}
{{- fail (printf "edgeFunctions.%s: %q is not an overridable per-tier key. Allowed: %s. The surface is an allowlist because Sprig's mergeOverwrite (mergo) SKIPS EMPTY source values -- a false, a 0 or an empty list here would render as the base's value with no error, so an unlisted key is far more likely to be silently ignored than honoured. Booleans that must stay shared across tiers (verifyJwt, reloader, e2e, email) are excluded for exactly that reason; set them on edgeFunctions instead." $tier $k (join ", " (sortAlpha $allowed))) -}}
{{- end -}}
{{- if not (has $k (list "enabled" "replicas" "functions")) -}}
{{- include "pawtograder.edgeFunctions.assertNoEmptyLeaves" (dict "value" $v "path" (printf "edgeFunctions.%s.%s" $tier $k)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "pawtograder.edgeFunctions.workload" -}}
{{- $ctx := .ctx -}}
{{/* Effective config for THIS workload: .Values.edgeFunctions, optionally with a
     tier's overrides merged over it. Every knob below reads $ef rather than
     .Values.edgeFunctions directly, which is what lets two workloads run
     different policies and different memory budgets from one definition.

     deepCopy on both sides is required, not defensive: mergeOverwrite MUTATES
     its destination and aliases sub-maps out of src, so without it a second
     tier rendered in the same pass would see the first tier's `worker` block --
     and .Values itself would be corrupted for every template after this one.

     `workerTier` is unset from the result so a tier can never carry a tier of
     its own. Nothing reads that key off $ef, so removing it changes no output.

     MERGE SEMANTICS, stated because one of them is a trap: mergeOverwrite is
     mergo with WithOverride, and mergo SKIPS EMPTY SOURCE VALUES -- false, 0,
     "", {} and []. So an override of `verifyJwt: false` against a base of true
     is SILENTLY IGNORED. That is why the override surface is an allowlist
     (assertTierOverrides below) that excludes every boolean, and why `enabled`,
     `replicas` and `autoscaling` are read from the RAW tier block by callers
     instead of from this merged result. Helm's own values coalescing across -f
     files handles false correctly; only this template-level merge does not. */}}
{{- $ef := deepCopy $ctx.Values.edgeFunctions -}}
{{- $_ := unset $ef "workerTier" -}}
{{- with .overrides -}}
{{- $ef = mergeOverwrite $ef (deepCopy .) -}}
{{- end -}}
{{- include "pawtograder.edgeFunctions.assertMemoryBudget" (dict "cfg" $ef "tier" (.tier | default "")) -}}
{{- $component := .component -}}
{{- $image := .image -}}
{{- $name := include "pawtograder.componentName" (dict "ctx" $ctx "component" $component) -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  namespace: {{ $ctx.Release.Namespace }}
  labels:
    {{- include "pawtograder.componentLabels" (dict "ctx" $ctx "component" $component) | nindent 4 }}
spec:
  type: ClusterIP
  ports:
    - name: http
      port: {{ $ef.service.port }}
      targetPort: http
  selector:
    {{- include "pawtograder.componentSelectorLabels" (dict "ctx" $ctx "component" $component) | nindent 4 }}
---
# The functions image is built upstream from this chart by the pawtograder
# release pipeline: it copies supabase/functions/ on top of supabase/edge-runtime
# and pins a deno cache. We just point edge-runtime at /home/deno/functions.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  namespace: {{ $ctx.Release.Namespace }}
  labels:
    {{- include "pawtograder.componentLabels" (dict "ctx" $ctx "component" $component) | nindent 4 }}
  {{- if $ef.reloader.enabled }}
  annotations:
    # Stakater Reloader: roll this Deployment when a referenced Secret changes.
    # The edge-functions env (incl. GITHUB_PRIVATE_KEY_STRING) comes from a
    # SealedSecret applied OUTSIDE helm, so a rotation does NOT change the pod
    # template — without this annotation the pods keep the stale value until a
    # manual `kubectl rollout restart`. Requires the Reloader controller to be
    # installed cluster-wide; harmless (ignored) if it is not.
    reloader.stakater.com/auto: "true"
  {{- end }}
spec:
  {{- if not .autoscaling }}
  replicas: {{ .replicas }}
  {{- end }}
  {{- include "pawtograder.deploymentStrategy" (dict "component" $ef) | nindent 2 }}
  selector:
    matchLabels:
      {{- include "pawtograder.componentSelectorLabels" (dict "ctx" $ctx "component" $component) | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "pawtograder.componentLabels" (dict "ctx" $ctx "component" $component) | nindent 8 }}
    spec:
      serviceAccountName: {{ include "pawtograder.serviceAccountName" $ctx }}
      {{- include "pawtograder.imagePullSecrets" $ctx | nindent 6 }}
      {{- include "pawtograder.priorityClassName" (dict "ctx" $ctx "component" $ef) | nindent 6 }}
      {{- include "pawtograder.podSecurityContext" (dict "ctx" $ctx "component" $ef) | nindent 6 }}
      terminationGracePeriodSeconds: {{ $ef.terminationGracePeriodSeconds | default 30 }}
      containers:
        - name: functions
          image: {{ include "pawtograder.image" (dict "ctx" $ctx "image" $image) }}
          imagePullPolicy: {{ $image.pullPolicy }}
          {{- include "pawtograder.containerSecurityContext" (dict "ctx" $ctx "component" $ef) | nindent 10 }}
          {{- include "pawtograder.preStop" (dict "component" $ef) | nindent 10 }}
          ports:
            - name: http
              containerPort: {{ $ef.service.port }}
          command: ["edge-runtime"]
          # NOTE: --no-verify-jwt isn't supported by edge-runtime (as of v1.74.0);
          # JWT verification (or lack thereof) is handled inside main.ts.
          args:
            - start
            - --main-service
            - /home/deno/functions/main
            - -p
            - "{{ $ef.service.port }}"
            - --policy
            - {{ $ef.policy | quote }}
            {{- with $ef.gracefulExitTimeoutSeconds }}
            # On SIGTERM (scale-down / rolling deploy / node drain) edge-runtime
            # stops new intake and lets in-flight handlers finish for up to this
            # many seconds before forcibly terminating, then exits (immediately if
            # idle). Sized >= worker.timeoutMs so the longest request can complete;
            # terminationGracePeriodSeconds is the SIGKILL backstop above it.
            - --graceful-exit-timeout
            - {{ . | quote }}
            {{- end }}
            {{- if $ef.maxParallelism }}
            # Cap on simultaneous isolates; under per_request this bounds max
            # concurrent requests/pod (excess queue via --request-wait-timeout).
            - --max-parallelism
            - {{ $ef.maxParallelism | quote }}
            {{- end }}
            {{- with $ef.beforeUnload }}
            # EarlyDrop: retire+recycle a per_worker isolate at this % of a
            # resource limit so memory is reclaimed before the hard cap (default
            # 90% is too late under bursty load). ~50% mirrors supabase.com.
            - --dispatch-beforeunload-memory-ratio
            - {{ .memoryRatio | quote }}
            - --dispatch-beforeunload-cpu-ratio
            - {{ .cpuRatio | quote }}
            - --dispatch-beforeunload-wall-clock-ratio
            - {{ .wallClockRatio | quote }}
            {{- end }}
          env:
            - name: SUPABASE_URL
              value: "http://{{ include "pawtograder.kong.host" $ctx }}:{{ $ctx.Values.kong.service.port }}"
            # Public-facing origin for storage signed URLs that are consumed
            # OUTSIDE the cluster (e.g. grader tarballs handed to the GitHub
            # Actions runner). SUPABASE_URL points at the in-cluster Kong
            # service, which external consumers can't resolve; GitHubWrapper's
            # toPublicSupabaseUrl() rebases signed URLs onto this origin.
            - name: SUPABASE_PUBLIC_URL
              value: {{ include "pawtograder.api.url" $ctx | quote }}
            - name: SUPABASE_ANON_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ $ctx.Values.secrets.names.jwt }}
                  key: ANON_KEY
            - name: SUPABASE_SERVICE_ROLE_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ $ctx.Values.secrets.names.jwt }}
                  key: SERVICE_ROLE_KEY
            # POSTGRES_PASSWORD MUST come before SUPABASE_DB_URL so the
            # `$(POSTGRES_PASSWORD)` reference below substitutes — k8s only
            # interpolates env vars defined earlier in the same container.
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ $ctx.Values.secrets.names.postgres }}
                  key: POSTGRES_PASSWORD
            - name: SUPABASE_DB_URL
              value: "postgres://postgres:$(POSTGRES_PASSWORD)@{{ include "pawtograder.postgres.host" $ctx }}:{{ $ctx.Values.postgres.service.port }}/{{ $ctx.Values.postgres.database }}"
            - name: VERIFY_JWT
              value: {{ $ef.verifyJwt | quote }}
            # Per-isolate worker limits read by the main.ts demuxer.
            - name: EDGE_WORKER_MEMORY_LIMIT_MB
              value: {{ $ef.worker.memoryLimitMb | quote }}
            - name: EDGE_WORKER_TIMEOUT_MS
              value: {{ $ef.worker.timeoutMs | quote }}
            - name: EDGE_WORKER_CPU_SOFT_MS
              value: {{ $ef.worker.cpuSoftMs | quote }}
            - name: EDGE_WORKER_CPU_HARD_MS
              value: {{ $ef.worker.cpuHardMs | quote }}
            - name: EDGE_WORKER_LOW_MEMORY_MULTIPLIER
              value: {{ $ef.worker.lowMemoryMultiplier | quote }}
            # Byte budget for the demuxer's resident eszip cache. This is the
            # THIRD term in the container's memory budget, alongside
            # maxParallelism x worker.memoryLimitMb — see values.yaml.
            - name: EDGE_ESZIP_CACHE_MAX_BYTES
              value: {{ mul $ef.eszipCacheMaxMb 1048576 | quote }}
            # Enforced at runtime by main.ts, not just budgeted here: a semaphore
            # holds these bytes from before a cold read until create() returns.
            - name: EDGE_ESZIP_COLD_LOAD_MAX_BYTES
              value: {{ mul $ef.eszipColdLoadHeadroomMb 1048576 | quote }}
            # JWT_SECRET here is NOT the deployment's HS256 shared secret. The
            # only consumer inside the edge runtime is _shared/MCPAuth.ts, which
            # mints short-lived per-user RLS JWTs for MCP and the CLI — with
            # ES256, so it needs the EC *private JWK* (a JSON object), not the
            # base64 random string GoTrue/PostgREST/Realtime/Kong share. Feeding
            # it the shared secret is why MCP and the CLI have never worked on
            # any self-hosted install: MCPAuth rejects it at
            # `secret.startsWith("{")`.
            #
            # JWT_SIGNING_JWK holds the `pawtograder-session-v1` EC entry from
            # JWT_PRIVATE_JWKS alone. Its public half is already in
            # JWT_PUBLIC_JWKS, which PostgREST verifies against (rest.yaml), so
            # tokens minted with it validate without any further wiring.
            #
            # optional: true is deliberate. Externally-managed Secrets
            # (ESO/OpenBao/SealedSecrets) need this key added by hand, and a
            # missing *required* secretKeyRef crash-loops the entire edge tier.
            # Optional degrades to exactly the pre-existing behavior instead:
            # every function keeps working and only MCP/CLI fail, with
            # MCPAuth's "JWT_SECRET must be set" pointing at the cause.
            # Nothing else in this container reads JWT_SECRET and
            # edgeFunctions.verifyJwt is false, so repointing it is safe.
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: {{ $ctx.Values.secrets.names.jwt }}
                  key: JWT_SIGNING_JWK
                  optional: true
            # Sentry identity, consumed by supabase/functions/_shared/SentryContext.ts. ENVIRONMENT was
            # previously unset for edge functions, so Sentry labelled their events by whatever each
            # Sentry.init happened to pass — the same deploy reported some events as "development" and
            # others as "production". Bind it to the one value the chart already validates against.
            - name: ENVIRONMENT
              value: {{ $ctx.Values.global.environment | quote }}
            - name: DEPLOY_KIND
              value: {{ $ctx.Values.global.environment | quote }}
            # The image tag is the closest thing to a build identity the chart knows (previews use
            # pr-<n>-<short_sha>), so it doubles as the Sentry release when nothing more precise is set.
            #
            # $image.tag, NOT $ef.image.tag: $image is the tag this workload actually RUNS, after a
            # channel's `mergeOverwrite` (edge-functions-channels.yaml). Reading it off the values
            # block instead reported the STABLE tag as a canary channel's Sentry release, i.e. the
            # one field whose whole job is to say which build an error came from named the wrong
            # build. The container image on line ~199 has always used $image; only this disagreed.
            {{- with $image.tag }}
            - name: RELEASE_VERSION
              value: {{ . | quote }}
            {{- end }}
            {{- with $ctx.Values.global.deploy.branch }}
            - name: DEPLOY_BRANCH
              value: {{ . | quote }}
            {{- end }}
            {{- with $ctx.Values.global.deploy.pr }}
            - name: DEPLOY_PR
              value: {{ . | quote }}
            {{- end }}
            {{- with $ctx.Values.global.deploy.runId }}
            - name: DEPLOY_RUN_ID
              value: {{ . | quote }}
            {{- end }}
            {{- with $ctx.Values.global.deploy.runAttempt }}
            - name: DEPLOY_RUN_ATTEMPT
              value: {{ . | quote }}
            {{- end }}
            {{- with $ctx.Values.global.deploy.commit }}
            - name: GIT_COMMIT_SHA
              value: {{ . | quote }}
            {{- end }}
            {{- $emailEnabled := $ef.email.enabled }}
            {{- if or (kindIs "bool" $emailEnabled) $emailEnabled }}
            # Explicit switch for notification email, consumed by
            # supabase/functions/_shared/emailTransportConfig.ts. Leave unset to infer from
            # SMTP_HOST (the historical behavior). Set "true" wherever email is meant to work: the
            # processor then REFUSES loudly if SMTP config is missing, rather than treating an
            # unconfigured mailer as an empty queue and deferring the backlog forever.
            #
            # `kindIs "bool"` first, NOT a bare `with`/`if`: Go templates treat the boolean false as
            # empty, so `enabled: false` -- the natural reading of a key named `enabled` -- would
            # skip this block entirely and never render EMAIL_ENABLED. The runtime would then fall
            # back to inferring from SMTP_HOST, which the SMTP Secret now supplies, and the
            # deployment would send mail from an environment the operator had just switched off.
            - name: EMAIL_ENABLED
              value: {{ $emailEnabled | toString | quote }}
            {{- end }}
            {{- if $ef.e2e.enabled }}
            - name: E2E_ENABLE
              value: "true"
            {{- end }}
            {{- if $ef.e2e.mockGitHub }}
            - name: E2E_MOCK_GITHUB
              value: "true"
            {{- end }}
          envFrom:
            - secretRef:
                name: {{ $ctx.Values.secrets.names.edgeFunctions }}
                optional: true
            {{- if $ef.envFromSecrets }}
            # These are always optional: true, deliberately and permanently. envFrom is one-shot
            # and all-or-nothing: if any named Secret is absent when the pod starts, the kubelet
            # fails the container with CreateContainerConfigError and never retries the lookup on
            # its own, so the ENTIRE edge tier — grading included — stays down until an operator
            # notices. A list like this one inevitably names Secrets that are not guaranteed to
            # exist in every environment (per-tier integrations, an ESO sync that lags a fresh
            # install), and one absent Secret must not take the tier offline.
            #
            # The trade-off is real: a pod that boots before a Secret has synced runs WITHOUT
            # those variables for its whole life, with nothing to re-read them later. That is how
            # notification email went dark and stayed dark. Detect that case instead of trying to
            # prevent it here — edgeFunctions.email.enabled makes missing SMTP config a loud
            # runtime failure, and Reloader (edgeFunctions.reloader) rolls the Deployment when a
            # referenced Secret changes. Secrets that genuinely must gate startup get their own
            # explicit `optional: false` secretRef (see pawtograder-redis below), not a
            # chart-wide switch over a list of unrelated names.
            {{- end }}
            {{- range $ef.envFromSecrets }}
            - secretRef:
                name: {{ . }}
                optional: true
            {{- end }}
            {{- if ne ($ctx.Values.redis.provider | default "external") "external" }}
            # In-cluster Redis URL (REDIS_URL): for provider=shared it's synced
            # from a secret store by templates/redis-externalsecret.yaml; for
            # provider=internal it's written by templates/redis-secret.yaml
            # alongside the chart's own Redis. The Redis.ts factory picks the
            # ioredis branch when REDIS_URL is present (preferred over any
            # UPSTASH_* in pawtograder-edge-functions). REQUIRED, not optional:
            # envFrom is one-shot, so a pod booted before the secret synced would
            # run WITHOUT REDIS_URL forever and silently fall back to per-isolate
            # Bottleneck limiters — the exact cross-replica rate-limiter
            # coordination loss this wiring exists to prevent. A late sync only
            # delays start (self-healing), which is preferable to silent
            # degradation across the whole edge gateway.
            - secretRef:
                name: pawtograder-redis
                optional: false
            {{- end }}
          readinessProbe:
            tcpSocket:
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
          livenessProbe:
            tcpSocket:
              port: http
            initialDelaySeconds: 30
            periodSeconds: 30
            failureThreshold: 4
          resources:
            {{- toYaml $ef.resources | nindent 12 }}
      {{- with (include "pawtograder.nodeSelector" (dict "ctx" $ctx "component" $ef)) }}
      nodeSelector:
        {{- . | nindent 8 }}
      {{- end }}
      {{- with (include "pawtograder.tolerations" (dict "ctx" $ctx "component" $ef)) }}
      tolerations:
        {{- . | nindent 8 }}
      {{- end }}
      {{- include "pawtograder.componentAffinity" (dict "ctx" $ctx "component" $ef "name" $component) | nindent 6 }}
{{- end -}}
