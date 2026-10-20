import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();
const kubeContext = config.require("kubeContext");
const appNamespace = config.require("appNamespace");
const dockerHubUser = config.require("dockerHubUser");
// Optional: only needed if the Docker Hub repos are private
const dockerHubToken = config.getSecret("dockerHubToken");
const imageRepo = config.require("imageRepo");
const chartRepo = config.require("chartRepo");
const chartName = config.require("chartName");
const chartVersion = config.require("chartVersion");
const appHost = config.require("appHost");
const istioVersion = config.require("istioVersion");

// Never fall back to the shell's current kubectl context (those are company EKS clusters).
if (kubeContext !== "docker-desktop") {
    throw new Error(`kubeContext must be docker-desktop, got ${kubeContext}`);
}
const provider = new k8s.Provider("local", { context: kubeContext });
const opts = { provider };

// Istio: CRDs -> control plane -> ingress gateway. On Docker Desktop the gateway's
// LoadBalancer Service is published on localhost:80.
const istioRepo = { repo: "https://istio-release.storage.googleapis.com/charts" };
const istioBase = new k8s.helm.v3.Release("istio-base", {
    name: "istio-base",
    chart: "base",
    version: istioVersion,
    repositoryOpts: istioRepo,
    namespace: "istio-system",
    createNamespace: true,
}, opts);
const istiod = new k8s.helm.v3.Release("istiod", {
    name: "istiod",
    chart: "istiod",
    version: istioVersion,
    repositoryOpts: istioRepo,
    namespace: "istio-system",
    // Local single-node cluster: keep the control plane small
    values: { pilot: { resources: { requests: { cpu: "100m", memory: "256Mi" } } } },
}, { provider, dependsOn: [istioBase] });
const istioGateway = new k8s.helm.v3.Release("istio-ingressgateway", {
    name: "istio-ingressgateway",
    chart: "gateway",
    version: istioVersion,
    repositoryOpts: istioRepo,
    namespace: "istio-ingress",
    createNamespace: true,
    values: {
        labels: { istio: "ingressgateway" },
        service: { type: "LoadBalancer" },
    },
}, { provider, dependsOn: [istiod] });

// Platform-owned Gateway; the app chart's VirtualService attaches to it as istio-ingress/devops-gateway
const gateway = new k8s.apiextensions.CustomResource("devops-gateway", {
    apiVersion: "networking.istio.io/v1",
    kind: "Gateway",
    metadata: { name: "devops-gateway", namespace: "istio-ingress" },
    spec: {
        selector: { istio: "ingressgateway" },
        servers: [{ port: { number: 80, name: "http", protocol: "HTTP" }, hosts: ["*"] }],
    },
}, { provider, dependsOn: [istioGateway] });

const argocd = new k8s.helm.v3.Release("argocd", {
    name: "argocd",
    chart: "argo-cd",
    repositoryOpts: { repo: "https://argoproj.github.io/argo-helm" },
    namespace: "argocd",
    createNamespace: true,
    values: {
        // Plain HTTP behind port-forward; no TLS setup needed locally
        configs: { params: { "server.insecure": true } },
    },
}, opts);

const appNs = new k8s.core.v1.Namespace("app-ns", { metadata: { name: appNamespace } }, opts);

// Private Docker Hub only: lets ArgoCD pull the OCI chart and the kubelet pull the image
const credDeps: pulumi.Resource[] = [];
if (dockerHubToken) {
    credDeps.push(new k8s.core.v1.Secret("argocd-dockerhub-repo", {
        metadata: {
            name: "dockerhub-oci",
            namespace: "argocd",
            labels: { "argocd.argoproj.io/secret-type": "repository" },
        },
        stringData: {
            type: "helm",
            name: "dockerhub",
            url: chartRepo,
            enableOCI: "true",
            username: dockerHubUser,
            password: dockerHubToken,
        },
    }, { provider, dependsOn: [argocd] }));

    credDeps.push(new k8s.core.v1.Secret("regcred", {
        metadata: { name: "regcred", namespace: appNamespace },
        type: "kubernetes.io/dockerconfigjson",
        stringData: {
            ".dockerconfigjson": dockerHubToken.apply(t => JSON.stringify({
                auths: {
                    "https://index.docker.io/v1/": {
                        username: dockerHubUser,
                        password: t,
                        auth: Buffer.from(`${dockerHubUser}:${t}`).toString("base64"),
                    },
                },
            })),
        },
    }, { provider, dependsOn: [appNs] }));
}

// GitOps: Pulumi only declares the ArgoCD Application; ArgoCD does every deploy from here on.
const app = new k8s.apiextensions.CustomResource("devops-task-app", {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: { name: chartName, namespace: "argocd" },
    spec: {
        project: "default",
        source: {
            repoURL: chartRepo,
            chart: chartName,
            targetRevision: chartVersion,
            helm: {
                values: [
                    `image:\n  repository: ${imageRepo}\n`,
                    ...(dockerHubToken ? [`imagePullSecrets:\n  - name: regcred\n`] : []),
                    `virtualService:\n  hosts:\n    - ${appHost}\n`,
                ].join(""),
            },
        },
        destination: { server: "https://kubernetes.default.svc", namespace: appNamespace },
        syncPolicy: {
            automated: { prune: true, selfHeal: true },
            syncOptions: ["CreateNamespace=true"],
        },
    },
}, { provider, dependsOn: [argocd, appNs, gateway, ...credDeps] });

export const appUrl = `http://${appHost}/my-app`;
export const argocdPortForward = "kubectl --context docker-desktop -n argocd port-forward svc/argocd-server 8081:80";
export const argocdAdminPassword = "kubectl --context docker-desktop -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d";
export const applicationName = app.metadata.name;
