#!/usr/bin/env bash
# One-shot setup for a machine that only has Docker Desktop with Kubernetes enabled.
# Installs missing tooling, then runs the Pulumi stack, which deploys Istio, ArgoCD, the monitoring
# stack (Prometheus, Grafana, Loki) and the app.
#
#   ./scripts/bootstrap.sh              install tooling, deploy, wait until the app answers
#   ./scripts/bootstrap.sh --dry-run    same, but only `pulumi preview`
#   ./scripts/bootstrap.sh --reset      forget local Pulumi state first (use after wiping the cluster)
#
# Optional env: SKIP_INSTALL=1 (do not install missing tools)
set -euo pipefail

CTX=docker-desktop
STACK=local
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="${PULUMI_LOCAL_BACKEND:-file://$HOME/.pulumi-local}"
HOST=devops-task.localhost
GRAFANA_HOST=grafana.localhost
DRY_RUN=0; RESET=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --reset) RESET=1 ;;
    -h|--help) sed -n 2,11p "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

log "Checking Docker and the $CTX Kubernetes context"
have docker || die "Docker Desktop is not installed"
docker info >/dev/null 2>&1 || die "Docker is not running"
kubectl_ok() { kubectl --context "$CTX" get nodes >/dev/null 2>&1; }

install_tools() {
  [ "${SKIP_INSTALL:-0}" = 1 ] && return
  export PATH="$HOME/.pulumi/bin:$HOME/.local/bin:$PATH"
  if ! have kubectl; then
    log "Installing kubectl"
    if have brew; then brew install kubectl
    else
      os=$(uname -s | tr A-Z a-z); arch=$(uname -m); [ "$arch" = x86_64 ] && arch=amd64; [ "$arch" = aarch64 ] && arch=arm64
      v=$(curl -fsSL https://dl.k8s.io/release/stable.txt)
      mkdir -p "$HOME/.local/bin"
      curl -fsSL -o "$HOME/.local/bin/kubectl" "https://dl.k8s.io/release/$v/bin/$os/$arch/kubectl"
      chmod +x "$HOME/.local/bin/kubectl"
    fi
  fi
  if ! have node || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    log "Installing Node.js"
    if have brew; then brew install node@22 && brew link --overwrite --force node@22
    else
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
      export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 22
    fi
  fi
  if ! have pulumi; then
    log "Installing Pulumi"
    curl -fsSL https://get.pulumi.com | sh
  fi
}
install_tools
export PATH="$HOME/.pulumi/bin:$HOME/.local/bin:$PATH"
have kubectl && have node && have pulumi || die "kubectl, node and pulumi are required (re-run without SKIP_INSTALL)"

kubectl_ok || die "context '$CTX' is not reachable. Docker Desktop -> Settings -> Kubernetes -> Enable Kubernetes, wait until it is green, then re-run."

log "Pulumi stack '$STACK' (backend: $BACKEND)"
cd "$ROOT/pulumi"
# The stack config is committed with an empty passphrase, so no secrets prompt locally
export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE-}"
unset PULUMI_BACKEND_URL
npm install --silent --no-audit --no-fund --registry=https://registry.npmjs.org/
mkdir -p "${BACKEND#file://}"
pulumi login "$BACKEND" >/dev/null
if [ "$RESET" = 1 ]; then
  # An interrupted run leaves a lock behind, which blocks `stack rm`
  pulumi stack select "$STACK" >/dev/null 2>&1 && pulumi cancel --yes >/dev/null 2>&1 || true
  # `stack rm` also deletes Pulumi.$STACK.yaml, which is committed, so put it back
  cp "Pulumi.$STACK.yaml" "Pulumi.$STACK.yaml.bak"
  pulumi stack rm "$STACK" --yes --force >/dev/null 2>&1 || true
  mv "Pulumi.$STACK.yaml.bak" "Pulumi.$STACK.yaml"
fi
pulumi stack select "$STACK" >/dev/null 2>&1 || pulumi stack init "$STACK" >/dev/null

if [ "$DRY_RUN" = 1 ]; then
  pulumi preview --non-interactive
  exit 0
fi
log "Deploying Istio, ArgoCD, monitoring and the app (first run takes several minutes)"
pulumi up --yes --non-interactive --skip-preview

log "Waiting for ArgoCD to sync and the app to become healthy"
for i in $(seq 1 90); do
  sync=$(kubectl --context "$CTX" -n argocd get application devops-task -o jsonpath='{.status.sync.status}' 2>/dev/null || true)
  health=$(kubectl --context "$CTX" -n argocd get application devops-task -o jsonpath='{.status.health.status}' 2>/dev/null || true)
  printf '  argocd: sync=%s health=%s\n' "${sync:-?}" "${health:-?}"
  [ "$sync" = Synced ] && [ "$health" = Healthy ] && break
  sleep 10
done
[ "$health" = Healthy ] || die "app did not become healthy; inspect: kubectl --context $CTX -n argocd describe application devops-task"

log "Checking http://$HOST/my-app through the Istio gateway"
for i in $(seq 1 30); do
  out=$(curl -fsS -m 5 --resolve "$HOST:80:127.0.0.1" "http://$HOST/my-app" 2>/dev/null || true)
  [ -n "$out" ] && break
  sleep 5
done
[ -n "${out:-}" ] || die "gateway did not answer on localhost:80 (is another process using port 80?)"
echo "  response: $out"

log "Checking Grafana at http://$GRAFANA_HOST"
for i in $(seq 1 30); do
  g=$(curl -fsS -m 5 --resolve "$GRAFANA_HOST:80:127.0.0.1" "http://$GRAFANA_HOST/api/health" 2>/dev/null || true)
  [ -n "$g" ] && break
  sleep 5
done
[ -n "${g:-}" ] && echo "  grafana: $g" || echo "  warning: Grafana did not answer yet; check: kubectl --context $CTX -n monitoring get pods"

pw=$(kubectl --context "$CTX" -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)
cat <<MSG

Done.
  App:     http://$HOST/my-app
  Grafana: http://$GRAFANA_HOST   user: admin   password: admin   (dashboard: "devops-task")
  Prometheus: http://prometheus.localhost
  ArgoCD:  http://argocd.localhost   user: admin   password: $pw
MSG
