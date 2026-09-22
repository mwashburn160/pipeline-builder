---
layout: default
title: Service Mesh
---

# Service Mesh (Istio Ambient)

Pipeline Builder runs an **Istio ambient (sidecar-less) service mesh** on every
deploy target — `deploy/local/minikube`, `deploy/aws/ec2`, and `deploy/aws/eks`.
It provides **STRICT mutual TLS** and **identity-based L4 authorization** between
every service. The `CiliumNetworkPolicy` files ship but are **inert on every target** — no
Cilium controller is installed, and they are kept only as a ready-made overlay
for clusters that already run Cilium. The standard Kubernetes `NetworkPolicy`
files CAN be enforced — minikube's `kindnet` CNI enforces them (an `inet
kindnet-network-policies` nftables table), as does the EKS VPC CNI. Because every
ambient connection reaches the destination pod on the HBONE port `15008` (HBONE —
HTTP-Based Overlay Network Environment, the mTLS tunnel ztunnel carries traffic in) rather
than the app's port, each target's `networkpolicy.yaml` carries an
`allow-ambient-hbone` policy; without it `default-deny-ingress` silently drops
all mesh traffic (ztunnel logs "maybe a NetworkPolicy is blocking HBONE port
15008").

> **TL;DR** — All east-west traffic inside the `pipeline-builder` namespace is
> mTLS-encrypted and authorized by SPIFFE identity. The only plaintext hops are
> the intentional ingress edge (the ALB / nginx TLS listener) and two PERMISSIVE
> carve-outs. The mesh is the real enforcement layer; the NetworkPolicy files are
> defense-in-depth where the CNI enforces them (minikube kindnet, EKS VPC CNI).

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

Allow-lists were **derived from real dependencies** rather than copied from the
NetworkPolicy files — e.g. Redis is used by ~every service (not just `plugin`),
and `reporting` connects to postgres. The NetworkPolicy files were then refreshed
to agree with the mesh policies, so the two layers now describe the same graph.

### Per-route policies for INTERNAL routes (L7, via a waypoint)

A handful of routes exist ONLY for service-to-service calls — `/internal/*`, the
quota usage counters, the entity-event and audit ingests, and the
billing→compliance / billing→reporting entitlement legs. They are enforced **in
the application** by api-core's `requireInternalService`, which refuses every user
token and admits only the named calling services (whose names are bound to their
signing keys — see [Authentication](authentication.md#internal-service-tokens-one-key-per-service)).
That check is the enforcement, and it has to be: docker compose runs no mesh at
all, and the gate must hold identically there.

`k8s/istio-internal-routes.yaml` adds a second, independent refusal at the network
layer, so reaching an internal route needs both a valid service token AND the
right workload identity.

- **A waypoint, because these are L7 rules.** Per-route means path + method, and
  ztunnel is L4-only — an L7 `AuthorizationPolicy` is enforced by a waypoint proxy
  or not at all. The `pb-waypoint` Gateway is attached (via the
  `istio.io/use-waypoint` label on the **Service**) to exactly the six Services
  that expose an internal route: `platform`, `message`, `compliance`, `quota`,
  `reporting`, `image-registry` (`POST /internal/plugin-signatures` — plugin-image
  signing — and `/internal/plugin-publications*` — the `public/*` namespace
  operations; both `plugin` only). Not namespace-wide, which would put an Envoy hop in front of the
  datastores too. It needs the Kubernetes Gateway API CRDs, which
  `istioctl install` does not ship — each target's setup installs the standard
  channel (`GATEWAY_API_VERSION`, pinned) when they are absent.
- **`action: DENY`, not ALLOW.** ALLOW policies union, so an ALLOW for the
  internal paths would narrow nothing: the broad per-service ALLOW above must keep
  admitting `nginx` on the same port. DENY takes precedence, so
  `notPrincipals` + a path match expresses "only these callers, on this route"
  without restating every service's full caller list.
- **Traffic through a waypoint arrives as the WAYPOINT's identity**, so
  `sa/pb-waypoint` is listed in those six workloads' ALLOW policies. The original
  caller has already been checked, at the waypoint. For `image-registry` this
  covers far more than the internal route: nginx's `/token` and `/api/images/*`
  proxying, buildkitd's token fetches from the plugin pod, the bootstrap crane
  push pods and per-org build pods all address the Service, so all of them now
  reach the pod as the waypoint — drop `sa/pb-waypoint` from
  `image-registry-allow` and the registry token flow 403s.
- **Path matching** is exact / prefix (`/x/*`) / suffix (`*/x`) only — no wildcard
  in the middle — so a route with an `:orgId` segment is matched by suffix or
  prefix (e.g. `*/increment`). The app-side gate matches the exact route
  regardless.
- **Rollback**: remove the `istio.io/use-waypoint` label from a Service and its
  traffic stops going through the waypoint; the policies then match nothing and
  the app-side gate carries the routes on its own, exactly as under compose.

The caller lists here are reviewed against the one authoritative list in each
service's route-coverage test (`findInternalRouteViolations`), which checks the
declaration against the code in both directions.

**Plugin ecosystem callers.** The plugin service is a caller of four internal
surfaces:

- `platform POST /internal/notify-email` (with `compliance`): plugin-ecosystem
  notices (N6–N10, N22, N24, N25, N28, N29), resolved to recipients by platform;
- `platform GET /internal/ecosystem/*` (`plugin` only): the Verified
  application's eligibility facts (the publisher org's DNS-verified domains and
  whether its owners have a second factor) and the Ecosystem Manager approver
  count (holders of the decision permission, minus conflicts of interest);
- `image-registry /internal/plugin-publications*` (`plugin` only, DENY policy
  `image-registry-internal-plugin-publications`): publishing an approved version
  into `public/*`, re-signing, re-tagging an unyanked version, yanking,
  verifying and collecting published images;
- `platform GET /organization/:id/members/:userId/exists`, a service-principal
  membership probe (not an `/internal` path, so no DENY policy): the Ecosystem
  console's separation-of-duties check asks whether a manager belongs to the
  org that submitted a request.

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

# ec2 (fits a t3.xlarge / 4 vCPU instead of requiring t3.2xlarge)
LEAN=1 sudo -E bash deploy/aws/ec2/bin/startup.sh   # -E preserves LEAN through sudo
# ...or at launch: set the CFN `Lean` param — LEAN=1 deploy/aws/ec2/bin/setup.sh
#    (or: pipeline-manager infra provision --target ec2 --lean --instance-type t3.xlarge)
```

LEAN omits the optional observability/admin services (prometheus, thanos, loki,
promtail, jaeger, alertmanager, mongo-express, pgadmin, grafana, kiali) and collapses every workload to
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

## Kiali (mesh console)

Kiali ships on the three kubernetes targets (`k8s/kiali.yaml`), reached through
nginx at **`/kiali/`** like `/pgadmin/`, and dropped by `LEAN=1`. It is not
deployed on **docker**, which runs no mesh.

**What you get here is L4 only.** This mesh runs ambient with no waypoint
proxies, so ztunnel is a TCP proxy and reports `istio_tcp_*` and nothing else —
measured on a live cluster, 553 `istio_*` series with `istio_requests_total` at
**zero**. The graph shows who talks to whom, how much traffic, and whether the
edge is mTLS. It does **not** show HTTP success rates, RPS, per-route latency or
status codes; those need waypoint proxies, which cost a pod per
namespace/service and change the data path.

It depends on the `istio-mesh` Prometheus scrape job — Kiali reads topology from
Prometheus, not from the API server, so without that job the graph is empty.

**Access is deliberately restricted.** Kiali has no tenant model: it shows every
org's workloads and traffic. So it runs `view_only_mode` with read-only RBAC (no
create/update/delete verbs in its ClusterRole) and `auth.strategy: token` —
nginx applies no auth to `/kiali/`, so anonymous would publish a cross-tenant
view of the whole mesh to anyone who can reach the gateway. Sign in with a
ServiceAccount token:

```bash
kubectl -n pipeline-builder create token kiali
```

## Cross-target parity

The three `k8s/` trees are parallel copies. The **policy model is identical**
across them (same SAs, PeerAuthentications, AuthorizationPolicies); only these
differ: nginx carve-out port (local adds 8443), Redis Sentinel (aws), per-org +
`db-backup` (aws/eks), and the install mechanics (istiod HA + Auto Mode notes on
eks). Keep them in sync when editing.
