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

{{- define "pawtograder.api.url" -}}
{{- if .Values.global.apiOnSeparateHost -}}
{{- printf "https://api.%s" .Values.global.hostname -}}
{{- else -}}
{{- printf "https://%s" .Values.global.hostname -}}
{{- end -}}
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
