import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();
const kubeContext = config.require("kubeContext");
const appNamespace = config.require("appNamespace");
const dockerHubUser = config.require("dockerHubUser");
const dockerHubToken = config.requireSecret("dockerHubToken");
const imageRepo = config.require("imageRepo");
const chartRepo = config.require("chartRepo");
const chartName = config.require("chartName");
const chartVersion = config.require("chartVersion");
const ingressHost = config.require("ingressHost");

// Never fall back to the shell's current kubectl context (those are company EKS clusters).
if (kubeContext !== "docker-desktop") {
    throw new Error(`kubeContext must be docker-desktop, got ${kubeContext}`);
}
const provider = new k8s.Provider("local", { context: kubeContext });
const opts = { provider };

// Ingress controller: on Docker Desktop its LoadBalancer is published on localhost:80
const ingressNginx = new k8s.helm.v3.Release("ingress-nginx", {
    name: "ingress-nginx",
    chart: "ingress-nginx",
    repositoryOpts: { repo: "https://kubernetes.github.io/ingress-nginx" },
    namespace: "ingress-nginx",
    createNamespace: true,
}, opts);

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

// Lets ArgoCD pull the (private) Helm chart from Docker Hub as an OCI artifact
const argoRepo = new k8s.core.v1.Secret("argocd-dockerhub-repo", {
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
}, { provider, dependsOn: [argocd] });

// Lets the kubelet pull the private image
const pullSecret = new k8s.core.v1.Secret("regcred", {
    metadata: { name: "regcred", namespace: appNamespace },
    type: "kubernetes.io/dockerconfigjson",
    stringData: {
        ".dockerconfigjson": pulumi.secret(pulumi.all([dockerHubToken]).apply(([t]) =>
            JSON.stringify({
                auths: {
                    "https://index.docker.io/v1/": {
                        username: dockerHubUser,
                        password: t,
                        auth: Buffer.from(`${dockerHubUser}:${t}`).toString("base64"),
                    },
                },
            }))),
    },
}, { provider, dependsOn: [appNs] });

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
                    `imagePullSecrets:\n  - name: regcred\n`,
                    `ingress:\n  hosts:\n    - host: ${ingressHost}\n      paths:\n        - path: /my-app\n          pathType: Prefix\n        - path: /about\n          pathType: Prefix\n`,
                ].join(""),
            },
        },
        destination: { server: "https://kubernetes.default.svc", namespace: appNamespace },
        syncPolicy: {
            automated: { prune: true, selfHeal: true },
            syncOptions: ["CreateNamespace=true"],
        },
    },
}, { provider, dependsOn: [argocd, argoRepo, pullSecret, ingressNginx] });

export const appUrl = `http://${ingressHost}/my-app`;
export const argocdPortForward = "kubectl --context docker-desktop -n argocd port-forward svc/argocd-server 8081:80";
export const argocdAdminPassword = "kubectl --context docker-desktop -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d";
export const applicationName = app.metadata.name;
