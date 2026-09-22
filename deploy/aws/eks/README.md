# EKS Auto Mode deployment (Pipeline Builder)

Production AWS target on **Amazon EKS Auto Mode** — EC2-backed, AWS-managed nodes
(Karpenter) with the AWS Load Balancer Controller, EBS CSI, and CoreDNS built in.

## Why EKS Auto Mode

Rootless BuildKit — how every plugin/base image is built — needs an **unconfined
seccomp profile** to create the user namespace it runs in, which requires EC2-backed
Kubernetes nodes (they allow `securityContext.seccompProfile: Unconfined`, already used
by the minikube/ec2 targets). EKS Auto Mode keeps node management hands-off *and* runs
on EC2 nodes, so BuildKit works and we reuse the proven k8s manifests.

> **Bottlerocket userns gotcha (handled in `k8s/plugin.yaml`).** Auto Mode nodes are
> Bottlerocket, which ships with `user.max_user_namespaces = 0` — so rootless buildkitd
> can't create its user namespace and dies with `rootlesskit … no space left on device`
> (ENOSPC). Seccomp is *not* the issue here (Unconfined is honored). Auto Mode's managed
> NodeClass exposes no sysctl/user-data knob, so the plugin pod runs a privileged
> `enable-userns` init container (`sysctl -w user.max_user_namespaces=15000`) before
> buildkitd. Without it, `plugin` is stuck `Init:CrashLoopBackOff`.

## Layout

```
deploy/aws/eks/
  bin/setup.sh           # orchestrates: cluster → EFS → ACM → secrets → IAM → apply → Route 53
  bin/shutdown.sh        # teardown, in dependency order (see its header)
  bin/backup.sh restore.sh  # thin wrappers over deploy/bin/{backup,restore}.sh --connect k8s
  cluster/cluster.yaml   # eksctl ClusterConfig (Auto Mode; addons deliberately NOT here)
  cluster/addons.yaml    # aws-efs-csi-driver, applied AFTER the NodePool exists
  cluster/nodeclass.yaml # NetworkPolicy enforcement overlay on the managed `default` NodeClass
  cluster/nodepool.yaml  # the cluster's compute ceiling + the quarantine build pool
  backup/                # opt-in nightly db-backup CronJob template (see docs/deploy-operations.md)
  .env.example           # platform config template (setup.sh fills secrets + domain)
  config/ nginx/         # prometheus/promtail/grafana + nginx conf (→ ConfigMaps)
  mongodb-keyfile        # generated, gitignored — see note below
  k8s/
    kustomization.yaml   # standalone manifests (NOT shared with ec2/minikube)
    storageclasses.yaml  # pb-ebs (RWO, single-writer data) + pb-efs (RWX, alertmanager only)
    ingress.yaml         # ALB Ingress → nginx:8080 (ACM TLS at the ALB)
    *.yaml               # full workload set, tuned for multi-node (PVC, no hostPath)
```

postgres-init.sql, mongodb-init.js, the njs `jwt.js`/`metrics.js` and the
loki/alertmanager/thanos-objstore configs are shared by every target and live
once in `deploy/shared/` (read by `pb_create_config_maps` in
`deploy/bin/k8s-resources.sh`).

> **MongoDB keyfile secret.** `mongodb-keyfile` is the shared secret for the replica set's
> internal auth. It is gitignored and generated per-deploy: `setup.sh` calls
> `pb_ensure_mongo_keyfile` (`deploy/bin/mongo-keyfile.sh`, `openssl rand -base64 756`) before
> `pb_create_config_maps` reads it, so every environment gets its own. A fresh checkout ships
> none. Existing environments whose keyfile was ever committed should rotate it (roll the
> replica set with the new key).

This target is **self-contained** — its own copy of every manifest and config file, so
it never shares state with ec2/minikube (per project convention). The service *images*
are unchanged; only storage (hostPath → PVC) and the external entrypoint (NodePort → ALB
Ingress) differ.

## Reused vs net-new

**Reused (proven on minikube/ec2):** the **buildkitd sidecar with
`seccompProfile: Unconfined`**, the secret/configmap layout from `.env`, the workload
manifests (copied + storage-tuned), and `init-platform.sh` for admin + base-image seeding.

**Net-new (this folder):** the Auto Mode cluster + its NodeClass/NodePools, EBS/EFS storage
classes + the `hostPath → PVC` conversion (multi-node can't use hostPath), the ALB Ingress +
ACM + Route 53, and EKS Pod Identity for the SES / CodePipeline / KMS-signing grants.

## What `setup.sh` does

Numbered as the script's own phase labels, so a phase added there is visible here.

   Before phase 1 it also creates (or adopts) the **token-signing KMS key** and proves it is
   usable — up front, because `eksctl create cluster` is ~20 minutes and a key problem would
   otherwise surface after that time is spent.

1. **Cluster** — `eksctl create cluster` from `cluster/cluster.yaml` (Auto Mode).
1b. **NodeClass + NodePool** — applies `cluster/nodeclass.yaml` (merged onto the managed
   `default` NodeClass) plus the `amazon-vpc-cni` ConfigMap that switches NetworkPolicy
   enforcement ON, then `cluster/nodepool.yaml`. MUST precede any workload: `cluster.yaml`
   disables the built-in `general-purpose` pool, so nothing schedules until this lands.
1c. **Addons** — `cluster/addons.yaml` (`aws-efs-csi-driver`), after the NodePool exists.
2. **EFS** — creates an encrypted filesystem + SG (NFS from nodes) + mount targets in the
   private subnets; exports `EFS_FILESYSTEM_ID` for the `pb-efs` StorageClass.
3. **ACM** — requests a DNS-validated cert for `--domain`, publishes the Route 53
   validation record, waits for `ISSUED`; exports `ACM_CERT_ARN` for the Ingress.
4. **Secrets/ConfigMaps** — generates `.env` (random secrets, once), then creates the
   same secret/configmap set the ec2 target uses (mirrors [../ec2/bin/startup.sh](../ec2/bin/startup.sh)).
5. **SES + Pod Identity IAM** — provisions (when email is enabled) the SES domain identity
   (Easy DKIM) + the 3 Route 53 CNAMEs, a configuration set, and a bounce/complaint SNS
   topic, then grants **scoped** customer-managed IAM policies through Pod Identity.
   Pod Identity binds one IAM role per ServiceAccount, and every workload runs as its OWN
   named SA — never the namespace `default`, which would strand the credentials — so each
   grant goes to the SA of the pod that actually needs it:
   - `<cluster>-eks-ses` → **`platform`**: `ses:SendEmail` on this identity + From address
     (email only — full parity with ec2).
   - `<cluster>-eks-pipeline-exec` → **`pipeline`** (**always**):
     `codepipeline:Start/StopPipelineExecution` + `Get*`, backing the pipeline service's
     run/re-run/cancel endpoints (`api/pipeline` → `pipeline-execution-service`, which
     resolves the CodePipeline name from the registry). Scoped to `codepipeline:*:<account>:*`
     — pipeline names vary per org/project, so an account+service bound is the tightest possible.
   - `<cluster>-eks-token-signing` → **`platform`** (under `TOKEN_SIGNING_MODE=kms`, the AWS
     default): `kms:Sign` + `kms:GetPublicKey` on the user-token signing key only.
   - `<cluster>-eks-plugin-signing` → **`image-registry`** (under `PLUGIN_SIGNING_MODE=kms`):
     `kms:Sign` + `kms:GetPublicKey` on the plugin-image signing key only — never `plugin`,
     whose pod shares a network namespace with tenant builds.

   Each policy is created once and reused; a re-run back-fills it onto the existing role
   (attach is idempotent). `shutdown.sh` deletes all four, since they belong to no stack.
6. **KEDA** — installs the operator (the plugin `ScaledObject` autoscaler).
6a. **metrics-server** — Auto Mode does not bundle it; without it every cpu/memory HPA and
   the plugin `ScaledObject`'s cpu/mem triggers report `<unknown>` and never scale.
6b. **Istio ambient mesh** — HA istiod (2 replicas) + ztunnel + istio-cni, plus a
   PodDisruptionBudget so a node drain can't take istiod to zero.
7. **Apply** — verifies every referenced ghcr image carries a valid cosign signature
   (break-glass `SKIP_IMAGE_SIGNATURE_VERIFY=1`), then
   `kubectl kustomize k8s | envsubst | kubectl apply` (restricted token expansion).
8. **Route 53** — upserts an A-alias `--domain → ALB` once the Ingress reports its address.
9. **Init platform** (`AUTO_INIT`, default on — parity with the ec2 target) — runs
   [../../bin/init-platform.sh](../../bin/init-platform.sh) `eks`: registers the admin user and loads plugins +
   compliance rules + sample pipeline templates (building the CodeBuild bootstrap image and the
   plugin images first). It port-forwards to nginx via kubectl, so it works in both
   deploy modes without waiting on ALB/DNS. Pass `--no-auto-init` to skip and run it yourself.
   Needs Docker + yq on the machine running `setup.sh` (the plugin image builds), and the
   builds dominate the runtime.
10. **Smoke checks** (never fatal) — a test alert through Alertmanager, a test email, a
   CodePipeline credential dry-run from the `pipeline` pod, and a probe that a connection
   the NetworkPolicies deny really is denied.

NetworkPolicy is standard k8s (`networkpolicy.yaml`), enforced by the VPC CNI;
`cilium-network-policies.yaml` (FQDN egress) is opt-in and requires Cilium as the CNI.

## Remaining live-AWS validation

The infra phases (EFS, ACM, SES, Pod Identity, Route 53) can't be exercised locally —
the API calls and manifest/eksctl syntax are validated statically, but verify against a
real account on first deploy. Specifically:

- [ ] Confirm the `aws-efs-csi-driver` addon's node DaemonSet schedules on Auto Mode nodes.
- [ ] **Istio ambient on Auto Mode** (AWS-recommended): after `setup.sh`, confirm
      `istiod` (HA, 2 replicas), `ztunnel`, and `istio-cni-node` are Ready in `istio-system`,
      then `istioctl ztunnel-config workloads` shows every `pipeline-builder` pod `HBONE`
      **across all Auto Mode nodes**. Verify the node SecurityGroups allow node↔node HBONE
      `:15008` (+ istiod xDS `:15012` / webhook `:15017`), and that a Karpenter scale-up
      captures pods on a fresh node (ztunnel/istio-cni Ready first). If capture fails, AWS's
      Auto Mode guidance may require `--set values.cni.cniConfDir/cniBinDir` in `setup.sh`.
      See [docs/service-mesh.md](../../../docs/service-mesh.md).
- [ ] First-deploy run of the SES phase (DKIM verification is async; the sandbox still
      applies — request production access + verify a real recipient to smoke-test).
- [ ] Pod Identity CodePipeline grant: confirm the **`pipeline`** SA's role carries
      `${CLUSTER_NAME}-eks-pipeline-exec` after `setup.sh`, then hit the pipeline detail
      page's **Run pipeline** / **Cancel** actions against a deployed pipeline and confirm the
      `StartPipelineExecution`/`StopPipelineExecution` calls succeed (no `AccessDenied` /
      `PipelineNotFoundException` — the latter would mean a registry `pipelineName` ≠ the live
      CodePipeline name).

The Kubernetes version defaults to **1.36** for fresh installs (`setup.sh`/`cluster.yaml`).
Override with `--eks-version <X>` / `$EKS_VERSION`, or pass `--eks-version latest` to resolve
the newest version EKS offers (`aws eks describe-cluster-versions`). If EKS doesn't yet offer
the requested version in your region, `eksctl create` fails with an unsupported-version error —
check availability with `aws eks describe-cluster-versions --region <r>`.

## Quick start

```bash
cd deploy/aws/eks
# setup.sh runs init-platform automatically at the end (admin + plugins/compliance/pipelines):
./bin/setup.sh --domain pipeline-builder.com --hosted-zone-id Z... --region us-east-1
# add --no-auto-init to skip that and initialize by hand instead:
../../bin/init-platform.sh eks      # register admin + load plugins/samples
```
or via the CLI (runs both in an ephemeral container):
`pipeline-manager infra provision --target eks --domain … --hosted-zone-id … --execute --yes`

### Prerequisites

`setup.sh` needs the AWS CLI (+ credentials), `kubectl`, `openssl`, and `envsubst` on the host.
**`eksctl` is auto-installed** — when it isn't already on PATH, `setup.sh`/`shutdown.sh` download
the latest binary (to `/usr/local/bin`, falling back to `~/.local/bin` if that isn't writable)
before creating/deleting the cluster. `pipeline-manager infra provision --target eks` additionally
installs the other tools at runtime.
