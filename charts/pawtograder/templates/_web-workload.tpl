{{/*
Web (Next.js) Service + Deployment, parameterized so the stable channel and any
extra deployment channels (.Values.channels) render from one definition.

Usage:
  {{ include "pawtograder.web.workload" (dict "ctx" . "component" "web" "image" .Values.web.image "replicas" .Values.web.replicas) }}

Args:
  ctx        root context (.)
  component  component label + name suffix: "web" for stable, "web-<channel>" for a channel
  image      image dict ({ repository, tag, pullPolicy })
  replicas   replica count

All other config (env, secrets, probes, resources, placement) is shared from
.Values.web — channels differ only by name, labels, image, and replicas. They
target the same Postgres/auth/storage as stable (see chart README: channels share
the data plane; only web + edge-functions code varies).
*/}}
{{- define "pawtograder.web.workload" -}}
{{- $ctx := .ctx -}}
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
      containers:
        - name: web
          image: {{ include "pawtograder.image" (dict "ctx" $ctx "image" $image) }}
          imagePullPolicy: {{ $image.pullPolicy }}
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
            {{- if $ctx.Values.web.workflowMetricsLeader }}
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
            {{- with $ctx.Values.web.extraEnv }}
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
            {{- toYaml $ctx.Values.web.resources | nindent 12 }}
      {{- with (include "pawtograder.nodeSelector" (dict "ctx" $ctx "component" $ctx.Values.web)) }}
      nodeSelector:
        {{- . | nindent 8 }}
      {{- end }}
      {{- with (include "pawtograder.tolerations" (dict "ctx" $ctx "component" $ctx.Values.web)) }}
      tolerations:
        {{- . | nindent 8 }}
      {{- end }}
      {{- with (include "pawtograder.affinity" (dict "ctx" $ctx "component" $ctx.Values.web)) }}
      affinity:
        {{- . | nindent 8 }}
      {{- end }}
{{- end -}}
