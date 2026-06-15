{{/*
Expand the name of the chart.
*/}}
{{- define "pawtograder.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
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
