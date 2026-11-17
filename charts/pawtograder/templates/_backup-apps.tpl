{{/*
Helpers for the Forgejo and Coder backups (backup-apps.yaml, and the app steps in
backup-verify.yaml and backup-restore-drill.yaml).
*/}}

{{/* The enabled apps, space-separated: "forgejo coder", "forgejo", "coder" or "". */}}
{{- define "pawtograder.backupApps.enabled" -}}
{{- $apps := list -}}
{{- range $app := list "forgejo" "coder" -}}
{{- if (index $.Values $app).enabled -}}{{- $apps = append $apps $app -}}{{- end -}}
{{- end -}}
{{- join " " $apps -}}
{{- end -}}

{{/*
The image that dumps and restores an app's database: <app>-db.image, the official
Postgres image the chart runs for database: own. pg_dump must be at least as new as
the server it dumps. In own mode that image is the server; in pawtograder mode
backup-apps-validations.yaml refuses an <app>-db.image older than postgres.image.
*/}}
{{- define "pawtograder.backupApps.image" -}}
{{- $img := (index .ctx.Values (printf "%s-db" .app)).image -}}
{{- printf "%s/%s:%s" $img.registry $img.repository (toString $img.tag) -}}
{{- end -}}

{{/* Superuser connection to the server holding the app's database, as the app-databases Job connects. */}}
{{- define "pawtograder.backupApps.pgEnv" -}}
{{- $ctx := .ctx -}}
{{- $app := .app -}}
{{- $su := dict -}}
{{- if eq (index $ctx.Values $app).database "own" -}}{{- $su = dig "settings" "superuser" dict (index $ctx.Values (printf "%s-db" $app)) | default dict -}}{{- end -}}
- name: PGHOST
  value: {{ include "pawtograder.appDatabase.host" (dict "ctx" $ctx "app" $app) }}
- name: PGPORT
  value: {{ include "pawtograder.appDatabase.port" (dict "ctx" $ctx "app" $app) | quote }}
- name: PGDATABASE
  value: {{ $app }}
- name: PGUSER
{{- if $su.secretKey }}
  valueFrom:
    secretKeyRef:
      name: {{ include "pawtograder.appDatabase.superuserSecret" (dict "ctx" $ctx "app" $app) }}
      key: {{ $su.secretKey }}
{{- else }}
  value: {{ $su.value | default (include "pawtograder.appDatabase.superuser" (dict "ctx" $ctx "app" $app)) }}
{{- end }}
- name: PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "pawtograder.appDatabase.superuserSecret" (dict "ctx" $ctx "app" $app) }}
      key: {{ include "pawtograder.appDatabase.superuserSecretKey" (dict "ctx" $ctx "app" $app) }}
{{- end -}}

{{/*
The PersistentVolumeClaim Forgejo mounts at /data, or "" when /data isn't a claim
(persistence off, an emptyDir). Mirrors the subchart's deployment.yaml.
*/}}
{{- define "pawtograder.backupApps.forgejoClaim" -}}
{{- $p := .Values.forgejo.persistence | default dict -}}
{{- if and $p.enabled (ne (toString $p.mount) "false") -}}
{{- $p.claimName | default "gitea-shared-storage" -}}
{{- else -}}
{{- range .Values.forgejo.extraVolumes -}}
{{- if eq .name "data" -}}{{- dig "persistentVolumeClaim" "claimName" "" . -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Forgejo's repository root as a member name in the /data archive, such as
./git/gitea-repositories, or "" when repository.ROOT is outside /data.
*/}}
{{- define "pawtograder.backupApps.forgejoRepoRoot" -}}
{{- $root := dig "gitea" "config" "repository" "ROOT" "/data/git/gitea-repositories" .Values.forgejo | toString | trimSuffix "/" -}}
{{- if hasPrefix "/data/" $root -}}
{{- printf ".%s" (trimPrefix "/data" $root) -}}
{{- end -}}
{{- end -}}

{{/* The mc fallback and alias, as in backup.yaml. .tag is the log prefix. */}}
{{- define "pawtograder.backupApps.mc" -}}
if ! command -v mc >/dev/null 2>&1; then
  echo "[{{ .tag }}] mc not in image — installing at runtime (see backup.image)"
  apt-get update && apt-get install -y --no-install-recommends curl ca-certificates
  curl -fsSL "{{ .ctx.Values.backup.mc.url }}" -o /usr/local/bin/mc
  echo "{{ .ctx.Values.backup.mc.sha256 }}  /usr/local/bin/mc" | sha256sum -c -
  chmod +x /usr/local/bin/mc
fi
mc alias set s3 "${S3_ENDPOINT}" "${AWS_ACCESS_KEY_ID}" "${AWS_SECRET_ACCESS_KEY}"
{{- end -}}

{{/* S3 endpoint, bucket and credentials, as backup.yaml sets them. */}}
{{- define "pawtograder.backupApps.s3Env" -}}
- name: S3_ENDPOINT
  value: {{ required "backup.s3.endpoint is required when backup.enabled=true" .Values.backup.s3.endpoint | quote }}
- name: S3_BUCKET
  value: {{ required "backup.s3.bucket is required when backup.enabled=true" .Values.backup.s3.bucket | quote }}
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
