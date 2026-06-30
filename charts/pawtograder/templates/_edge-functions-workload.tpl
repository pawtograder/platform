{{/*
Edge functions (Deno edge-runtime) Service + Deployment, parameterized so the
stable channel and any extra deployment channels (.Values.channels) render from
one definition.

Usage:
  {{ include "pawtograder.edgeFunctions.workload" (dict "ctx" . "component" "functions" "image" .Values.edgeFunctions.image "replicas" .Values.edgeFunctions.replicas "autoscaling" .Values.edgeFunctions.autoscaling.enabled) }}

Args:
  ctx          root context (.)
  component    component label + name suffix: "functions" for stable, "functions-<channel>" for a channel
  image        image dict ({ repository, tag, pullPolicy })
  replicas     replica count (used when autoscaling is false)
  autoscaling  when true, omit replicas (an HPA owns it — stable only)

All other config is shared from .Values.edgeFunctions; channels differ only by
name, labels, image, and replicas, and target the same Postgres/auth/storage.
*/}}
{{- define "pawtograder.edgeFunctions.workload" -}}
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
      port: {{ $ctx.Values.edgeFunctions.service.port }}
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
spec:
  {{- if not .autoscaling }}
  replicas: {{ .replicas }}
  {{- end }}
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
        - name: functions
          image: {{ include "pawtograder.image" (dict "ctx" $ctx "image" $image) }}
          imagePullPolicy: {{ $image.pullPolicy }}
          ports:
            - name: http
              containerPort: {{ $ctx.Values.edgeFunctions.service.port }}
          command: ["edge-runtime"]
          # NOTE: --no-verify-jwt isn't supported by edge-runtime (as of v1.74.0);
          # JWT verification (or lack thereof) is handled inside main.ts.
          args:
            - start
            - --main-service
            - /home/deno/functions/main
            - -p
            - "{{ $ctx.Values.edgeFunctions.service.port }}"
            - --policy
            - {{ $ctx.Values.edgeFunctions.policy | quote }}
            {{- if $ctx.Values.edgeFunctions.maxParallelism }}
            # Cap on simultaneous isolates; under per_request this bounds max
            # concurrent requests/pod (excess queue via --request-wait-timeout).
            - --max-parallelism
            - {{ $ctx.Values.edgeFunctions.maxParallelism | quote }}
            {{- end }}
            {{- with $ctx.Values.edgeFunctions.beforeUnload }}
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
              value: {{ $ctx.Values.edgeFunctions.verifyJwt | quote }}
            # Per-isolate worker limits read by the main.ts demuxer.
            - name: EDGE_WORKER_MEMORY_LIMIT_MB
              value: {{ $ctx.Values.edgeFunctions.worker.memoryLimitMb | quote }}
            - name: EDGE_WORKER_TIMEOUT_MS
              value: {{ $ctx.Values.edgeFunctions.worker.timeoutMs | quote }}
            - name: EDGE_WORKER_CPU_SOFT_MS
              value: {{ $ctx.Values.edgeFunctions.worker.cpuSoftMs | quote }}
            - name: EDGE_WORKER_CPU_HARD_MS
              value: {{ $ctx.Values.edgeFunctions.worker.cpuHardMs | quote }}
            - name: EDGE_WORKER_LOW_MEMORY_MULTIPLIER
              value: {{ $ctx.Values.edgeFunctions.worker.lowMemoryMultiplier | quote }}
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: {{ $ctx.Values.secrets.names.jwt }}
                  key: JWT_SECRET
            {{- if $ctx.Values.edgeFunctions.e2e.enabled }}
            - name: E2E_ENABLE
              value: "true"
            {{- end }}
            {{- if $ctx.Values.edgeFunctions.e2e.mockGitHub }}
            - name: E2E_MOCK_GITHUB
              value: "true"
            {{- end }}
          envFrom:
            - secretRef:
                name: {{ $ctx.Values.secrets.names.edgeFunctions }}
                optional: true
            {{- range $ctx.Values.edgeFunctions.envFromSecrets }}
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
          resources:
            {{- toYaml $ctx.Values.edgeFunctions.resources | nindent 12 }}
      {{- with (include "pawtograder.nodeSelector" (dict "ctx" $ctx "component" $ctx.Values.edgeFunctions)) }}
      nodeSelector:
        {{- . | nindent 8 }}
      {{- end }}
      {{- with (include "pawtograder.tolerations" (dict "ctx" $ctx "component" $ctx.Values.edgeFunctions)) }}
      tolerations:
        {{- . | nindent 8 }}
      {{- end }}
{{- end -}}
