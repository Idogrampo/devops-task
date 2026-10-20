# DevOps Sample Node.js App

A small Express app with Prometheus metrics and health endpoints, packaged as a Docker image and Helm chart, built and scanned by GitHub Actions, and deployed to Kubernetes by ArgoCD.

| Path | Purpose | Exposed through the gateway |
|---|---|---|
| `/my-app` | Hello World, increments `root_access_total` | yes |
| `/about` | Static text | yes |
| `/ready`, `/live` | Readiness and liveness probes | no |
| `/metrics` | Prometheus metrics | no |
| `/classified` | Sample "do not expose" route | no |

## Repository layout

| Path | Contents |
|---|---|
| `app.js`, `test/` | The app and its smoke tests (`npm test`) |
| `Dockerfile` | Multi-stage build, non-root user, npm removed from the final image |
| `helm/devops-task/` | Helm chart |
| `.github/workflows/cicd.yml` | CI/CD pipeline |
| `actions/send_slack/` | Slack notification action (incoming webhook) |
| `pulumi/` | Pulumi program that installs Istio, ArgoCD and the monitoring stack and declares the ArgoCD `Application` |
| `monitoring/` | Grafana dashboard for the app (provisioned by Pulumi as a ConfigMap) |
| `scripts/` | `bootstrap.sh` and `teardown.sh` for a local cluster |

## Design decisions

**Deployment, not StatefulSet.** The app is stateless: replicas are interchangeable and need no stable identity, ordered startup or persistent storage. A Deployment with a rolling update (`maxUnavailable: 0`) fits.

**Helm chart.** Readiness, liveness and startup probes, resource requests and limits, a ConfigMap (with a checksum annotation so config changes roll the pods), an optional Secret, a Service, a PodDisruptionBudget and an optional HPA. Pods run as non-root with a read-only root filesystem and all capabilities dropped. Traffic enters through an Istio `VirtualService`; a plain `Ingress` template is included but disabled by default.

**GitOps: ArgoCD pulls the OCI chart from Docker Hub.** The two options were a separate GitOps repository or ArgoCD reading the app repository. I used neither: CI publishes a versioned chart to Docker Hub and ArgoCD follows it (`targetRevision: ">=0.0.1"`). The chart version is the release artifact, so there is no second repository to maintain and no CI commit back into `main`, which avoids pipeline loops and a write token. The cost is that Git no longer holds the deployed version; Docker Hub tags and GitHub releases do. Pin `chartVersion` in `pulumi/Pulumi.local.yaml` to freeze a release.

**Pulumi only bootstraps.** It installs Istio (base, istiod, ingress gateway), ArgoCD and a platform-owned `Gateway`, then declares one ArgoCD `Application`. After that, every deploy is a chart push by CI. The stack is pinned to the `docker-desktop` context and refuses any other, and its state lives in a local file backend (`~/.pulumi-local`).

**Git workflow: trunk-based.** Pull requests run every gate but publish nothing. Pushes to `main` publish and release.

## Monitoring

Installed by the same Pulumi stack, sized for a laptop (no Alertmanager, 6 h of metrics, 24 h of logs, nothing persisted).

- **Metrics:** kube-prometheus-stack (Prometheus, Grafana, kube-state-metrics). The chart ships a `ServiceMonitor` (enabled by the ArgoCD `Application`), so Prometheus scrapes `/metrics` inside the cluster even though the gateway does not expose it.
- **Logs:** Loki in single-binary mode, fed by Grafana Alloy, which tails every pod's logs through the Kubernetes API (no hostPath mounts, so it works on Docker Desktop).
- **Dashboard:** `devops-task` in Grafana: ready replicas, request rate and total hits (`root_access_total`), CPU, memory, restarts, Node.js event loop lag, heap and open file descriptors, plus a live log panel. Grafana loads it from a ConfigMap labelled `grafana_dashboard=1`.
- **Access:** http://grafana.localhost (user `admin`, password `admin`, local only; override with `pulumi config set --secret grafanaAdminPassword ...`) and http://prometheus.localhost, both through the Istio gateway.

## CI/CD pipeline

Runs on GitHub-hosted runners (`ubuntu-latest`).

**What triggers it.** Only changes that can affect the artifacts: `app.js`, `package*.json`, `Dockerfile`, `.dockerignore`, `test/`, `helm/`, `actions/` and the workflow itself. README, docs, Pulumi, monitoring and script changes do not run the pipeline.

**What gets rebuilt.** The image tag is `sha-<last commit that changed an image input>`, so a chart-only change reuses the existing image. If that tag is already on Docker Hub, build, scan and push are skipped. A new chart version is published only when the image inputs or `helm/` changed; otherwise the run just re-checks tests and security gates.

1. **Lint and test**: `npm test`, `helm lint`, `helm template`.
2. **SAST**: Semgrep (JavaScript, Node.js and Dockerfile rules); fails on any ERROR finding. `npm audit` fails on critical advisories.
3. **Version**: SemVer from the last `vX.Y.Z` tag. A `feat` commit bumps minor, `!:` or `BREAKING CHANGE` bumps major, anything else bumps patch. Pull requests get a throwaway `0.0.0-pr<N>` that is never published.
4. **Build and scan**: build the image, then Trivy; any fixable HIGH or CRITICAL finding fails the job and blocks everything after it.
5. **Push** (only on `main`): multi-arch image (`linux/amd64,linux/arm64`) tagged `sha-<commit>`, and the Helm chart as an OCI artifact in the same Docker Hub repository, with `appVersion` set to that image tag.
6. **Release and notify**: a GitHub release `v<version>` and a Slack message through `actions/send_slack`.

Repository secrets: `DOCKER_HUB_TOKEN` (read and write) and `SLACK_WEBHOOK`. The Docker Hub namespace is set in the workflow `env` block.

## Run it locally

Prerequisites:

- Docker Desktop with Kubernetes enabled (the `docker-desktop` context).
- A macOS or Linux terminal with `bash` and `curl`. The scripts do not run in native Windows (PowerShell or `cmd`). On Windows use WSL2 with Docker Desktop's WSL integration enabled and run the scripts from inside WSL; this is untested.

Nothing else is needed; the script installs kubectl, Node.js 20+ and Pulumi if they are missing. It has only been run on macOS (Apple Silicon).

```sh
./scripts/bootstrap.sh            # install, deploy, wait until the app answers
./scripts/bootstrap.sh --dry-run  # pulumi preview only
./scripts/bootstrap.sh --reset    # forget old Pulumi state, e.g. after wiping the cluster
./scripts/teardown.sh             # remove everything
```

When it finishes:

- App: http://devops-task.localhost/my-app
- ArgoCD: http://argocd.localhost (user `admin`, password printed by the script)
- Grafana: http://grafana.localhost (user `admin`, password `admin`) and Prometheus: http://prometheus.localhost

The first run pulls a lot of images and takes several minutes. The gateway uses `localhost:80`, so that port must be free. The Docker Hub repository is public. If you use a private one, export `DOCKER_HUB_TOKEN` before running the script and it creates the ArgoCD repository credential and the image pull secret.

## Access (local cluster)

| Service | URL | Login |
|---|---|---|
| App | http://devops-task.localhost/my-app | none |
| App, about page | http://devops-task.localhost/about | none |
| ArgoCD | http://argocd.localhost | `admin` / initial admin secret, see below |
| Grafana | http://grafana.localhost | `admin` / `admin` |
| Prometheus | http://prometheus.localhost | none |
| Repository | https://github.com/Idogrampo/devops-task | |
| CI/CD runs | https://github.com/Idogrampo/devops-task/actions | |
| Docker Hub (image and chart) | https://hub.docker.com/r/grampo/devops-task | |

The ArgoCD password is generated per cluster. `bootstrap.sh` prints it, or read it with:

```sh
kubectl --context docker-desktop -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

The Grafana password is a local-only default; override it with `pulumi config set --secret grafanaAdminPassword <value>`. `/metrics`, `/classified`, `/ready` and `/live` are deliberately not routed by the gateway (404 from outside the cluster).

**Logs:** the dashboard has a live log panel. For ad-hoc queries, open Grafana, then Explore, pick the **Loki** datasource and run `{namespace="devops-task"}`, or `{namespace="devops-task"} | json | path="/my-app"` to filter the JSON access log.

## Screenshots

**CI/CD notification in Slack**

![Slack notification](docs/screenshots/slack.png)

**Slack message for a change that needs no build (checks pass, nothing is released)**

![Slack, nothing to release](docs/screenshots/slack-no-release.png)

**ArgoCD: application synced and healthy**

![ArgoCD application](docs/screenshots/argocd.png)

**Grafana: `devops-task` dashboard**

![Grafana dashboard](docs/screenshots/grafana-dashboard.png)

**Prometheus**

![Prometheus query](docs/screenshots/prometheus.png)

**Cluster after a fresh `bootstrap.sh` (k9s): namespaces**

![k9s namespaces](docs/screenshots/k9s-namespaces.png)

**k9s: app pods in `devops-task`**

![k9s pods](docs/screenshots/k9s-pods.png)

**k9s: Istio VirtualServices for the app, ArgoCD, Grafana and Prometheus**

![k9s virtualservices](docs/screenshots/k9s-virtualservices.png)

## Local development

```sh
npm ci
npm test
PORT=8080 node app.js
```
