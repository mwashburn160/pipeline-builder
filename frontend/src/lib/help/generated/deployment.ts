// GENERATED FROM docs/aws-deployment.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 84502527b7610efb74dc39d186a2bfaa12df70bb4e20a5cb4029867fe7c19d67
// SPDX-License-Identifier: Apache-2.0
import { Server } from 'lucide-react';
import type { HelpTopic } from '../types';

export const deploymentTopic: HelpTopic = {
  "icon": Server,
  "id": "deployment",
  "title": "Deployment",
  "description": "Install with the pipeline-manager CLI, plus Local, Minikube, and AWS guides",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Two deployment options: EC2 (single Minikube instance) or EKS (managed Kubernetes — EKS Auto Mode)."
        },
        {
          "type": "text",
          "content": "Both deploy the full stack: app services, databases, observability (Prometheus + Loki, surfaced via the native /dashboard/observability page), and admin tools. Both front the workload with an ALB that terminates TLS using an ACM cert (DNS-validated); the compute is always in private subnets. A domain + public Route 53 zone is required."
        },
        {
          "type": "text",
          "content": "Observability is the native /dashboard/observability page across all deployments. Five dashboards (Platform Overview, Plugin Builds, Queue Health, Registry Activity, Audit Activity) are seeded into the database at platform cold start as public rows owned by the system org (org_id = the configured SYSTEM_ORG_ID, default 000000000000000000000001), so they appear automatically for any logged-in org and open at /dashboard/observability/<id>. Panels backed by fleet-wide queries (catalog entries that aren't orgScoped — platform totals, queue/registry metrics) are shown only to system admins, and a dashboard with no panel the caller can render is hidden. Org members see Plugin Builds and the org-scoped part of Platform Overview; org admins also get Audit Activity, which reads the MongoDB audit trail scoped to their org; Queue Health and Registry Activity are system-admin only. Audit Activity also has a dedicated page at /dashboard/observability/audit-activity."
        },
        {
          "type": "text",
          "content": "Related docs: Environment Variables | API Reference | Plugin Catalog"
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This guide is for operators standing up Pipeline Builder on AWS. It covers the two targets — EC2 (single Minikube instance) and EKS (managed Kubernetes, Auto Mode) — deployed in either public (internet-facing ALB) or private (internal ALB, the default) mode, plus email (SES), platform initialization, execution reporting, and drift detection. Both targets keep the compute in private subnets behind a TLS-terminating ALB using a DNS-validated ACM cert, so a domain and public Route 53 zone are always required. The recommended entry point is the AI-assisted infra provision command, which wraps the underlying bin/setup.sh scripts that remain the source of truth."
        }
      ]
    },
    {
      "id": "process-overview",
      "title": "Process overview",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Pick a target and mode — EC2 or EKS; public or private. Both need --domain + --hosted-zone-id.",
            "Provision — run pipeline-manager infra provision (recommended) or bin/setup.sh / raw CloudFormation directly; it requests a DNS-validated ACM cert and fronts the private compute with an ALB.",
            "Wait for the URL — the cert validates mid-deploy, then instances/pods pass health checks a few minutes later; the URL is https://<your-domain> (public, or in-VPC only for private mode).",
            "Initialize the platform — register the admin and load plugins/compliance/samples via init-platform.sh (runs automatically by default; use --init manual to set real admin creds yourself).",
            "Store service credentials — infra store-token provisions the org's service accounts and writes their pb_sa_… keys to Secrets Manager for the lookup Lambda, CodeBuild's registry pulls and the event-ingestion Lambda.",
            "Deploy reporting — wire up the EventBridge → SQS → Lambda stack for execution and plugin analytics.",
            "Operate — monitor via /dashboard/observability, reconcile registry vs live stacks with audit stacks, and tear down with --teardown when done."
          ]
        }
      ]
    },
    {
      "id": "table-of-contents",
      "title": "Table of Contents",
      "blocks": [
        {
          "type": "list",
          "items": [
            "AI-assisted install (infra provision) -- The recommended way to install the platform",
            "Deployment modes -- Public vs private, and what each changes",
            "Public deployment (quickstart) -- Internet-facing install, EC2 or EKS",
            "Private deployment (quickstart) -- Inside-AWS-only install, EC2 or EKS",
            "EC2 -- Single Minikube instance (dev/staging, ~$140-265/mo)",
            "EKS -- Managed Kubernetes, EKS Auto Mode (production, ~$150-400/mo)",
            "Email (SES) -- Transactional email (provisioned by default; --no-email to skip)",
            "Post-Deploy Steps -- Platform init, credentials, EventBridge reporting",
            "Drift Detection (audit stacks) -- Reconcile registry vs live CloudFormation",
            "Report API Endpoints -- Execution and plugin analytics",
            "Access Points -- Service URLs after deployment",
            "File Structure -- Deployment file layout",
            "Troubleshooting -- Common issues and fixes"
          ]
        },
        {
          "type": "table",
          "headers": [
            "",
            "EC2",
            "EKS"
          ],
          "rows": [
            [
              "Runtime",
              "Minikube on EC2",
              "EKS Auto Mode (Karpenter-scaled EC2 nodes)"
            ],
            [
              "Infra",
              "1 CloudFormation stack",
              "eksctl cluster + Kubernetes manifests"
            ],
            [
              "TLS",
              "ACM cert at the ALB",
              "ACM cert at the ALB Ingress"
            ],
            [
              "Public surface",
              "ALB only (instance private)",
              "ALB Ingress only (nodes private)"
            ],
            [
              "Storage",
              "hostPath PVCs on EBS",
              "EBS (RWO) + EFS (RWX) via CSI"
            ],
            [
              "Scaling",
              "Vertical (instance resize)",
              "Horizontal (Karpenter nodes + pod autoscaling)"
            ],
            [
              "Cost",
              "~$140-560/mo (t3.xlarge–m5.4xlarge, 24/7)",
              "~$150-400/mo"
            ],
            [
              "Best for",
              "Dev/staging",
              "Production"
            ]
          ]
        }
      ]
    },
    {
      "id": "ai-assisted-install-infra-provision",
      "title": "AI-assisted install (infra provision)",
      "blocks": [
        {
          "type": "text",
          "content": "The recommended way to install the platform is pipeline-manager infra provision. It picks the target, runs prerequisite checks (AWS CLI + working credentials for EC2/EKS — plus kubectl, openssl, and envsubst for EKS (eksctl is auto-installed by setup.sh); Docker etc. for local), assembles the exact, validated setup.sh command (secrets masked, missing inputs reported rather than guessed), prints the plan, and then deploys it — gated by confirmation prompts (--yes to auto-accept for CI; --json prints the plan and runs nothing). With an AI key configured it also parses a natural-language goal and diagnoses CloudFormation failures."
        },
        {
          "type": "code",
          "content": "npm install -g @pipeline-builder/pipeline-manager\n\npipeline-manager infra provision --target eks \\\n  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx --email\n\npipeline-manager infra provision --target eks --json \\\n  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx --email\n\npipeline-manager infra provision --prompt \"deploy to EKS in us-east-1 with email enabled\"\n\npipeline-manager infra provision --target eks --diagnose ./stack-events.txt",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Always deploys (gated). infra provision checks, assembles, prints the plan, and runs the deploy — it refuses on failed prerequisites or missing inputs, asks for confirmation before deploying (--yes auto-accepts for CI), streams the deploy to your terminal, then verifies /health + /ready on the application URL. On the AWS targets the deploy self-inits (EC2 on first boot; EKS in setup.sh's final phase), so infra provision surfaces it rather than running it separately; on local/minikube infra provision runs init-platform for you. --json is the only non-executing mode — it prints the plan and exits (for tooling)."
        },
        {
          "type": "text",
          "content": "On failure it troubleshoots. It matches known CloudFormation signatures and prints the likely cause + fix — and for a few it can auto-fix and retry (e.g. an existing SES identity → re-run with --skip-ses-identity; an ACM/DNS-propagation timeout → resume). Retries are gated and bounded by --retries <n> (default 1; the scripts are idempotent so a re-run resumes). With an AI key it adds a free-form diagnosis on top. When SES is enabled, a successful deploy prints DKIM/sandbox next-steps."
        },
        {
          "type": "text",
          "content": "Flags: --yes auto-approves (CI), --retries <n> auto-fix/retry budget, --init <mode> controls post-deploy initialization (auto default / manual / skip — see below), --skip-ses-identity for an already-verified SES domain, --stack-name <name> (EC2) / --cluster-name <name> (EKS) to deploy/manage a second environment."
        },
        {
          "type": "text",
          "content": "Init mode (--init <mode>). One flag controls how the platform initializes after deploy:"
        },
        {
          "type": "list",
          "items": [
            "auto (default) — init-platform runs once the platform is up, registering the admin (with the default password) and loading plugins/compliance/samples. The AWS targets self-run it as part of the deploy: EC2 on first boot (UserData → on the box as the minikube user — watch with aws ssm start-session … && sudo tail -f /var/log/user-data.log); EKS in setup.sh's final phase, reaching the cluster over a kubectl port-forward. local/minikube run it from infra provision.",
            "manual — don't init; infra provision surfaces the exact step for you to run yourself (do this to set real admin credentials PLATFORM_IDENTIFIER/PLATFORM_PASSWORD instead of the default).",
            "skip — don't initialize at all (no register, no loads)."
          ]
        },
        {
          "type": "text",
          "content": "Teardown. Add --teardown to remove a deployment. local/minikube stop the stack (on-disk / PVC data persists). EC2 DELETEs its CloudFormation stack and EKS runs bin/shutdown.sh (deletes the cluster, EFS, ACM cert + Route 53 alias) — both irreversible — so the destructive path is gated harder than deploy: you must type the resource id to confirm (a y/N is too easy to fat-finger), and --yes alone does not bypass it — only --force does (for CI). When you pass a custom --stack-name <name> (EC2) or --cluster-name <name> (EKS), the confirmation binds to that name — you type the stack/cluster name, not the target id, so a wrong name can't be confirmed by habit. The region comes from --region / AWS_REGION. As always, bin/shutdown.sh (local/minikube/EKS) and aws cloudformation delete-stack (EC2) can be run directly."
        },
        {
          "type": "code",
          "content": "# Teardown — prints the destroy plan, then prompts (type \"eks\" to confirm):\npipeline-manager infra provision --target eks --teardown",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Bootstrap a fresh machine (--repo). Without a checkout, --repo git-clones the platform repo first and runs from it. The clone is sparse + partial — git clone --filter=blob:none --no-checkout + cone sparse-checkout (git ≥ 2.27; older git falls back to a full clone) — so it materializes only the deploy folders the selected target + options need, not the whole repo (packages/, api/, frontend/, … are never downloaded). The common base is just deploy/bin; each target adds its own folder (deploy/local/docker, deploy/local/minikube — self-contained — deploy/aws/ec2, deploy/aws/eks), and each post-install load adds its folder. Re-syncs are additive (sparse-checkout add), so one --workdir can accumulate multiple targets. Override with --repo <url>, --ref <branch|tag>, --workdir <dir>. (--ref is a branch/tag; arbitrary SHAs may not fetch under the shallow clone.)"
        },
        {
          "type": "text",
          "content": "Post-install steps. After deploy + health, infra provision registers the admin (non-interactive with --admin-email/--admin-password, which set PLATFORM_IDENTIFIER/PLATFORM_PASSWORD) and runs opt-in loads — each also pulls its folder into the sparse clone: --with-plugins (build + load plugins; adds deploy/plugins + deploy/codebuild), --with-compliance (deploy/compliance), --with-samples (deploy/samples), or --with-all. Also --build-bootstrap (CodeBuild bootstrap image), --with-smoke-test (read-only API check), --with-events (EC2/EKS event ingestion — a four-step bundle: three infra store-token runs writing the platform, registry:push and reporting:ingest service-account keys to Secrets Manager at the pipeline-builder/{orgId}/… pattern, then infra setup-events --scoped-ingest deploying the EventBridge → SQS → Lambda that reads the ingest key; all pull AWS creds from the standard env / ~/.aws chain, and need PLATFORM_PASSWORD for the step-up each key write requires), and repeatable --post-step \"<cmd>\". The default is register-only (minimal clone); the loads are deterministic + idempotent, so re-running with more options just layers them on. On the AWS targets these loads run deploy-side by default (so infra provision doesn't prompt for them locally) — EC2 on first boot, EKS in setup.sh's final phase over a kubectl port-forward. Pass --init manual to drive them yourself."
        },
        {
          "type": "code",
          "content": "# Fresh box → sparse-clone just deploy/bin + deploy/local/docker, deploy, register, load samples:\npipeline-manager infra provision --target docker --repo --with-samples --yes \\\n  --admin-email admin@acme.com --admin-password 's3cret'",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "The underlying bin/setup.sh scripts remain the source of truth and can always be run directly — the rest of this guide documents them."
        }
      ]
    },
    {
      "id": "service-mesh-istio-ambient",
      "title": "Service mesh (Istio ambient)",
      "blocks": [
        {
          "type": "text",
          "content": "Both AWS targets run an Istio ambient service mesh (STRICT mTLS + identity-based L4 authorization between all services). bin/setup.sh (EKS) / bin/startup.sh (EC2) install it right after KEDA; policies live in k8s/istio.yaml. See Service Mesh for the full model. AWS-target specifics:"
        },
        {
          "type": "list",
          "items": [
            "EKS uses Auto Mode + ambient (AWS-recommended). istiod runs HA (2 replicas",
            "PDB). The node SecurityGroups must allow node↔node HBONE :15008 (cross-node"
          ]
        },
        {
          "type": "text",
          "content": "mTLS) plus istiod xDS :15012 / webhook :15017. If AWS's Auto Mode guidance pins different CNI conf/bin dirs, pass them via --set values.cni.cniConfDir/cniBinDir in setup.sh. Validate capture across all nodes and under a Karpenter scale-up."
        },
        {
          "type": "list",
          "items": [
            "EC2 is single-node Minikube; ambient installs trivially. The mesh adds"
          ]
        },
        {
          "type": "text",
          "content": "~0.3–0.7 GiB (istiod + ztunnel). The default is m5.4xlarge — the smallest allowed instance on which every HPA can reach maxReplicas at once alongside the self-hosted 7B ask-model; t3.2xlarge still runs the stack at steady state (lower the ResourceQuota to match — see k8s/resource-limits.yaml). To run a t3.xlarge instead, deploy with LEAN=1 — it drops the optional observability/admin services and single-replicas every workload so the core stack + mesh fits. Set it at launch (CFN Lean param): LEAN=1 deploy/aws/ec2/bin/setup.sh (or pipeline-manager infra provision --target ec2 --lean --instance-type t3.xlarge), or on the box: LEAN=1 sudo -E bash deploy/aws/ec2/bin/startup.sh (-E preserves the env through sudo). See Service Mesh: LEAN mode."
        },
        {
          "type": "list",
          "items": [
            "Ingress: the ALB terminates TLS (ACM) and forwards plain HTTP to nginx:8080,"
          ]
        },
        {
          "type": "text",
          "content": "which is carved out of STRICT (PERMISSIVE) — the ALB health check on :8080/health rides the same carve-out."
        },
        {
          "type": "list",
          "items": [
            "Redis runs as Sentinel HA on both targets (redis-sentinel.yaml); clients reach"
          ]
        },
        {
          "type": "text",
          "content": "redis-sentinel:26379 + redis:6379, both meshed."
        }
      ]
    },
    {
      "id": "deployment-modes-public-vs-private",
      "title": "Deployment modes (public vs private)",
      "blocks": [
        {
          "type": "text",
          "content": "Either target (EC2 or EKS) deploys in one of two modes. Both put the compute in private subnets and terminate TLS at an ALB with a publicly-trusted, DNS-validated ACM cert — so both require --domain + --hosted-zone-id (the public Route 53 zone is where ACM validates the cert). The mode flips only the ALB scheme and the DNS record:"
        },
        {
          "type": "table",
          "headers": [
            "",
            "private (inside-AWS-only, default)",
            "public"
          ],
          "rows": [
            [
              "ALB scheme",
              "internal, private subnets",
              "internet-facing, public subnets"
            ],
            [
              "Compute (instance / tasks)",
              "private subnet, no public IP",
              "private subnet, no public IP"
            ],
            [
              "DNS",
              "Route 53 private zone alias → internal ALB",
              "public Route 53 alias → ALB"
            ],
            [
              "Reachable from",
              "inside the VPC (peered / VPN / Direct Connect)",
              "the public internet"
            ],
            [
              "CodeBuild",
              "VPC-attached (PIPELINE_VPC_ID / SUBNET_IDS / SECURITY_GROUP_IDS)",
              "AWS-managed network, reaches the ALB over the internet"
            ],
            [
              "Plugin pull",
              "https://<domain>/v2/ (resolves in-VPC)",
              "https://<domain>/v2/ (public)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "In private mode, EC2 folds the VPC interface endpoints (S3, Logs, Secrets Manager, KMS, STS, CodeBuild, ECR) and the Route 53 private-zone alias to the internal ALB into its single stack, gated on DeployMode=private (no separate prereqs stack). EKS sets the ALB Ingress to scheme: internal and aliases the domain to it; eksctl provisions the cluster VPC (public + private subnets, NAT). Both request a DNS-validated ACM cert and alias the domain to the ALB (public alias or private zone). For VPC-attached CodeBuild plugin pulls, supply PIPELINE_VPC_ID / SUBNET_IDS and build-dependency egress (NAT / internal mirrors)."
        },
        {
          "type": "text",
          "content": "Use the matching quickstart below: Public or Private."
        }
      ]
    },
    {
      "id": "public-deployment-quickstart",
      "title": "Public deployment (quickstart)",
      "blocks": [
        {
          "type": "text",
          "content": "A public deployment uses an internet-facing ALB so the dashboard, API, and plugin registry are reachable from the internet over HTTPS (the compute still stays private behind it). See Deployment modes for the full comparison."
        },
        {
          "type": "text",
          "content": "Prerequisites (both targets)"
        },
        {
          "type": "list",
          "items": [
            "AWS CLI configured with credentials for the target account/region.",
            "A registered domain and its public Route 53 hosted zone — required. The stack requests a DNS-validated ACM cert for the domain against this zone, so setup.sh refuses to start without --domain + --hosted-zone-id.",
            "A GitHub account + personal access token (PAT). The service images live on GitHub Container Registry (ghcr.io/mwashburn160/); they're public, but GitHub rate-limits anonymous* pulls (60/hr) which trips mid-deploy when all 10 images pull at once. Generate your own PAT under your GitHub account: on GitHub go to Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic) (https://github.com/settings/tokens) and check only the read:packages scope. Then pass --ghcr-token <your-pat> (ghcr.io validates only the token for PAT auth — there is no username flag to set; the deploy uses a fixed internal value). Don't reuse a token from these docs or another deployment. See GhcrToken rejected for the fine-grained-PAT option and details.",
            "EC2 only: an EC2 key pair in the target region (--key-pair) for break-glass serial-console access (routine access is via SSM)."
          ]
        },
        {
          "type": "text",
          "content": "1. Deploy in public mode"
        },
        {
          "type": "text",
          "content": "Pick the target. Both take --deploy-mode public; everything else matches the private flow."
        },
        {
          "type": "code",
          "content": "cd deploy/aws/ec2\nbash bin/setup.sh --deploy-mode public \\\n  --key-pair my-keypair \\\n  --domain pipeline.example.com \\\n  --hosted-zone-id Z1234567890 \\\n  --ghcr-token ghp_xxxxxxxxxxxx\n\ncd deploy/aws/eks\nbash bin/setup.sh --deploy-mode public \\\n  --domain pipeline.example.com \\\n  --hosted-zone-id Z1234567890 \\\n  --ghcr-token ghp_xxxxxxxxxxxx",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "The ACM cert DNS-validates during the deploy, so expect setup.sh to wait a few minutes for the cert to reach ISSUED (EC2: while CloudFormation is CREATE_IN_PROGRESS; EKS: aws acm wait certificate-validated). setup.sh runs from your machine with your credentials. The EC2 Deploy section also shows the raw-CloudFormation equivalent."
        },
        {
          "type": "text",
          "content": "2. Get the URL"
        },
        {
          "type": "text",
          "content": "The URL is simply https://<your-domain> (the value you passed to --domain), reachable once the Route 53 alias resolves and the target(s) pass health checks — a few minutes after the stack completes, while the instance bootstraps / tasks start. To read it back from the stack outputs:"
        },
        {
          "type": "code",
          "content": "aws cloudformation describe-stacks --stack-name pipeline-builder \\\n  --query 'Stacks[0].Outputs[?OutputKey==`ApplicationURL`].OutputValue' --output text\n\nkubectl get ingress pb-ingress -n pipeline-builder \\\n  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "3. Initialize the platform"
        },
        {
          "type": "text",
          "content": "Public install is otherwise identical to private — by default the admin user is registered and plugins loaded automatically (EC2 self-inits on first boot; EKS self-inits in setup.sh's final phase over a kubectl port-forward). To do it yourself, deploy with --init manual and follow Post-Deploy Steps."
        },
        {
          "type": "note",
          "content": "Note: \"public\" exposes only the ALB. The instance/nodes have no public IP and no inbound SSH; admin access is still SSM Session Manager (EC2) or kubectl (EKS). To make a deployment internal-only later, redeploy with --deploy-mode private (default). See Deployment mode (DEPLOY_MODE) for the full mode comparison."
        }
      ]
    },
    {
      "id": "private-deployment-quickstart",
      "title": "Private deployment (quickstart)",
      "blocks": [
        {
          "type": "text",
          "content": "A private deployment uses an internal-scheme ALB — reachable only from inside your AWS network (the VPC, peered VPCs, or via VPN / Direct Connect), never the public internet. This is the default mode. See Deployment modes for the full comparison."
        },
        {
          "type": "text",
          "content": "Prerequisites (both targets)"
        },
        {
          "type": "text",
          "content": "Identical to the Public quickstart above: AWS CLI, a registered domain + public Route 53 hosted zone, a GitHub PAT (--ghcr-token), and — EC2 only — an EC2 key pair."
        },
        {
          "type": "note",
          "content": "The public Route 53 hosted zone is still required even in private mode: ACM validates the cert via a public DNS record. The private hosted zone (for in-VPC resolution of your domain) is created automatically by the stack — you don't supply it."
        },
        {
          "type": "text",
          "content": "1. Deploy in private mode"
        },
        {
          "type": "text",
          "content": "private is the default, so --deploy-mode private is optional (shown for clarity). Same flags as public, minus the public exposure."
        },
        {
          "type": "code",
          "content": "cd deploy/aws/ec2\nbash bin/setup.sh --deploy-mode private \\\n  --key-pair my-keypair \\\n  --domain pipeline.example.com \\\n  --hosted-zone-id Z1234567890 \\\n  --ghcr-token ghp_xxxxxxxxxxxx\n\ncd deploy/aws/eks\nbash bin/setup.sh --deploy-mode private \\\n  --domain pipeline.example.com \\\n  --hosted-zone-id Z1234567890 \\\n  --ghcr-token ghp_xxxxxxxxxxxx",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "In private mode, EC2 also folds the VPC interface endpoints (S3, Logs, Secrets Manager, KMS, STS, CodeBuild, ECR) and the Route 53 private-zone alias to the internal ALB into its single stack (gated on DeployMode=private, no separate prereqs stack). EKS sets the ALB Ingress to scheme: internal and aliases the domain to it. Either way the ACM cert still DNS-validates during the deploy, so expect a few minutes of waiting for it to issue."
        },
        {
          "type": "text",
          "content": "2. Get the URL"
        },
        {
          "type": "text",
          "content": "The URL is the same https://<your-domain>, but it resolves only from inside the VPC (via the private hosted zone) — it will not resolve from your laptop or the public internet. For EC2, read it back from the stack output (ApplicationURL); for EKS the URL is https://<your-domain> from the Route 53 alias, and you can confirm the ALB hostname as in the public step 2."
        },
        {
          "type": "text",
          "content": "3. Initialize the platform"
        },
        {
          "type": "text",
          "content": "By default this happens automatically. EC2 runs init-platform.sh ec2 on first boot (as the minikube user, in-VPC); EKS runs init-platform.sh eks from setup.sh's final phase over a kubectl port-forward to svc/nginx. Both register the admin (default password) and load plugins/compliance/samples — watch EC2 with sudo tail -f /var/log/user-data.log (after SSM)."
        },
        {
          "type": "text",
          "content": "If you deployed with --init manual (or want to re-run / set real admin creds):"
        },
        {
          "type": "list",
          "items": [
            "EC2 — SSM into the instance (aws ssm start-session --target <instance-id>), sudo -iu minikube, cd /opt/pipeline/pipeline-builder, then run ./deploy/bin/init-platform.sh ec2; it's already in-VPC.",
            "EKS — run ./deploy/bin/init-platform.sh eks with kubectl access to the cluster. It port-forwards svc/nginx (8080), so it works without the domain resolving — no VPC-attached host required."
          ]
        },
        {
          "type": "text",
          "content": "Then load plugins per Post-Deploy Steps."
        },
        {
          "type": "note",
          "content": "Note: private mode also wires CodeBuild into the VPC (PIPELINE_VPC_ID / SUBNET_IDS from the foundation VPC) so it can reach the internal ALB and pull plugin images over https://<domain>/v2/. You still supply egress (NAT / package mirrors) for build dependencies. See Deployment mode (DEPLOY_MODE) for the full comparison."
        }
      ]
    },
    {
      "id": "ec2",
      "title": "EC2",
      "blocks": [
        {
          "type": "text",
          "content": "Single hardened EC2 instance running Minikube with all services."
        },
        {
          "type": "text",
          "content": "Prerequisites"
        },
        {
          "type": "list",
          "items": [
            "AWS CLI configured",
            "EC2 key pair in target region",
            "A registered domain + its public Route 53 hosted zone (required — the template requests a DNS-validated ACM cert against it; required in both public and private mode)"
          ]
        },
        {
          "type": "text",
          "content": "Deploy"
        },
        {
          "type": "text",
          "content": "For the one-command happy path, use the Public or Private quickstart — both run bin/setup.sh from your machine with your credentials (so the instance role needs no CloudFormation permissions). An ALB fronts the always-private instance and terminates TLS with an ACM cert the template DNS-validates against your zone, so --domain + --hosted-zone-id are required; setup.sh refuses to start without them."
        },
        {
          "type": "text",
          "content": "Manual alternative (raw CloudFormation). Deploys the same single stack — nothing to follow up with. The ACM cert DNS-validates during stack creation, so expect a few minutes in CREATE_IN_PROGRESS:"
        },
        {
          "type": "code",
          "content": "cd deploy/aws/ec2\n\naws cloudformation deploy \\\n  --stack-name pipeline-builder \\\n  --template-file template.yaml \\\n  --parameter-overrides \\\n    DeployMode=private \\\n    DomainName=pipeline.example.com \\\n    HostedZoneId=Z1234567890 \\\n    KeyPairName=my-keypair \\\n    GhcrToken=ghp_xxxxxxxxxxxx \\\n  --capabilities CAPABILITY_IAM",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Get the URL:"
        },
        {
          "type": "code",
          "content": "aws cloudformation describe-stacks --stack-name pipeline-builder \\\n  --query 'Stacks[0].Outputs[?OutputKey==`ApplicationURL`].OutputValue' --output text",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Parameters"
        },
        {
          "type": "table",
          "headers": [
            "Parameter",
            "Required",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "KeyPairName",
              "Yes",
              "—",
              "EC2 key pair (serial-console/break-glass; routine access is via SSM)"
            ],
            [
              "GhcrToken",
              "Yes",
              "—",
              "GHCR token for pulling images"
            ],
            [
              "DomainName",
              "Yes",
              "—",
              "FQDN — ACM cert + Route 53 alias to the ALB"
            ],
            [
              "HostedZoneId",
              "Yes",
              "—",
              "Public Route 53 zone ID (ACM DNS validation + alias)"
            ],
            [
              "InstanceType",
              "No",
              "m5.4xlarge",
              "EC2 instance type (16 vCPU / 64 GiB) — the smallest size on which every HPA can reach maxReplicas alongside the mesh and the self-hosted ask-model. t3.2xlarge (8 vCPU / 32 GiB) runs the stack at steady state with less headroom; use t3.xlarge only with Lean=true."
            ],
            [
              "Lean",
              "No",
              "false",
              "When true, omit the optional observability/admin services + single-replica everything so the core stack + mesh fits a t3.xlarge. Pair with InstanceType=t3.xlarge. See Service Mesh: LEAN mode."
            ],
            [
              "EbsVolumeSize",
              "No",
              "60",
              "Root volume size in GiB (OS, binaries)"
            ],
            [
              "DataVolumeSize",
              "No",
              "500",
              "Data volume size in GiB (/opt/pipeline, gp3 encrypted) — Docker, plugins, registry, databases. Lower to ~200 for slim/build_image deploys."
            ],
            [
              "GitRepo",
              "No",
              "(this repo)",
              "Git repository URL"
            ],
            [
              "GitBranch",
              "No",
              "main",
              "Branch to deploy"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Storage Requirements"
        },
        {
          "type": "text",
          "content": "The EC2 deployment uses two EBS volumes:"
        },
        {
          "type": "table",
          "headers": [
            "Volume",
            "Default",
            "Mount",
            "Contents"
          ],
          "rows": [
            [
              "Root",
              "60 GiB",
              "/",
              "OS, Docker/minikube binaries, app code"
            ],
            [
              "Data",
              "500 GiB",
              "/opt/pipeline",
              "Docker layers, plugin artifacts, registry, databases, logs"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Data volume breakdown:"
        },
        {
          "type": "table",
          "headers": [
            "Component",
            "build_image",
            "prebuilt",
            "prebuilt + --cleanup"
          ],
          "rows": [
            [
              "Docker build cache + images",
              "20-30 GB",
              "60-90 GB",
              "60-90 GB"
            ],
            [
              "Plugin artifacts (image.tar + plugin.zip)",
              "0 GB",
              "130-190 GB",
              "0 GB"
            ],
            [
              "Registry (pushed images)",
              "40-60 GB",
              "40-60 GB",
              "40-60 GB"
            ],
            [
              "PostgreSQL + MongoDB",
              "5-15 GB",
              "5-15 GB",
              "5-15 GB"
            ],
            [
              "Minikube + logs + metrics",
              "15-25 GB",
              "15-25 GB",
              "15-25 GB"
            ],
            [
              "Total",
              "80-130 GB",
              "250-380 GB",
              "120-190 GB"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Recommendations:"
        },
        {
          "type": "table",
          "headers": [
            "Plugin strategy",
            "Data volume",
            "Notes"
          ],
          "rows": [
            [
              "build_image (default)",
              "200 GB",
              "Builds from Dockerfile at upload time"
            ],
            [
              "prebuilt with --cleanup",
              "250 GB",
              "Removes artifacts after upload"
            ],
            [
              "prebuilt without cleanup",
              "500 GB",
              "Keeps artifacts for re-runs"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Daily runtime operations (after initial plugin load) add ~1-5 GB/month from database growth and logs. Add a weekly Docker prune cron to reclaim build cache:"
        },
        {
          "type": "code",
          "content": "docker system prune -af --filter \"until=168h\"",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Expanding EBS Volume"
        },
        {
          "type": "text",
          "content": "If you need more storage after deployment (e.g., switching to prebuilt), expand the data volume live — no reboot required:"
        },
        {
          "type": "code",
          "content": "INSTANCE_ID=$(curl -s -H \"X-aws-ec2-metadata-token: $(curl -s -X PUT \\\n  http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600')\" \\\n  http://169.254.169.254/latest/meta-data/instance-id)\n\nVOL_ID=$(aws ec2 describe-volumes \\\n  --filters \"Name=attachment.instance-id,Values=$INSTANCE_ID\" \"Name=tag:Name,Values=*data*\" \\\n  --query 'Volumes[0].VolumeId' --output text)\n\naws ec2 modify-volume --volume-id $VOL_ID --size 500\n\nwatch -n5 \"aws ec2 describe-volumes-modifications --volume-ids $VOL_ID \\\n  --query 'VolumesModifications[0].ModificationState' --output text\"\n\nDEVICE=$(lsblk -no PKNAME $(findmnt -n -o SOURCE /opt/pipeline))\nPART=$(lsblk -no PARTNUM $(findmnt -n -o SOURCE /opt/pipeline) 2>/dev/null)\n[ -n \"$PART\" ] && sudo growpart /dev/$DEVICE $PART\nsudo xfs_growfs /opt/pipeline    # XFS filesystem\n\ndf -h /opt/pipeline",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Deploy with a larger data volume upfront:"
        },
        {
          "type": "code",
          "content": "aws cloudformation deploy \\\n  --stack-name pipeline-builder \\\n  --template-file template.yaml \\\n  --parameter-overrides \\\n    DataVolumeSize=500 \\\n    KeyPairName=my-key \\\n    GhcrToken=ghp_xxx \\\n  --capabilities CAPABILITY_IAM",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "What Happens"
        },
        {
          "type": "list",
          "items": [
            "CloudFormation creates the VPC (2 AZs: public + private subnets), NAT gateway, ALB + ACM cert, security groups, the private EC2 instance, and the Route 53 alias to the ALB",
            "EC2 UserData clones the repo and runs bootstrap.sh, which:",
            "Updates OS, installs fail2ban, disables SSH password auth",
            "Installs Docker, Minikube, kubectl",
            "Generates .env with random secrets (JWT keys, DB passwords)",
            "Runs startup.sh — creates Minikube (fresh, no cluster yet), installs the mesh/KEDA, deploys all K8s manifests",
            "Sets one iptables bridge: instance :30080 → Minikube NodePort 30080 (the ALB target). TLS is terminated at the ALB (ACM) — no cert on the box."
          ]
        },
        {
          "type": "note",
          "content": "First boot always CREATES a fresh cluster — startup.sh finds no existing profile, so it never prompts (the RECREATE prompt is TTY-gated and only reached on an existing cluster; a non-interactive UserData run has no TTY). If you later SSH onto the box and re-run startup.sh against a running/stopped cluster, it resumes by default; force a cluster rebuild with RECREATE=y sudo -u minikube deploy/aws/ec2/bin/startup.sh. The EC2 data lives on the host ($DATA_DIR), so a rebuild re-mounts the same data — to truly wipe, clear $DATA_DIR on the host first."
        },
        {
          "type": "text",
          "content": "Post-Deploy"
        },
        {
          "type": "text",
          "content": "The instance is private (no public IP); use SSM:"
        },
        {
          "type": "code",
          "content": "aws ssm start-session --target <instance-id>   # then: sudo tail -f /var/log/user-data.log\n\naws ssm start-session --target <instance-id>   # then: sudo -u minikube kubectl get pods -n pipeline-builder",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "The ALB target reports unhealthy (503) until the instance finishes bootstrapping Minikube + services — expected; it self-heals."
        },
        {
          "type": "text",
          "content": "Scripts"
        },
        {
          "type": "text",
          "content": "All in deploy/aws/ec2/bin/. On the instance the repo is checked out under the data volume, so the scripts live at /opt/pipeline/pipeline-builder/deploy/aws/ec2/bin/."
        },
        {
          "type": "table",
          "headers": [
            "Script",
            "Purpose",
            "Run as"
          ],
          "rows": [
            [
              "setup.sh",
              "Deploy the stack (private mode folds endpoints + private zone into it) — from your machine",
              "operator"
            ],
            [
              "bootstrap.sh",
              "Full EC2 setup (runs automatically via UserData)",
              "root"
            ],
            [
              "startup.sh",
              "Start Minikube + deploy K8s manifests + the ALB-target iptables bridge",
              "root (sudo)"
            ],
            [
              "shutdown.sh",
              "Stop Minikube + remove iptables rules",
              "root (sudo)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The instance has no public IP / no SSH — connect with SSM Session Manager first:"
        },
        {
          "type": "code",
          "content": "aws ssm start-session --target <instance-id>   # then, on the instance:\n\nsudo bash /opt/pipeline/pipeline-builder/deploy/aws/ec2/bin/startup.sh\n\nsudo bash /opt/pipeline/pipeline-builder/deploy/aws/ec2/bin/shutdown.sh\n\nsudo -u minikube kubectl get pods -n pipeline-builder",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Security"
        },
        {
          "type": "list",
          "items": [
            "Instance is always private — no public IP; the internet-facing ALB is the only public surface",
            "Instance SG: only the ALB SG → 30080 — no 0.0.0.0/0, no public SSH (port 22 closed; access via SSM Session Manager)",
            "TLS terminated at the ALB with an ACM cert (no private key on the box); HTTPS-only (TLS1.2+), 80→443 redirect at the ALB",
            "IMDSv2 required (token-based metadata); encrypted gp3 EBS; automatic security updates (dnf-automatic)"
          ]
        },
        {
          "type": "text",
          "content": "TLS"
        },
        {
          "type": "text",
          "content": "TLS is terminated at the ALB with an ACM certificate the template requests and DNS-validates against HostedZoneId. ACM auto-renews it; there is no certbot/Let's Encrypt and no cert on the instance. nginx serves plain HTTP behind the ALB."
        },
        {
          "type": "text",
          "content": "Deployment mode (DEPLOY_MODE)"
        },
        {
          "type": "text",
          "content": "See Deployment modes for the public/private comparison and what each changes. DEPLOY_MODE defaults to private; pass --deploy-mode public (or DEPLOY_MODE=public) for the internet-facing posture. The instance is always private and TLS is always ACM-at-the-ALB regardless of mode; the private-mode VPC endpoints + private-zone alias are folded into the single stack (gated on DeployMode=private) — no separate prereqs stack."
        },
        {
          "type": "text",
          "content": "DEPLOY_MODE and the VPC identity (PIPELINE_VPC_ID / PIPELINE_SUBNET_IDS) are injected into the instance .env automatically by bootstrap.sh (exported from the template's UserData, from the stack's VPC + private subnets) — and passed through to the first-boot init — so the synthesized CodeBuild attaches to the VPC and init-platform.sh's private-mode preflight passes with no manual step. (If you run init-platform.sh by hand on the box, the values are already in .env.)"
        },
        {
          "type": "text",
          "content": "Teardown"
        },
        {
          "type": "code",
          "content": "aws cloudformation delete-stack --stack-name pipeline-builder\naws cloudformation wait stack-delete-complete --stack-name pipeline-builder",
          "language": "bash"
        }
      ]
    },
    {
      "id": "eks",
      "title": "EKS",
      "blocks": [
        {
          "type": "text",
          "content": "Managed Kubernetes on Amazon EKS Auto Mode — AWS-managed, Karpenter-scaled EC2 nodes with the AWS Load Balancer Controller, EBS CSI, and CoreDNS built in (EFS CSI added by the deploy). One orchestrator script stands up the cluster and applies the same Kubernetes workloads as the minikube/ec2 targets, tuned for multi-node (PVC storage, ALB Ingress)."
        },
        {
          "type": "note",
          "content": "Why EKS Auto Mode? Plugin/base images are built with rootless BuildKit, which needs an unconfined seccomp profile to create its user namespace — only possible on EC2-backed Kubernetes nodes (securityContext.seccompProfile: Unconfined). Auto Mode keeps node management hands-off while running on EC2, so BuildKit works and the proven k8s manifests are reused as-is."
        },
        {
          "type": "text",
          "content": "Prerequisites"
        },
        {
          "type": "list",
          "items": [
            "AWS CLI + working credentials for the target account/region.",
            "eksctl (creates/destroys the Auto Mode cluster) — auto-installed by setup.sh/shutdown.sh (latest binary) when it isn't already on PATH.",
            "kubectl (applies the manifests), openssl (registry token keypair), and envsubst (renders cluster.yaml + the manifests). infra provision checks all of these; deploy/bin/provision-docker.sh --target eks installs them in a throwaway container if you'd rather not put them on your host.",
            "A registered domain + its public Route 53 hosted zone (required — the deploy requests a DNS-validated ACM cert against it)."
          ]
        },
        {
          "type": "text",
          "content": "Deploy"
        },
        {
          "type": "text",
          "content": "Use the Public or Private quickstart for the one-command path — bin/setup.sh runs all phases end to end. It requests a DNS-validated ACM cert for --domain and terminates TLS at the ALB Ingress (no certbot, no self-signed cert), so --domain + --hosted-zone-id are required in both modes. The cert validates mid-deploy (aws acm wait certificate-validated), so expect a few minutes of waiting there."
        },
        {
          "type": "text",
          "content": "Parameters"
        },
        {
          "type": "table",
          "headers": [
            "Parameter",
            "Required",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "--domain",
              "Yes",
              "—",
              "FQDN — ACM cert + Route 53 alias to the ALB Ingress"
            ],
            [
              "--hosted-zone-id",
              "Yes",
              "—",
              "Public Route 53 zone ID (ACM DNS validation + alias)"
            ],
            [
              "--ghcr-token",
              "Yes",
              "—",
              "GHCR token for pulling the service images"
            ],
            [
              "--deploy-mode",
              "No",
              "private",
              "public (internet-facing ALB) or private (internal)"
            ],
            [
              "--cluster-name",
              "No",
              "pipeline-builder",
              "EKS cluster name (set a second one to run multiple environments)"
            ],
            [
              "--no-email",
              "No",
              "—",
              "Skip SES (transactional email is provisioned by default)"
            ],
            [
              "--email-from",
              "No",
              "noreply@<domain>",
              "From address SES sends as"
            ],
            [
              "--email-from-name",
              "No",
              "pipeline-builder",
              "Display name on outbound email"
            ],
            [
              "--no-create-ses-identity",
              "No",
              "—",
              "Skip creating the SES identity (domain already verified in this account)"
            ],
            [
              "--alert-email",
              "No",
              "—",
              "Subscribe an address to the SES bounce/complaint SNS topic"
            ],
            [
              "--region",
              "No",
              "us-east-1",
              "AWS region"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Deployment mode (DEPLOY_MODE)"
        },
        {
          "type": "text",
          "content": "See Deployment modes for the public/private comparison. DEPLOY_MODE defaults to private; set it in the env before setup.sh or use --deploy-mode public. On EKS it controls only the ALB Ingress scheme — internal (private) vs internet-facing (public) — and the Route 53 record. For VPC-attached CodeBuild plugin pulls in private mode, supply PIPELINE_VPC_ID / SUBNET_IDS (the eksctl cluster VPC)."
        },
        {
          "type": "text",
          "content": "Phases"
        },
        {
          "type": "text",
          "content": "bin/setup.sh runs these in order — there are no per-component CloudFormation stacks (eksctl manages the cluster's own stacks under the hood):"
        },
        {
          "type": "table",
          "headers": [
            "Phase",
            "Contents"
          ],
          "rows": [
            [
              "1. Cluster",
              "eksctl creates the EKS Auto Mode cluster (cluster/cluster.yaml) + the aws-efs-csi-driver addon"
            ],
            [
              "2. EFS",
              "Encrypted EFS filesystem + security group (NFS from the nodes) + mount targets in the private subnets → the pb-efs (RWX) StorageClass"
            ],
            [
              "3. ACM",
              "DNS-validated ACM cert for --domain (publishes the validation record to Route 53, waits for ISSUED)"
            ],
            [
              "4. Secrets",
              "Namespace + the secret/ConfigMap set the manifests expect (JWT, DB creds, registry token keypair, app-env, DB init, observability configs) — same layout as the ec2 target"
            ],
            [
              "5. Pod Identity",
              "SES ses:SendEmail association for the platform ServiceAccount (when email is enabled)"
            ],
            [
              "6. KEDA",
              "Installs the KEDA operator (the plugin ScaledObject autoscaler — Auto Mode doesn't bundle it)"
            ],
            [
              "7. Workloads",
              "`kubectl kustomize k8s",
              "kubectl apply — all services: Nginx, Platform, Pipeline, Plugin, Quota, Billing, Message, Reporting, Compliance, Frontend, the in-cluster image-registry, observability (Prometheus, Loki, Alertmanager — surfaced via /dashboard/observability`), admin tools (PgAdmin, Mongo Express), and the ALB Ingress"
            ],
            [
              "8. Route 53",
              "A-alias --domain → the ALB the Ingress provisions"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Post-Deploy"
        },
        {
          "type": "text",
          "content": "setup.sh applies the manifests, then the pods need a minute or two to pull, start, and pass readiness. The ALB target group reports unhealthy (503) until nginx and the platform are ready — expected; it self-heals."
        },
        {
          "type": "code",
          "content": "kubectl get pods -n pipeline-builder -w\n\nkubectl rollout status deploy/nginx deploy/platform deploy/pipeline deploy/plugin -n pipeline-builder\n\nkubectl exec -it deploy/platform -n pipeline-builder -- /bin/sh",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Plugin base images are seeded by init-platform.sh eks (the post-deploy step) — built by the in-cluster rootless buildkitd and pushed to the in-cluster registry; setup.sh itself doesn't build them. By default infra provision runs that init for you over a kubectl port-forward; with the raw script, run ./deploy/bin/init-platform.sh eks once the registry is up (see Post-Deploy Steps). It works from anywhere with kubectl access — no VPC-attached host needed, even in private mode."
        },
        {
          "type": "text",
          "content": "Storage Requirements"
        },
        {
          "type": "text",
          "content": "Persistent state lives on PVCs provisioned by the EBS/EFS CSI drivers — no EBS volumes to hand-manage. PostgreSQL, MongoDB, Redis, and the rest run as Kubernetes workloads (the postgres/mongo/redis images), not as RDS/DocumentDB/ElastiCache. Plugin images are built by an in-cluster rootless BuildKit sidecar and pushed to the in-cluster registry (there is no ECR dependency)."
        },
        {
          "type": "table",
          "headers": [
            "Resource",
            "Storage class",
            "Size",
            "Notes"
          ],
          "rows": [
            [
              "PostgreSQL",
              "pb-ebs (RWO)",
              "5-15 GB",
              "Pipelines, plugins, compliance, messages"
            ],
            [
              "MongoDB",
              "pb-ebs (RWO)",
              "10-20 GB",
              "Quota + billing records"
            ],
            [
              "Prometheus / Alertmanager / PgAdmin",
              "pb-ebs (RWO)",
              "1-10 GB each",
              "Metrics, alert state, admin UI"
            ],
            [
              "In-cluster registry",
              "none — MinIO",
              "—",
              "Stateless: images go to the registry bucket via the S3 storage driver"
            ],
            [
              "Loki",
              "none — MinIO",
              "—",
              "Chunks + index ship to the loki bucket"
            ],
            [
              "Redis",
              "pb-ebs (RWO)",
              "1-5 GB",
              "Sentinel HA StatefulSet (3 Redis + 3 Sentinel) — queues + cache"
            ],
            [
              "Plugin builds / uploads",
              "pb-efs (RWX)",
              "per-pod",
              "BuildKit layer cache + upload staging (shared in-pod with the sidecar)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Recommendations:"
        },
        {
          "type": "table",
          "headers": [
            "Resource",
            "Setting"
          ],
          "rows": [
            [
              "pb-ebs PVCs",
              "gp3, ReclaimPolicy: Retain — data survives a PVC/pod delete (clean up orphans manually)"
            ],
            [
              "pb-efs",
              "Elastic — grows automatically; no pre-provisioning"
            ],
            [
              "Registry growth",
              "Prune old plugin image tags from the in-cluster registry periodically"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Monthly cost estimate (infra):"
        },
        {
          "type": "table",
          "headers": [
            "Resource",
            "Cost"
          ],
          "rows": [
            [
              "EKS control plane",
              "~$73"
            ],
            [
              "EC2 nodes (Karpenter, on-demand)",
              "~$60-250 (scales with workload)"
            ],
            [
              "EBS (gp3 PVCs)",
              "~$5-15"
            ],
            [
              "EFS (registry + loki)",
              "~$3-10"
            ],
            [
              "ALB + NAT gateway",
              "~$30-50"
            ],
            [
              "Total",
              "~$150-400/mo"
            ]
          ]
        },
        {
          "type": "text",
          "content": "(EC2 node cost is the dominant, workload-dependent term — Karpenter scales nodes to fit scheduled pods.)"
        },
        {
          "type": "text",
          "content": "Expanding EKS Storage"
        },
        {
          "type": "text",
          "content": "pb-ebs PVCs (postgres / mongodb / prometheus / …): the gp3 StorageClass allows volume expansion, so grow a volume by raising the PVC request and letting the EBS CSI driver expand it online:"
        },
        {
          "type": "code",
          "content": "kubectl patch pvc postgres-data -n pipeline-builder \\\n  -p '{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"30Gi\"}}}}'",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "pb-efs (plugin build uploads) — no expansion needed: EFS is elastic and grows automatically. (The registry, Loki, and message attachments now live in MinIO, not EFS — the registry is stateless S3, Loki ships chunks/index to S3; only plugin build uploads still use pb-efs.) Cap MinIO growth via bucket lifecycle rules + Loki retention_period; check EFS usage via aws efs describe-file-systems."
        },
        {
          "type": "text",
          "content": "Cluster capacity: node capacity is managed by Karpenter (Auto Mode) — it provisions and removes EC2 nodes to fit scheduled pods, so there is no instance to resize."
        },
        {
          "type": "text",
          "content": "EKS vs the other k8s targets"
        },
        {
          "type": "text",
          "content": "EKS reuses the same Kubernetes manifests as minikube/ec2, with these AWS-managed substitutions:"
        },
        {
          "type": "table",
          "headers": [
            "minikube / ec2",
            "EKS"
          ],
          "rows": [
            [
              "hostPath volumes",
              "EBS (RWO) + EFS (RWX) PVCs via CSI"
            ],
            [
              "NodePort + iptables bridge",
              "ALB Ingress (target-type: ip → nginx:8080)"
            ],
            [
              "Single node",
              "Karpenter-scaled EC2 nodes (Auto Mode)"
            ],
            [
              "EC2 instance role (SES)",
              "EKS Pod Identity association"
            ],
            [
              "Self-managed addons",
              "Auto Mode: AWS LB Controller, EBS CSI, CoreDNS built in (EFS CSI added)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Scripts"
        },
        {
          "type": "text",
          "content": "All in deploy/aws/eks/bin/. Run from your local machine (or via infra provision)."
        },
        {
          "type": "table",
          "headers": [
            "Script",
            "Purpose"
          ],
          "rows": [
            [
              "setup.sh",
              "Full deploy: cluster → EFS → ACM → secrets → KEDA → manifests → Route 53"
            ],
            [
              "shutdown.sh",
              "Teardown: Ingress/ALB → Route 53 → EFS → cluster → ACM cert"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Monitoring"
        },
        {
          "type": "code",
          "content": "kubectl get pods,svc -n pipeline-builder\n\nkubectl logs -f deploy/nginx -n pipeline-builder",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "TLS Renewal"
        },
        {
          "type": "text",
          "content": "The ACM cert is DNS-validated and auto-renews — nothing to do (ACM rotates it as long as the validation CNAME stays in the hosted zone). The ALB Ingress picks up the renewed cert automatically."
        },
        {
          "type": "text",
          "content": "Teardown"
        },
        {
          "type": "code",
          "content": "cd deploy/aws/eks\nbash bin/shutdown.sh --cluster-name pipeline-builder --region us-east-1 \\\n  --domain pipeline.example.com --hosted-zone-id Z123 --yes",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Deletes the Ingress/ALB, the Route 53 alias, the EFS filesystem, the cluster (eksctl delete cluster), and the ACM cert — in dependency order."
        },
        {
          "type": "note",
          "content": "EBS volumes on the pb-ebs (Retain) StorageClass are not auto-deleted (they're reported at the end). Remove leftovers manually if you don't need the data."
        }
      ]
    },
    {
      "id": "email-ses",
      "title": "Email (SES)",
      "blocks": [
        {
          "type": "text",
          "content": "The platform sends transactional email (invitations, email verification, password resets) via Amazon SES. It's enabled by default — every AWS deploy provisions it; pass --no-email to skip it:"
        },
        {
          "type": "code",
          "content": "bash bin/setup.sh --key-pair my-keypair --domain pipeline.example.com \\\n  --hosted-zone-id Z123 --ghcr-token ghp_xxx\n\nbash bin/setup.sh --domain pipeline.example.com \\\n  --hosted-zone-id Z123 --ghcr-token ghp_xxx --no-email",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "By default the deploy wires up everything in one shot:"
        },
        {
          "type": "list",
          "items": [
            "Identity (Easy DKIM): creates an SES domain identity for --domain and"
          ]
        },
        {
          "type": "text",
          "content": "publishes its 3 DKIM CNAMEs to your Route 53 zone, so the domain self-verifies — no manual click. (EC2: in template.yaml; EKS: setup.sh Phase 5 via aws sesv2.) The CNAMEs always go to the public hosted zone, so this works in private mode too. Pass --no-create-ses-identity if the domain is already a verified SES identity in this account."
        },
        {
          "type": "list",
          "items": [
            "Permission: grants ses:SendEmail, scoped to the identity and the From"
          ]
        },
        {
          "type": "text",
          "content": "address — on EC2 via the instance role (the platform pod reaches it over IMDS; metadata hop limit is already 2); on EKS via an EKS Pod Identity association for the platform ServiceAccount, carrying a policy scoped to ses:SendEmail on that identity (not AmazonSESFullAccess). No access keys are created or stored."
        },
        {
          "type": "list",
          "items": [
            "App config: sets EMAIL_ENABLED=true, EMAIL_PROVIDER=ses,"
          ]
        },
        {
          "type": "text",
          "content": "SES_REGION=<deploy region>, EMAIL_FROM=noreply@<domain>, EMAIL_FROM_NAME=pipeline-builder. Override the sender with --email-from / --email-from-name."
        },
        {
          "type": "table",
          "headers": [
            "Flag",
            "Default",
            "Purpose"
          ],
          "rows": [
            [
              "--no-email",
              "—",
              "Skip SES (it is provisioned by default: identity + DKIM + role grant + app env)"
            ],
            [
              "--email-from",
              "noreply@<domain>",
              "From address SES sends as"
            ],
            [
              "--email-from-name",
              "pipeline-builder",
              "Display name on outbound email"
            ],
            [
              "--no-create-ses-identity",
              "—",
              "Skip identity creation when --domain is already a verified SES identity in this account/region (avoids a \"already exists\" rollback); IAM + env are still wired"
            ],
            [
              "--alert-email",
              "—",
              "Subscribe this address to the bounce/complaint SNS topic (you must confirm the email AWS sends)"
            ]
          ]
        },
        {
          "type": "note",
          "content": "Region matters: the SES identity is regional and must match the deploy region. The deploy pins SES_REGION to it automatically (EC2 derives it from the stack region in bootstrap.sh, not the static .env default)."
        },
        {
          "type": "text",
          "content": "Verification & the SES sandbox"
        },
        {
          "type": "text",
          "content": "Two things happen after the stack completes, and both need your attention:"
        },
        {
          "type": "list",
          "items": [
            "DKIM verification is asynchronous — Route 53 → SES propagation takes"
          ]
        },
        {
          "type": "text",
          "content": "minutes to hours. Sends before the domain verifies fail gracefully (the platform logs it and continues). Check status at SES console → Verified identities."
        },
        {
          "type": "list",
          "items": [
            "New SES accounts are sandboxed — you can only send to verified"
          ]
        },
        {
          "type": "text",
          "content": "recipients, max 200/day. To send to arbitrary users, request production access (SES console → Account dashboard). CloudFormation can't do this for you. To smoke-test while sandboxed, verify a real recipient address — never admin@internal (it bounces, and sandbox bounces hurt the reputation AWS reviews for production approval)."
        },
        {
          "type": "text",
          "content": "Bounce & complaint tracking"
        },
        {
          "type": "text",
          "content": "SES enforces sender reputation at the account level — above ~5% bounce or ~0.1% complaint it puts the account under review and can pause all sending (including password resets). To make that visible instead of a silent outage, the deploy provisions a configuration set that every send routes through (SES_CONFIGURATION_SET on the platform), with an SNS topic receiving every bounce, complaint, and reject (pipeline-builder-email-events on EC2; <cluster-name>-email-events on EKS)."
        },
        {
          "type": "text",
          "content": "Pass --alert-email you@example.com to subscribe an address at deploy time (confirm the subscription email AWS sends), or subscribe the topic later from the console. Without a subscription the topic still collects events — you just won't be alerted. Reputation rates are also on the SES console Account dashboard."
        }
      ]
    },
    {
      "id": "post-deploy-steps",
      "title": "Post-Deploy Steps",
      "blocks": [
        {
          "type": "text",
          "content": "After deploying (EC2 or EKS), complete these steps to initialize the platform and enable reporting."
        },
        {
          "type": "text",
          "content": "1. Initialize the Platform"
        },
        {
          "type": "text",
          "content": "Register the admin user and load pre-built plugins and sample pipeline templates:"
        },
        {
          "type": "code",
          "content": "cd deploy\n\nbash bin/init-platform.sh ec2         # EC2 (resolves URL from the pipeline-builder stack)\nbash bin/init-platform.sh eks         # EKS (port-forwards svc/nginx via kubectl)\nbash bin/init-platform.sh docker       # Docker Compose\nbash bin/init-platform.sh minikube    # Minikube\n\nexport PLATFORM_BASE_URL=https://pipeline.example.com\nexport PLATFORM_IDENTIFIER=admin@internal\nexport PLATFORM_PASSWORD='<a strong secret you generate>'\nbash bin/init-platform.sh ec2\n\nPLUGIN_BUILD_STRATEGY=prebuilt bash bin/init-platform.sh ec2\n\nPLUGIN_BUILD_STRATEGY=prebuilt PLUGIN_CATEGORY=infrastructure,language bash bin/init-platform.sh ec2\n\nPARALLEL_JOBS=2 bash bin/init-platform.sh docker\n\nPLUGIN_BUILD_STRATEGY=prebuilt FORCE_REBUILD=true bash bin/init-platform.sh ec2\n\nbash bin/init-platform.sh --force ec2\n\n./deploy/bin/init-platform.sh --cleanup docker\n./deploy/bin/load-plugins.sh --rebuild --cleanup\n\nsudo -u minikube PLATFORM_BASE_URL=https://your-ip bash /opt/pipeline/pipeline-builder/deploy/bin/init-platform.sh ec2\nsudo -u minikube PLATFORM_BASE_URL=https://your-ip bash /opt/pipeline/pipeline-builder/deploy/bin/init-platform.sh --cleanup ec2",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "init-platform.sh does: health check → register admin → login → select build strategy → load plugins → load pipelines."
        },
        {
          "type": "text",
          "content": "Environment Variables"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "PLATFORM_BASE_URL",
              "auto-detected",
              "Platform API URL (skips CloudFormation lookup when set)"
            ],
            [
              "PLATFORM_IDENTIFIER",
              "admin@internal",
              "Admin email"
            ],
            [
              "PLATFORM_PASSWORD",
              "Pipeline-Builder-Dev-2026! (local targets only)",
              "Admin password. The dev default is REFUSED on ec2/eks — set a strong secret there."
            ],
            [
              "PLUGIN_BUILD_STRATEGY",
              "build_image",
              "build_image or prebuilt"
            ],
            [
              "PLUGIN_CATEGORY",
              "all",
              "Comma-separated categories (e.g., language,security)"
            ],
            [
              "PARALLEL_JOBS",
              "4 (1 for prebuilt)",
              "Upload concurrency. Passed through to load-plugins.sh. Override with --parallel N on CLI."
            ],
            [
              "FORCE_REBUILD",
              "false",
              "Force rebuild all prebuilt image.tar files"
            ],
            [
              "PLUGIN_S3_CLEAR",
              "false",
              "Clear S3 bucket before upload (S3 strategy only)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Use --cleanup flag on init-platform.sh or load-plugins.sh to remove plugin.zip and image.tar files after upload. Useful on EC2 where prebuilt images can consume 25-75GB of disk."
        },
        {
          "type": "text",
          "content": "Use --force on init-platform.sh to rebuild the base images and the CodeBuild bootstrap image from scratch, ignoring the docker-cache / registry-tag idempotency skips (drives FORCE_REBUILD for the base images and --force + FORCE_PUSH for the bootstrap image). Use it after changing a base Dockerfile or the bootstrap image contents, when the cached tag would otherwise be reused."
        },
        {
          "type": "table",
          "headers": [
            "Script",
            "Purpose"
          ],
          "rows": [
            [
              "init-platform.sh",
              "Register admin + select build strategy + load plugins + pipelines (interactive)"
            ],
            [
              "build-plugin-images.sh",
              "Pre-build Docker images for plugins (prebuilt strategy)"
            ],
            [
              "load-plugins.sh",
              "Upload plugins from deploy/plugins/"
            ],
            [
              "load-templates.sh",
              "Upload pipeline templates from deploy/samples/templates/"
            ],
            [
              "test-plugins.sh",
              "Validate plugin specs and Dockerfiles"
            ],
            [
              "build-codebuild-bootstrap.sh",
              "Build + publish the CodeBuild bootstrap image (CODEBUILD_DEFAULT_IMAGE fallback runtime)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Build the CodeBuild bootstrap image (build-codebuild-bootstrap.sh)"
        },
        {
          "type": "text",
          "content": "The bootstrap image backs CODEBUILD_DEFAULT_IMAGE — the fallback runtime CodeBuild uses for the synth step and for any plugin step whose own image isn't resolved. build-codebuild-bootstrap.sh builds it with Docker and publishes it to the platform's registry. provision --build-bootstrap runs this for you; run it directly to refresh the image after a CLI/Dockerfile change."
        },
        {
          "type": "note",
          "content": "The bootstrap image bakes in aws-cdk + esbuild + pnpm so synth bundles the PluginLookup Lambda locally (no Docker-in-Docker). If you instead run cdk synth / pipeline deploy on your own machine, you need those same tools on PATH — otherwise bundling fails with Could not resolve \"axios\". See Pipeline Manager → local deploy prerequisites."
        },
        {
          "type": "code",
          "content": "cd deploy/bin\n\nDEPLOY_TARGET=ec2 ./build-codebuild-bootstrap.sh\n\nDEPLOY_TARGET=ec2 FORCE_PUSH=true ./build-codebuild-bootstrap.sh --force\n\nDEPLOY_TARGET=ec2 PIPELINE_MANAGER_VERSION=3.4.131 ./build-codebuild-bootstrap.sh --force\n\nDEPLOY_TARGET=ec2 BOOTSTRAP_IMAGE_TAG=pipeline-bootstrap:1.1 ./build-codebuild-bootstrap.sh",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Environment variables"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "DEPLOY_TARGET",
              "docker",
              "Push transport: docker \\",
              "minikube \\",
              "ec2 \\",
              "eks. ec2/minikube push via a kubectl run crane pod."
            ],
            [
              "FORCE_PUSH",
              "false",
              "Republish even when the remote tag already exists."
            ],
            [
              "BOOTSTRAP_IMAGE_TAG",
              "pipeline-bootstrap:1.0",
              "Image tag to build/push. Must match the deployment's CODEBUILD_DEFAULT_IMAGE — a mismatch fails CodeBuild with BUILD_CONTAINER_UNABLE_TO_PULL_IMAGE."
            ],
            [
              "PIPELINE_MANAGER_VERSION",
              "latest",
              "npm dist-tag/version baked in; auto-resolved to a concrete version so the Docker layer cache is correct."
            ],
            [
              "PUBLISH_PLATFORM",
              "linux/amd64",
              "Build/push platform; set linux/arm64 for an all-Graviton stack."
            ]
          ]
        },
        {
          "type": "text",
          "content": "--force rebuilds the local image; without it an already-cached image skips straight to publish."
        },
        {
          "type": "text",
          "content": "Run it on the EC2 instance — the ec2 transport runs a kubectl run crane pod, so it needs both Docker and a kubeconfig that reaches the cluster. Two gotchas:"
        },
        {
          "type": "list",
          "items": [
            "Don't run the whole script under sudo. sudo runs as root, whose $HOME has no kubeconfig, so the publish fails with \"the deploy-bootstrap service key was not found … Available contexts: (none)\". Instead grant your user Docker access and run without sudo:"
          ]
        },
        {
          "type": "text",
          "content": "bash sudo usermod -aG docker \"$(whoami)\" && newgrp docker DEPLOY_TARGET=ec2 ./build-codebuild-bootstrap.sh  If you must use sudo, hand root the kubeconfig + context explicitly: bash sudo KUBECONFIG=/home/minikube/.kube/config KUBECTL_CONTEXT=pipeline-builder \\ DEPLOY_TARGET=ec2 ./build-codebuild-bootstrap.sh  (Find the context name with kubectl config get-contexts; default is pipeline-builder.)"
        },
        {
          "type": "list",
          "items": [
            "After a fresh deploy (which generates a new user-token signing key), re-run infra store-token before publishing — otherwise the crane push / CodeBuild image pull can 401.",
            "Re-run it for ALL THREE credentials — the platform one, --scope registry:push (what CodeBuild presents to the registry) and --scope reporting:ingest (what the event Lambda reads). Each is a separate service account with only the authority its job needs; see Authentication → Stored machine credentials (AWS). Each secret holds an opaque pb_sa_… key in its password field — the full procedure, including the ordering that matters, is in Access Keys and Machine Credentials."
          ]
        },
        {
          "type": "text",
          "content": "2. Store Service Credentials"
        },
        {
          "type": "text",
          "content": "The Lambdas and CodeBuild read service-account keys from Secrets Manager — machine identities owned by the org, not a person's token. infra store-token provisions the account and issues the key:"
        },
        {
          "type": "code",
          "content": "pipeline-manager auth login --no-verify-ssl\n\nexport PLATFORM_PASSWORD='…'\n\npipeline-manager infra store-token --days 30 --schedule --region us-east-1\n\npipeline-manager infra store-token --scope registry:push --schedule --region us-east-1\n\npipeline-manager infra store-token --scope reporting:ingest --schedule --region us-east-1",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Each run writes its own secret and its own rotation stack:"
        },
        {
          "type": "table",
          "headers": [
            "Secret",
            "Service account",
            "Key scope"
          ],
          "rows": [
            [
              "pipeline-builder/{orgId}/platform",
              "platform-automation",
              "none (org admin Roles)"
            ],
            [
              "pipeline-builder/{orgId}/registry-push",
              "registry-push",
              "registry:push"
            ],
            [
              "pipeline-builder/{orgId}/reporting-ingest",
              "reporting-ingest",
              "reporting:ingest"
            ]
          ]
        },
        {
          "type": "note",
          "content": "On a headless host with no browser, export PLATFORM_IDENTIFIER / PLATFORM_PASSWORD instead: store-token still has a non-interactive password login of its own for exactly that case (it is provisioning a machine credential, with nobody present to approve anything). PLATFORM_PASSWORD is required either way — it is the step-up factor for both writes."
        },
        {
          "type": "text",
          "content": "By default infra store-token only writes the secret — you must re-run it before the key expires (audit tokens warns you in advance). To avoid that, add --schedule to also deploy a small daily key-rotation stack (pipeline-builder-token-renew):"
        },
        {
          "type": "code",
          "content": "pipeline-manager infra store-token --schedule --cron '0 3 * * *' --region us-east-1",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "The rotation stack is a scheduled Lambda that mints a sibling key on the same account, writes it to the secret, and only then retires its predecessor — in that order, so a failure at any step leaves a working credential behind. It installs nothing at runtime. See Authentication → Self-rotation. (The --with-events provision bundle opts into --schedule automatically, since the event-ingestion Lambda depends on its key.)"
        },
        {
          "type": "text",
          "content": "3. Deploy EventBridge Reporting Infrastructure"
        },
        {
          "type": "text",
          "content": "Set up pipeline execution reporting to track success rates, stage performance, and build analytics:"
        },
        {
          "type": "code",
          "content": "export PLATFORM_BASE_URL=https://pipeline.example.com\n\npipeline-manager infra setup-events --region us-east-1",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "This creates a CloudFormation stack (pipeline-builder-events) containing:"
        },
        {
          "type": "list",
          "items": [
            "EventBridge rule matching all CodePipeline and CodeBuild state changes",
            "SQS queue with dead-letter queue for failed events",
            "Lambda handler that authenticates via Secrets Manager and POSTs events to the reporting API"
          ]
        },
        {
          "type": "text",
          "content": "What is (and isn't) forwarded to the platform"
        },
        {
          "type": "text",
          "content": "The Lambda runs inside your AWS account and forwards only pipeline-execution telemetry — enough to compute success rates, stage/action timing, and DORA metrics."
        },
        {
          "type": "text",
          "content": "Not forwarded — stays in your AWS account:"
        },
        {
          "type": "list",
          "items": [
            "Your AWS account number — explicitly stripped from every event (delete detail.account).",
            "The pipeline ARN (arn:aws:codepipeline:<region>:<account>:<name>) — built only as a"
          ]
        },
        {
          "type": "text",
          "content": "transient handle to resolve the pipeline's pb.pipeline-id tag via codepipeline:ListTagsForResource, then discarded; never stored or sent."
        },
        {
          "type": "list",
          "items": [
            "AWS credentials / IAM and any account-identifying details."
          ]
        },
        {
          "type": "text",
          "content": "The platform stores no AWS account id anywhere (schemas, JWTs, and APIs are account-id-free by design), so there is nothing to mask."
        },
        {
          "type": "text",
          "content": "Forwarded payload (POST /api/reports/events, batched):"
        },
        {
          "type": "table",
          "headers": [
            "Field",
            "Notes"
          ],
          "rows": [
            [
              "pipelineId",
              "The platform pipeline id (from the pb.pipeline-id tag) — not the ARN"
            ],
            [
              "eventSource / eventType",
              "codepipeline · PIPELINE/STAGE/ACTION"
            ],
            [
              "status",
              "CodePipeline state (SUCCEEDED/FAILED/…)"
            ],
            [
              "executionId · stageName · actionName",
              "Execution GUID + stage/action names"
            ],
            [
              "errorMessage",
              "Human-readable failure summary (capped), on failures"
            ],
            [
              "startedAt · completedAt · durationMs",
              "Timing"
            ],
            [
              "commitSha · commitRef · commitTimestamp · commitCount",
              "Source revision + commit time/count for measured lead time (DORA), when --with-dora is enabled"
            ],
            [
              "environment",
              "The deploy stage's env, from the pipeline's pb.deploys tag"
            ],
            [
              "detail",
              "Raw CodePipeline event detail with account removed (log URL / error code for drill-down)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Reference: @pipeline-builder/pipeline-events."
        },
        {
          "type": "text",
          "content": "4. Verify Reporting"
        },
        {
          "type": "code",
          "content": "aws cloudformation describe-stacks --stack-name pipeline-builder-events \\\n  --query 'Stacks[0].StackStatus' --output text\n\naws events describe-rule --name pipeline-builder-codepipeline-events\n\naws lambda get-function --function-name pipeline-builder-event-ingestion \\\n  --query 'Configuration.LastModified'",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "How Reporting Works"
        },
        {
          "type": "code",
          "content": "Synth  → CDK tags the CodePipeline `pb.pipeline-id=<pipelineId>` (+ `pb.deploys`) (stable, set at creation)\nDeploy → pipeline-manager registers the pipeline (by pipelineId) in pipeline_registry\nExecute → CodePipeline runs → EventBridge captures state changes\nIngest  → SQS → Lambda resolves the pb.pipeline-id tag → POST /api/reports/events (keyed by pipelineId)\nStore   → Reporting API matches the registry by pipelineId → inserts into pipeline_events\nView    → Dashboard Reports page or GET /api/reports/..."
        },
        {
          "type": "note",
          "content": "The pipeline ARN and AWS account number never leave AWS — the Lambda attributes events via the pipeline's pb.pipeline-id tag (= the opaque pipelineId), so nothing sensitive is stored and there is no masking key to manage. The Lambda's execution role needs codepipeline:ListTagsForResource."
        },
        {
          "type": "note",
          "content": "Plugin Docker builds are captured automatically by the plugin service (no EventBridge needed)."
        },
        {
          "type": "text",
          "content": "Drift Detection (audit stacks)"
        },
        {
          "type": "text",
          "content": "The pipeline_registry table is written only when pipeline-manager pipeline deploy succeeds. CloudFormation stacks can be created or destroyed outside of that path — manual aws cloudformation delete-stack, console operations, side-channel deploys — and over time the registry can drift from reality."
        },
        {
          "type": "text",
          "content": "The audit stacks command joins the registry against live CloudFormation stacks tagged pipeline-builder and surfaces two categories of drift:"
        },
        {
          "type": "table",
          "headers": [
            "Finding",
            "Meaning",
            "Typical cause"
          ],
          "rows": [
            [
              "Orphaned stack",
              "Tagged stack exists in CloudFormation, but no matching row in pipeline_registry",
              "Pipeline was deleted from the dashboard but the CDK stack stayed in AWS"
            ],
            [
              "Missing stack",
              "Registry row exists, but no matching CloudFormation stack",
              "Stack was deleted manually (e.g. aws cloudformation delete-stack) without going through the platform"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Usage"
        },
        {
          "type": "code",
          "content": "pipeline-manager audit stacks --region us-east-1\n\npipeline-manager audit stacks --org acme --region us-east-1 --json\n\npipeline-manager audit stacks --profile production --region us-east-1",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Flags:"
        },
        {
          "type": "table",
          "headers": [
            "Flag",
            "Purpose"
          ],
          "rows": [
            [
              "--region <region>",
              "AWS region to scan. Defaults to AWS_REGION env, then CDK_DEFAULT_REGION, then us-east-1."
            ],
            [
              "--org <orgId>",
              "Restrict both the registry fetch and the stack scan to a single org."
            ],
            [
              "--profile <profile>",
              "AWS CLI profile (default: default)."
            ],
            [
              "--json",
              "Emit a single JSON document instead of human output."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Exit codes"
        },
        {
          "type": "text",
          "content": "The command is designed to be cron-friendly:"
        },
        {
          "type": "table",
          "headers": [
            "Exit code",
            "Meaning"
          ],
          "rows": [
            [
              "0",
              "No drift"
            ],
            [
              "1",
              "One or more findings (orphaned and/or missing stacks)"
            ],
            [
              "2",
              "AWS error or scan failure"
            ]
          ]
        },
        {
          "type": "text",
          "content": "A typical alerting setup runs the audit nightly and pages on non-zero exit:"
        },
        {
          "type": "code",
          "content": "0 6 * * * deploy-bot pipeline-manager audit stacks --region us-east-1 --json > /var/log/pb-audit.json || alert-on-call \"pipeline-builder drift detected\"",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Remediation"
        },
        {
          "type": "text",
          "content": "Drift is not auto-fixed — the command only reports. Reconciliation is manual and depends on the cause:"
        },
        {
          "type": "list",
          "items": [
            "Orphaned stack: confirm the pipeline definition really was deleted, then aws cloudformation delete-stack --stack-name <name> to clean up the leftover. If the deletion was unintentional, recreate the pipeline definition and redeploy.",
            "Missing stack: redeploy the pipeline (pipeline-manager pipeline deploy --id <pipelineId>) to recreate the stack and refresh the registry row. There is currently no API or dashboard surface to drop a stale registry row in isolation — if redeploy isn't desired, the row must be removed directly in Postgres (DELETE FROM pipeline_registry WHERE pipeline_id = '<pipelineId>')."
          ]
        },
        {
          "type": "text",
          "content": "What it doesn't catch"
        },
        {
          "type": "list",
          "items": [
            "Out-of-region drift — only scans the region you pass with --region. Run once per region you deploy to.",
            "Stack content drift — doesn't detect when a stack's resources have been edited in-console but the template still matches the last deploy. Use aws cloudformation detect-stack-drift for that.",
            "Mid-deploy states — only *_COMPLETE statuses are considered active. A stack stuck in CREATE_IN_PROGRESS or ROLLBACK_FAILED will look like a missing stack."
          ]
        }
      ]
    },
    {
      "id": "report-api-endpoints",
      "title": "Report API Endpoints",
      "blocks": [
        {
          "type": "text",
          "content": "All endpoints require authentication and org context. Time range defaults to last 30 days."
        },
        {
          "type": "text",
          "content": "Pipeline Execution Reports"
        },
        {
          "type": "table",
          "headers": [
            "Endpoint",
            "Description",
            "Query Params"
          ],
          "rows": [
            [
              "GET /api/reports/execution/count",
              "Execution count per pipeline with status breakdown",
              "—"
            ],
            [
              "GET /api/reports/execution/success-rate",
              "Pass/fail rate over time",
              "interval, from, to"
            ],
            [
              "GET /api/reports/execution/timeline",
              "Execution timeline (alias for success-rate)",
              "interval, from, to"
            ],
            [
              "GET /api/reports/execution/duration",
              "Average/min/max/p95 execution duration",
              "from, to"
            ],
            [
              "GET /api/reports/execution/stage-failures",
              "Stage failure heatmap",
              "from, to"
            ],
            [
              "GET /api/reports/execution/stage-bottlenecks",
              "Slowest stages per pipeline",
              "from, to"
            ],
            [
              "GET /api/reports/execution/action-failures",
              "Action/step failure rate",
              "from, to"
            ],
            [
              "GET /api/reports/execution/errors",
              "Error categorization (top N)",
              "from, to, limit"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Plugin Reports"
        },
        {
          "type": "table",
          "headers": [
            "Endpoint",
            "Description",
            "Query Params"
          ],
          "rows": [
            [
              "GET /api/reports/plugins/summary",
              "Plugin inventory (total/active/public/private)",
              "—"
            ],
            [
              "GET /api/reports/plugins/distribution",
              "Type and compute distribution",
              "—"
            ],
            [
              "GET /api/reports/plugins/versions",
              "Version counts per plugin name",
              "—"
            ],
            [
              "GET /api/reports/plugins/build-success-rate",
              "Docker build success rate over time",
              "interval, from, to"
            ],
            [
              "GET /api/reports/plugins/build-duration",
              "Build time per plugin",
              "from, to"
            ],
            [
              "GET /api/reports/plugins/build-failures",
              "Build failure reasons (top N)",
              "from, to, limit"
            ],
            [
              "GET /api/reports/plugins/runtime-success-rate",
              "Runtime success rate per plugin version (pipeline runs)",
              "from, to, name, publisher, version"
            ],
            [
              "GET /api/reports/plugins/runtime-duration",
              "Runtime p50/p95 duration per plugin version",
              "from, to, name, publisher, version"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Plugin runtime telemetry. The runtime reports describe how plugins behave when your pipelines run them. The build reports cover building the plugin images. In the dashboard, Reports → Plugins → Runs shows both runtime reports as one table per plugin version (runs, success rate, p50/p95 duration, last run), with CSV export. Here is how the data gets there:"
        },
        {
          "type": "list",
          "items": [
            "When pipeline-manager pipeline deploy synthesizes a pipeline, it records a step manifest: which plugin (publisher, name, version, image digest) each CodePipeline stage and action runs. It writes it as pb-step-manifest.json in the cloud assembly.",
            "After the deploy, the manifest is sent with the POST /api/pipelines/registry registration. The platform re-reads name, version and digest from the plugin row (the CLI's claim isn't trusted), then replaces the pipeline's rows in pipeline_step_manifests.",
            "Event ingest joins each ACTION/BUILD event on (pipeline, stage, action). It stamps plugin_publisher, plugin_name and plugin_version onto pipeline_events."
          ]
        },
        {
          "type": "list",
          "items": [
            "A run is a terminal ACTION event: SUCCEEDED or FAILED. Canceled and superseded actions aren't counted.",
            "publisher is pipeline-builder for the Official catalog and empty for your org's own plugins. To select only your own plugins, pass ?publisher= with an empty value.",
            "A pipeline deployed before this existed has no manifest, so its events carry no plugin until its next deploy.",
            "These reports are rollup-aware (?includeDescendants=true with reports:rollup) and capped by your retention window."
          ]
        },
        {
          "type": "text",
          "content": "Common query parameters:"
        },
        {
          "type": "table",
          "headers": [
            "Param",
            "Values",
            "Default"
          ],
          "rows": [
            [
              "interval",
              "day, week, month",
              "week"
            ],
            [
              "from",
              "ISO 8601 timestamp",
              "30 days ago"
            ],
            [
              "to",
              "ISO 8601 timestamp",
              "now"
            ],
            [
              "limit",
              "integer",
              "20"
            ]
          ]
        }
      ]
    },
    {
      "id": "access-points",
      "title": "Access Points",
      "blocks": [
        {
          "type": "text",
          "content": "After deployment, access services at:"
        },
        {
          "type": "table",
          "headers": [
            "Service",
            "Path"
          ],
          "rows": [
            [
              "Application",
              "/"
            ],
            [
              "Reports Dashboard",
              "/dashboard/reports"
            ],
            [
              "Observability (native)",
              "/dashboard/observability"
            ],
            [
              "Registry UI",
              "/dashboard/registry (system-admin only)"
            ],
            [
              "PgAdmin",
              "/pgadmin/ — only with ADMIN_UIS_ENABLED=true"
            ],
            [
              "Mongo Express",
              "/mongo-express/ — same"
            ],
            [
              "Grafana",
              "/grafana/ — same (then its own login, GRAFANA_ADMIN_USER / GRAFANA_ADMIN_PASSWORD)"
            ],
            [
              "Kiali (mesh graph)",
              "/kiali/ — same (read-only)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The four admin consoles are off by default on AWS: their routes 404. With ADMIN_UIS_ENABLED=true in .env (re-run setup), every request to them first passes an nginx auth_request to platform GET /admin/console-check — a live session of a platform administrator at AAL2 — with the token taken from the pb_admin_console cookie and stripped before the console sees the request. For occasional use prefer kubectl -n pipeline-builder port-forward svc/grafana 3000."
        },
        {
          "type": "text",
          "content": "After every provision the setup scripts run deploy/bin/post-provision-smoke.sh: a test alert through Alertmanager to Slack, a test email through platform, a CodePipeline credential dry-run from the pipeline pod, and a probe that a connection the NetworkPolicies deny is actually denied. Its warnings are non-fatal — read the summary line."
        }
      ]
    },
    {
      "id": "file-structure",
      "title": "File Structure",
      "blocks": [
        {
          "type": "text",
          "content": "<details> <summary>EC2 deployment files</summary>"
        },
        {
          "type": "code",
          "content": "deploy/aws/ec2/\n├── template.yaml          # CloudFormation stack\n├── .env.example           # Reference config\n├── postgres-init.sql      # Schema + RLS (identical in every target)\n├── mongodb-init.js        # Mongo indexes (identical in every target)\n├── services.txt           # Generated by projen: <kind> <name> <dir>\n├── bin/\n│   ├── setup.sh         # Deploy the stack (from your machine)\n│   ├── bootstrap.sh      # EC2 setup + hardening\n│   ├── startup.sh        # Minikube + K8s deploy + ALB-target iptables bridge\n│   └── shutdown.sh       # Teardown\n├── k8s/                   # Kubernetes manifests\n│   └── kustomization.yaml # Kustomize entry point\n├── nginx/\n│   ├── nginx.conf         # Nginx config (routes; drift-checked against the other targets)\n│   ├── jwt.js             # NJS access-log claim decode (identical in every target)\n│   ├── metrics.js         # NJS gateway request counters (identical in every target)\n│   └── registry-auth.js   # NJS registry token-realm rewrite\n└── config/                # Prometheus, Promtail, Grafana, Loki, Alertmanager, Thanos"
        },
        {
          "type": "text",
          "content": "This target's own copies, read straight out of this tree: postgres-init.sql, services.txt, mongodb-init.js, nginx/jwt.js, nginx/metrics.js and config/{loki,alertmanager,thanos}. They are identical in every target, and test/deploy-contracts fails the build if a copy drifts."
        },
        {
          "type": "text",
          "content": "</details>"
        },
        {
          "type": "text",
          "content": "<details> <summary>EKS deployment files</summary>"
        },
        {
          "type": "code",
          "content": "deploy/aws/eks/\n├── bin/\n│   ├── setup.sh           # Full deploy orchestrator (cluster → … → Route 53)\n│   └── shutdown.sh        # Teardown (Ingress/ALB → Route 53 → EFS → cluster → ACM)\n├── cluster/\n│   └── cluster.yaml       # eksctl ClusterConfig (Auto Mode + aws-efs-csi-driver)\n├── k8s/\n│   ├── kustomization.yaml # Standalone manifests (not shared with ec2/minikube)\n│   ├── storageclasses.yaml# pb-ebs (RWO) + pb-efs (RWX)\n│   ├── ingress.yaml       # ALB Ingress → nginx:8080 (ACM TLS at the ALB)\n│   └── *.yaml             # Full workload set, PVC-tuned for multi-node\n├── config/                # Prometheus, Promtail, Grafana, Loki, Alertmanager, Thanos\n├── nginx/                 # nginx.conf, admin-uis*.conf, registry-auth.js, jwt.js, metrics.js\n├── .env.example\n├── postgres-init.sql      # Schema + RLS (identical in every target)\n├── mongodb-init.js        # Mongo indexes (identical in every target)\n├── services.txt           # Generated by projen: <kind> <name> <dir>\n└── mongodb-keyfile        # generated per deploy, gitignored"
        },
        {
          "type": "text",
          "content": "postgres-init.sql, services.txt, mongodb-init.js, jwt.js/metrics.js and the Loki/Alertmanager/Thanos configs are this target's own copies, held identical across targets by test/deploy-contracts."
        },
        {
          "type": "text",
          "content": "</details>"
        }
      ]
    },
    {
      "id": "troubleshooting",
      "title": "Troubleshooting",
      "blocks": [
        {
          "type": "text",
          "content": "Pods stuck Pending (EC2): Check CPU requests vs instance capacity. kubectl describe pod <name> shows scheduling failures."
        },
        {
          "type": "text",
          "content": "ImagePullBackOff (EC2): Verify GHCR credentials and that iptables rules aren't intercepting minikube's outbound traffic. Authenticate with the GitHub Container Registry first if you haven't already:"
        },
        {
          "type": "code",
          "content": "echo $YOUR_PAT | docker login ghcr.io -u USERNAME --password-stdin",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "YOUR_PAT is a GitHub Personal Access Token with the read:packages scope. The bootstrap.sh and startup.sh scripts pick up GHCR_TOKEN and GHCR_USER env vars to create the in-cluster ghcr-secret automatically."
        },
        {
          "type": "text",
          "content": "GhcrToken rejected with unauthorized or denied: The pre-built images at ghcr.io/mwashburn160/* are public — anonymous pulls succeed — but GhcrToken is still requested by the CFN templates because anonymous GHCR pulls are subject to a low per-IP rate limit (60 req/hr) that will trip mid-deploy when EC2 pulls all 10 service images concurrently. Authenticated pulls raise the limit to 5,000 req/hr."
        },
        {
          "type": "text",
          "content": "Use your own GitHub Personal Access Token — do not copy a value from documentation, an example command, or another user's deployment. Tokens that aren't yours will fail (or worse, succeed temporarily and break later when the original owner rotates them). To create your own:"
        },
        {
          "type": "list",
          "items": [
            "Classic PAT (simplest): https://github.com/settings/tokens → \"Generate new token (classic)\" → check only the read:packages scope.",
            "Fine-grained PAT (recommended): https://github.com/settings/personal-access-tokens → \"Generate new token\" → resource owner = your account → permissions: Packages: Read (account permissions, not repo)."
          ]
        },
        {
          "type": "text",
          "content": "Pass it as the GhcrToken CFN parameter or export it as GHCR_TOKEN for bootstrap.sh/startup.sh. There is no username to set — ghcr.io validates only the token for PAT auth, so the deploy uses a fixed internal value."
        },
        {
          "type": "text",
          "content": "If you intentionally want to skip auth for a small test deploy, leave GhcrToken empty and the bootstrap scripts will fall back to anonymous pulls — expect occasional 429s on retry-storms across all 10 services."
        },
        {
          "type": "text",
          "content": "CrashLoopBackOff on observability pods (EC2): Usually hostPath permission issues. Check pod logs. Init containers handle chown for loki (10001) and prometheus (65534)."
        },
        {
          "type": "text",
          "content": "Pods stuck Pending / no nodes (EKS): Karpenter provisions nodes on demand — a brief Pending is normal at cold start. If it persists, check kubectl describe pod <name> for scheduling reasons and kubectl get events -n pipeline-builder. A pb-ebs (RWO) PVC is AZ-pinned, so its pod must schedule in the volume's AZ."
        },
        {
          "type": "text",
          "content": "ALB Ingress has no address (EKS): The AWS Load Balancer Controller provisions the ALB from ingress.yaml. Check kubectl describe ingress pb-ingress -n pipeline-builder for controller events, and that the ACM cert reached ISSUED. The Route 53 alias is only written once the Ingress reports a hostname."
        },
        {
          "type": "text",
          "content": "Certificate / stack hangs in CREATE_IN_PROGRESS: The ACM cert DNS-validates during stack creation (a few minutes). If it never issues, the --hosted-zone-id is wrong or not authoritative for --domain. Check ACM status: aws acm describe-certificate --certificate-arn <arn> (look for DomainValidationOptions[].ValidationStatus)."
        },
        {
          "type": "text",
          "content": "No reporting data after deploy:"
        },
        {
          "type": "list",
          "items": [
            "Verify pipeline-manager infra store-token was run",
            "Check Lambda logs: aws logs tail /aws/lambda/pipeline-builder-event-ingestion --follow",
            "Check SQS DLQ for failed events",
            "Verify pipeline was deployed after infra setup-events (it must have a pipeline_registry row)"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/aws-deployment.md"
};
