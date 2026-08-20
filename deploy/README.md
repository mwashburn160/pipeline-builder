# Deploy

Everything needed to stand up the Pipeline Builder platform, across four targets — from a laptop to a production EKS cluster. Every target runs the **same** container images and the **same** shared orchestration in [`bin/`](bin/); only the substrate differs.

## Targets (in increasing order of scale)

| Target | Path | Substrate | Use |
|---|---|---|---|
| **Docker Compose** | [`local/docker/`](local/docker/) | Docker Compose + rootless buildkitd | Fastest local bring-up / dev |
| **minikube** | [`local/minikube/`](local/minikube/) | single-node Kubernetes | Model the k8s posture locally |
| **EC2** | [`aws/ec2/`](aws/ec2/) | one EC2 instance (CloudFormation) | Small single-node AWS deploy |
| **EKS** | [`aws/eks/`](aws/eks/) | EKS Auto Mode (Bottlerocket) | Production, multi-node |

Each target dir has a `bin/setup.sh` (bring the stack up) and `bin/shutdown.sh`. The single-node minikube-based targets (**local/minikube** + **aws/ec2**) also ship a `bin/startup.sh` — a fast **resume** of a stopped cluster (reconnect only, no re-provision); ec2 additionally has `bootstrap.sh` (first-boot instance provisioning via UserData). Each also ships a `.env.example`, a `README.md` with target-specific notes, and its manifests (`docker-compose.yml` / `k8s/`).

## The two-step flow

```bash
# 1. Bring the stack up (containers/pods, TLS, DBs, buildkit)
deploy/local/docker/bin/setup.sh                      # or minikube / aws targets

# 2. Register the admin + optionally load plugins/samples/compliance
#    Loading is env-gated (or prompted on a TTY), NOT a flag:
#    LOAD_PLUGINS / LOAD_COMPLIANCE / LOAD_PIPELINES = y|n
LOAD_PLUGINS=y deploy/bin/init-platform.sh docker     # target: docker|minikube|ec2|eks
```

> **Small node (`LEAN=1`)** — when the full stack **+ the Istio mesh** doesn't fit in ~8 vCPU, `LEAN=1` deploys the core stack + mesh only: it omits the optional observability/admin services (prometheus, thanos, loki, promtail, jaeger, alertmanager, mongo-express, pgadmin) and collapses every workload to a single replica. Supported on the single-node minikube-based targets — **minikube** (`LEAN=1 deploy/local/minikube/bin/setup.sh`, ~8-core laptop) and **ec2** (at launch: `LEAN=1 deploy/aws/ec2/bin/setup.sh` sets the CFN `Lean` param; on the box: `LEAN=1 sudo -E bash deploy/aws/ec2/bin/startup.sh` — fits a t3.xlarge instead of t3.2xlarge). eks is unaffected. Details: [Service Mesh: LEAN mode](../docs/service-mesh.md#lean-mode-trimming-the-footprint).
>
> **Overrides** (env vars on `setup.sh`): `DISK_SIZE=60g` (VM disk, default 30g), `ISTIO_VERSION=…` (mesh version), `LEAN=1` (above), `RECREATE=y` (when a cluster already exists, WIPE + rebuild instead of resuming — otherwise `setup.sh` prompts on a TTY and defaults to keeping data). Disk size and CPU/memory are applied at cluster **create** only. Data lives on the minikube **VM disk** (survives `stop/start` and a `shutdown.sh`/`startup.sh` cycle; wiped by `delete` or `RECREATE=y`), not the host `data/` folder — see [docs/deploy-operations.md](../docs/deploy-operations.md#teardown).

Or provision a fresh machine end-to-end in one command (sparse-clones the repo, runs setup + init + post-steps):

```bash
pipeline-manager infra provision --repo --with-plugins           # add --prompt "..." for NL goals
```

## Shared orchestration ([`bin/`](bin/))

- **Images** — `build-plugin-images.sh` (base + plugin images; defaults `PUBLISH_PLATFORM` to the host arch for local targets, wires `ensure-binfmt.sh` for cross-arch), `push-base-images.sh`, `build-codebuild-bootstrap.sh`, `sync-image-tags.sh` / `verify-image-tags.sh`.
- **Init** — `init-platform.sh` (health-gates dependencies, registers admin, drives the `load-*` steps), `load-plugins.sh` / `load-plugin-worker.sh`, `load-pipelines.sh`, `load-compliance.sh`.
- **Secrets / TLS** — `gen-env-secrets.sh` (`pb_gen_env_secrets` fills the `.env` `CHANGE_ME` credentials with fresh random values and asserts none remain), `jwt-keys.sh` (registry signing keypair), `nginx-tls.sh` (gateway TLS), `mongo-keyfile.sh` (`pb_ensure_mongo_keyfile` — the replica-set keyfile, generated **per deploy**, never committed).
- **Helpers** — `common.sh` (logging, retries, `preflight <tools…>`, `curl_with_retry`, health waits, image-tag hashing, `mc_setup_aliases`), `k8s-resources.sh`, `cfn-deploy.sh`, `provision-docker.sh`.

> **Data (backup/restore) is per-target, not shared.** Each target owns its `bin/backup.sh` + `bin/restore.sh` (same names everywhere): the kubectl targets (minikube/ec2/eks) run the port-forward variant (auto-tunnels to the in-cluster datastores), docker connects directly. Both dump/restore Postgres + Mongo to/from S3 (`restore.sh` needs `--confirm-destructive`) and optionally mirror MinIO. See the [operations runbook](../docs/deploy-operations.md#backups--disaster-recovery) for scheduling + DR.

## Conventions

- **Secrets are generated per-deploy.** `.env` is seeded from `.env.example` on first run and its `CHANGE_ME` placeholders filled by `pb_gen_env_secrets`; the Mongo keyfile is generated by `pb_ensure_mongo_keyfile`. Neither `.env` nor `mongodb-keyfile` is tracked in git.
- **Idempotent + re-run safe.** Cert/keyfile/secret generators skip-if-exists; provisioning guards `.env` regeneration so DB passwords aren't rotated out from under existing data.
- **Platform matters for local builds.** On Apple Silicon, local plugin images build native `linux/arm64` (building `amd64` under QEMU segfaults the Rust base). AWS targets build `linux/amd64` for CodeBuild.
- **`chmod 644` on TLS/JWT key files is intentional** (do not tighten). The Mongo keyfile is `600` (MongoDB requires it).
- **Every target runs an Istio ambient service mesh** (STRICT mTLS + identity-based L4 authorization). The provisioning script installs it after KEDA; policies live in each tree's `k8s/istio.yaml`, and the namespace is enrolled via the `istio.io/dataplane-mode: ambient` label. `istioctl` is a required tool. Verify with `istioctl ztunnel-config workloads` (every pod `HBONE`). Full model + troubleshooting: [docs/service-mesh.md](../docs/service-mesh.md).

## Not covered here

Plugin sources, sample pipelines, compliance rule/policy seeds, and the CodeBuild bootstrap image live in sibling dirs — [`plugins/`](plugins/), [`samples/`](samples/), [`compliance/`](compliance/), [`codebuild/`](codebuild/) — and are loaded by the `load-*` / `init-platform.sh` steps above.
