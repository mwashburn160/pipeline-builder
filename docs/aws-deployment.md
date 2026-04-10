# AWS Deployment

Two deployment options: **EC2** (single instance, Kubernetes) or **Fargate** (serverless containers).

Both deploy the full stack: app services, databases, observability (Prometheus, Loki, Grafana), and admin tools. TLS via Let's Encrypt (custom domain) or self-signed (IP-only).

**Related docs:** [Environment Variables](environment-variables.md) | [API Reference](api-reference.md) | [Plugin Catalog](plugins/README.md)

## Table of Contents

- [EC2](#ec2) -- Single Minikube instance (dev/staging, ~$30-80/mo)
- [Fargate](#fargate) -- Serverless ECS containers (production, ~$100-300/mo)
- [Post-Deploy Steps](#post-deploy-steps) -- Platform init, credentials, EventBridge reporting
- [Report API Endpoints](#report-api-endpoints) -- Execution and plugin analytics
- [Access Points](#access-points) -- Service URLs after deployment
- [File Structure](#file-structure) -- Deployment file layout
- [Troubleshooting](#troubleshooting) -- Common issues and fixes

| | EC2 | Fargate |
|--|-----|---------|
| Runtime | Minikube on EC2 | ECS Fargate |
| Infra | 1 CloudFormation stack | 6 CloudFormation stacks |
| TLS | Let's Encrypt or self-signed | Let's Encrypt + ACM |
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

**With custom domain:**

```bash
cd deploy/aws/ec2

aws cloudformation deploy \
  --stack-name pipeline-builder \
  --template-file template.yaml \
  --parameter-overrides \
    DomainName=pipeline.example.com \
    HostedZoneId=Z1234567890 \
    KeyPairName=my-keypair \
    GhcrToken=ghp_xxxxxxxxxxxx \
  --capabilities CAPABILITY_IAM
```

**Without domain (self-signed TLS):**

```bash
aws cloudformation deploy \
  --stack-name pipeline-builder \
  --template-file template.yaml \
  --parameter-overrides \
    KeyPairName=my-keypair \
    GhcrToken=ghp_xxxxxxxxxxxx \
  --capabilities CAPABILITY_IAM
```

Get the URL:

```bash
aws cloudformation describe-stacks --stack-name pipeline-builder \
  --query 'Stacks[0].Outputs[?OutputKey==`ApplicationURL`].OutputValue' --output text
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `KeyPairName` | Yes | — | EC2 key pair for SSH |
| `GhcrToken` | Yes | — | GHCR token for pulling images |
| `DomainName` | No | — | FQDN for Route 53 + Let's Encrypt |
| `HostedZoneId` | If domain set | — | Route 53 hosted zone ID |
| `InstanceType` | No | `t3.xlarge` | EC2 instance type (4 vCPU / 16 GiB recommended) |
| `GhcrUser` | No | `mwashburn160` | GitHub username for GHCR |
| `SshCidr` | No | `0.0.0.0/0` | CIDR for SSH access |
| `EbsVolumeSize` | No | `60` | Root volume size in GiB (OS, binaries) |
| `DataVolumeSize` | No | `500` | Data volume size in GiB (Docker, plugins, registry, databases) |
| `GitRepo` | No | *(this repo)* | Git repository URL |
| `GitBranch` | No | `main` | Branch to deploy |

### Storage Requirements

The EC2 deployment uses two EBS volumes:

| Volume | Default | Mount | Contents |
|--------|---------|-------|----------|
| **Root** | 60 GiB | `/` | OS, Docker/minikube binaries, app code |
| **Data** | 500 GiB | `/mnt/data` | Docker layers, plugin artifacts, registry, databases, logs |

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

### What Happens

1. CloudFormation creates VPC, subnet, security group, Elastic IP, EC2 instance, and optional Route 53 record
2. EC2 UserData clones the repo and runs `bootstrap.sh`, which:
   - Updates OS, installs fail2ban, disables SSH password auth
   - Installs Docker, Minikube, kubectl
   - Generates `.env` with random secrets (JWT keys, DB passwords)
   - Provisions TLS (Let's Encrypt or self-signed)
   - Starts Minikube, deploys all K8s manifests
   - Configures iptables DNAT (443 → 30443, 80 → 30080)

### Post-Deploy

```bash
# Watch bootstrap progress
ssh -i my-keypair.pem ec2-user@<ip> 'tail -f /var/log/user-data.log'

# Check pods
ssh -i my-keypair.pem ec2-user@<ip> \
  'sudo -u minikube kubectl --context=pipeline-builder get pods -n pipeline-builder'

# SSM (no SSH key needed)
aws ssm start-session --target <instance-id>
```

### Scripts

All in `deploy/aws/ec2/bin/`. On the instance: `/opt/pipeline-builder/deploy/aws/ec2/bin/`.

| Script | Purpose | Run as |
|--------|---------|--------|
| `bootstrap.sh` | Full EC2 setup (runs automatically via UserData) | root |
| `startup.sh` | Start Minikube + deploy K8s manifests | root (sudo) |
| `shutdown.sh` | Stop Minikube + remove iptables rules | root (sudo) |
| `update-tls-secret.sh` | Certbot hook to update K8s TLS secret | root |

```bash
# Start (after bootstrap or reboot)
sudo bash /opt/pipeline-builder/deploy/aws/ec2/bin/startup.sh

# Stop
sudo bash /opt/pipeline-builder/deploy/aws/ec2/bin/shutdown.sh

# Check pod status
sudo -u minikube kubectl get pods -n pipeline-builder
```

### Security

- IMDSv2 required (token-based metadata)
- Encrypted gp3 EBS volume
- fail2ban for SSH brute-force protection
- SSH password auth disabled
- Automatic security updates (dnf-automatic)
- Security group: SSH CIDR-locked, only 80/443 public

### TLS

- **With domain:** Let's Encrypt auto-renews daily (cron at 3am)
- **Without domain:** Self-signed cert at `/etc/pipeline-builder/tls/`

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
- Route 53 hosted zone (required — no IP-only mode)
- certbot + certbot-dns-route53 installed locally
  - macOS: `brew install certbot && pip3 install certbot-dns-route53`
  - Linux: `pip3 install certbot certbot-dns-route53`

### Deploy

```bash
cd deploy/aws/fargate

bash bin/deploy.sh \
  --domain pipeline.example.com \
  --hosted-zone-id Z1234567890 \
  --ghcr-token ghp_xxxxxxxxxxxx
```

With an existing ACM certificate:

```bash
bash bin/deploy.sh \
  --domain pipeline.example.com \
  --hosted-zone-id Z1234567890 \
  --ghcr-token ghp_xxxxxxxxxxxx \
  --certificate-arn arn:aws:acm:us-east-1:123456789012:certificate/abc-123
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--domain` | Yes | — | FQDN for Route 53 + Let's Encrypt |
| `--hosted-zone-id` | Yes | — | Route 53 hosted zone ID |
| `--ghcr-token` | Yes | — | GHCR token for pulling images |
| `--ghcr-user` | No | `mwashburn160` | GitHub username |
| `--region` | No | `us-east-1` | AWS region |
| `--stack-prefix` | No | `pb` | CloudFormation stack name prefix |
| `--certificate-arn` | No | *(auto-provisioned)* | Existing ACM certificate ARN |

### Stacks

Deployed in order. Each exports values consumed by downstream stacks.

| Stack | Contents |
|-------|----------|
| **01-foundation** | VPC, ALB, Route 53, EFS, S3 config bucket, Cloud Map |
| **02-cluster** | ECS Cluster, IAM roles, security groups, log groups |
| **03-databases** | PostgreSQL, MongoDB, Redis |
| **04-services** | Nginx, Platform, Pipeline, Plugin, Quota, Billing, Message, Reporting, Frontend |
| **05-observability** | Prometheus, Loki, Grafana |
| **06-admin** | Registry, PgAdmin, Mongo Express, Registry UI |

### Storage Requirements

Fargate uses managed services — no EBS volumes to manage. Plugin builds use `build_image` with kaniko (prebuilt is not supported on Fargate).

| Resource | Type | Size | Notes |
|----------|------|------|-------|
| Task ephemeral | Per-task | 20 GB (30 GB for plugin) | Non-persistent, cleared on task restart |
| RDS PostgreSQL | RDS gp3 | 50 GB (autoscaling) | Pipelines, plugins, compliance, messages |
| DocumentDB / MongoDB Atlas | Managed | 10-20 GB | Quota + billing records |
| ECR | Managed | 40-60 GB | Plugin container images |
| EFS | Managed | 5-10 GB | Shared config, TLS certs |
| CloudWatch Logs | Managed | ~5 GB/month | 30-day retention recommended |
| S3 | Managed | <1 GB | CDK assets, CloudFormation templates |

**Recommendations:**

| Resource | Setting |
|----------|---------|
| RDS storage | 50 GB gp3 with autoscaling enabled |
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
| RDS (50 GB gp3) | ~$5 |
| ECR (60 GB) | ~$6 |
| EFS (10 GB) | ~$3 |
| CloudWatch | ~$3 |
| **Total** | **~$17/mo** |

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
| `deploy.sh` | Full deploy: secrets → cert → 6 stacks → config upload |
| `teardown.sh` | Delete all stacks in reverse order |
| `init-cert.sh` | Let's Encrypt cert via Route 53 DNS challenge → ACM |
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

Certificates expire every 90 days. Re-run to renew (same ACM ARN is reused):

```bash
bash bin/init-cert.sh --domain pipeline.example.com
```

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
| Grafana | `/grafana/` |
| PgAdmin | `/pgadmin/` |
| Mongo Express | `/mongo-express/` |
| Registry UI | `/registry-express/` |

---

## File Structure

<details>
<summary>EC2 deployment files</summary>

```
deploy/aws/ec2/
├── template.yaml          # CloudFormation stack
├── .env.example           # Reference config
├── bin/
│   ├── bootstrap.sh       # EC2 setup + hardening
│   ├── startup.sh         # Minikube + K8s deploy
│   ├── shutdown.sh        # Teardown
│   └── update-tls-secret.sh
├── k8s/                   # 22 Kubernetes manifests
│   └── kustomization.yaml # Kustomize entry point
├── nginx/
│   ├── nginx-ec2.conf     # Nginx config (TLS + JWT)
│   ├── jwt.js             # NJS JWT parsing
│   └── metrics.js         # NJS metrics
└── config/                # Prometheus, Loki, Promtail, Grafana configs
```

</details>

<details>
<summary>Fargate deployment files</summary>

```
deploy/aws/fargate/
├── bin/
│   ├── deploy.sh          # Full deployment orchestrator
│   ├── teardown.sh        # Delete all stacks
│   ├── init-cert.sh       # Let's Encrypt → ACM
│   └── init-secrets.sh    # Generate secrets
├── stacks/
│   ├── 01-foundation.yaml # VPC, ALB, EFS, S3, Cloud Map
│   ├── 02-cluster.yaml    # ECS, IAM, security groups
│   ├── 03-databases.yaml  # PostgreSQL, MongoDB, Redis
│   ├── 04-services.yaml   # Nginx + 8 app services (incl. Reporting)
│   ├── 05-observability.yaml
│   └── 06-admin.yaml
├── config/                # Prometheus, Loki, Grafana, Fluent Bit
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
Verify GHCR credentials and that iptables rules aren't intercepting minikube's outbound traffic.

**CrashLoopBackOff on observability pods (EC2):**
Usually hostPath permission issues. Check pod logs. Init containers handle `chown` for loki (10001), prometheus (65534), grafana (472).

**ECS tasks stuck in PROVISIONING (Fargate):**
Check CloudWatch logs: `aws logs tail /pipeline-builder/<service> --follow`

**ALB health checks failing (Fargate):**
Verify nginx is running. Check target group health and port 8080 accessibility.

**Certificate errors:**
Ensure certbot has Route 53 permissions. Check ACM status: `aws acm describe-certificate --certificate-arn <arn>`

**No reporting data after deploy:**
1. Verify `pipeline-manager store-token` was run
2. Check Lambda logs: `aws logs tail /aws/lambda/pipeline-builder-event-ingestion --follow`
3. Check SQS DLQ for failed events
4. Verify pipeline was deployed after `setup-events` (ARN must be registered)
