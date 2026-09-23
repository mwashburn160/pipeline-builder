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
#    LOAD_PLUGINS / LOAD_COMPLIANCE / LOAD_TEMPLATES = y|n
LOAD_PLUGINS=y deploy/bin/init-platform.sh docker     # target: docker|minikube|ec2|eks
```

> **Small node (`LEAN=1`)** — when the full stack **+ the Istio mesh** doesn't fit in ~8 vCPU, `LEAN=1` deploys the core stack + mesh only: it omits the optional observability/admin services (prometheus, thanos, loki, promtail, jaeger, alertmanager, mongo-express, pgadmin, grafana, kiali) and collapses every workload to a single replica. Supported on the single-node minikube-based targets — **minikube** (`LEAN=1 deploy/local/minikube/bin/setup.sh`, ~8-core laptop) and **ec2** (at launch: `LEAN=1 deploy/aws/ec2/bin/setup.sh` sets the CFN `Lean` param; on the box: `LEAN=1 sudo -E bash deploy/aws/ec2/bin/startup.sh` — fits a t3.xlarge instead of t3.2xlarge). eks is unaffected. Details: [Service Mesh: LEAN mode](../docs/service-mesh.md#lean-mode-trimming-the-footprint).
>
> **Self-hosted Ask model (`ASK_MODEL=1`)** — the Ask assistant needs *some* AI provider. The **eks** and **ec2** targets deploy one by default (`k8s/ask-model.yaml`, Ollama running `qwen2.5-coder:7b`) and point the ask service at it. On **minikube** it is opt-in: `ASK_MODEL=1 deploy/local/minikube/bin/setup.sh` applies the manifest *and* wires `OPENAI_COMPATIBLE_BASE_URL`/`_MODELS` into `app-env`. The same flag works on **`startup.sh`** to enable it on an already-provisioned cluster without re-provisioning (it applies the manifest, patches `app-env`, and restarts `ask`). `LEAN` is a provision-time choice and is ignored by `startup.sh`. The minikube copy is laptop-sized — the 1.5B coder model at a 1536Mi request, since the 7B/6Gi shape would sit Pending on a ~7Gi VM. Without either this flag or a cloud provider key in `.env`, every Ask turn fails with *"AI is not configured"*. This is the opposite of `LEAN` (which *removes* optional workloads), so it is a separate flag rather than a `LEAN` level.
>
> On **ec2**, `LEAN=1` **drops** the model (and the `ask` service's pointer at it): at 6Gi it is 52% of the lean memory footprint — 3.60 cpu / 11.56Gi with it versus 3.35 / 5.56Gi without — which does not fit the t3.xlarge that `LEAN` exists to target. Run `LEAN=0` (the m5.4xlarge default, or t3.2xlarge with the quota lowered to match) to get the self-hosted model on ec2. **eks** has no `LEAN` mode: Karpenter sizes nodes from pod requests, so the model always deploys.
>
> **Compute ceiling (eks)** — EKS Auto Mode's built-in NodePools carry no `limits`, so an Auto Mode cluster will buy EC2 capacity until the account quota stops it. `cluster/cluster.yaml` therefore disables the built-in `general-purpose` pool (keeping only the `CriticalAddonsOnly`-tainted `system` pool) and `cluster/nodepool.yaml` adds a bounded `pipeline-builder` NodePool — **48 cpu / 96Gi**, about 2x the measured full-scale requirement of ~20-24 cpu / 40-48Gi. Hitting it surfaces as **Pending pods**, not a bill. Raise the `limits` block if real load needs more; don't delete it, or the ceiling is gone. `bin/setup.sh` applies it in Phase 1b — before any workload, since with `general-purpose` off nothing else can schedule.
>
> On **docker** the mechanism is a compose profile rather than a flag: `docker compose --profile ask-model up -d`, then uncomment `OPENAI_COMPATIBLE_BASE_URL`/`_MODELS` in `.env` and `docker compose up -d ask`. `OLLAMA_MODEL` picks the model the container pulls and must name the same model `OPENAI_COMPATIBLE_MODELS` advertises.
>
> On every target the workload stays **NotReady/unhealthy** until the model is actually on disk — a `startupProbe` in k8s, a healthcheck grepping `ollama list` on docker — so nothing ever routes a turn to a server whose catalogue is still empty (~4.7GB for the 7B on first run; that failure mode surfaced as `AI_APICallError: Cannot connect to API: other side closed`).

> **Operator consoles (`/grafana/`, `/kiali/`)** — alongside the tenant-facing, org-scoped Observability pages, the three kubernetes targets ship two admin consoles behind nginx subpaths, exactly like `/pgadmin/`: **Grafana** (dashboards over Thanos/Prometheus/Loki/Jaeger) and **Kiali** (the Istio mesh console). Both are dropped by `LEAN=1`. Each has its own login; on the AWS targets the routes are additionally OFF unless `ADMIN_UIS_ENABLED=true`, and then gated at nginx by platform's superadmin + AAL2 check. Both read data with **no org scoping**, so they are admin-only and nothing tenant-facing links to them. Kiali is additionally `view_only_mode` with read-only RBAC and `auth.strategy: token`. On **docker** only Grafana ships: that target runs no service mesh, so Kiali would render an empty graph. Under Istio *ambient* without waypoint proxies Kiali's graph is **L4 only** — who talks to whom, how much, and whether it is mTLS; no HTTP rates, latency or status codes.

> **Overrides** (env vars on `setup.sh`): `DISK_SIZE=60g` (VM disk, default 30g), `ISTIO_VERSION=…` (mesh version), `LEAN=1` (above), `ASK_MODEL=1` (above), `RECREATE=y` (when a cluster already exists, WIPE + rebuild instead of resuming — otherwise `setup.sh` prompts on a TTY and defaults to keeping data). Disk size and CPU/memory are applied at cluster **create** only. Data lives on the minikube **VM disk** (survives `stop/start` and a `shutdown.sh`/`startup.sh` cycle; wiped by `delete` or `RECREATE=y`), not the host `data/` folder — see [docs/deploy-operations.md](../docs/deploy-operations.md#teardown).

Or provision a fresh machine end-to-end in one command (sparse-clones the repo, runs setup + init + post-steps):

```bash
pipeline-manager infra provision --repo --with-plugins           # add --prompt "..." for NL goals
```

## Shared orchestration ([`bin/`](bin/))

- **Images** — `build-plugin-images.sh` (base + plugin images; defaults `PUBLISH_PLATFORM` to the host arch for local targets, wires `ensure-binfmt.sh` for cross-arch), `push-base-images.sh`, `build-codebuild-bootstrap.sh`, `sync-image-tags.sh` / `verify-image-tags.sh`, `verify-plugin-urls.sh` (HEAD-checks every download URL + `COPY --from` image in the plugin Dockerfiles; also wired to `.github/workflows/plugin-urls.yml`).
- **Init** — `init-platform.sh` (health-gates dependencies, registers admin, mints the `setup` **service-account** key the template and compliance loads run with, plus the `official-catalog-loader` key the plugin load runs with, and drives them), `load-plugins.sh` / `load-plugin-worker.sh`, `load-templates.sh`, `load-compliance.sh`. The admin signs in **once**: everything after that authenticates with a 24-hour `pb_sa_…` key (`SETUP_KEY_TTL_SECONDS` to change), so no password is replayed between steps and nothing durable is left behind — see [Authentication → Service accounts](../docs/authentication.md#service-accounts).
- **Secrets / TLS** — `gen-env-secrets.sh` (`pb_gen_env_secrets` fills the `.env` `CHANGE_ME` credentials with fresh random values and asserts none remain), `jwt-keys.sh` (registry signing keypair), `nginx-tls.sh` (gateway TLS), `mongo-keyfile.sh` (`pb_ensure_mongo_keyfile` — the replica-set keyfile, generated **per deploy**, never committed).
- **Helpers** — `common.sh` (logging, retries, `preflight <tools…>`, `curl_with_retry`, health waits, image-tag hashing, `mc_setup_aliases`, `PB_MINIO_BUCKETS`), `k8s-resources.sh` (the whole k8s bring-up every kubectl target shares: Secret/ConfigMap creators, pinned KEDA / Istio ambient / Gateway API installs, the istiod-gated apply + mesh re-enrollment restart, `pb_lean_filter`), `db-connect.sh`, `cfn-deploy.sh`, `provision-docker.sh`.
- **Env** — each target owns its `.env.example` outright ([`local/docker`](local/docker/.env.example), [`local/minikube`](local/minikube/.env.example), [`aws/ec2`](aws/ec2/.env.example), [`aws/eks`](aws/eks/.env.example)); there is no template and no generator. **A new key must be added to all four by hand.** The `.env.example` key-parity contract test (`test/deploy-contracts/test/env-contract.test.ts`) catches the omission: every key must exist in all four files unless it is declared in that test's `TARGET_SPECIFIC` table with the exact targets it belongs to.

## Per-target config

There is no shared config directory: **every file a target needs lives in that target's own tree**, and a target's bring-up never reads a path outside it. docker-compose mounts its own copies by relative path (`./postgres-init.sql`, …); the kubectl targets build their ConfigMaps out of the target directory `pb_create_config_maps` is handed in `bin/k8s-resources.sh`. The three k8s targets keep standalone manifest trees (no shared kustomize base), and their observability and gateway configs are per-target copies too. Where copies must match, a deploy contract test ([`test/deploy-contracts`](../test/deploy-contracts/)) holds them equal: `postgres-init.sql` (schema + RLS), `mongodb-init.js`, the njs gateway modules `nginx/jwt.js` + `nginx/metrics.js`, the observability configs `config/loki/loki-config.yml` / `config/alertmanager/alertmanager.yml` / `config/thanos/objstore.yml`, and the projen-generated `services.txt` across all four; alert rules and promtail across the k8s targets; the Grafana dashboards across all four; the AWS gateways' `nginx.conf` / `admin-uis-disabled.conf` / `registry-auth.js`; and the per-org namespace templates. `nginx.conf` across all targets is drift-checked region by region (`nginx-drift.test.ts`), allowing differences only inside declared target-specific regions.

`services.txt` (`<kind> <name> <dir>`, generated into every target by projen from `.projenrc.ts`) is the one list of services/libraries the deploy scripts read: `service-signing-keys.sh` takes the copy belonging to the target whose `certs/` directory it was given, while the two repo-wide scripts (`sync-image-tags.sh`, `verify-npm-deps.sh`) run for no single target and read the docker copy.

> **Backup/restore** is one implementation, `bin/backup.sh` + `bin/restore.sh` (`--connect k8s|direct`, tunnels in `bin/db-connect.sh`); each target's `bin/backup.sh` / `bin/restore.sh` is a wrapper that picks the mode (kubectl port-forward for minikube/ec2/eks, direct for docker). Both dump/restore Postgres + Mongo to/from S3 (`restore.sh` needs `--confirm-destructive`) and optionally mirror every MinIO bucket (`PB_MINIO_BUCKETS` in `bin/common.sh`). See the [operations runbook](../docs/deploy-operations.md#backups--disaster-recovery) for scheduling + DR.

## Conventions

- **Secrets are generated per-deploy.** `.env` is seeded from `.env.example` on first run and its `CHANGE_ME` placeholders filled by `pb_gen_env_secrets`; the Mongo keyfile is generated by `pb_ensure_mongo_keyfile`. Neither `.env` nor `mongodb-keyfile` is tracked in git.
- **Idempotent + re-run safe.** Cert/keyfile/secret generators skip-if-exists; provisioning guards `.env` regeneration so DB passwords aren't rotated out from under existing data.
- **Platform matters for local builds.** On Apple Silicon, local plugin images build native `linux/arm64` (building `amd64` under QEMU segfaults the Rust base). AWS targets build `linux/amd64` for CodeBuild.
- **`chmod 644` on TLS/JWT key files is intentional** (do not tighten). The Mongo keyfile is `600` (MongoDB requires it).
- **Third-party images are pinned by DIGEST; first-party images are pinned by TAG.** Every image outside `ghcr.io/mwashburn160/*` is referenced as `repo@sha256:…` with its human-readable tag in a trailing comment, in every target (compose + all three `k8s/` trees). A floating tag like `postgres:18` or `redis:8-alpine` silently changes underneath a re-provision, so two installs of the same commit could run different bytes; a digest makes the manifest say exactly what runs. The comment is what you read and what you bump. **To update one**: `docker buildx imagetools inspect <repo>:<newtag>` → take the `Digest:` line (that is the multi-arch INDEX digest, so it still resolves per-architecture), then change the digest, the comment, and every target together. First-party tags stay tags on purpose — `sync-image-tags.sh` rewrites them from each service's `package.json` version and `verify-image-tags.sh` asserts each one is publicly pullable, and both work on tags.
- **Every target runs an Istio ambient service mesh** (STRICT mTLS + identity-based L4 authorization). The provisioning script installs it after KEDA; policies live in each tree's `k8s/istio.yaml`, and the namespace is enrolled via the `istio.io/dataplane-mode: ambient` label. `istioctl` is a required tool. Verify with `istioctl ztunnel-config workloads` (every pod `HBONE`). Full model + troubleshooting: [docs/service-mesh.md](../docs/service-mesh.md).

## Not covered here

Plugin sources, sample pipeline templates, compliance rule/policy seeds, and the CodeBuild bootstrap image live in sibling dirs — [`plugins/`](plugins/), [`samples/`](samples/), [`compliance/`](compliance/), [`codebuild/`](codebuild/) — and are loaded by the `load-*` / `init-platform.sh` steps above.
