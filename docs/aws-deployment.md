---
layout: default
title: AWS Deployment
---

# AWS Deployment

Two deployment options: **EC2** (single Minikube instance) or **EKS** (managed Kubernetes — EKS Auto Mode).

Both deploy the full stack: app services, databases, observability (Prometheus + Loki, surfaced via the native `/dashboard/observability` page), and admin tools. Both front the workload with an **ALB that terminates TLS using an ACM cert** (DNS-validated); the compute is always in private subnets. A domain + public Route 53 zone is required.

Observability is the native `/dashboard/observability` page across all deployments. Five dashboards (Platform Overview, Plugin Builds, Queue Health, Registry Activity, Audit Activity) are seeded into the database at platform cold start as public `org_id='system'` rows, so they appear automatically for any logged-in org and open at `/dashboard/observability/<id>`. Audit Activity also has a dedicated page at `/dashboard/observability/audit-activity`.

**Related docs:** [Environment Variables](environment-variables.md) | [API Reference](api-reference.md) | [Plugin Catalog](plugins/README.md)

## Table of Contents

- [AI-assisted install (`provision`)](#ai-assisted-install-provision) -- The recommended way to install the platform
- [Deployment modes](#deployment-modes-public-vs-private) -- Public vs private, and what each changes
- [Public deployment (quickstart)](#public-deployment-quickstart) -- Internet-facing install, EC2 or EKS
- [Private deployment (quickstart)](#private-deployment-quickstart) -- Inside-AWS-only install, EC2 or EKS
- [EC2](#ec2) -- Single Minikube instance (dev/staging, ~$140-265/mo)
- [EKS](#eks) -- Managed Kubernetes, EKS Auto Mode (production, ~$150-400/mo)
- [Email (SES)](#email-ses) -- Transactional email (provisioned by default; `--no-email` to skip)
- [Post-Deploy Steps](#post-deploy-steps) -- Platform init, credentials, EventBridge reporting
- [Drift Detection (`audit-stacks`)](#drift-detection-audit-stacks) -- Reconcile registry vs live CloudFormation
- [Report API Endpoints](#report-api-endpoints) -- Execution and plugin analytics
- [Access Points](#access-points) -- Service URLs after deployment
- [File Structure](#file-structure) -- Deployment file layout
- [Troubleshooting](#troubleshooting) -- Common issues and fixes

| | EC2 | EKS |
|--|-----|-----|
| Runtime | Minikube on EC2 | EKS Auto Mode (Karpenter-scaled EC2 nodes) |
| Infra | 1 CloudFormation stack | eksctl cluster + Kubernetes manifests |
| TLS | ACM cert at the ALB | ACM cert at the ALB Ingress |
| Public surface | ALB only (instance private) | ALB Ingress only (nodes private) |
| Storage | hostPath PVCs on EBS | EBS (RWO) + EFS (RWX) via CSI |
| Scaling | Vertical (instance resize) | Horizontal (Karpenter nodes + pod autoscaling) |
| Cost | ~$140-265/mo (t3.xlarge–t3.2xlarge, 24/7) | ~$150-400/mo |
| Best for | Dev/staging | Production |

---

## AI-assisted install (`provision`)

The **recommended** way to install the platform is `pipeline-manager provision`. It picks the target, runs prerequisite checks (AWS CLI + working credentials for EC2/EKS — plus `kubectl`, `openssl`, and `envsubst` for EKS (`eksctl` is auto-installed by `setup.sh`); Docker etc. for local), assembles the **exact, validated `setup.sh` command** (secrets masked, missing inputs reported rather than guessed), prints the plan, and then **deploys it — gated by confirmation prompts** (`--yes` to auto-accept for CI; `--json` prints the plan and runs nothing). With an AI key configured it also parses a natural-language goal and diagnoses CloudFormation failures.

```bash
npm install -g @pipeline-builder/pipeline-manager

# Deploy (shows the plan, then confirms; add --yes for non-interactive CI):
pipeline-manager provision --target eks \
  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx --email

# Inspect the plan as JSON without running anything:
pipeline-manager provision --target eks --json \
  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx --email

# Or describe the goal (needs an AI key — see Environment Variables):
pipeline-manager provision --prompt "deploy to EKS in us-east-1 with email enabled"

# Diagnose a failed deploy:
pipeline-manager provision --target eks --diagnose ./stack-events.txt
```

> **Always deploys (gated).** `provision` checks, assembles, prints the plan, and runs the deploy — it **refuses** on failed prerequisites or missing inputs, asks for confirmation before deploying (**`--yes`** auto-accepts for CI), streams the deploy to your terminal, then verifies `/health` + `/ready` on the application URL. On the **AWS targets the deploy self-inits** (EC2 on first boot; EKS in `setup.sh`'s final phase), so `provision` surfaces it rather than running it separately; on **local/minikube** `provision` runs `init-platform` for you. **`--json`** is the only non-executing mode — it prints the plan and exits (for tooling).
>
> **On failure it troubleshoots.** It matches known CloudFormation signatures and prints the likely cause + fix — and for a few it can **auto-fix and retry** (e.g. an existing SES identity → re-run with `--skip-ses-identity`; an ACM/DNS-propagation timeout → resume). Retries are gated and bounded by **`--retries <n>`** (default 1; the scripts are idempotent so a re-run resumes). With an AI key it adds a free-form diagnosis on top. When SES is enabled, a successful deploy prints DKIM/sandbox next-steps.
>
> Flags: **`--yes`** auto-approves (CI), **`--retries <n>`** auto-fix/retry budget, **`--init <mode>`** controls post-deploy initialization (`auto` default / `manual` / `skip` — see below), **`--skip-ses-identity`** for an already-verified SES domain, **`--stack-name <name>`** (EC2) / **`--cluster-name <name>`** (EKS) to deploy/manage a second environment.
>
> **Init mode (`--init <mode>`).** One flag controls how the platform initializes after deploy:
> - **`auto`** (default) — `init-platform` runs once the platform is up, registering the admin (with the **default** password) and loading plugins/compliance/samples. The **AWS targets self-run it as part of the deploy**: **EC2** on first boot (UserData → on the box as the `minikube` user — watch with `aws ssm start-session … && sudo tail -f /var/log/user-data.log`); **EKS** in `setup.sh`'s final phase, reaching the cluster over a `kubectl port-forward`. **local/minikube** run it from `provision`.
> - **`manual`** — don't init; `provision` surfaces the exact step for you to run yourself (do this to set real admin credentials `PLATFORM_IDENTIFIER`/`PLATFORM_PASSWORD` instead of the default).
> - **`skip`** — don't initialize at all (no register, no loads).
>
> **Teardown.** Add **`--teardown`** to remove a deployment. `local`/`minikube` stop the stack (on-disk / PVC data persists). **EC2 DELETEs its CloudFormation stack and EKS runs `bin/shutdown.sh` (deletes the cluster, EFS, ACM cert + Route 53 alias) — both irreversible** — so the destructive path is gated harder than deploy: you must **type the resource id** to confirm (a y/N is too easy to fat-finger), and **`--yes` alone does *not* bypass it** — only **`--force`** does (for CI). When you pass a custom **`--stack-name <name>`** (EC2) or **`--cluster-name <name>`** (EKS), the confirmation binds to that name — you type the **stack/cluster name**, not the target id, so a wrong name can't be confirmed by habit. The region comes from **`--region`** / `AWS_REGION`. As always, `bin/shutdown.sh` (local/minikube/EKS) and `aws cloudformation delete-stack` (EC2) can be run directly.
>
> ```bash
> # Teardown — prints the destroy plan, then prompts (type "eks" to confirm):
> pipeline-manager provision --target eks --teardown
> ```
>
> **Bootstrap a fresh machine (`--repo`).** Without a checkout, `--repo` git-clones the platform repo first and runs from it. The clone is **sparse + partial** — `git clone --filter=blob:none --no-checkout` + cone `sparse-checkout` (git ≥ 2.27; older git falls back to a full clone) — so it materializes **only the deploy folders the selected target + options need**, not the whole repo (`packages/`, `api/`, `frontend/`, … are never downloaded). The common base is just `deploy/bin`; each target adds its own folder (`deploy/local/docker`, `deploy/local/minikube` — self-contained — `deploy/aws/ec2`, `deploy/aws/eks`), and each post-install load adds its folder. Re-syncs are **additive** (`sparse-checkout add`), so one `--workdir` can accumulate multiple targets. Override with `--repo <url>`, `--ref <branch|tag>`, `--workdir <dir>`. (`--ref` is a branch/tag; arbitrary SHAs may not fetch under the shallow clone.)
>
> **Post-install steps.** After deploy + health, `provision` registers the admin (non-interactive with `--admin-email`/`--admin-password`, which set `PLATFORM_IDENTIFIER`/`PLATFORM_PASSWORD`) and runs **opt-in** loads — each also pulls its folder into the sparse clone: `--with-plugins` (build + load plugins; adds `deploy/plugins` + `deploy/codebuild`), `--with-compliance` (`deploy/compliance`), `--with-samples` (`deploy/samples`), or `--with-all`. Also `--build-bootstrap` (CodeBuild bootstrap image), `--with-smoke-test` (read-only API check), `--with-events` (EC2/EKS event ingestion — a two-step bundle: **`store-token`** writes a platform JWT to Secrets Manager at the `pipeline-builder/{orgId}/platform` pattern, then **`setup-events`** deploys the EventBridge → SQS → Lambda that reads it; both pull AWS creds from the standard env / `~/.aws` chain), and repeatable `--post-step "<cmd>"`. The default is **register-only** (minimal clone); the loads are deterministic + idempotent, so re-running with more options just layers them on. On the AWS targets these loads run **deploy-side by default** (so `provision` doesn't prompt for them locally) — EC2 on first boot, EKS in `setup.sh`'s final phase over a `kubectl port-forward`. Pass `--init manual` to drive them yourself.
>
> ```bash
> # Fresh box → sparse-clone just deploy/bin + deploy/local/docker, deploy, register, load samples:
> pipeline-manager provision --target docker --repo --with-samples --yes \
>   --admin-email admin@acme.com --admin-password 's3cret'
> ```

The underlying `bin/setup.sh` scripts remain the source of truth and can always be run directly — the rest of this guide documents them.

---

## Deployment modes (public vs private)

Either target (EC2 or EKS) deploys in one of two modes. **Both** put the compute in **private subnets** and terminate TLS at an ALB with a publicly-trusted, **DNS-validated ACM cert** — so both **require `--domain` + `--hosted-zone-id`** (the public Route 53 zone is where ACM validates the cert). The mode flips only the **ALB scheme** and the **DNS record**:

| | `private` (inside-AWS-only, **default**) | `public` |
|---|---|---|
| ALB scheme | internal, private subnets | internet-facing, public subnets |
| Compute (instance / tasks) | private subnet, no public IP | private subnet, no public IP |
| DNS | Route 53 **private** zone alias → internal ALB | public Route 53 alias → ALB |
| Reachable from | inside the VPC (peered / VPN / Direct Connect) | the public internet |
| CodeBuild | **VPC-attached** (`PIPELINE_VPC_ID` / `SUBNET_IDS` / `SECURITY_GROUP_IDS`) | AWS-managed network, reaches the ALB over the internet |
| Plugin pull | `https://<domain>/v2/` (resolves in-VPC) | `https://<domain>/v2/` (public) |

In **`private`** mode, **EC2** folds the VPC interface endpoints (S3, Logs, Secrets Manager, KMS, STS, CodeBuild, ECR) **and** the Route 53 private-zone alias to the internal ALB into its single stack, gated on `DeployMode=private` (no separate prereqs stack). **EKS** sets the ALB Ingress to `scheme: internal` and aliases the domain to it; eksctl provisions the cluster VPC (public + private subnets, NAT). Both request a DNS-validated ACM cert and alias the domain to the ALB (public alias or private zone). For VPC-attached CodeBuild plugin pulls, supply `PIPELINE_VPC_ID` / `SUBNET_IDS` and build-dependency egress (NAT / internal mirrors).

Use the matching quickstart below: **[Public](#public-deployment-quickstart)** or **[Private](#private-deployment-quickstart)**.

---

## Public deployment (quickstart)

A **public** deployment uses an **internet-facing ALB** so the dashboard, API, and plugin registry are reachable from the internet over HTTPS (the compute still stays private behind it). See [Deployment modes](#deployment-modes-public-vs-private) for the full comparison.

### Prerequisites (both targets)

- **AWS CLI** configured with credentials for the target account/region.
- A **registered domain** and its **public Route 53 hosted zone** — required. The stack requests a DNS-validated ACM cert for the domain against this zone, so setup.sh refuses to start without `--domain` + `--hosted-zone-id`.
- A **GitHub account + personal access token (PAT)**. The service images live on GitHub Container Registry (`ghcr.io/mwashburn160/*`); they're public, but GitHub rate-limits *anonymous* pulls (60/hr) which trips mid-deploy when all 10 images pull at once. **Generate your own PAT under your GitHub account**: on GitHub go to **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)** (https://github.com/settings/tokens) and check only the `read:packages` scope. Then pass `--ghcr-token <your-pat>` (ghcr.io validates only the token for PAT auth — there is no username flag to set; the deploy uses a fixed internal value). Don't reuse a token from these docs or another deployment. See [GhcrToken rejected](#troubleshooting) for the fine-grained-PAT option and details.
- **EC2 only:** an EC2 **key pair** in the target region (`--key-pair`) for break-glass serial-console access (routine access is via SSM).

### 1. Deploy in public mode

Pick the target. Both take `--deploy-mode public`; everything else matches the private flow.

```bash
# EC2 — single Minikube instance behind an internet-facing ALB
cd deploy/aws/ec2
bash bin/setup.sh --deploy-mode public \
  --key-pair my-keypair \
  --domain pipeline.example.com \
  --hosted-zone-id Z1234567890 \
  --ghcr-token ghp_xxxxxxxxxxxx

# EKS — managed Kubernetes (Auto Mode) behind an internet-facing ALB Ingress
cd deploy/aws/eks
bash bin/setup.sh --deploy-mode public \
  --domain pipeline.example.com \
  --hosted-zone-id Z1234567890 \
  --ghcr-token ghp_xxxxxxxxxxxx
```

The ACM cert DNS-validates **during** the deploy, so expect `setup.sh` to wait a few minutes for the cert to reach `ISSUED` (EC2: while CloudFormation is `CREATE_IN_PROGRESS`; EKS: `aws acm wait certificate-validated`). `setup.sh` runs from your machine with your credentials. The EC2 [Deploy](#deploy) section also shows the raw-CloudFormation equivalent.

### 2. Get the URL

The URL is simply `https://<your-domain>` (the value you passed to `--domain`), reachable once the Route 53 alias resolves and the target(s) pass health checks — a few minutes after the stack completes, while the instance bootstraps / tasks start. To read it back from the stack outputs:

```bash
# EC2 — ApplicationURL output is the full https:// URL
aws cloudformation describe-stacks --stack-name pipeline-builder \
  --query 'Stacks[0].Outputs[?OutputKey==`ApplicationURL`].OutputValue' --output text

# EKS — the URL is https://<your-domain> (the Route 53 alias setup.sh creates → the ALB Ingress).
# Confirm the ALB hostname the Ingress was assigned:
kubectl get ingress pb-ingress -n pipeline-builder \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

### 3. Initialize the platform

Public install is otherwise identical to private — by default the admin user is registered and plugins loaded automatically (EC2 self-inits on first boot; EKS self-inits in `setup.sh`'s final phase over a `kubectl port-forward`). To do it yourself, deploy with `--init manual` and follow [Post-Deploy Steps](#post-deploy-steps).

> **Note:** "public" exposes only the ALB. The instance/nodes have **no public IP and no inbound SSH**; admin access is still **SSM Session Manager** (EC2) or `kubectl` (EKS). To make a deployment internal-only later, redeploy with `--deploy-mode private` (default). See [Deployment mode (`DEPLOY_MODE`)](#deployment-mode-deploy_mode) for the full mode comparison.

---

## Private deployment (quickstart)

A **private** deployment uses an **internal-scheme ALB** — reachable only from inside your AWS network (the VPC, peered VPCs, or via VPN / Direct Connect), never the public internet. **This is the default mode.** See [Deployment modes](#deployment-modes-public-vs-private) for the full comparison.

### Prerequisites (both targets)

Identical to the [Public quickstart](#prerequisites-both-targets) above: AWS CLI, a registered **domain + public Route 53 hosted zone**, a GitHub **PAT** (`--ghcr-token`), and — EC2 only — an EC2 **key pair**.

> The **public** Route 53 hosted zone is still required even in private mode: ACM validates the cert via a public DNS record. The *private* hosted zone (for in-VPC resolution of your domain) is created automatically by the stack — you don't supply it.

### 1. Deploy in private mode

`private` is the default, so `--deploy-mode private` is optional (shown for clarity). Same flags as public, minus the public exposure.

```bash
# EC2 — single Minikube instance behind an internal ALB
cd deploy/aws/ec2
bash bin/setup.sh --deploy-mode private \
  --key-pair my-keypair \
  --domain pipeline.example.com \
  --hosted-zone-id Z1234567890 \
  --ghcr-token ghp_xxxxxxxxxxxx

# EKS — managed Kubernetes (Auto Mode) behind an internal ALB Ingress
cd deploy/aws/eks
bash bin/setup.sh --deploy-mode private \
  --domain pipeline.example.com \
  --hosted-zone-id Z1234567890 \
  --ghcr-token ghp_xxxxxxxxxxxx
```

In private mode, **EC2** also folds the VPC interface endpoints (S3, Logs, Secrets Manager, KMS, STS, CodeBuild, ECR) and the Route 53 private-zone alias to the internal ALB into its single stack (gated on `DeployMode=private`, no separate prereqs stack). **EKS** sets the ALB Ingress to `scheme: internal` and aliases the domain to it. Either way the ACM cert still DNS-validates during the deploy, so expect a few minutes of waiting for it to issue.

### 2. Get the URL

The URL is the same `https://<your-domain>`, but it **resolves only from inside the VPC** (via the private hosted zone) — it will not resolve from your laptop or the public internet. For EC2, read it back from the stack output (`ApplicationURL`); for EKS the URL is `https://<your-domain>` from the Route 53 alias, and you can confirm the ALB hostname as in the [public step 2](#2-get-the-url).

### 3. Initialize the platform

**By default this happens automatically.** EC2 runs `init-platform.sh ec2` on first boot (as the `minikube` user, in-VPC); EKS runs `init-platform.sh eks` from `setup.sh`'s final phase over a `kubectl port-forward` to `svc/nginx`. Both register the admin (default password) and load plugins/compliance/samples — watch EC2 with `sudo tail -f /var/log/user-data.log` (after SSM).

If you deployed with **`--init manual`** (or want to re-run / set real admin creds):

- **EC2** — SSM into the instance (`aws ssm start-session --target <instance-id>`), `sudo -iu minikube`, `cd /opt/pipeline/pipeline-builder`, then run `./deploy/bin/init-platform.sh ec2`; it's already in-VPC.
- **EKS** — run `./deploy/bin/init-platform.sh eks` with `kubectl` access to the cluster. It port-forwards `svc/nginx` (8080), so it works without the domain resolving — no VPC-attached host required.

Then load plugins per [Post-Deploy Steps](#post-deploy-steps).

> **Note:** private mode also wires CodeBuild into the VPC (`PIPELINE_VPC_ID` / `SUBNET_IDS` from the foundation VPC) so it can reach the internal ALB and pull plugin images over `https://<domain>/v2/`. You still supply egress (NAT / package mirrors) for build dependencies. See [Deployment mode (`DEPLOY_MODE`)](#deployment-mode-deploy_mode) for the full comparison.

---

## EC2

Single hardened EC2 instance running Minikube with all services.

### Prerequisites

- AWS CLI configured
- EC2 key pair in target region
- A registered domain + its **public Route 53 hosted zone** (required — the template requests a DNS-validated ACM cert against it; required in both `public` and `private` mode)

### Deploy

For the one-command happy path, use the [Public](#public-deployment-quickstart) or [Private](#private-deployment-quickstart) quickstart — both run `bin/setup.sh` from your machine with your credentials (so the instance role needs no CloudFormation permissions). An **ALB fronts the always-private instance** and terminates TLS with an **ACM cert** the template DNS-validates against your zone, so `--domain` + `--hosted-zone-id` are required; `setup.sh` refuses to start without them.

**Manual alternative (raw CloudFormation).** Deploys the same single stack — nothing to follow up with. The ACM cert DNS-validates during stack creation, so expect a few minutes in `CREATE_IN_PROGRESS`:

```bash
cd deploy/aws/ec2

aws cloudformation deploy \
  --stack-name pipeline-builder \
  --template-file template.yaml \
  --parameter-overrides \
    DeployMode=private \
    DomainName=pipeline.example.com \
    HostedZoneId=Z1234567890 \
    KeyPairName=my-keypair \
    GhcrToken=ghp_xxxxxxxxxxxx \
  --capabilities CAPABILITY_IAM
# (DeployMode=public for an internet-facing ALB; domain + zone still required.)
```

Get the URL:

```bash
aws cloudformation describe-stacks --stack-name pipeline-builder \
  --query 'Stacks[0].Outputs[?OutputKey==`ApplicationURL`].OutputValue' --output text
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `KeyPairName` | Yes | — | EC2 key pair (serial-console/break-glass; routine access is via SSM) |
| `GhcrToken` | Yes | — | GHCR token for pulling images |
| `DomainName` | **Yes** | — | FQDN — ACM cert + Route 53 alias to the ALB |
| `HostedZoneId` | **Yes** | — | Public Route 53 zone ID (ACM DNS validation + alias) |
| `InstanceType` | No | `t3.2xlarge` | EC2 instance type (8 vCPU / 32 GiB; full stack fits with the default ResourceQuota) |
| `EbsVolumeSize` | No | `60` | Root volume size in GiB (OS, binaries) |
| `DataVolumeSize` | No | `500` | Data volume size in GiB (`/opt/pipeline`, gp3 encrypted) — Docker, plugins, registry, databases. Lower to ~200 for slim/`build_image` deploys. |
| `GitRepo` | No | *(this repo)* | Git repository URL |
| `GitBranch` | No | `main` | Branch to deploy |

### Storage Requirements

The EC2 deployment uses two EBS volumes:

| Volume | Default | Mount | Contents |
|--------|---------|-------|----------|
| **Root** | 60 GiB | `/` | OS, Docker/minikube binaries, app code |
| **Data** | 500 GiB | `/opt/pipeline` | Docker layers, plugin artifacts, registry, databases, logs |

Data volume breakdown:

| Component | build_image | prebuilt | prebuilt + --cleanup |
|-----------|-------------|----------|---------------------|
| Docker build cache + images | 20-30 GB | 60-90 GB | 60-90 GB |
| Plugin artifacts (image.tar + plugin.zip) | 0 GB | 130-190 GB | 0 GB |
| Registry (pushed images) | 40-60 GB | 40-60 GB | 40-60 GB |
| PostgreSQL + MongoDB | 5-15 GB | 5-15 GB | 5-15 GB |
| Minikube + logs + metrics | 15-25 GB | 15-25 GB | 15-25 GB |
| **Total** | **80-130 GB** | **250-380 GB** | **120-190 GB** |

**Recommendations:**

| Plugin strategy | Data volume | Notes |
|----------------|-------------|-------|
| `build_image` (default) | 200 GB | Builds from Dockerfile at upload time |
| `prebuilt` with `--cleanup` | 250 GB | Removes artifacts after upload |
| `prebuilt` without cleanup | 500 GB | Keeps artifacts for re-runs |

Daily runtime operations (after initial plugin load) add ~1-5 GB/month from database growth and logs. Add a weekly Docker prune cron to reclaim build cache:

```bash
# /etc/cron.weekly/docker-prune
docker system prune -af --filter "until=168h"
```

### Expanding EBS Volume

If you need more storage after deployment (e.g., switching to prebuilt), expand the data volume live — no reboot required:

```bash
# 1. Find the data volume ID
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT \
  http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600')" \
  http://169.254.169.254/latest/meta-data/instance-id)

VOL_ID=$(aws ec2 describe-volumes \
  --filters "Name=attachment.instance-id,Values=$INSTANCE_ID" "Name=tag:Name,Values=*data*" \
  --query 'Volumes[0].VolumeId' --output text)

# 2. Expand to desired size (e.g., 500 GiB for prebuilt)
aws ec2 modify-volume --volume-id $VOL_ID --size 500

# 3. Wait for modification to complete (~30s)
watch -n5 "aws ec2 describe-volumes-modifications --volume-ids $VOL_ID \
  --query 'VolumesModifications[0].ModificationState' --output text"
# Wait until it shows "optimizing" or "completed"

# 4. Grow the partition and filesystem (on the EC2 instance)
DEVICE=$(lsblk -no PKNAME $(findmnt -n -o SOURCE /opt/pipeline))
PART=$(lsblk -no PARTNUM $(findmnt -n -o SOURCE /opt/pipeline) 2>/dev/null)
[ -n "$PART" ] && sudo growpart /dev/$DEVICE $PART
sudo xfs_growfs /opt/pipeline    # XFS filesystem
# or: sudo resize2fs $(findmnt -n -o SOURCE /opt/pipeline)   # ext4 filesystem

# 5. Verify
df -h /opt/pipeline
```

Deploy with a larger data volume upfront:
```bash
aws cloudformation deploy \
  --stack-name pipeline-builder \
  --template-file template.yaml \
  --parameter-overrides \
    DataVolumeSize=500 \
    KeyPairName=my-key \
    GhcrToken=ghp_xxx \
  --capabilities CAPABILITY_IAM
```

### What Happens

1. CloudFormation creates the VPC (2 AZs: public + private subnets), NAT gateway, ALB + ACM cert, security groups, the **private** EC2 instance, and the Route 53 alias to the ALB
2. EC2 UserData clones the repo and runs `bootstrap.sh`, which:
   - Updates OS, installs fail2ban, disables SSH password auth
   - Installs Docker, Minikube, kubectl
   - Generates `.env` with random secrets (JWT keys, DB passwords)
   - Starts Minikube, deploys all K8s manifests
   - Sets one iptables bridge: instance `:30080` → Minikube NodePort `30080` (the ALB target). TLS is terminated at the ALB (ACM) — no cert on the box.

### Post-Deploy

The instance is private (no public IP); use **SSM**:

```bash
# Watch bootstrap progress
aws ssm start-session --target <instance-id>   # then: sudo tail -f /var/log/user-data.log

# Check pods
aws ssm start-session --target <instance-id>   # then: sudo -u minikube kubectl get pods -n pipeline-builder
```

The ALB target reports **unhealthy (503)** until the instance finishes bootstrapping Minikube + services — expected; it self-heals.

### Scripts

All in `deploy/aws/ec2/bin/`. On the instance the repo is checked out under the
data volume, so the scripts live at `/opt/pipeline/pipeline-builder/deploy/aws/ec2/bin/`.

| Script | Purpose | Run as |
|--------|---------|--------|
| `setup.sh` | Deploy the stack (private mode folds endpoints + private zone into it) — from your machine | operator |
| `bootstrap.sh` | Full EC2 setup (runs automatically via UserData) | root |
| `startup.sh` | Start Minikube + deploy K8s manifests + the ALB-target iptables bridge | root (sudo) |
| `shutdown.sh` | Stop Minikube + remove iptables rules | root (sudo) |

The instance has **no public IP / no SSH** — connect with SSM Session Manager first:

```bash
aws ssm start-session --target <instance-id>   # then, on the instance:

# Start (after bootstrap or reboot)
sudo bash /opt/pipeline/pipeline-builder/deploy/aws/ec2/bin/startup.sh

# Stop
sudo bash /opt/pipeline/pipeline-builder/deploy/aws/ec2/bin/shutdown.sh

# Check pod status
sudo -u minikube kubectl get pods -n pipeline-builder
```

### Security

- **Instance is always private** — no public IP; the internet-facing ALB is the only public surface
- **Instance SG: only the ALB SG → `30080`** — no `0.0.0.0/0`, no public SSH (port 22 closed; access via **SSM Session Manager**)
- **TLS terminated at the ALB with an ACM cert** (no private key on the box); HTTPS-only (TLS1.2+), `80`→`443` redirect at the ALB
- IMDSv2 required (token-based metadata); encrypted gp3 EBS; automatic security updates (dnf-automatic)

### TLS

TLS is terminated at the **ALB** with an **ACM certificate** the template requests and DNS-validates against `HostedZoneId`. ACM auto-renews it; there is no certbot/Let's Encrypt and no cert on the instance. nginx serves plain HTTP behind the ALB.

### Deployment mode (`DEPLOY_MODE`)

See [Deployment modes](#deployment-modes-public-vs-private) for the public/private comparison and what each changes. `DEPLOY_MODE` defaults to `private`; pass `--deploy-mode public` (or `DEPLOY_MODE=public`) for the internet-facing posture. The instance is always private and TLS is always ACM-at-the-ALB regardless of mode; the private-mode VPC endpoints + private-zone alias are folded into the single stack (gated on `DeployMode=private`) — no separate prereqs stack.

`DEPLOY_MODE` and the VPC identity (`PIPELINE_VPC_ID` / `PIPELINE_SUBNET_IDS`) are **injected into the instance `.env` automatically** by `bootstrap.sh` (exported from the template's UserData, from the stack's VPC + private subnets) — and passed through to the first-boot init — so the synthesized CodeBuild attaches to the VPC and `init-platform.sh`'s private-mode preflight passes with no manual step. (If you run `init-platform.sh` by hand on the box, the values are already in `.env`.)

### Teardown

```bash
aws cloudformation delete-stack --stack-name pipeline-builder
aws cloudformation wait stack-delete-complete --stack-name pipeline-builder
```

---

## EKS

Managed Kubernetes on **Amazon EKS Auto Mode** — AWS-managed, Karpenter-scaled EC2 nodes with the AWS Load Balancer Controller, EBS CSI, and CoreDNS built in (EFS CSI added by the deploy). One orchestrator script stands up the cluster and applies the same Kubernetes workloads as the minikube/ec2 targets, tuned for multi-node (PVC storage, ALB Ingress).

> **Why EKS Auto Mode?** Plugin/base images are built with **rootless BuildKit**, which needs an *unconfined seccomp profile* to create its user namespace — only possible on **EC2-backed** Kubernetes nodes (`securityContext.seccompProfile: Unconfined`). Auto Mode keeps node management hands-off while running on EC2, so BuildKit works and the proven k8s manifests are reused as-is.

### Prerequisites

- **AWS CLI** + working credentials for the target account/region.
- **`eksctl`** (creates/destroys the Auto Mode cluster) — **auto-installed** by `setup.sh`/`shutdown.sh` (latest binary) when it isn't already on PATH.
- **`kubectl`** (applies the manifests), **`openssl`** (registry token keypair), and **`envsubst`** (renders `cluster.yaml` + the manifests). `provision` checks all of these; `deploy/bin/provision-docker.sh --target eks` installs them in a throwaway container if you'd rather not put them on your host.
- A registered domain + its **public Route 53 hosted zone** (required — the deploy requests a DNS-validated ACM cert against it).

### Deploy

Use the [Public](#public-deployment-quickstart) or [Private](#private-deployment-quickstart) quickstart for the one-command path — `bin/setup.sh` runs all phases end to end. It requests a **DNS-validated ACM cert** for `--domain` and terminates TLS at the **ALB Ingress** (no certbot, no self-signed cert), so `--domain` + `--hosted-zone-id` are required in both modes. The cert validates mid-deploy (`aws acm wait certificate-validated`), so expect a few minutes of waiting there.

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--domain` | **Yes** | — | FQDN — ACM cert + Route 53 alias to the ALB Ingress |
| `--hosted-zone-id` | **Yes** | — | Public Route 53 zone ID (ACM DNS validation + alias) |
| `--ghcr-token` | Yes | — | GHCR token for pulling the service images |
| `--deploy-mode` | No | `private` | `public` (internet-facing ALB) or `private` (internal) |
| `--cluster-name` | No | `pipeline-builder` | EKS cluster name (set a second one to run multiple environments) |
| `--no-email` | No | — | Skip SES (transactional email is provisioned **by default**) |
| `--email-from` | No | `noreply@<domain>` | From address SES sends as |
| `--email-from-name` | No | `pipeline-builder` | Display name on outbound email |
| `--no-create-ses-identity` | No | — | Skip creating the SES identity (domain already verified in this account) |
| `--alert-email` | No | — | Subscribe an address to the SES bounce/complaint SNS topic |
| `--region` | No | `us-east-1` | AWS region |

### Deployment mode (`DEPLOY_MODE`)

See [Deployment modes](#deployment-modes-public-vs-private) for the public/private comparison. `DEPLOY_MODE` defaults to `private`; set it in the env before `setup.sh` or use `--deploy-mode public`. On EKS it controls only the **ALB Ingress scheme** — `internal` (private) vs `internet-facing` (public) — and the Route 53 record. For VPC-attached CodeBuild plugin pulls in private mode, supply `PIPELINE_VPC_ID` / `SUBNET_IDS` (the eksctl cluster VPC).

### Phases

`bin/setup.sh` runs these in order — there are no per-component CloudFormation stacks (eksctl manages the cluster's own stacks under the hood):

| Phase | Contents |
|-------|----------|
| **1. Cluster** | `eksctl` creates the EKS Auto Mode cluster (`cluster/cluster.yaml`) + the `aws-efs-csi-driver` addon |
| **2. EFS** | Encrypted EFS filesystem + security group (NFS from the nodes) + mount targets in the private subnets → the `pb-efs` (RWX) StorageClass |
| **3. ACM** | DNS-validated ACM cert for `--domain` (publishes the validation record to Route 53, waits for `ISSUED`) |
| **4. Secrets** | Namespace + the secret/ConfigMap set the manifests expect (JWT, DB creds, registry token keypair, app-env, DB init, observability configs) — same layout as the ec2 target |
| **5. Pod Identity** | SES `ses:SendEmail` association for the platform ServiceAccount (when email is enabled) |
| **6. KEDA** | Installs the KEDA operator (the plugin `ScaledObject` autoscaler — Auto Mode doesn't bundle it) |
| **7. Workloads** | `kubectl kustomize k8s | kubectl apply` — all services: Nginx, Platform, Pipeline, Plugin, Quota, Billing, Message, Reporting, Compliance, Frontend, the in-cluster image-registry, observability (Prometheus, Loki, Alertmanager — surfaced via `/dashboard/observability`), admin tools (PgAdmin, Mongo Express), and the ALB Ingress |
| **8. Route 53** | A-alias `--domain` → the ALB the Ingress provisions |

### Post-Deploy

`setup.sh` applies the manifests, then the pods need a minute or two to pull, start, and pass readiness. The ALB target group reports **unhealthy (503)** until nginx and the platform are ready — expected; it self-heals.

```bash
# Watch the rollout reach a steady state
kubectl get pods -n pipeline-builder -w

# Wait on the gateway + core services
kubectl rollout status deploy/nginx deploy/platform deploy/pipeline deploy/plugin -n pipeline-builder

# Shell into a running pod (platform)
kubectl exec -it deploy/platform -n pipeline-builder -- /bin/sh
```

Plugin **base images** are seeded by `init-platform.sh eks` (the post-deploy step) — built by the in-cluster rootless buildkitd and pushed to the in-cluster registry; `setup.sh` itself doesn't build them. By default `provision` runs that init for you over a `kubectl port-forward`; with the raw script, run `./deploy/bin/init-platform.sh eks` once the registry is up (see [Post-Deploy Steps](#post-deploy-steps)). It works from anywhere with `kubectl` access — no VPC-attached host needed, even in private mode.

### Storage Requirements

Persistent state lives on **PVCs** provisioned by the EBS/EFS CSI drivers — no EBS volumes to hand-manage. PostgreSQL, MongoDB, Redis, and the rest run as Kubernetes workloads (the `postgres`/`mongo`/`redis` images), not as RDS/DocumentDB/ElastiCache. Plugin images are built by an in-cluster **rootless BuildKit** sidecar and pushed to the **in-cluster registry** (there is no ECR dependency).

| Resource | Storage class | Size | Notes |
|----------|---------------|------|-------|
| PostgreSQL | pb-ebs (RWO) | 5-15 GB | Pipelines, plugins, compliance, messages |
| MongoDB | pb-ebs (RWO) | 10-20 GB | Quota + billing records |
| Prometheus / Alertmanager / PgAdmin | pb-ebs (RWO) | 1-10 GB each | Metrics, alert state, admin UI |
| In-cluster registry | pb-efs (RWX) | 40-60 GB | Plugin container images (shared across nodes) |
| Loki | pb-efs (RWX) | grows with logs | Log storage (shared across nodes) |
| Redis | ephemeral | — | Caching / queues |
| Plugin builds / uploads | emptyDir | per-pod | BuildKit layer cache + upload staging (shared in-pod with the sidecar) |

**Recommendations:**

| Resource | Setting |
|----------|---------|
| pb-ebs PVCs | gp3, `ReclaimPolicy: Retain` — data survives a PVC/pod delete (clean up orphans manually) |
| pb-efs | Elastic — grows automatically; no pre-provisioning |
| Registry growth | Prune old plugin image tags from the in-cluster registry periodically |

**Monthly cost estimate (infra):**

| Resource | Cost |
|----------|------|
| EKS control plane | ~$73 |
| EC2 nodes (Karpenter, on-demand) | ~$60-250 (scales with workload) |
| EBS (gp3 PVCs) | ~$5-15 |
| EFS (registry + loki) | ~$3-10 |
| ALB + NAT gateway | ~$30-50 |
| **Total** | **~$150-400/mo** |

(EC2 node cost is the dominant, workload-dependent term — Karpenter scales nodes to fit scheduled pods.)

### Expanding EKS Storage

**pb-ebs PVCs (postgres / mongodb / prometheus / …):** the gp3 StorageClass allows volume expansion, so grow a volume by raising the PVC request and letting the EBS CSI driver expand it online:
```bash
kubectl patch pvc postgres-data -n pipeline-builder \
  -p '{"spec":{"resources":{"requests":{"storage":"30Gi"}}}}'
# the EBS CSI driver expands the volume + filesystem online (gp3) — no pod restart needed
```

**pb-efs (registry / loki) — no expansion needed:** EFS is elastic and grows automatically as data is written. To cap growth, prune old plugin image tags from the in-cluster registry; check usage via the EFS metered size (`aws efs describe-file-systems`).

**Cluster capacity:** node capacity is managed by **Karpenter** (Auto Mode) — it provisions and removes EC2 nodes to fit scheduled pods, so there is no instance to resize.

### EKS vs the other k8s targets

EKS reuses the same Kubernetes manifests as minikube/ec2, with these AWS-managed substitutions:

| minikube / ec2 | EKS |
|----------------|-----|
| hostPath volumes | EBS (RWO) + EFS (RWX) PVCs via CSI |
| NodePort + iptables bridge | ALB Ingress (`target-type: ip` → nginx:8080) |
| Single node | Karpenter-scaled EC2 nodes (Auto Mode) |
| EC2 instance role (SES) | EKS Pod Identity association |
| Self-managed addons | Auto Mode: AWS LB Controller, EBS CSI, CoreDNS built in (EFS CSI added) |

### Scripts

All in `deploy/aws/eks/bin/`. Run from your local machine (or via `provision`).

| Script | Purpose |
|--------|---------|
| `setup.sh` | Full deploy: cluster → EFS → ACM → secrets → KEDA → manifests → Route 53 |
| `shutdown.sh` | Teardown: Ingress/ALB → Route 53 → EFS → cluster → ACM cert |

### Monitoring

```bash
# Pod / service status
kubectl get pods,svc -n pipeline-builder

# Tail logs for a service
kubectl logs -f deploy/nginx -n pipeline-builder
```

### TLS Renewal

The ACM cert is **DNS-validated and auto-renews** — nothing to do (ACM rotates it as long as the validation CNAME stays in the hosted zone). The ALB Ingress picks up the renewed cert automatically.

### Teardown

```bash
cd deploy/aws/eks
bash bin/shutdown.sh --cluster-name pipeline-builder --region us-east-1 \
  --domain pipeline.example.com --hosted-zone-id Z123 --yes
```

Deletes the Ingress/ALB, the Route 53 alias, the EFS filesystem, the cluster (`eksctl delete cluster`), and the ACM cert — in dependency order.

> **EBS volumes on the `pb-ebs` (Retain) StorageClass are *not* auto-deleted** (they're reported at the end). Remove leftovers manually if you don't need the data.

---

## Email (SES)

The platform sends transactional email (invitations, email verification, password
resets) via Amazon SES. It's **enabled by default** — every AWS deploy provisions
it; pass `--no-email` to skip it:

```bash
# EC2 — SES is provisioned by default
bash bin/setup.sh --key-pair my-keypair --domain pipeline.example.com \
  --hosted-zone-id Z123 --ghcr-token ghp_xxx

# EKS — pass --no-email to opt out
bash bin/setup.sh --domain pipeline.example.com \
  --hosted-zone-id Z123 --ghcr-token ghp_xxx --no-email
```

By default the deploy wires up everything in one shot:

- **Identity (Easy DKIM):** creates an SES domain identity for `--domain` and
  publishes its 3 DKIM CNAMEs to your Route 53 zone, so the domain
  **self-verifies** — no manual click. (EC2: in `template.yaml`; EKS: `setup.sh`
  Phase 5 via `aws sesv2`.) The CNAMEs always go to the **public** hosted zone,
  so this works in private mode too. Pass `--no-create-ses-identity` if the
  domain is already a verified SES identity in this account.
- **Permission:** grants `ses:SendEmail`, scoped to the identity and the From
  address — on **EC2** via the **instance role** (the platform pod reaches it
  over IMDS; metadata hop limit is already 2); on **EKS** via an **EKS Pod
  Identity** association for the platform ServiceAccount, carrying a policy
  scoped to `ses:SendEmail` on that identity (not `AmazonSESFullAccess`). No
  access keys are created or stored.
- **App config:** sets `EMAIL_ENABLED=true`, `EMAIL_PROVIDER=ses`,
  `SES_REGION=<deploy region>`, `EMAIL_FROM=noreply@<domain>`,
  `EMAIL_FROM_NAME=pipeline-builder`. Override the sender with `--email-from` /
  `--email-from-name`.

| Flag | Default | Purpose |
|------|---------|---------|
| `--no-email` | — | Skip SES (it is provisioned by default: identity + DKIM + role grant + app env) |
| `--email-from` | `noreply@<domain>` | From address SES sends as |
| `--email-from-name` | `pipeline-builder` | Display name on outbound email |
| `--no-create-ses-identity` | — | Skip identity creation when `--domain` is **already** a verified SES identity in this account/region (avoids a "already exists" rollback); IAM + env are still wired |
| `--alert-email` | — | Subscribe this address to the bounce/complaint SNS topic (you must confirm the email AWS sends) |

> **Region** matters: the SES identity is regional and must match the deploy
> region. The deploy pins `SES_REGION` to it automatically (EC2 derives it from
> the stack region in `bootstrap.sh`, not the static `.env` default).

### Verification & the SES sandbox

Two things happen **after** the stack completes, and both need your attention:

1. **DKIM verification is asynchronous** — Route 53 → SES propagation takes
   minutes to hours. Sends before the domain verifies fail gracefully (the
   platform logs it and continues). Check status at **SES console → Verified
   identities**.
2. **New SES accounts are sandboxed** — you can only send to **verified**
   recipients, max 200/day. To send to arbitrary users, request **production
   access** (SES console → Account dashboard). CloudFormation can't do this for
   you. To smoke-test while sandboxed, verify a **real** recipient address —
   never `admin@internal` (it bounces, and sandbox bounces hurt the reputation
   AWS reviews for production approval).

### Bounce & complaint tracking

SES enforces sender reputation at the **account level** — above ~5% bounce or
~0.1% complaint it puts the account *under review* and can **pause all sending**
(including password resets). To make that visible instead of a silent outage,
the deploy provisions a **configuration set** that every send routes through
(`SES_CONFIGURATION_SET` on the platform), with an **SNS topic** receiving every
bounce, complaint, and reject (`pipeline-builder-email-events` on EC2;
`<cluster-name>-email-events` on EKS).

Pass `--alert-email you@example.com` to subscribe an address at deploy time
(confirm the subscription email AWS sends), or subscribe the topic later from the
console. Without a subscription the topic still collects events — you just won't
be alerted. Reputation rates are also on the SES console **Account dashboard**.

---

## Post-Deploy Steps

After deploying (EC2 or EKS), complete these steps to initialize the platform and enable reporting.

### 1. Initialize the Platform

Register the admin user and load pre-built plugins and sample pipelines:

```bash
cd deploy

# Prompts for build strategy + categories. Admin creds come from PLATFORM_IDENTIFIER /
# PLATFORM_PASSWORD (defaulting if unset — export real values on ec2/eks)
bash bin/init-platform.sh ec2         # EC2 (resolves URL from the pipeline-builder stack)
bash bin/init-platform.sh eks         # EKS (port-forwards svc/nginx via kubectl)
bash bin/init-platform.sh docker       # Docker Compose
bash bin/init-platform.sh minikube    # Minikube

# Non-interactive
export PLATFORM_BASE_URL=https://pipeline.example.com
export PLATFORM_IDENTIFIER=admin@internal
export PLATFORM_PASSWORD=SecurePassword123!
bash bin/init-platform.sh ec2

# Non-interactive with prebuilt images
PLUGIN_BUILD_STRATEGY=prebuilt bash bin/init-platform.sh ec2

# Non-interactive with prebuilt + specific categories
PLUGIN_BUILD_STRATEGY=prebuilt PLUGIN_CATEGORY=infrastructure,language bash bin/init-platform.sh ec2

# Control upload parallelism (default: 4, auto-lowered to 1 for prebuilt)
PARALLEL_JOBS=2 bash bin/init-platform.sh docker

# Force rebuild all prebuilt images even if image.tar exists
PLUGIN_BUILD_STRATEGY=prebuilt FORCE_REBUILD=true bash bin/init-platform.sh ec2

# Clean up plugin.zip and image.tar after upload (reclaim disk space)
./deploy/bin/init-platform.sh --cleanup local
./deploy/bin/load-plugins.sh --rebuild --cleanup

# EC2 with sudo (required for minikube user context)
sudo -u minikube PLATFORM_BASE_URL=https://your-ip bash /opt/pipeline/pipeline-builder/deploy/bin/init-platform.sh ec2
sudo -u minikube PLATFORM_BASE_URL=https://your-ip bash /opt/pipeline/pipeline-builder/deploy/bin/init-platform.sh --cleanup ec2
```

`init-platform.sh` does: health check → register admin → login → select build strategy → load plugins → load pipelines.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLATFORM_BASE_URL` | auto-detected | Platform API URL (skips CloudFormation lookup when set) |
| `PLATFORM_IDENTIFIER` | `admin@internal` | Admin email |
| `PLATFORM_PASSWORD` | `SecurePassword123!` | Admin password |
| `PLUGIN_BUILD_STRATEGY` | `build_image` | `build_image` or `prebuilt` |
| `PLUGIN_CATEGORY` | all | Comma-separated categories (e.g., `language,security`) |
| `PARALLEL_JOBS` | 4 (1 for prebuilt) | Upload concurrency. Passed through to `load-plugins.sh`. Override with `--parallel N` on CLI. |
| `FORCE_REBUILD` | `false` | Force rebuild all prebuilt image.tar files |
| `PLUGIN_S3_CLEAR` | `false` | Clear S3 bucket before upload (S3 strategy only) |

Use `--cleanup` flag on `init-platform.sh` or `load-plugins.sh` to remove `plugin.zip` and `image.tar` files after upload. Useful on EC2 where prebuilt images can consume 25-75GB of disk.

| Script | Purpose |
|--------|---------|
| `init-platform.sh` | Register admin + select build strategy + load plugins + pipelines (interactive) |
| `build-plugin-images.sh` | Pre-build Docker images for plugins (prebuilt strategy) |
| `load-plugins.sh` | Upload plugins from `deploy/plugins/` |
| `load-pipelines.sh` | Upload pipelines from `deploy/samples/pipelines/` |
| `test-plugins.sh` | Validate plugin specs and Dockerfiles |

### 2. Store Service Credentials

The plugin-lookup Lambda and event-ingestion Lambda use a JWT token stored in Secrets Manager. Generate and store it using the CLI:

```bash
# First, login to get a PLATFORM_TOKEN
eval $(pipeline-manager login -u admin@your-domain.com -p '***' --quiet --no-verify-ssl)

# Then generate a long-lived token and store in Secrets Manager
pipeline-manager store-token --days 30 --region us-east-1
```

By default `store-token` **only writes the secret** — you must re-run it before the
token expires (`audit-tokens` warns you in advance). To avoid that, add `--schedule`
to also deploy a small **daily auto-renewal stack** (`pipeline-builder-token-renew`):

```bash
# Write the token AND install a Lambda that re-mints it daily, so it never lapses
pipeline-manager store-token --days 30 --schedule --region us-east-1

# Custom renewal time (5-field cron; minimum every 15 minutes):
pipeline-manager store-token --schedule --cron '0 3 * * *' --region us-east-1
```

The renewal stack is a scheduled Lambda that reads the current JWT, mints a fresh
one via the platform, and writes it back to the same secret. (The `--with-events`
provision bundle opts into `--schedule` automatically, since the event-ingestion
Lambda depends on this token.)

### 3. Deploy EventBridge Reporting Infrastructure

Set up pipeline execution reporting to track success rates, stage performance, and build analytics:

```bash
export PLATFORM_BASE_URL=https://pipeline.example.com

pipeline-manager setup-events --region us-east-1
```

This creates a CloudFormation stack (`pipeline-builder-events`) containing:

- **EventBridge rule** matching all CodePipeline and CodeBuild state changes
- **SQS queue** with dead-letter queue for failed events
- **Lambda handler** that authenticates via Secrets Manager and POSTs events to the reporting API

### 4. Verify Reporting

```bash
# Check the EventBridge stack
aws cloudformation describe-stacks --stack-name pipeline-builder-events \
  --query 'Stacks[0].StackStatus' --output text

# Check the EventBridge rule
aws events describe-rule --name pipeline-builder-codepipeline-events

# Check the Lambda
aws lambda get-function --function-name pipeline-builder-event-ingestion \
  --query 'Configuration.LastModified'
```

### How Reporting Works

```
Synth  → CDK tags the CodePipeline `PIPELINE_EVENT_ID=<pipelineId>` (stable, set at creation)
Deploy → pipeline-manager registers the pipeline (by pipelineId) in pipeline_registry
Execute → CodePipeline runs → EventBridge captures state changes
Ingest  → SQS → Lambda resolves the PIPELINE_EVENT_ID tag → POST /api/reports/events (keyed by pipelineId)
Store   → Reporting API matches the registry by pipelineId → inserts into pipeline_events
View    → Dashboard Reports page or GET /api/reports/...
```

> The pipeline ARN and AWS account number **never leave AWS** — the Lambda attributes events via the pipeline's `PIPELINE_EVENT_ID` tag (= the opaque `pipelineId`), so nothing sensitive is stored and there is no masking key to manage. The Lambda's execution role needs `codepipeline:ListTagsForResource`.

> Plugin Docker builds are captured automatically by the plugin service (no EventBridge needed).

### Drift Detection (`audit-stacks`)

The `pipeline_registry` table is written only when `pipeline-manager deploy` succeeds. CloudFormation stacks can be created or destroyed outside of that path — manual `aws cloudformation delete-stack`, console operations, side-channel deploys — and over time the registry can drift from reality.

The `audit-stacks` command joins the registry against live CloudFormation stacks tagged `pipeline-builder` and surfaces two categories of drift:

| Finding | Meaning | Typical cause |
|---------|---------|---------------|
| **Orphaned stack** | Tagged stack exists in CloudFormation, but no matching row in `pipeline_registry` | Pipeline was deleted from the dashboard but the CDK stack stayed in AWS |
| **Missing stack** | Registry row exists, but no matching CloudFormation stack | Stack was deleted manually (e.g. `aws cloudformation delete-stack`) without going through the platform |

#### Usage

```bash
# Scan all orgs in the default region
pipeline-manager audit-stacks --region us-east-1

# Scan one org, JSON output (suitable for piping into jq / cron alerting)
pipeline-manager audit-stacks --org acme --region us-east-1 --json

# With a specific AWS profile
pipeline-manager audit-stacks --profile production --region us-east-1
```

Flags:

| Flag | Purpose |
|------|---------|
| `--region <region>` | AWS region to scan. Defaults to `AWS_REGION` env, then `CDK_DEFAULT_REGION`, then `us-east-1`. |
| `--org <orgId>` | Restrict both the registry fetch and the stack scan to a single org. |
| `--profile <profile>` | AWS CLI profile (default: `default`). |
| `--json` | Emit a single JSON document instead of human output. |

#### Exit codes

The command is designed to be cron-friendly:

| Exit code | Meaning |
|-----------|---------|
| `0` | No drift |
| `1` | One or more findings (orphaned and/or missing stacks) |
| `2` | AWS error or scan failure |

A typical alerting setup runs the audit nightly and pages on non-zero exit:

```bash
# /etc/cron.d/pipeline-builder-audit
0 6 * * * deploy-bot pipeline-manager audit-stacks --region us-east-1 --json > /var/log/pb-audit.json || alert-on-call "pipeline-builder drift detected"
```

#### Remediation

Drift is **not auto-fixed** — the command only reports. Reconciliation is manual and depends on the cause:

- **Orphaned stack**: confirm the pipeline definition really was deleted, then `aws cloudformation delete-stack --stack-name <name>` to clean up the leftover. If the deletion was unintentional, recreate the pipeline definition and redeploy.
- **Missing stack**: redeploy the pipeline (`pipeline-manager deploy --id <pipelineId>`) to recreate the stack and refresh the registry row. There is currently no API or dashboard surface to drop a stale registry row in isolation — if redeploy isn't desired, the row must be removed directly in Postgres (`DELETE FROM pipeline_registry WHERE pipeline_id = '<pipelineId>'`).

#### What it doesn't catch

- **Out-of-region drift** — only scans the region you pass with `--region`. Run once per region you deploy to.
- **Stack content drift** — doesn't detect when a stack's resources have been edited in-console but the template still matches the last deploy. Use `aws cloudformation detect-stack-drift` for that.
- **Mid-deploy states** — only `*_COMPLETE` statuses are considered active. A stack stuck in `CREATE_IN_PROGRESS` or `ROLLBACK_FAILED` will look like a missing stack.

---

## Report API Endpoints

All endpoints require authentication and org context. Time range defaults to last 30 days.

### Pipeline Execution Reports

| Endpoint | Description | Query Params |
|----------|-------------|--------------|
| `GET /api/reports/execution/count` | Execution count per pipeline with status breakdown | — |
| `GET /api/reports/execution/success-rate` | Pass/fail rate over time | `interval`, `from`, `to` |
| `GET /api/reports/execution/timeline` | Execution timeline (alias for success-rate) | `interval`, `from`, `to` |
| `GET /api/reports/execution/duration` | Average/min/max/p95 execution duration | `from`, `to` |
| `GET /api/reports/execution/stage-failures` | Stage failure heatmap | `from`, `to` |
| `GET /api/reports/execution/stage-bottlenecks` | Slowest stages per pipeline | `from`, `to` |
| `GET /api/reports/execution/action-failures` | Action/step failure rate | `from`, `to` |
| `GET /api/reports/execution/errors` | Error categorization (top N) | `from`, `to`, `limit` |

### Plugin Reports

| Endpoint | Description | Query Params |
|----------|-------------|--------------|
| `GET /api/reports/plugins/summary` | Plugin inventory (total/active/public/private) | — |
| `GET /api/reports/plugins/distribution` | Type and compute distribution | — |
| `GET /api/reports/plugins/versions` | Version counts per plugin name | — |
| `GET /api/reports/plugins/build-success-rate` | Docker build success rate over time | `interval`, `from`, `to` |
| `GET /api/reports/plugins/build-duration` | Build time per plugin | `from`, `to` |
| `GET /api/reports/plugins/build-failures` | Build failure reasons (top N) | `from`, `to`, `limit` |

**Common query parameters:**

| Param | Values | Default |
|-------|--------|---------|
| `interval` | `day`, `week`, `month` | `week` |
| `from` | ISO 8601 timestamp | 30 days ago |
| `to` | ISO 8601 timestamp | now |
| `limit` | integer | `20` |

---

## Access Points

After deployment, access services at:

| Service | Path |
|---------|------|
| Application | `/` |
| Reports Dashboard | `/dashboard/reports` |
| Observability (native) | `/dashboard/observability` |
| PgAdmin | `/pgadmin/` |
| Mongo Express | `/mongo-express/` |
| Registry UI | `/dashboard/registry` (system-admin only) |

---

## File Structure

<details>
<summary>EC2 deployment files</summary>

```
deploy/aws/ec2/
├── template.yaml          # CloudFormation stack
├── .env.example           # Reference config
├── bin/
│   ├── setup.sh         # Deploy the stack (from your machine)
│   ├── bootstrap.sh      # EC2 setup + hardening
│   ├── startup.sh        # Minikube + K8s deploy + ALB-target iptables bridge
│   └── shutdown.sh       # Teardown
├── k8s/                   # 26 Kubernetes manifests
│   └── kustomization.yaml # Kustomize entry point
├── nginx/
│   ├── nginx.conf     # Nginx config (TLS + JWT)
│   ├── jwt.js             # NJS JWT parsing
│   └── metrics.js         # NJS metrics
└── config/                # Prometheus, Loki, Promtail configs
```

</details>

<details>
<summary>EKS deployment files</summary>

```
deploy/aws/eks/
├── bin/
│   ├── setup.sh           # Full deploy orchestrator (cluster → … → Route 53)
│   └── shutdown.sh        # Teardown (Ingress/ALB → Route 53 → EFS → cluster → ACM)
├── cluster/
│   └── cluster.yaml       # eksctl ClusterConfig (Auto Mode + aws-efs-csi-driver)
├── k8s/
│   ├── kustomization.yaml # Standalone manifests (not shared with ec2/minikube)
│   ├── storageclasses.yaml# pb-ebs (RWO) + pb-efs (RWX)
│   ├── ingress.yaml       # ALB Ingress → nginx:8080 (ACM TLS at the ALB)
│   └── *.yaml             # Full workload set, PVC-tuned for multi-node
├── config/                # Prometheus, Loki, Alertmanager, Promtail
├── nginx/                 # nginx.conf, jwt.js, metrics.js, registry-auth.js
├── .env.example
├── mongodb-init.js
├── mongodb-keyfile
└── postgres-init.sql
```

</details>

---

## Troubleshooting

**Pods stuck Pending (EC2):**
Check CPU requests vs instance capacity. `kubectl describe pod <name>` shows scheduling failures.

**ImagePullBackOff (EC2):**
Verify GHCR credentials and that iptables rules aren't intercepting minikube's outbound traffic. Authenticate with the GitHub Container Registry first if you haven't already:

```bash
echo $YOUR_PAT | docker login ghcr.io -u USERNAME --password-stdin
```

`YOUR_PAT` is a GitHub Personal Access Token with the `read:packages` scope. The `bootstrap.sh` and `startup.sh` scripts pick up `GHCR_TOKEN` and `GHCR_USER` env vars to create the in-cluster `ghcr-secret` automatically.

**`GhcrToken` rejected with `unauthorized` or `denied`:**
The pre-built images at `ghcr.io/mwashburn160/*` are **public** — anonymous pulls succeed — but `GhcrToken` is still requested by the CFN templates because anonymous GHCR pulls are subject to a low per-IP rate limit (60 req/hr) that will trip mid-deploy when EC2 pulls all 10 service images concurrently. Authenticated pulls raise the limit to 5,000 req/hr.

**Use your own GitHub Personal Access Token — do not copy a value from documentation, an example command, or another user's deployment.** Tokens that aren't yours will fail (or worse, succeed temporarily and break later when the original owner rotates them). To create your own:

- **Classic PAT** (simplest): https://github.com/settings/tokens → "Generate new token (classic)" → check only the `read:packages` scope.
- **Fine-grained PAT** (recommended): https://github.com/settings/personal-access-tokens → "Generate new token" → resource owner = your account → permissions: `Packages: Read` (account permissions, not repo).

Pass it as the `GhcrToken` CFN parameter or export it as `GHCR_TOKEN` for `bootstrap.sh`/`startup.sh`. There is no username to set — ghcr.io validates only the token for PAT auth, so the deploy uses a fixed internal value.

If you intentionally want to skip auth for a small test deploy, leave `GhcrToken` empty and the bootstrap scripts will fall back to anonymous pulls — expect occasional 429s on retry-storms across all 10 services.

**CrashLoopBackOff on observability pods (EC2):**
Usually hostPath permission issues. Check pod logs. Init containers handle `chown` for loki (10001) and prometheus (65534).

**Pods stuck Pending / no nodes (EKS):**
Karpenter provisions nodes on demand — a brief Pending is normal at cold start. If it persists, check `kubectl describe pod <name>` for scheduling reasons and `kubectl get events -n pipeline-builder`. A pb-ebs (RWO) PVC is AZ-pinned, so its pod must schedule in the volume's AZ.

**ALB Ingress has no address (EKS):**
The AWS Load Balancer Controller provisions the ALB from `ingress.yaml`. Check `kubectl describe ingress pb-ingress -n pipeline-builder` for controller events, and that the ACM cert reached `ISSUED`. The Route 53 alias is only written once the Ingress reports a hostname.

**Certificate / stack hangs in CREATE_IN_PROGRESS:**
The ACM cert DNS-validates during stack creation (a few minutes). If it never issues, the `--hosted-zone-id` is wrong or not authoritative for `--domain`. Check ACM status: `aws acm describe-certificate --certificate-arn <arn>` (look for `DomainValidationOptions[].ValidationStatus`).

**No reporting data after deploy:**
1. Verify `pipeline-manager store-token` was run
2. Check Lambda logs: `aws logs tail /aws/lambda/pipeline-builder-event-ingestion --follow`
3. Check SQS DLQ for failed events
4. Verify pipeline was deployed after `setup-events` (ARN must be registered)
