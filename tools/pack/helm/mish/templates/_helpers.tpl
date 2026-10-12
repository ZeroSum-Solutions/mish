{{- /*
Mishh Mashh Helm chart helpers. Spec §15.5.

Names:
  mish.name        chart-name (`mish`)
  mish.fullname    release-prefixed name (truncated to 63 chars)
  mish.labels      common label set
  mish.selectorLabels   selector subset
*/ -}}

{{- define "mish.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "mish.fullname" -}}
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

{{- define "mish.labels" -}}
app.kubernetes.io/name: {{ include "mish.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "mish.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mish.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
