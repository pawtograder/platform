{{/*
Expand the name of the chart.
*/}}
{{- define "pawtograder.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Version-STABLE component labels: the full componentLabels set MINUS the two
chart-version-carrying lines (helm.sh/chart, app.kubernetes.io/version). Use on
a StatefulSet POD TEMPLATE so a chart-only version bump does not mutate the
template and roll the pod, while still carrying the stable common/managed labels
(app.kubernetes.io/managed-by, global.commonLabels, name/instance/component)
that policy/cost-allocation/admission selectors rely on.
Usage: {{ include "pawtograder.componentStableLabels" (dict "ctx" . "component" "postgres") }}
*/}}
{{- define "pawtograder.componentStableLabels" -}}
{{ include "pawtograder.selectorLabels" .ctx }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
{{- /* commonLabels last, but strip the reserved selector keys: this label set
     goes on a StatefulSet/Deployment pod template, and the selector is immutable
     and must equal the template labels — a commonLabels override of name/
     instance/component would break that contract, so drop those keys. */}}
{{- with omit (.ctx.Values.global.commonLabels | default dict) "app.kubernetes.io/name" "app.kubernetes.io/instance" "app.kubernetes.io/component" }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Fully qualified app name. Truncated to 63 chars (DNS-1123 limit).
*/}}
{{- define "pawtograder.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Per-component name: <fullname>-<component>.
Usage: {{ include "pawtograder.componentName" (dict "ctx" . "component" "postgres") }}
*/}}
{{- define "pawtograder.componentName" -}}
{{- printf "%s-%s" (include "pawtograder.fullname" .ctx) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Chart label string.
*/}}
{{- define "pawtograder.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels stamped on every resource.
*/}}
{{- define "pawtograder.labels" -}}
helm.sh/chart: {{ include "pawtograder.chart" . }}
{{ include "pawtograder.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.global.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "pawtograder.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pawtograder.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Per-component labels: full label set + a component label.
Usage: {{ include "pawtograder.componentLabels" (dict "ctx" . "component" "postgres") }}
*/}}
{{- define "pawtograder.componentLabels" -}}
{{ include "pawtograder.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Per-component selector labels.
*/}}
{{- define "pawtograder.componentSelectorLabels" -}}
{{ include "pawtograder.selectorLabels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
ServiceAccount name.
*/}}
{{- define "pawtograder.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "pawtograder.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Resolve a component image, applying global.imageRegistry override and
defaulting empty tags to chart appVersion.
Usage: {{ include "pawtograder.image" (dict "ctx" . "image" .Values.web.image) }}
*/}}
{{- define "pawtograder.image" -}}
{{- $registry := .ctx.Values.global.imageRegistry -}}
{{- $repo := .image.repository -}}
{{- $tag := default .ctx.Chart.AppVersion .image.tag -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end -}}

{{/*
Merge global pod placement with per-component overrides.
Usage: {{ include "pawtograder.nodeSelector" (dict "ctx" . "component" .Values.postgres) }}
*/}}
{{- define "pawtograder.nodeSelector" -}}
{{- $merged := merge (deepCopy (default (dict) .component.nodeSelector)) (default (dict) .ctx.Values.global.nodeSelector) -}}
{{- if $merged -}}
{{ toYaml $merged }}
{{- end -}}
{{- end -}}

{{- define "pawtograder.tolerations" -}}
{{- $merged := concat (default (list) .component.tolerations) (default (list) .ctx.Values.global.tolerations) -}}
{{- if $merged -}}
{{ toYaml $merged }}
{{- end -}}
{{- end -}}

{{- define "pawtograder.affinity" -}}
{{- if .component.affinity -}}
{{ toYaml .component.affinity }}
{{- else if .ctx.Values.global.affinity -}}
{{ toYaml .ctx.Values.global.affinity }}
{{- end -}}
{{- end -}}

{{/*
Public URLs.
*/}}
{{- define "pawtograder.web.url" -}}
{{- printf "https://%s" .Values.global.hostname -}}
{{- end -}}

{{/*
The separate-API hostname. Default is "api.<hostname>". When
global.apiHostnameFlatten is true it instead prefixes "-api" onto the first
label — pr-123.preview.pawtograder.net -> pr-123-api.preview.pawtograder.net —
so the host stays a single label under the parent zone and is therefore covered
by a *.preview.pawtograder.net wildcard TLS cert (a wildcard spans only one
label, so the default two-label "api.pr-123.preview…" form is NOT coverable).
*/}}
{{- define "pawtograder.api.hostname" -}}
{{- if and .Values.global.apiHostnameFlatten (contains "." .Values.global.hostname) -}}
{{- $parts := splitn "." 2 .Values.global.hostname -}}
{{- printf "%s-api.%s" $parts._0 $parts._1 -}}
{{- else -}}
{{- printf "api.%s" .Values.global.hostname -}}
{{- end -}}
{{- end -}}

{{- define "pawtograder.api.url" -}}
{{- if .Values.global.apiOnSeparateHost -}}
{{- printf "https://%s" (include "pawtograder.api.hostname" .) -}}
{{- else -}}
{{- printf "https://%s" .Values.global.hostname -}}
{{- end -}}
{{- end -}}

{{/*
Per-deployment-channel public host. Each channel (.Values.channels[]) is served
on its own single-label host "<name>.<global.hostname>" so a *.<zone> wildcard
TLS cert always covers it; the channel runs web + edge-functions code against the
shared data plane, and the app redirects each course to its channel's host
(classes.deployment_channel). The host pattern is fixed (no per-channel override)
because the web middleware's hostForChannel() computes the same "<name>.<suffix>"
to drive the redirect — the chart and the app must agree on one host per channel.
The name is capped at 63 chars to match the DB CHECK on classes.deployment_channel
(a longer channel could render chart resources but never be stored / pinned to).
Usage: {{ include "pawtograder.channel.host" (dict "ctx" . "channel" $c) }}
*/}}
{{- define "pawtograder.channel.host" -}}
{{- $name := required "channels[].name is required" .channel.name -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" $name) -}}
{{- fail (printf "invalid channels[].name %q: must be a DNS-1123 label, <=63 chars (lowercase alphanumeric and '-', starting/ending alphanumeric) — it becomes a resource name and host label" $name) -}}
{{- end -}}
{{- printf "%s.%s" $name .ctx.Values.global.hostname -}}
{{- end -}}

{{/*
Shared Supabase API path routes (auth / rest / realtime / storage / functions →
Kong) for an Ingress host. Used by the primary host, its TLS-SAN extraHosts, and
every deployment-channel host, so the five proxied prefixes (and their port
handling) can't drift between the three Ingresses. Caller decides whether to emit
them (the primary host omits these when global.apiOnSeparateHost).
Usage: {{ include "pawtograder.ingress.apiPaths" $ | trim | nindent 10 }}
*/}}
{{- define "pawtograder.ingress.apiPaths" -}}
{{- $kong := include "pawtograder.kong.host" . -}}
{{- $port := .Values.kong.service.port -}}
{{- range $p := (list "auth" "rest" "realtime" "storage" "functions") }}
- path: /{{ $p }}/v1
  pathType: Prefix
  backend:
    service:
      name: {{ $kong }}
      port:
        number: {{ $port }}
{{- end }}
{{- end -}}

{{/*
Internal service hostnames.
*/}}
{{- define "pawtograder.postgres.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "postgres") -}}
{{- end -}}

{{- define "pawtograder.supavisor.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "supavisor") -}}
{{- end -}}

{{- define "pawtograder.kong.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "kong") -}}
{{- end -}}

{{- define "pawtograder.auth.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "auth") -}}
{{- end -}}

{{- define "pawtograder.rest.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "rest") -}}
{{- end -}}

{{- define "pawtograder.realtime.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "realtime") -}}
{{- end -}}

{{- define "pawtograder.realtime.headless" -}}
{{- printf "%s-headless" (include "pawtograder.realtime.host" .) -}}
{{- end -}}

{{- define "pawtograder.storage.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "storage") -}}
{{- end -}}

{{- define "pawtograder.imgproxy.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "imgproxy") -}}
{{- end -}}

{{- define "pawtograder.meta.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "meta") -}}
{{- end -}}

{{- define "pawtograder.studio.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "studio") -}}
{{- end -}}

{{- define "pawtograder.edgeFunctions.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "functions") -}}
{{- end -}}

{{- define "pawtograder.web.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "web") -}}
{{- end -}}

{{- define "pawtograder.postgres.replica.host" -}}
{{- include "pawtograder.componentName" (dict "ctx" . "component" "postgres-replica") -}}
{{- end -}}

{{/*
WAL-G environment (the WALG_ and AWS_ vars). Shared verbatim by the primary
container (runs archive_command), the base-backup sidecar, and the replica (restore_command
fallback), so wal-g behaves identically wherever it runs. Call with the root
context and nindent (see the postgres StatefulSet for a call site). S3
credentials come from secrets.names.s3 (the same secret backup.yaml uses).
*/}}
{{- define "pawtograder.walg.env" -}}
- name: WALG_S3_PREFIX
  value: {{ required "postgres.walg.s3Prefix is required when postgres.walg.enabled=true" .Values.postgres.walg.s3Prefix | quote }}
- name: WALG_COMPRESSION_METHOD
  value: {{ .Values.postgres.walg.compressionMethod | default "zstd" | quote }}
- name: AWS_REGION
  value: {{ .Values.postgres.walg.region | default "us-east-1" | quote }}
{{- if .Values.postgres.walg.s3Endpoint }}
- name: AWS_ENDPOINT
  value: {{ .Values.postgres.walg.s3Endpoint | quote }}
{{- end }}
- name: AWS_S3_FORCE_PATH_STYLE
  # `dig` (not `| default true`): sprig's `default` treats a boolean false as
  # empty and would force "true", making forcePathStyle: false impossible to
  # set. `dig` returns the actual value when the key is present — including
  # false — and only falls back to true when the key is absent.
  value: {{ dig "forcePathStyle" true .Values.postgres.walg | quote }}
- name: AWS_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.names.s3 }}
      key: AWS_ACCESS_KEY_ID
- name: AWS_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.names.s3 }}
      key: AWS_SECRET_ACCESS_KEY
{{- end -}}

{{/*
Postgres connection URL — pointed at supavisor by default. Components that
need the unpooled connection use pawtograder.postgres.directUrl.
*/}}
{{- define "pawtograder.postgres.url" -}}
{{- printf "postgres://postgres:$(POSTGRES_PASSWORD)@%s:%d/%s" (include "pawtograder.supavisor.host" .) (.Values.supavisor.service.port | int) .Values.postgres.database -}}
{{- end -}}

{{- define "pawtograder.postgres.directUrl" -}}
{{- printf "postgres://postgres:$(POSTGRES_PASSWORD)@%s:%d/%s" (include "pawtograder.postgres.host" .) (.Values.postgres.service.port | int) .Values.postgres.database -}}
{{- end -}}

{{/*
Image pull secrets.
*/}}
{{- define "pawtograder.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end -}}
{{- end -}}

{{/*
Pod-level securityContext. A component that defines its own
`podSecurityContext` key wins outright (set it to {} to opt a component out
entirely — postgres-style images whose entrypoints need more than the
default allows). Otherwise global.podSecurityContext applies.
Usage: {{ include "pawtograder.podSecurityContext" (dict "ctx" . "component" .Values.web) | nindent 6 }}
*/}}
{{- define "pawtograder.podSecurityContext" -}}
{{- $sc := .ctx.Values.global.podSecurityContext -}}
{{- if hasKey .component "podSecurityContext" -}}
{{- $sc = .component.podSecurityContext -}}
{{- end -}}
{{- with $sc }}
securityContext:
  {{- toYaml . | nindent 2 }}
{{- end -}}
{{- end -}}

{{/*
Container-level securityContext, same precedence rules as
pawtograder.podSecurityContext. Applied to main containers only — init
containers and hook Jobs that legitimately need root (apk/apt installs,
postgres entrypoint chown/su) are left alone.
Usage: {{ include "pawtograder.containerSecurityContext" (dict "ctx" . "component" .Values.web) | nindent 10 }}
*/}}
{{- define "pawtograder.containerSecurityContext" -}}
{{- $sc := .ctx.Values.global.containerSecurityContext -}}
{{- if hasKey .component "containerSecurityContext" -}}
{{- $sc = .component.containerSecurityContext -}}
{{- end -}}
{{- with $sc }}
securityContext:
  {{- toYaml . | nindent 2 }}
{{- end -}}
{{- end -}}

{{/*
priorityClassName — component override, else global.
Usage: {{ include "pawtograder.priorityClassName" (dict "ctx" . "component" .Values.web) | nindent 6 }}
*/}}
{{- define "pawtograder.priorityClassName" -}}
{{- $p := default .ctx.Values.global.priorityClassName .component.priorityClassName -}}
{{- with $p }}
priorityClassName: {{ . }}
{{- end -}}
{{- end -}}

{{/*
Pod affinity block. Per-component / global affinity (if set) wins — the
user opted into custom placement explicitly. Otherwise emit a soft
podAntiAffinity spreading the component's pods across nodes when its
`spreadAcrossNodes` value is true (no effect on single-node tiers).
Generalizes the pattern realtime.yaml pioneered.
Usage: {{ include "pawtograder.componentAffinity" (dict "ctx" . "component" .Values.web "name" "web") | nindent 6 }}
*/}}
{{- define "pawtograder.componentAffinity" -}}
{{- $userAffinity := include "pawtograder.affinity" (dict "ctx" .ctx "component" .component) -}}
{{- if $userAffinity }}
affinity:
  {{- $userAffinity | nindent 2 }}
{{- else if .component.spreadAcrossNodes }}
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          topologyKey: kubernetes.io/hostname
          labelSelector:
            matchLabels:
              {{- include "pawtograder.componentSelectorLabels" (dict "ctx" .ctx "component" .name) | nindent 14 }}
{{- end -}}
{{- end -}}

{{/*
preStop drain hook: sleep so the kubelet's endpoint removal propagates to
kube-proxy/ingress before the process gets SIGTERM, instead of dropping
in-flight requests. Rendered only when the component sets a non-zero
preStopSleepSeconds (images without /bin/sh must keep it 0).
Usage: {{ include "pawtograder.preStop" (dict "component" .Values.web) | nindent 10 }}
*/}}
{{- define "pawtograder.preStop" -}}
{{- with .component.preStopSleepSeconds }}
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep {{ . }}"]
{{- end -}}
{{- end -}}

{{/*
Deployment rollout strategy from the component's updateStrategy value.
Usage: {{ include "pawtograder.deploymentStrategy" (dict "component" .Values.web) | nindent 2 }}
*/}}
{{- define "pawtograder.deploymentStrategy" -}}
{{- with .component.updateStrategy }}
strategy:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- /* Deployment progress deadline. Default 1200s, not the k8s default 600s:
     a chart-version bump rolls the postgres StatefulSet (its pod template
     checksums postgres-config.yaml, whose labels carry the chart version), and
     dependent tiers wait on postgres to come back — which on slow (NFS) storage
     can exceed 600s and make `helm --wait` report a false failure even though
     the rollout converges seconds later. Per-component overridable. */}}
progressDeadlineSeconds: {{ .component.progressDeadlineSeconds | default 1200 }}
{{- end -}}

{{/*
github-async-worker org-leased WALL-CLOCK RUN BUDGET (env
GITHUB_ASYNC_WORKER_ORG_SLOT_RUN_BUDGET_SECONDS, values
edgeFunctions.githubAsyncWorker.orgSlotRunBudgetSeconds).

Two helpers, defined once and used by BOTH _edge-functions-workload.tpl (which
renders the env entry) and validations.yaml (which refuses an incoherent
combination), so the value that is checked is literally the string that is
rendered. A separate copy of this arithmetic in each file is how a chart starts
validating one number and shipping another.

runBudgetRaw — the configured value as a trimmed STRING, "" when unset.
"" is the shipped default and means "let the worker derive it". `null` (an
explicit --set x=null, or a values file that blanks the key) is also "", because
a null IS an absence. 0 is NOT: it is returned as "0" so the validation below can
refuse it by name instead of it disappearing into the unset case — which is what
`default ""` would have done, 0 being falsey in a template.
*/}}
{{- define "pawtograder.asyncWorker.runBudgetRaw" -}}
{{- $v := .Values.edgeFunctions.githubAsyncWorker.orgSlotRunBudgetSeconds -}}
{{- if kindIs "invalid" $v -}}{{- else -}}{{- $v | toString | trim -}}{{- end -}}
{{- end -}}

{{/*
runBudgetCeiling — the budget's ceiling AND the worker's default for it, in
seconds, DERIVED from the isolate lifetime:

  max(120, worker.timeoutMs/1000 - 120 - 30)

which is 250 at the shipped 400000 and 330 at the 480000 production runs. It
mirrors orgSlotRunBudgetCeilingSeconds() in
supabase/functions/_shared/asyncWorkerTuning.ts, including the integer
truncation of the millisecond value (`Math.floor(ms / 1000)` there, `div` here).
The two terms are constants in that file and not knobs of their own:
PER_MESSAGE_VT_BUDGET_SECONDS (120) is the drain-out reserve one in-flight
message is modelled at, ORG_SLOT_RUN_BUDGET_MARGIN_SECONDS (30) is slack before
the runtime's kill. The Math.max floor is why a too-short isolate yields 120 and
not a negative number; the worker reports that degenerate case as an invariant.

Because the ceiling moves with worker.timeoutMs, a validation that hardcoded 330
(or 250) would be wrong for every deployment that is not the one it was written
on — production and the chart default already disagree.
*/}}
{{- define "pawtograder.asyncWorker.runBudgetCeiling" -}}
{{- max 120 (sub (div (.Values.edgeFunctions.worker.timeoutMs | int) 1000) 150) -}}
{{- end -}}

{{/*
Convert a Kubernetes quantity (1Gi / 1.5Gi / 512Mi / 65536Ki / plain bytes) to
a byte count.

Used to keep a /dev/shm sizeLimit and the monitoring that watches it derived
from ONE value: postgres.shm.sizeLimit sets the emptyDir, and the same number
becomes limit_bytes in the postgres_exporter query and the denominator of
PawtograderPostgresSharedMemoryHigh. Raising the volume therefore moves the
alert threshold with it, instead of leaving a rule that still compares against
the old ceiling.

Fractions are supported deliberately. An earlier version rejected them, which
turned a perfectly valid Kubernetes quantity into a LATENT render failure:
monitoring.enabled defaults to false, so `sizeLimit: 1.5Gi` rendered fine and
then broke the next upgrade that switched monitoring on, in a template the
operator had not touched. Accepting what Kubernetes accepts removes the trap
rather than relocating it. (Raised in review on #1021.)

validations.yaml calls this for every enabled shm volume so a malformed value
fails at render time regardless of whether monitoring is on.
*/}}
{{- define "pawtograder.quantityToBytes" -}}
{{- $v := . | toString | trim -}}
{{- $mult := 1 -}}
{{- $n := $v -}}
{{- if hasSuffix "Gi" $v -}}
{{- $mult = 1073741824 -}}{{- $n = trimSuffix "Gi" $v -}}
{{- else if hasSuffix "Mi" $v -}}
{{- $mult = 1048576 -}}{{- $n = trimSuffix "Mi" $v -}}
{{- else if hasSuffix "Ki" $v -}}
{{- $mult = 1024 -}}{{- $n = trimSuffix "Ki" $v -}}
{{- end -}}
{{- if not (regexMatch "^[0-9]+(\\.[0-9]+)?$" $n) -}}
{{- fail (printf "pawtograder.quantityToBytes: unsupported quantity %q (want Gi/Mi/Ki or plain bytes, e.g. 1Gi, 1.5Gi, 512Mi)" $v) -}}
{{- end -}}
{{- int64 (mulf (float64 $n) $mult) -}}
{{- end -}}
