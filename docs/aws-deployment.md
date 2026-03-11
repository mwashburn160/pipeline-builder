# AWS Deployment

Two deployment options: **EC2** (single instance, Kubernetes) or **Fargate** (serverless containers).

Both deploy the full stack: app services, databases, observability (Prometheus, Loki, Grafana), and admin tools. TLS via Let's Encrypt (custom domain) or self-signed (IP-only).

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
| `EbsVolumeSize` | No | `50` | Root volume size (GiB) |
| `GitRepo` | No | *(this repo)* | Git repository URL |
| `GitBranch` | No | `main` | Branch to deploy |

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
| `startup.sh` | Start Minikube + deploy K8s manifests | minikube |
| `shutdown.sh` | Stop Minikube + remove iptables rules | root |
| `update-tls-secret.sh` | Certbot hook to update K8s TLS secret | root |

**Restart services:**

```bash
sudo -u minikube bash /opt/pipeline-builder/deploy/aws/ec2/bin/startup.sh
```

**Stop services:**

```bash
sudo bash /opt/pipeline-builder/deploy/aws/ec2/bin/shutdown.sh
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

### Files

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
| **04-services** | Nginx, Platform, Pipeline, Plugin, Quota, Billing, Message, Frontend |
| **05-observability** | Prometheus, Loki, Grafana |
| **06-admin** | Registry, PgAdmin, Mongo Express, Registry UI |

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

### Files

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
│   ├── 04-services.yaml   # Nginx + 7 app services
│   ├── 05-observability.yaml
│   └── 06-admin.yaml
├── config/                # Prometheus, Loki, Grafana, Fluent Bit
├── nginx/                 # nginx-fargate.conf, jwt.js, metrics.js
├── .env.example
├── mongodb-init.js
└── postgres-init.sql
```

---

## Platform Initialization

After deploying (EC2 or Fargate), initialize the platform with admin user, plugins, and sample pipelines.

### Quick Start

```bash
cd deploy

# Interactive — prompts for admin credentials
bash bin/init-platform.sh local       # Docker Compose
bash bin/init-platform.sh minikube    # Minikube
bash bin/init-platform.sh ec2         # EC2 (resolves URL from CloudFormation)

# Non-interactive
export PLATFORM_BASE_URL=https://pipeline.example.com
export PLATFORM_IDENTIFIER=admin@internal
export PLATFORM_PASSWORD=SecurePassword123!
bash bin/init-platform.sh ec2
```

`init-platform.sh` does: health check → register admin → login → load plugins → load pipelines.

### Scripts

All in `deploy/bin/`.

| Script | Purpose |
|--------|---------|
| `init-platform.sh` | Register admin + load plugins + pipelines (interactive) |
| `load-plugins.sh` | Upload plugins from `deploy/plugins/` |
| `load-pipelines.sh` | Upload pipelines from `deploy/samples/pipelines/` |
| `test-plugins.sh` | Validate plugin manifests and Dockerfiles |
| `generate-plugins.sh` | Verify tool versions in `plugin-versions.yaml` |
| `verify-plugin-urls.sh` | Check plugin Dockerfile download URLs |

**load-plugins.sh options:**

```bash
bash bin/load-plugins.sh --category language,security  # specific categories
bash bin/load-plugins.sh --dry-run                     # validate only
bash bin/load-plugins.sh --rebuild                     # force rebuild zips
```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PLATFORM_BASE_URL` | `https://localhost:8443` | Platform URL |
| `PLATFORM_IDENTIFIER` | *(prompted)* | Admin email |
| `PLATFORM_PASSWORD` | *(prompted)* | Admin password |
| `PLATFORM_TOKEN` | *(prompted)* | JWT token (skip login) |

---

## Access Points

After deployment, access services at:

| Service | Path |
|---------|------|
| Application | `/` |
| Grafana | `/grafana/` |
| PgAdmin | `/pgadmin/` |
| Mongo Express | `/mongo-express/` |
| Registry UI | `/registry-express/` |

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
