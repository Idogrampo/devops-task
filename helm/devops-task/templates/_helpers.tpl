{{- define "sample-nodejs.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "sample-nodejs.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "sample-nodejs.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "sample-nodejs.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "sample-nodejs.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sample-nodejs.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "sample-nodejs.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- include "sample-nodejs.fullname" . }}
{{- else }}default{{- end }}
{{- end }}

{{- define "sample-nodejs.secretName" -}}
{{- default (include "sample-nodejs.fullname" .) .Values.secret.existingSecret }}
{{- end }}
