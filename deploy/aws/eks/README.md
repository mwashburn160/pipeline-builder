# EKS Auto Mode deployment (Pipeline Builder)

Production AWS target on **Amazon EKS Auto Mode** — EC2-backed, AWS-managed nodes
(Karpenter) with the AWS Load Balancer Controller, EBS CSI, and CoreDNS built in.

## Why EKS Auto Mode

Rootless BuildKit — how every plugin/base image is built — needs an **unconfined
seccomp profile** to create the user namespace it runs in, which requires EC2-backed
Kubernetes nodes (they allow `securityContext.seccompProfile: Unconfined`, already used
by the minikube/ec2 targets). EKS Auto Mode keeps node management hands-off *and* runs
on EC2 nodes, so BuildKit works and we reuse the proven k8s manifests.

## Layout

```
deploy/aws/eks/
  bin/setup.sh           # orchestrates: cluster → EFS → ACM → secrets → apply → Route 53
  cluster/cluster.yaml   # eksctl ClusterConfig, Auto Mode + aws-efs-csi-driver
  .env.example           # platform config template (setup.sh fills secrets + domain)
  config/ nginx/         # prometheus/loki/alertmanager/promtail + nginx conf (→ ConfigMaps)
  postgres-init.sql  mongodb-init.js  mongodb-keyfile
  k8s/
    kustomization.yaml   # standalone manifests (NOT shared with ec2/minikube)
    storageclasses.yaml  # pb-ebs (RWO, DBs) + pb-efs (RWX, registry/loki)
    ingress.yaml         # ALB Ingress → nginx:8080 (ACM TLS at the ALB)
    *.yaml               # full workload set, tuned for multi-node (PVC, no hostPath)
```

This target is **self-contained** — its own copy of every manifest and config file, so
it never shares state with ec2/minikube (per project convention). The service *images*
are unchanged; only storage (hostPath → PVC) and the external entrypoint (NodePort → ALB
Ingress) differ.

## Reused vs net-new

**Reused (proven on minikube/ec2):** the **buildkitd sidecar with
`seccompProfile: Unconfined`**, the secret/configmap layout from `.env`, the workload
manifests (copied + storage-tuned), and `init-platform.sh` for admin + base-image seeding.

**Net-new (this folder):** the Auto Mode cluster, EBS/EFS storage classes + the
`hostPath → PVC` conversion (multi-node can't use hostPath), the ALB Ingress + ACM +
Route 53, and EKS Pod Identity for SES.

## What `setup.sh` does

1. **Cluster** — `eksctl create cluster` from `cluster/cluster.yaml` (Auto Mode).
2. **EFS** — creates an encrypted filesystem + SG (NFS from nodes) + mount targets in the
   private subnets; exports `EFS_FILESYSTEM_ID` for the `pb-efs` StorageClass.
3. **ACM** — requests a DNS-validated cert for `--domain`, publishes the Route 53
   validation record, waits for `ISSUED`; exports `ACM_CERT_ARN` for the Ingress.
4. **Secrets/ConfigMaps** — generates `.env` (random secrets, once), then creates the
   same secret/configmap set the ec2 target uses (mirrors [../ec2/bin/startup.sh](../ec2/bin/startup.sh)).
5. **SES + Pod Identity** (when email is enabled) — provisions the SES domain identity
   (Easy DKIM) + the 3 Route 53 CNAMEs, a configuration set, and a bounce/complaint SNS
   topic, then associates a **scoped** `ses:SendEmail` policy (on this identity + From
   address) with the platform's ServiceAccount. Full parity with the ec2 target.
6. **KEDA** — installs the operator (the plugin `ScaledObject` autoscaler).
7. **Apply** — `kubectl kustomize k8s | envsubst | kubectl apply` (restricted token expansion).
8. **Route 53** — upserts an A-alias `--domain → ALB` once the Ingress reports its address.

NetworkPolicy is standard k8s (`networkpolicy.yaml`), enforced by the VPC CNI;
`cilium-network-policies.yaml` (FQDN egress) is opt-in and requires Cilium as the CNI.

## Remaining live-AWS validation

The infra phases (EFS, ACM, SES, Pod Identity, Route 53) can't be exercised locally —
the API calls and manifest/eksctl syntax are validated statically, but verify against a
real account on first deploy. Specifically:

- [ ] Confirm the `aws-efs-csi-driver` addon's node DaemonSet schedules on Auto Mode nodes.
- [ ] First-deploy run of the SES phase (DKIM verification is async; the sandbox still
      applies — request production access + verify a real recipient to smoke-test).

The Kubernetes version defaults to **1.36** for fresh installs (`setup.sh`/`cluster.yaml`).
Override with `--eks-version <X>` / `$EKS_VERSION`, or pass `--eks-version latest` to resolve
the newest version EKS offers (`aws eks describe-cluster-versions`). If EKS doesn't yet offer
the requested version in your region, `eksctl create` fails with an unsupported-version error —
check availability with `aws eks describe-cluster-versions --region <r>`.

## Quick start

```bash
cd deploy/aws/eks
./bin/setup.sh --domain pipeline-builder.com --hosted-zone-id Z... --region us-east-1
../../bin/init-platform.sh eks      # register admin + (opt-in) load plugins/samples
```
or via the CLI (runs both in an ephemeral container):
`pipeline-manager provision --target eks --domain … --hosted-zone-id … --execute --yes`
