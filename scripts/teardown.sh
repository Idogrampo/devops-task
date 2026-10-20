#!/usr/bin/env bash
# Removes everything bootstrap.sh created (Istio, ArgoCD, the app) and the local Pulumi state.
set -euo pipefail
export PATH="$HOME/.pulumi/bin:$PATH" PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE-}"
unset PULUMI_BACKEND_URL
cd "$(cd "$(dirname "$0")/.." && pwd)/pulumi"
pulumi login "${PULUMI_LOCAL_BACKEND:-file://$HOME/.pulumi-local}" >/dev/null
pulumi destroy --stack local --yes --non-interactive
pulumi stack rm local --yes
