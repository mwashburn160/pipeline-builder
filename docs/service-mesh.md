# Service Mesh (Istio Ambient)

Pipeline Builder runs an **Istio ambient (sidecar-less) service mesh** on every
deploy target — `deploy/local/minikube`, `deploy/aws/ec2`, and `deploy/aws/eks`.
It provides **STRICT mutual TLS** and **identity-based L4 authorization** between
every service, closing the gap left by the Kubernetes `NetworkPolicy` /
`CiliumNetworkPolicy` files (which are unenforced on all three targets — no
Cilium controller is installed and the minikube substrates use the default
bridge CNI).

> **TL;DR** — All east-west traffic inside the `pipeline-builder` namespace is
> mTLS-encrypted and authorized by SPIFFE identity. The only plaintext hops are
> the intentional ingress edge (the ALB / nginx TLS listener) and two PERMISSIVE
> carve-outs. The mesh is the real enforcement layer; the NetworkPolicy files are
> best-effort defense-in-depth for the day a CNI enforces them.

## Why ambient (not sidecars)

Ambient adds only node-level components (`ztunnel` DaemonSet + `istio-cni`),
living in `istio-system` — **no per-pod proxy and no changes to any container or
securityContext**. That matters here because:

- The pods are hardened (`readOnlyRootFilesystem`, `drop: [ALL]`, `runAsNonRoot`,
  `automountServiceAccountToken: false`). Ambient needs none of them relaxed —
  ztunnel obtains each workload's SPIFFE cert from istiod on the pod's behalf
  using the pod's ServiceAccount; the app never mounts the token.
- Local memory is tight and ec2 runs on modest instances; a sidecar per pod would
  roughly double proxy overhead.
- The plugin pod's KEDA CPU/memory `Utilization` triggers stay accurate — a
  sidecar would inflate the pod's request base and skew autoscaling.
- The plugin pod's privileged `enable-userns` init (Bottlerocket) has no
  `istio-init` container to order against — ambient captures init-container
  traffic at the node, so the `wait-for-dependencies` init hops satisfy STRICT
  with no special handling.

AWS recommends **EKS Auto Mode + Istio ambient**, so eks uses the same data plane
as local/ec2 — the design is uniform across all three targets.

## Architecture

```
[ALB/ACM (aws)  or  nginx TLS (local)]
        │  (plaintext to nginx:8080 on aws; TLS to nginx:8443 on local — PERMISSIVE carve-out)
        ▼
      nginx  ──ztunnel HBONE mTLS──▶  platform / pipeline / plugin / frontend / ...   [STRICT]
                                          │
                       ztunnel HBONE mTLS ▼
                    postgres / pgbouncer / mongodb / redis(+sentinel) / registry / minio   [STRICT, TCP]
```

- **Data plane**: ambient. The `pipeline-builder` namespace carries
  `istio.io/dataplane-mode: ambient` (see each tree's `k8s/namespace.yaml`).
- **Control plane**: `istiod` + `ztunnel` (DaemonSet) + `istio-cni`, installed by
  each target's provisioning script right after KEDA. eks runs istiod HA (2
  replicas + PDB).
- **Policies**: `k8s/istio.yaml` in each tree.

## mTLS posture

`PeerAuthentication/default` sets **STRICT** namespace-wide. Two PERMISSIVE
carve-outs, both port-scoped, keep non-mesh clients working:

| Carve-out | Where | Why |
|---|---|---|
| nginx `8080` (local also `8443`) | `PeerAuthentication/nginx-ingress` | The ALB (aws) / browser (local) is not a mesh member; nginx terminates the external leg. nginx→upstream stays STRICT. |
| prometheus `9090` | `PeerAuthentication/prometheus-keda` | KEDA's metrics-adapter (in the `keda` namespace, non-mesh) scrapes it for the plugin ScaledObject. |

Everything else — including app→datastore TCP (postgres/mongo/redis/registry/
minio) — is STRICT mTLS. Kubelet health probes are auto-exempted by istio-cni;
Prometheus→app `/metrics` is in-mesh (Prometheus is in the same namespace).

## Authorization (identity-based L4)

Each workload runs under its **own ServiceAccount** (created in `istio.yaml`), so
its SPIFFE identity is `cluster.local/ns/pipeline-builder/sa/<name>`. Sensitive
workloads (datastores + app APIs) have an `AuthorizationPolicy` (`action: ALLOW`)
listing exactly the caller identities real traffic needs.

> **ALLOW = default-deny once selected.** Every scraped app service lists
> `prometheus` (metrics share port 3000); every app API lists `nginx` (the single
> ingress principal); `registry`/`minio` list `default` (bootstrap Jobs).
> Observability infra (loki/alertmanager/thanos/jaeger) has **no** policy →
> STRICT-mTLS-only (any mesh peer), to bound the enumeration surface.

Allow-lists were **derived from real dependencies**, not the (stale) NetworkPolicy
files — e.g. Redis is used by ~every service (not just `plugin`), and `reporting`
connects to postgres. The refreshed NetworkPolicy files now agree with the mesh
policies. See the appendix in the implementation plan for the full table.

### aws specifics

- **Redis Sentinel (HA)**: ec2 and eks use `redis-sentinel.yaml`. Clients reach
  `redis-sentinel:26379` (master discovery) and `redis:6379` (data) — both have
  policies; `redis` + `redis-sentinel` identities are allowed for replication and
  gossip. Failover promotes a replica (new pod IP, same `sa/redis` → identity and
  authz unchanged; ioredis reconnects through ztunnel).
- **Per-org namespaces** (`pb-org-*`, enterprise tier): build pods run under
  `sa/org-workload` in a separate namespace, so `registry` and `image-registry`
  allow the `source.namespaces: ["pb-org-*"]` wildcard for the build/push path.
- **`db-backup` CronJob** (eks): its `db-backup` SA is allow-listed on
  postgres/mongodb/minio.

## External egress

The mesh keeps Istio's default `outboundTrafficPolicy: ALLOW_ANY` — do **not** set
`REGISTRY_ONLY`, or you break `billing`→payment providers, `plugin`/buildkit→
pypi/ghcr base-image pulls, `message`→SES/SMTP, and `platform`→GitHub/Bitbucket
OAuth. External destinations are plaintext-passthrough (protected by the remote's
own TLS); the plugin/billing egress NetworkPolicies still bound them.

## Queues, KEDA & buildkit

- The plugin BullMQ queue rides `redis:6379` over mTLS. Long-lived blocking
  connections can hit a proxy idle-timeout; ioredis auto-reconnects, so worst case
  is reconnect log-noise.
- The plugin autoscaler keeps its **Prometheus** trigger (queue depth via
  `sum(plugin_queue_jobs{...})`), **not** a Redis scaler — a Redis trigger would
  need a PERMISSIVE hole in the queue datastore, and it can't SUM across the three
  tier queues or count in-flight `active` jobs. A `fallback` holds a safe replica
  count if Prometheus is unreachable.
- `plugin ↔ buildkitd` is a **unix socket** (in-pod) — never touches the mesh.
  `buildkitd → registry:5000` is meshed; base-image pulls are passthrough egress.

## Verify

```bash
# control plane
kubectl get pods -n istio-system                 # istiod, ztunnel, istio-cni Ready
istioctl analyze -n pipeline-builder             # no errors

# every pod enrolled in ambient (HBONE)
istioctl ztunnel-config workloads                # PROTOCOL=HBONE for each pod

# mTLS is enforced: a pod OUTSIDE the mesh is denied
kubectl run probe --rm -it --image=curlimages/curl -- \
  curl -m5 http://platform.pipeline-builder:3000/health   # expect connection reset/denied

# ingress still works
curl -sk https://localhost:8443/health           # local
curl -s  https://<alb-dns>/health                # aws
```

eks adds: confirm capture across all Auto Mode nodes, node SecurityGroups allow
node↔node `:15008` (HBONE), and a Karpenter scale-up captures pods on fresh nodes
(ztunnel/istio-cni Ready first).

## LEAN mode (trimming the footprint)

The mesh adds ~1 CPU (istiod + ztunnel + istio-cni) on top of the app stack. On an
~8-core node the **full** stack + mesh exceeds 8 vCPU and pods sit Pending (and can
starve the apiserver). **`LEAN=1`** trims the deploy so the core stack + mesh fits —
supported on both **minikube** and **ec2** (they share the minikube substrate):

```bash
# minikube (~8-core laptop)
LEAN=1 ./deploy/local/minikube/bin/setup.sh
# clean restart: minikube delete --profile=pipeline-builder, then re-run

# ec2 (smaller instance, e.g. t3.large / 8 GiB instead of t3.xlarge)
LEAN=1 sudo -E bash deploy/aws/ec2/bin/startup.sh   # -E preserves LEAN through sudo
```

LEAN omits the optional observability/admin services (prometheus, thanos, loki,
promtail, jaeger, alertmanager, mongo-express, pgadmin) and collapses every workload to
a single replica, leaving the core stack + mesh room to schedule. Both targets drive the
same `lean_filter` over the kustomize stream. The full stack is the default (LEAN=0) for
larger machines; **eks** is unaffected (Karpenter provisions more nodes instead).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A service 403s another at L4 | Caller identity missing from the callee's `AuthorizationPolicy` — add its `sa/<name>` and re-apply `istio.yaml`. |
| mongodb `ReplicaSetNoPrimary` / stateful peer stuck | The workload's own SA must be in its `AuthorizationPolicy` — replica-set/gossip traffic is self-directed (e.g. `sa/mongodb` on `mongodb-allow`). |
| All calls to a service denied | An ALLOW policy selected it but omitted a real caller (often `prometheus` or `nginx`). |
| External ingress broken after enabling STRICT | nginx external port not carved out (`8080` on aws, `8080`+`8443` on local). |
| Builds can't pull base images | `outboundTrafficPolicy` was set to `REGISTRY_ONLY` — revert to `ALLOW_ANY`. |
| Pods not captured (no HBONE) | `istio-cni` not Ready before the pod started; on a non-standard node, set `values.cni.cniConfDir`/`cniBinDir`. |
| Periodic Redis reconnects | ztunnel idle-timeout reaping idle pub/sub connections — benign; tune the client `keepAlive` if noisy. |

## Optional: Kiali

Kiali (mesh visualization) is **not installed** to save resources. Add it
per the upstream Istio docs if you want a topology/health dashboard.

## Cross-target parity

The three `k8s/` trees are parallel copies. The **policy model is identical**
across them (same SAs, PeerAuthentications, AuthorizationPolicies); only these
differ: nginx carve-out port (local adds 8443), Redis Sentinel (aws), per-org +
`db-backup` (aws/eks), and the install mechanics (istiod HA + Auto Mode notes on
eks). Keep them in sync when editing.
