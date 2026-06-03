# AWS Deployment

Two deployment options: **EC2** (single instance, Kubernetes) or **Fargate** (serverless containers).

Both deploy the full stack: app services, databases, observability (Prometheus + Loki, surfaced via the native `/dashboard/observability` page), and admin tools. Both front the workload with an **ALB that terminates TLS using an ACM cert** (DNS-validated); the compute is always in private subnets. A domain + public Route 53 zone is required.

Observability is the native `/dashboard/observability` page across all deployments — there is no Grafana. Five dashboards (Platform Overview, Plugin Builds, Queue Health, Registry Activity, Audit Activity) are seeded into the database at platform cold start as public `org_id='system'` rows, so they appear automatically for any logged-in org and open at `/dashboard/observability/<id>`. Audit Activity also has a dedicated page at `/dashboard/observability/audit-activity`.

**Related docs:** [Environment Variables](environment-variables.md) | [API Reference](api-reference.md) | [Plugin Catalog](plugins/README.md)

## Table of Contents

- [EC2](#ec2) -- Single Minikube instance (dev/staging, ~$30-80/mo)
- [Fargate](#fargate) -- Serverless ECS containers (production, ~$100-300/mo)
- [Post-Deploy Steps](#post-deploy-steps) -- Platform init, credentials, EventBridge reporting
- [Drift Detection (`audit-stacks`)](#drift-detection-audit-stacks) -- Reconcile registry vs live CloudFormation
- [Report API Endpoints](#report-api-endpoints) -- Execution and plugin analytics
- [Access Points](#access-points) -- Service URLs after deployment
- [File Structure](#file-structure) -- Deployment file layout
- [Troubleshooting](#troubleshooting) -- Common issues and fixes

| | EC2 | Fargate |
|--|-----|---------|
| Runtime | Minikube on EC2 | ECS Fargate |
| Infra | 1 CloudFormation stack | 6 CloudFormation stacks |
| TLS | ACM cert at the ALB | ACM cert at the ALB |
| Public surface | ALB only (instance private) | ALB only (tasks private) |
| Storage | hostPath PVCs on EBS | EFS access points |
| Scaling | Vertical (instance resize) | Horizontal (task count) |
| Cost | ~$30-80/mo | ~$100-300/mo |
| Best for | Dev/staging | Production |

---

## EC2

Single hardened EC2 instance running Minikube with all services.

### Prerequisites

- AWS CLI configured
- EC2 key pair in target region
- (Optional) Route 53 hosted zone for custom domain

### Deploy

**Recommended — `bin/deploy.sh`** (mirrors Fargate: one command. In `private` mode the template itself also creates the VPC endpoints + private zone — no separate stack, no follow-up step):

An **ALB fronts the always-private instance** and terminates TLS with an **ACM cert** the template requests + DNS-validates against your hosted zone — so `--domain` + `--hosted-zone-id` are **required in both modes**.

```bash
cd deploy/aws/ec2

# private (default) — internal-scheme ALB, inside-AWS-only
bash bin/deploy.sh \
  --key-pair my-keypair \
  --domain pipeline.example.com \
  --hosted-zone-id Z1234567890 \
  --ghcr-token ghp_xxxxxxxxxxxx

# public — internet-facing ALB (instance still private behind it)
bash bin/deploy.sh --deploy-mode public \
  --key-pair my-keypair --domain pipeline.example.com \
  --hosted-zone-id Z1234567890 --ghcr-token ghp_xxxxxxxxxxxx
```

`deploy.sh` runs from your machine with your credentials, so the instance role needs no CloudFormation permissions. In `private` mode the single stack also creates the VPC endpoints + the private-zone alias to the internal ALB (gated on `DeployMode=private`). It refuses to start without `--domain`/`--hosted-zone-id` (the ACM cert can't validate otherwise).

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
| `GhcrUser` | No | `mwashburn160` | GitHub username for GHCR |
| `EbsVolumeSize` | No | `60` | Root volume size in GiB (OS, binaries) |
| `DataVolumeSize` | No | `200` | Data volume size in GiB (Docker, plugins, registry, databases). Increase to 500 for prebuilt. |
| `GitRepo` | No | *(this repo)* | Git repository URL |
| `GitBranch` | No | `main` | Branch to deploy |

### Storage Requirements

The EC2 deployment uses two EBS volumes:

| Volume | Default | Mount | Contents |
|--------|---------|-------|----------|
| **Root** | 60 GiB | `/` | OS, Docker/minikube binaries, app code |
| **Data** | 200 GiB | `/mnt/data` | Docker layers, plugin artifacts, registry, databases, logs |

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
DEVICE=$(lsblk -no PKNAME $(findmnt -n -o SOURCE /mnt/data))
PART=$(lsblk -no PARTNUM $(findmnt -n -o SOURCE /mnt/data) 2>/dev/null)
[ -n "$PART" ] && sudo growpart /dev/$DEVICE $PART
sudo xfs_growfs /mnt/data    # XFS filesystem
# or: sudo resize2fs $(findmnt -n -o SOURCE /mnt/data)   # ext4 filesystem

# 5. Verify
df -h /mnt/data
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

All in `deploy/aws/ec2/bin/`. On the instance: `/opt/pipeline-builder/deploy/aws/ec2/bin/`.

| Script | Purpose | Run as |
|--------|---------|--------|
| `deploy.sh` | Deploy the stack (private mode folds endpoints + private zone into it) — from your machine | operator |
| `bootstrap.sh` | Full EC2 setup (runs automatically via UserData) | root |
| `startup.sh` | Start Minikube + deploy K8s manifests + the ALB-target iptables bridge | root (sudo) |
| `shutdown.sh` | Stop Minikube + remove iptables rules | root (sudo) |

```bash
# Start (after bootstrap or reboot)
sudo bash /opt/pipeline-builder/deploy/aws/ec2/bin/startup.sh

# Stop
sudo bash /opt/pipeline-builder/deploy/aws/ec2/bin/shutdown.sh

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

`DEPLOY_MODE` **defaults to `private`** and flips **only the ALB scheme** — the instance is always private and TLS is always ACM-at-the-ALB. Pass `--deploy-mode public` (or `DEPLOY_MODE=public`) for the internet-facing posture. Both modes require `--domain` + `--hosted-zone-id`.

| | `private` (inside-AWS-only, **default**) | `public` |
|---|---|---|
| ALB | internal scheme, private subnets | internet-facing, public subnets |
| Instance | private subnet, no public IP | private subnet, no public IP |
| DNS | Route53 **private** zone alias → internal ALB | Public Route53 alias → ALB |
| CodeBuild | **VPC-attached** (`PIPELINE_VPC_ID`/`SUBNET_IDS`/`SECURITY_GROUP_IDS`) | AWS-managed network, reaches the ALB over internet |
| Plugin pull | `https://<domain>/v2/` (resolves private) | `https://<domain>/v2/` (public) |

Both share the registry `/v2/` route + `registry-auth.js` realm rewrite + `IMAGE_REGISTRY_PULL_HOST` — only the ALB scheme / DNS resolution differ.

**`private` mode prerequisites** — the VPC interface endpoints and the Route53 private zone (aliasing the domain to the internal ALB) are created by the **base template itself**, gated on `DeployMode=private`. There is **no separate `private-prereqs.yaml` stack** — the ALB's DNS is known in-stack, so everything deploys in one shot (whether via `bin/deploy.sh` or raw `aws cloudformation deploy`). The ALB SG already admits 443 from the VPC, so no extra ingress rule is needed.

After it's up, set `PIPELINE_VPC_ID`/`PIPELINE_SUBNET_IDS` in `.env` (from the stack's `VpcId`/`SubnetIds` outputs) so the synthesized CodeBuild attaches to the VPC, and `init-platform.sh` will pass its preflight. Still operator-supplied: build-dependency egress (NAT or internal mirrors) + a source path.

> Fargate is the same: its private-mode VPC endpoints live in `01-foundation.yaml` (gated on `DeployMode=private`). It needs no private zone because it uses the internal ALB's own DNS name, which resolves natively in-VPC.

### Teardown

```bash
aws cloudformation delete-stack --stack-name pipeline-builder
aws cloudformation wait stack-delete-complete --stack-name pipeline-builder
```

---

## Fargate

Serverless containers on ECS Fargate. 6 CloudFormation stacks deployed in dependency order.

### Prerequisites

- AWS CLI configured
- A registered domain + its **public Route 53 hosted zone** (required — the foundation requests a DNS-validated ACM cert against it; no IP-only mode)

### Deploy

The foundation stack requests a **DNS-validated ACM cert** for `--domain` and terminates TLS at the ALB — no certbot, no self-signed cert. `--domain` + `--hosted-zone-id` are required in both modes.

```bash
cd deploy/aws/fargate

# private (default) — internal ALB, inside-AWS-only
bash bin/deploy.sh \
  --domain pipeline.example.com \
  --hosted-zone-id Z1234567890 \
  --ghcr-token ghp_xxxxxxxxxxxx

# public — internet-facing ALB
bash bin/deploy.sh --deploy-mode public \
  --domain pipeline.example.com --hosted-zone-id Z1234567890 --ghcr-token ghp_xxxxxxxxxxxx
```

The ACM cert DNS-validates during foundation-stack creation, so expect a few minutes in `CREATE_IN_PROGRESS`.

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--domain` | **Yes** | — | FQDN — ACM cert + Route 53 alias to the ALB |
| `--hosted-zone-id` | **Yes** | — | Public Route 53 zone ID (ACM DNS validation + alias) |
| `--ghcr-token` | Yes | — | GHCR token for pulling images |
| `--deploy-mode` | No | `private` | `public` (internet-facing ALB) or `private` (internal) |
| `--ghcr-user` | No | `mwashburn160` | GitHub username |
| `--region` | No | `us-east-1` | AWS region |
| `--stack-prefix` | No | `pb` | CloudFormation stack name prefix |

### Deployment mode (`DEPLOY_MODE`)

`DEPLOY_MODE` **defaults to `private`** (inside-AWS-only); set it in the env before `deploy.sh` (passed to the foundation + services stacks). Export `DEPLOY_MODE=public` for the internet-facing posture.

| | `private` (inside-AWS-only, **default**) | `public` |
|---|---|---|
| ALB | internal scheme, private subnets | internet-facing, public subnets |
| DNS | Route53 **private** zone → internal ALB | public Route53 → ALB |
| CodeBuild | **VPC-attached** (`PIPELINE_VPC_ID`/`SUBNET_IDS` wired from the foundation VPC) | AWS-managed network, reaches ALB over internet |
| Plugin pull | `https://<domain>/v2/` (private) | `https://<domain>/v2/` (public) |

TLS is a **publicly-trusted, DNS-validated ACM cert** the `01-foundation.yaml` stack requests for `--domain` against `--hosted-zone-id` — publicly trusted, so CodeBuild's plugin-image pulls verify. In `private` mode the same stack also creates the VPC interface endpoints (S3, Logs, Secrets Manager, KMS, STS, CodeBuild, ECR) **and** a Route53 **private** zone aliasing the domain to the internal ALB (so VPC-attached CodeBuild resolves it), all gated on `DeployMode=private` — there's no separate prereqs stack. Still operator-supplied: egress (NAT/mirrors) for build deps. EC2 and Fargate are now **structurally identical**: both require a registered domain, both request a DNS-validated ACM cert in-stack, both alias the domain to the ALB (public alias / private zone), and both work for CodeBuild plugin pulls in either mode.

### Stacks

Deployed in order. Each exports values consumed by downstream stacks.

| Stack | Contents |
|-------|----------|
| **01-foundation** | VPC, ALB, Route 53, EFS, S3 config bucket, Cloud Map |
| **02-cluster** | ECS Cluster, IAM roles, security groups, log groups |
| **03-databases** | PostgreSQL, MongoDB, Redis |
| **04-services** | Nginx, Platform, Pipeline, Plugin, Quota, Billing, Message, Reporting, Compliance, Frontend, plus the plugin image-registry service |
| **05-observability** | Prometheus, Loki, Alertmanager (visualized via the native `/dashboard/observability` page — no Grafana) |
| **06-admin** | Registry, PgAdmin, Mongo Express, Registry UI |

### Storage Requirements

Fargate has no EBS volumes to manage — persistent state lives on EFS access points and managed AWS services. PostgreSQL, MongoDB, and Redis run as ECS Fargate containers (the `postgres`/`mongo`/`redis` images) backed by EFS, not as RDS/DocumentDB/ElastiCache. Plugin builds use `build_image` with kaniko (prebuilt is not supported on Fargate).

| Resource | Type | Size | Notes |
|----------|------|------|-------|
| Task ephemeral | Per-task | 20 GB (30 GB for plugin) | Non-persistent, cleared on task restart |
| PostgreSQL (EFS) | ECS task on EFS | 5-15 GB | Pipelines, plugins, compliance, messages |
| MongoDB (EFS) | ECS task on EFS | 10-20 GB | Quota + billing records |
| Redis | ECS task | ephemeral | Caching / queues |
| ECR | Managed | 40-60 GB | Plugin container images |
| EFS | Managed | shared volume | DB data, shared config, TLS certs |
| CloudWatch Logs | Managed | ~5 GB/month | 30-day retention recommended |
| S3 | Managed | <1 GB | CDK assets, CloudFormation templates |

**Recommendations:**

| Resource | Setting |
|----------|---------|
| EFS | Elastic — grows automatically with database/config data; no pre-provisioning |
| ECR lifecycle | Keep last 10 tags per repository |
| CloudWatch retention | 30 days |
| Plugin task ephemeral | 30 GB (kaniko builds need temp space) |

**Task sizing:**

| Service | CPU | Memory | Ephemeral |
|---------|-----|--------|-----------|
| Plugin | 2048 | 4096 | 30 GB |
| Pipeline | 512 | 1024 | 20 GB |
| Platform | 512 | 1024 | 20 GB |
| Compliance | 512 | 1024 | 20 GB |
| Frontend | 256 | 512 | 20 GB |
| Reporting, Quota, Billing, Message | 256 | 512 | 20 GB |

**Monthly cost estimate (storage only):**

| Resource | Cost |
|----------|------|
| ECR (60 GB) | ~$6 |
| EFS (DB data + config) | ~$3-8 |
| CloudWatch | ~$3 |
| **Total** | **~$12-17/mo** |

(Database storage is included in the EFS line, since PostgreSQL/MongoDB run as ECS tasks on EFS rather than as managed RDS/DocumentDB. This covers storage only — Fargate task vCPU/memory is the dominant Fargate cost and is not included here.)

### Expanding Fargate Storage

Unlike EC2, Fargate storage is per-service. Expand each independently:

**PostgreSQL / MongoDB (EFS) — no manual expansion needed:**
The databases run as ECS tasks on EFS access points. EFS is elastic and grows automatically as data is written, so there is no allocated-storage limit to raise. To cap growth, prune old data or set per-access-point quotas; to verify usage, check the EFS file system's metered size in the console or via `aws efs describe-file-systems`.

**ECR — add lifecycle policy to prevent unbounded growth:**
```bash
aws ecr put-lifecycle-policy \
  --repository-name plugin \
  --lifecycle-policy-text '{
    "rules": [{
      "rulePriority": 1,
      "description": "Keep last 10 images",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 10
      },
      "action": { "type": "expire" }
    }]
  }'
```

**CloudWatch Logs — set retention to control growth:**
```bash
# List log groups
aws logs describe-log-groups --log-group-name-prefix /pipeline-builder/ --query 'logGroups[*].logGroupName' --output table

# Set 30-day retention on all
for lg in $(aws logs describe-log-groups --log-group-name-prefix /pipeline-builder/ --query 'logGroups[*].logGroupName' --output text); do
  aws logs put-retention-policy --log-group-name "$lg" --retention-in-days 30
done
```

**Task ephemeral storage — increase in CloudFormation stack:**

Update `EphemeralStorage` in `04-services.yaml` and redeploy:
```bash
cd deploy/aws/fargate
bash bin/deploy.sh --stack-prefix pb --region us-east-1 --domain app.example.com
```

### K8s → Fargate Translation

| Kubernetes | Fargate |
|------------|---------|
| K8s DNS | Cloud Map (`*.pipeline-builder.local`) |
| hostPath PVCs | EFS access points |
| K8s Secrets | AWS Secrets Manager |
| ConfigMaps | S3 bucket (downloaded at startup) |
| NodePort + iptables | ALB + target groups |
| Docker socket mount | Kaniko sidecar |
| Promtail DaemonSet | Fluent Bit sidecar (FireLens) |
| NetworkPolicies | Security groups |
| Init containers | ECS container dependency ordering |

### Scripts

All in `deploy/aws/fargate/bin/`. Run from your local machine.

| Script | Purpose |
|--------|---------|
| `deploy.sh` | Full deploy: secrets → 6 stacks (foundation requests the ACM cert) → config upload |
| `teardown.sh` | Delete all stacks in reverse order |
| `init-secrets.sh` | Generate random secrets → Secrets Manager |

### Monitoring

```bash
# Service status
aws ecs describe-services --cluster pipeline-builder \
  --services nginx platform pipeline plugin --region us-east-1

# Tail logs
aws logs tail /pipeline-builder/nginx --follow --region us-east-1
```

### TLS Renewal

The ACM cert is **DNS-validated and auto-renews** — nothing to do (ACM rotates it as long as the validation CNAME stays in the hosted zone).

### Teardown

```bash
bash bin/teardown.sh --stack-prefix pb --region us-east-1
```

> Secrets Manager entries are **not** auto-deleted. Remove manually if needed.

---

## Post-Deploy Steps

After deploying (EC2 or Fargate), complete these steps to initialize the platform and enable reporting.

### 1. Initialize the Platform

Register the admin user and load pre-built plugins and sample pipelines:

```bash
cd deploy

# Interactive — prompts for admin credentials, build strategy, and categories
bash bin/init-platform.sh ec2         # EC2 (resolves URL from CloudFormation)
bash bin/init-platform.sh local       # Docker Compose
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
PARALLEL_JOBS=2 bash bin/init-platform.sh local

# Force rebuild all prebuilt images even if image.tar exists
PLUGIN_BUILD_STRATEGY=prebuilt FORCE_REBUILD=true bash bin/init-platform.sh ec2

# Clean up plugin.zip and image.tar after upload (reclaim disk space)
./deploy/bin/init-platform.sh --cleanup local
./deploy/bin/load-plugins.sh --rebuild --cleanup

# EC2 with sudo (required for minikube user context)
sudo -u minikube PLATFORM_BASE_URL=https://your-ip bash /opt/pipeline-builder/deploy/bin/init-platform.sh ec2
sudo -u minikube PLATFORM_BASE_URL=https://your-ip bash /opt/pipeline-builder/deploy/bin/init-platform.sh --cleanup ec2
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
Deploy → pipeline-manager registers hashed ARN in pipeline_registry
Execute → CodePipeline runs → EventBridge captures state changes
Ingest  → SQS → Lambda → hashes account → POST /api/reports/events
Store   → Reporting API resolves org via registry → inserts into pipeline_events
View    → Dashboard Reports page or GET /api/reports/...
```

> AWS account numbers are **never stored in plain text**. Both the deploy command and Lambda handler hash account numbers with SHA-256 before sending to the API. The reporting API applies the same hash as defense in depth.

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
- **Missing stack**: redeploy the pipeline (`pipeline-manager deploy --id <pipelineId>`) to recreate the stack and refresh the registry row. There is currently no API or dashboard surface to drop a stale registry row in isolation — if redeploy isn't desired, the row must be removed directly in Postgres (`DELETE FROM pipeline_registry WHERE pipeline_arn = '<arn>'`).

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
│   ├── deploy.sh         # Deploy the stack (from your machine)
│   ├── bootstrap.sh      # EC2 setup + hardening
│   ├── startup.sh        # Minikube + K8s deploy + ALB-target iptables bridge
│   └── shutdown.sh       # Teardown
├── k8s/                   # 26 Kubernetes manifests
│   └── kustomization.yaml # Kustomize entry point
├── nginx/
│   ├── nginx-ec2.conf     # Nginx config (TLS + JWT)
│   ├── jwt.js             # NJS JWT parsing
│   └── metrics.js         # NJS metrics
└── config/                # Prometheus, Loki, Promtail configs
```

</details>

<details>
<summary>Fargate deployment files</summary>

```
deploy/aws/fargate/
├── bin/
│   ├── deploy.sh          # Full deployment orchestrator
│   ├── teardown.sh        # Delete all stacks
│   └── init-secrets.sh    # Generate secrets
├── stacks/
│   ├── 01-foundation.yaml # VPC, ALB, EFS, S3, Cloud Map
│   ├── 02-cluster.yaml    # ECS, IAM, security groups
│   ├── 03-databases.yaml  # PostgreSQL, MongoDB, Redis
│   ├── 04-services.yaml   # Nginx + app services (incl. Reporting, Compliance, image-registry)
│   ├── 05-observability.yaml
│   └── 06-admin.yaml
├── config/                # Prometheus, Loki, Alertmanager, Fluent Bit, PgBouncer
├── nginx/                 # nginx-fargate.conf, jwt.js, metrics.js
├── .env.example
├── mongodb-init.js
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

Pass it as the `GhcrToken` CFN parameter or export it as `GHCR_TOKEN` for `bootstrap.sh`/`startup.sh`. Set `GhcrUser` (or `GHCR_USER`) to **your own GitHub username** to match the token's owner.

If you intentionally want to skip auth for a small test deploy, leave `GhcrToken` empty and the bootstrap scripts will fall back to anonymous pulls — expect occasional 429s on retry-storms across all 10 services.

**CrashLoopBackOff on observability pods (EC2):**
Usually hostPath permission issues. Check pod logs. Init containers handle `chown` for loki (10001) and prometheus (65534).

**ECS tasks stuck in PROVISIONING (Fargate):**
Check CloudWatch logs: `aws logs tail /pipeline-builder/<service> --follow`

**ALB health checks failing (Fargate):**
Verify nginx is running. Check target group health and port 8080 accessibility.

**Certificate / stack hangs in CREATE_IN_PROGRESS:**
The ACM cert DNS-validates during stack creation (a few minutes). If it never issues, the `--hosted-zone-id` is wrong or not authoritative for `--domain`. Check ACM status: `aws acm describe-certificate --certificate-arn <arn>` (look for `DomainValidationOptions[].ValidationStatus`).

**No reporting data after deploy:**
1. Verify `pipeline-manager store-token` was run
2. Check Lambda logs: `aws logs tail /aws/lambda/pipeline-builder-event-ingestion --follow`
3. Check SQS DLQ for failed events
4. Verify pipeline was deployed after `setup-events` (ARN must be registered)
