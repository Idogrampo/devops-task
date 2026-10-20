# DevOps Sample Node.js App

## Overview

A lightweight Node.js application. It features basic web endpoints, Prometheus metrics integration, and is designed for Kubernetes deployment and CI/CD pipeline demonstrations.

## Features

- Express.js web server
- Prometheus metrics integration
- Readiness and liveness probe endpoints
- Customizable port via environment variable

## Prerequisites

- Node.js (v22.1.0)

## Deployment (local docker-desktop cluster)

- **Workload:** Deployment, not StatefulSet. The app is stateless, so replicas are interchangeable and need no stable identity or storage.
- **CI/CD** (`.github/workflows/cicd.yml`): lint/test, Semgrep SAST (fails on ERROR), `npm audit` (fails on critical), Docker build, Trivy image scan (fails on fixable HIGH/CRITICAL) and only then push a multi-arch image and an OCI Helm chart to Docker Hub. Pushes to `main` bump the SemVer version from commit messages (`feat` = minor, `!:`/`BREAKING CHANGE` = major, else patch), create a GitHub release and notify Slack.
- **GitOps:** ArgoCD pulls the chart straight from Docker Hub (`grampo/devops-task`), so no second repo or CI write-back is needed. Pulumi (`pulumi/`) installs Istio (base, istiod, ingress gateway) and ArgoCD, creates the platform `Gateway` and declares the ArgoCD `Application`; after that every deploy is a chart push by CI.
- **Traffic:** the chart exposes the app through an Istio `VirtualService` (only `/my-app` and `/about`; `/metrics` and `/classified` stay internal). A plain `Ingress` template is included but disabled by default.

## Run it locally

Prerequisite: Docker Desktop with Kubernetes enabled. Nothing else; the script installs kubectl, Node.js and Pulumi if missing.

```sh
./scripts/bootstrap.sh            # deploys everything and waits until the app answers
# app: http://devops-task.localhost/my-app
./scripts/bootstrap.sh --dry-run  # preview only
./scripts/bootstrap.sh --reset    # after wiping the cluster, forget old Pulumi state
./scripts/teardown.sh             # remove everything
```

Set `DOCKER_HUB_TOKEN` first only if the Docker Hub repos are private.
