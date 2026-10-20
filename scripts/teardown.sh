#!/usr/bin/env bash
# Removes everything bootstrap.sh created (Istio, ArgoCD, monitoring, KEDA, the app) and the local Pulumi state.
set -euo pipefail
export PATH="$HOME/.pulumi/bin:$PATH" PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE-}"
unset PULUMI_BACKEND_URL
CTX=docker-desktop
K="kubectl --context $CTX"
cd "$(cd "$(dirname "$0")/.." && pwd)/pulumi"
pulumi login "${PULUMI_LOCAL_BACKEND:-file://$HOME/.pulumi-local}" >/dev/null

# Remove the app first, while KEDA and ArgoCD still run. The ScaledObject carries a KEDA finalizer, so if
# KEDA is uninstalled before the app namespace is gone, the namespace hangs in Terminating forever and
# `pulumi destroy` waits on it. Best effort: skipped if the cluster or the app is already gone.
if $K get ns devops-task >/dev/null 2>&1; then
  echo "==> Removing the app (ArgoCD Application, then its namespace)"
  # Delete the Application first, otherwise ArgoCD's self-heal recreates what we delete
  $K -n argocd delete application devops-task --wait=true --timeout=60s --ignore-not-found || true
  if ! $K delete ns devops-task --wait=true --timeout=120s --ignore-not-found; then
    echo "namespace still terminating; clearing leftover KEDA finalizers"
    $K -n devops-task patch scaledobject --all --type=merge -p '{"metadata":{"finalizers":null}}' || true
    $K wait --for=delete ns/devops-task --timeout=60s || true
  fi
fi

echo "==> Destroying the platform"
pulumi destroy --stack local --yes --non-interactive
# `stack rm` also deletes Pulumi.local.yaml, which is committed, so put it back
cp Pulumi.local.yaml Pulumi.local.yaml.bak
pulumi stack rm local --yes
mv Pulumi.local.yaml.bak Pulumi.local.yaml
