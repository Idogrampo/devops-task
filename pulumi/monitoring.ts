import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface MonitoringArgs {
    provider: k8s.Provider;
    gateway: pulumi.Resource;
    grafanaHost: string;
    prometheusHost: string;
    grafanaAdminPassword: pulumi.Input<string>;
}

const NAMESPACE = "monitoring";
const GATEWAY = "istio-ingress/devops-gateway";

// Metrics (Prometheus + Grafana + operator CRDs) and logs (Loki + Alloy), sized for a laptop cluster.
export function createMonitoring(args: MonitoringArgs) {
    const { provider } = args;
    const opts = { provider };

    const ns = new k8s.core.v1.Namespace("monitoring-ns", { metadata: { name: NAMESPACE } }, opts);

    const loki = new k8s.helm.v3.Release("loki", {
        name: "loki",
        chart: "loki",
        version: "7.3.0",
        repositoryOpts: { repo: "https://grafana.github.io/helm-charts" },
        namespace: NAMESPACE,
        timeout: 600,
        values: {
            deploymentMode: "SingleBinary",
            loki: {
                auth_enabled: false,
                commonConfig: { replication_factor: 1 },
                storage: { type: "filesystem" },
                schemaConfig: {
                    configs: [{
                        from: "2024-04-01",
                        store: "tsdb",
                        object_store: "filesystem",
                        schema: "v13",
                        index: { prefix: "loki_index_", period: "24h" },
                    }],
                },
                limits_config: { retention_period: "24h" },
                pattern_ingester: { enabled: false },
            },
            singleBinary: {
                replicas: 1,
                persistence: { enabled: false },
                // Without a PVC the chart mounts nothing at /var/loki and the root filesystem is read-only
                extraVolumes: [{ name: "loki-data", emptyDir: {} }],
                extraVolumeMounts: [{ name: "loki-data", mountPath: "/var/loki" }],
                resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "512Mi" } },
            },
            // Single-binary mode: switch off the scalable components, caches and test pods
            backend: { replicas: 0 }, read: { replicas: 0 }, write: { replicas: 0 },
            ingester: { replicas: 0 }, querier: { replicas: 0 }, queryFrontend: { replicas: 0 },
            queryScheduler: { replicas: 0 }, distributor: { replicas: 0 }, compactor: { replicas: 0 },
            indexGateway: { replicas: 0 }, bloomCompactor: { replicas: 0 }, bloomGateway: { replicas: 0 },
            chunksCache: { enabled: false }, resultsCache: { enabled: false },
            gateway: { enabled: false }, lokiCanary: { enabled: false },
            test: { enabled: false }, minio: { enabled: false },
            sidecar: { rules: { enabled: false } },
        },
    }, { provider, dependsOn: [ns] });

    // Alloy tails pod logs through the Kubernetes API (no hostPath mounts, so it works on Docker Desktop)
    const alloyConfig = `
discovery.kubernetes "pods" {
  role = "pod"
}

discovery.relabel "pods" {
  targets = discovery.kubernetes.pods.targets
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_name"]
    target_label  = "app"
  }
}

loki.source.kubernetes "pods" {
  targets    = discovery.relabel.pods.output
  forward_to = [loki.write.local.receiver]
}

loki.write "local" {
  endpoint {
    url = "http://loki.${NAMESPACE}.svc:3100/loki/api/v1/push"
  }
}
`;
    const alloy = new k8s.helm.v3.Release("alloy", {
        name: "alloy",
        chart: "alloy",
        version: "1.14.0",
        repositoryOpts: { repo: "https://grafana.github.io/helm-charts" },
        namespace: NAMESPACE,
        values: {
            controller: { type: "deployment", replicas: 1 },
            alloy: {
                configMap: { content: alloyConfig },
                resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "256Mi" } },
            },
        },
    }, { provider, dependsOn: [loki] });

    const stack = new k8s.helm.v3.Release("kube-prometheus-stack", {
        name: "kube-prometheus-stack",
        chart: "kube-prometheus-stack",
        version: "92.11.0",
        repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
        namespace: NAMESPACE,
        timeout: 900,
        values: {
            // Nothing here pages anyone, and these components are not reachable on Docker Desktop
            alertmanager: { enabled: false },
            nodeExporter: { enabled: false },
            kubeEtcd: { enabled: false },
            kubeScheduler: { enabled: false },
            kubeControllerManager: { enabled: false },
            kubeProxy: { enabled: false },
            defaultRules: { create: false },
            prometheusOperator: {
                admissionWebhooks: { enabled: false },
                tls: { enabled: false },
            },
            prometheus: {
                prometheusSpec: {
                    // Pick up ServiceMonitors from any namespace, not only ones labelled with this release
                    serviceMonitorSelectorNilUsesHelmValues: false,
                    podMonitorSelectorNilUsesHelmValues: false,
                    retention: "6h",
                    resources: { requests: { cpu: "200m", memory: "512Mi" }, limits: { memory: "1Gi" } },
                },
            },
            grafana: {
                adminPassword: args.grafanaAdminPassword,
                resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "768Mi" } },
                // Alertmanager is disabled, so its default datasource would only show as broken
                sidecar: { datasources: { alertmanager: { enabled: false } } },
                additionalDataSources: [{
                    name: "Loki",
                    uid: "loki",
                    type: "loki",
                    access: "proxy",
                    url: `http://loki.${NAMESPACE}.svc:3100`,
                }],
            },
        },
    }, { provider, dependsOn: [ns, loki] });

    // The Grafana sidecar loads any ConfigMap labelled grafana_dashboard=1
    const dashboard = new k8s.core.v1.ConfigMap("devops-task-dashboard", {
        metadata: {
            name: "devops-task-dashboard",
            namespace: NAMESPACE,
            labels: { grafana_dashboard: "1" },
        },
        data: {
            "devops-task.json": fs.readFileSync(
                path.join(__dirname, "..", "monitoring", "devops-task-dashboard.json"), "utf8"),
        },
    }, { provider, dependsOn: [stack] });

    const route = (name: string, host: string, service: string, port: number) =>
        new k8s.apiextensions.CustomResource(`${name}-vs`, {
            apiVersion: "networking.istio.io/v1",
            kind: "VirtualService",
            metadata: { name, namespace: NAMESPACE },
            spec: {
                hosts: [host],
                gateways: [GATEWAY],
                http: [{ route: [{ destination: { host: `${service}.${NAMESPACE}.svc.cluster.local`, port: { number: port } } }] }],
            },
        }, { provider, dependsOn: [stack, args.gateway] });

    const grafanaRoute = route("grafana", args.grafanaHost, "kube-prometheus-stack-grafana", 80);
    const prometheusRoute = route("prometheus", args.prometheusHost, "kube-prometheus-stack-prometheus", 9090);

    return { stack, loki, alloy, dashboard, routes: [grafanaRoute, prometheusRoute] };
}
