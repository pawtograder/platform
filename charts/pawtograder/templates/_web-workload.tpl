{{/*
Web (Next.js) Service + Deployment, parameterized so the stable channel and any
extra deployment channels (.Values.channels) render from one definition.

Usage:
  {{ include "pawtograder.web.workload" (dict "ctx" . "component" "web" "image" .Values.web.image "replicas" .Values.web.replicas "workflowLeader" .Values.web.workflowMetricsLeader) }}

Args:
  ctx                     root context (.)
  component               component label + name suffix: "web" for stable,
                          "web-<channel>" for a channel, "metrics-leader" for the
                          dedicated workflow-metrics leader
  image                   image dict ({ repository, tag, pullPolicy })
  replicas                replica count
  workflowLeader          bool. Renders METRICS_WORKFLOW_REFRESH_LEADER=true, which
                          makes /api/metrics refresh the DB-backed workflow gauges.
                          Must be true on AT MOST ONE workload in the release.
                          Passed in rather than read from
                          .Values.web.workflowMetricsLeader inside the template, so
                          each call site owns the answer: web.yaml forwards the
                          value, web-channels.yaml hard-codes false (a canary must
                          never become a second leader), web-metrics-leader.yaml
                          hard-codes true. The rendered `#` comment next to the env
                          var is deliberately left at its pre-refactor wording —
                          emitted comments are part of the rendered bytes, and the
                          byte-identity guard rail compares text.
  config                  OPTIONAL per-workload pod-shape overrides (placement,
                          resources, strategy, securityContext, preStop, grace
                          period, extraEnv). Omit to use .Values.web verbatim.
  refreshIntervalSeconds  OPTIONAL. Renders METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS
                          next to the leader flag. Rendered only when the key is
                          PRESENT (kindIs "invalid" test, not `with` — 0 is a
                          meaningful value that disables the app-side throttle):
                          the app already defaults to 300s, so callers that do not
                          pass it (web.yaml, web-channels.yaml) render EXACTLY the
                          bytes they rendered before this arg existed. That is a
                          hard requirement — a diff in those two templates is a full
                          rolling restart of every prod web replica plus the live
                          canary channel on a deploy that was meant to be additive,
                          and charts/pawtograder/tests/render-guardrails.sh asserts
                          byte-identity against every consumer values file.

Everything not overridden via `config` (env, secrets, probes) is shared from
.Values.web — channels differ only by name, labels, image, and replicas. They
target the same Postgres/auth/storage as stable (see chart README: channels share
the data plane; only web + edge-functions code varies).

Deployment-wide identity — .Values.web.service.port, .branding, .apiUrl, .e2e —
is deliberately NOT part of `config`: a second workload of the same app must
serve on the same port, against the same API, under the same brand. Only the
pod's shape is per-workload.
*/}}
{{- define "pawtograder.web.workload" -}}
{{- $ctx := .ctx -}}
{{- $component := .component -}}
{{- $image := .image -}}
{{- $cfg := .config | default $ctx.Values.web -}}
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
      port: {{ $ctx.Values.web.service.port }}
      targetPort: http
  selector:
    {{- include "pawtograder.componentSelectorLabels" (dict "ctx" $ctx "component" $component) | nindent 4 }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  namespace: {{ $ctx.Release.Namespace }}
  labels:
    {{- include "pawtograder.componentLabels" (dict "ctx" $ctx "component" $component) | nindent 4 }}
spec:
  replicas: {{ .replicas }}
  {{- include "pawtograder.deploymentStrategy" (dict "component" $cfg) | nindent 2 }}
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
      {{- include "pawtograder.priorityClassName" (dict "ctx" $ctx "component" $cfg) | nindent 6 }}
      {{- include "pawtograder.podSecurityContext" (dict "ctx" $ctx "component" $cfg) | nindent 6 }}
      terminationGracePeriodSeconds: {{ $cfg.terminationGracePeriodSeconds | default 30 }}
      containers:
        - name: web
          image: {{ include "pawtograder.image" (dict "ctx" $ctx "image" $image) }}
          imagePullPolicy: {{ $image.pullPolicy }}
          {{- include "pawtograder.containerSecurityContext" (dict "ctx" $ctx "component" $cfg) | nindent 10 }}
          {{- include "pawtograder.preStop" (dict "component" $cfg) | nindent 10 }}
          ports:
            - name: http
              containerPort: {{ $ctx.Values.web.service.port }}
          env:
            - name: NODE_ENV
              value: production
            - name: PORT
              value: {{ $ctx.Values.web.service.port | quote }}
            - name: HOSTNAME
              value: "0.0.0.0"
            # Server-only Supabase wiring. NEXT_PUBLIC_* are baked into the
            # client bundle at build time and cannot be overridden here — the
            # image must have been built with build-args matching this chart's
            # hostname/keys. (Channel images bake their own channel host +
            # NEXT_PUBLIC_PAWTOGRADER_CHANNEL; see chart README.)
            - name: SUPABASE_URL
              value: {{ default (include "pawtograder.api.url" $ctx) $ctx.Values.web.apiUrl | quote }}
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
            {{- if $ctx.Values.monitoring.enabled }}
            # Static bearer token gating the app's /api/metrics endpoint.
            # ServiceMonitor injects it as Authorization: Bearer <token>.
            # Marked optional: pre-existing pawtograder-jwt Secrets (from
            # before METRICS_SCRAPE_TOKEN was added to the bundle) may not
            # carry this key. When absent, /api/metrics returns 503 — the
            # /api/metrics route handler also checks for the env var so
            # there's no scrape leak.
            - name: METRICS_SCRAPE_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ $ctx.Values.secrets.names.jwt }}
                  key: METRICS_SCRAPE_TOKEN
                  optional: true
            {{- if .workflowLeader }}
            # Leader-gate for DB-backed workflow gauges. /api/metrics only
            # refreshes the cluster-wide RPCs when this is set; without it
            # the route just exports whatever is currently in the registry.
            #
            # Set on AT MOST ONE web pod across the deploy to avoid
            # multiplying DB load + over-counting gauges. For single-replica
            # installs (previews, small prod) it's safe to enable on the
            # only replica via this chart value. For multi-replica prod,
            # leave this off here and run a dedicated 1-replica metrics
            # leader deployment instead.
            - name: METRICS_WORKFLOW_REFRESH_LEADER
              value: "true"
            {{- if not (kindIs "invalid" .refreshIntervalSeconds) }}
            # Floor on how often refreshWorkflowMetrics() actually hits the
            # DB, independent of scrape frequency. This is the only bound
            # that survives a second Prometheus, a hand-edited ServiceMonitor
            # or an operator running a curl loop against /api/metrics.
            # Omitted => the app's built-in 300s default (lib/metrics.ts).
            - name: METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS
              value: {{ .refreshIntervalSeconds | quote }}
            {{- end }}
            {{- end }}
            {{- end }}
            {{- if $ctx.Values.web.e2e.enabled }}
            # E2E test bypass: utils/csp.ts flips CSP into report-only mode
            # when this is set, which lets Playwright inject the test-runner
            # frames and stubs that production CSP would block. NEVER set
            # this in a real prod install — it weakens browser-level
            # protections that depend on enforce mode.
            - name: E2E_ENABLE
              value: "true"
            {{- end }}
            # Namespaces the shared Next.js cache (cache-handler.cjs) in Redis so
            # staging and PR previews — which share one Redis instance — don't
            # cross-pollinate cache entries or tag-revalidation markers.
            - name: NEXT_CACHE_PREFIX
              value: {{ printf "nextcache:%s" $ctx.Release.Namespace | quote }}
            {{- /*
            Deployment skinning. These are plain (non-NEXT_PUBLIC_) env vars read
            server-side by lib/branding.ts at request time, so the SAME published
            web image can be re-branded per deployment — name, tagline, logos, and
            accent color — without a rebuild. Only render the ones explicitly set
            in values so the app falls back to its built-in Pawtograder defaults.
            */ -}}
            {{- with $ctx.Values.web.branding }}
            {{- if .name }}
            - name: BRAND_NAME
              value: {{ .name | quote }}
            {{- end }}
            {{- if .description }}
            - name: BRAND_DESCRIPTION
              value: {{ .description | quote }}
            {{- end }}
            {{- if .tagline }}
            - name: BRAND_TAGLINE
              value: {{ .tagline | quote }}
            {{- end }}
            {{- if .logoLight }}
            - name: BRAND_LOGO_LIGHT
              value: {{ .logoLight | quote }}
            {{- end }}
            {{- if .logoDark }}
            - name: BRAND_LOGO_DARK
              value: {{ .logoDark | quote }}
            {{- end }}
            {{- if .favicon }}
            - name: BRAND_FAVICON
              value: {{ .favicon | quote }}
            {{- end }}
            {{- if .colorPalette }}
            - name: BRAND_COLOR_PALETTE
              value: {{ .colorPalette | quote }}
            {{- end }}
            {{- if .ssoProviders }}
            {{- /*
            JSON array of sign-in SSO buttons ({provider,label,icon?,scopes?}).
            Each provider must ALSO be enabled in GoTrue (auth.external.* or
            auth.externalProviders). Omitted/empty => app default (the single
            Microsoft/Northeastern button). To render NO SSO buttons, set
            BRAND_SSO_PROVIDERS=[] via web.extraEnv instead.
            */}}
            - name: BRAND_SSO_PROVIDERS
              value: {{ .ssoProviders | toJson | quote }}
            {{- end }}
            {{- end }}
            {{- with $cfg.extraEnv }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          envFrom:
            - secretRef:
                name: {{ $ctx.Values.secrets.names.web }}
                optional: true
            {{- range $ctx.Values.web.envFromSecrets }}
            - secretRef:
                name: {{ . }}
                optional: true
            {{- end }}
            {{- if ne ($ctx.Values.redis.provider | default "external") "external" }}
            # In-cluster Redis URL (REDIS_URL) for the cross-replica Next.js
            # cache handler. provider=shared syncs it via
            # templates/redis-externalsecret.yaml; provider=internal writes it in
            # templates/redis-secret.yaml. REQUIRED, not optional: envFrom is
            # evaluated once at container start, so a pod that booted before the
            # secret existed would run on the per-pod in-memory fallback forever
            # (never picking REDIS_URL up) — silent, permanent loss of the shared
            # cache. Requiring it means a late sync only delays start
            # (CreateContainerConfigError, self-healing once the secret lands),
            # which is the correct loud behavior. Graceful degradation still
            # exists at the connection level (cache-handler.cjs catches Redis
            # outages), so this doesn't reduce runtime resilience.
            - secretRef:
                name: pawtograder-redis
                optional: false
            {{- end }}
          readinessProbe:
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 5
          livenessProbe:
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 60
            periodSeconds: 30
            timeoutSeconds: 10
          resources:
            {{- toYaml $cfg.resources | nindent 12 }}
      {{- with (include "pawtograder.nodeSelector" (dict "ctx" $ctx "component" $cfg)) }}
      nodeSelector:
        {{- . | nindent 8 }}
      {{- end }}
      {{- with (include "pawtograder.tolerations" (dict "ctx" $ctx "component" $cfg)) }}
      tolerations:
        {{- . | nindent 8 }}
      {{- end }}
      {{- include "pawtograder.componentAffinity" (dict "ctx" $ctx "component" $cfg "name" $component) | nindent 6 }}
{{- end -}}
