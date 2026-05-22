# Per-org Kubernetes namespace templates

Enterprise-tier customers can be deployed into their own k8s namespace
rather than sharing the default `pipeline-builder` namespace with every
other org. This is opt-in operator work — no orchestrator wires the
template into the org-create flow yet.

## Apply

```bash
export ORG_SLUG=acme
export CREATED_AT=$(date -u +%FT%TZ)

# Provision the namespace + RBAC + quota
envsubst < namespace-template.yaml | kubectl apply -f -

# Open the minimal egress allowlist + ingress from the cluster ingress controller
envsubst < network-policy-template.yaml | kubectl apply -f -
```

## Tear down

```bash
kubectl delete namespace pb-org-${ORG_SLUG}
```

Deletes the namespace and everything in it. The org's data in postgres /
mongo / registry remains — those are in the shared infra namespace and
follow the standard `org delete cascade` flow on the platform side.

## What the templates provision

- **Namespace** `pb-org-<slug>` with `tier: enterprise` label.
- **ServiceAccount** `org-workload` — workloads under the org's namespace
  run as this SA (further-tightened via IAM-for-ServiceAccounts when
  running on EKS).
- **NetworkPolicy** `default-deny` — denies all ingress + egress.
- **NetworkPolicy** `allow-egress-infra` — opens egress to kube-dns,
  in-cluster shared infrastructure (postgres / redis / registry / loki),
  and HTTPS (443) for AWS API calls when the org has per-org IAM/KMS.
- **NetworkPolicy** `allow-ingress-from-ingress-controller` — only the
  cluster's ingress controller can reach the org's pods.
- **ResourceQuota** capping CPU / memory / pod-count budgets.
- **LimitRange** enforcing per-pod CPU + memory ceilings (defense
  against a single plugin build chewing the whole namespace).

## Defaults that need tuning per customer

The ResourceQuota values are a baseline. Adjust before applying:

| Resource | Default | Tune for |
|----------|---------|----------|
| `pods` | 50 | Plugin build concurrency + in-flight workloads |
| `requests.cpu` | 20 cores | Sustained CPU need |
| `requests.memory` | 40 GiB | Sustained memory need |
| `limits.cpu` | 40 cores | Burst CPU ceiling |
| `limits.memory` | 80 GiB | Burst memory ceiling |
| `persistentvolumeclaims` | 10 | Storage-backed resources |

## What's still scaffolding

- No platform-side admin endpoint to apply the templates automatically.
  Operators apply by hand on customer signup.
- No tear-down hook on org delete. The platform's existing org-delete
  cascade drops data; operators currently delete the namespace manually
  afterwards.
- Resource-quota override mechanism (per-customer contracts) isn't
  templated — operators edit the manifest before applying.
