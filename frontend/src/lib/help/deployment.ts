// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Server } from 'lucide-react';
import type { HelpTopic } from './types';

export const deploymentTopic: HelpTopic = {
  id: 'deployment',
  title: 'Deployment',
  description: 'Install with the pipeline-manager CLI, plus Local, Minikube, and AWS guides',
  icon: Server,
  sections: [
    {
      id: 'provision',
      title: 'Install with the CLI (recommended)',
      blocks: [
        {
          type: 'text',
          content:
            'The recommended way to stand up the platform is the `pipeline-manager provision` installer. It picks the target, runs read-only prerequisite checks, and assembles the exact, validated `bin/setup.sh` command — secrets masked, missing inputs reported (never guessed). Add `--execute` to run it (gated by approval; it then verifies `/health` + `/ready` and offers to run `init-platform`). With an AI key set it also parses a natural-language goal and diagnoses CloudFormation failures.',
        },
        {
          type: 'code',
          language: 'bash',
          content: `npm install -g @pipeline-builder/pipeline-manager

# Advisor (default) — prints the exact command + prereq results, runs nothing:
pipeline-manager provision --target docker

# Run it (gated: confirm → deploy → verify health → init-platform):
pipeline-manager provision --target docker --execute

# Fargate, executed (SES email is provisioned by default):
pipeline-manager provision --target fargate \\
  --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx --execute

# Describe the goal (needs an AI key); or diagnose a failure:
pipeline-manager provision --prompt "deploy to Fargate in us-east-1 with email"
pipeline-manager provision --target fargate --diagnose ./stack-events.txt

# Tear it down (AWS targets prompt you to TYPE the target id to confirm):
pipeline-manager provision --target fargate --teardown --execute`,
        },
        {
          type: 'note',
          content:
            'On failure it matches known CloudFormation issues (cause + fix) and can auto-fix + retry a few (e.g. an existing SES identity → re-run with --skip-ses-identity); retries are gated and bounded by --retries (default 1, scripts are idempotent). Flags: --execute runs the deploy (refuses on failed prerequisites or missing inputs), --yes auto-approves for CI, --retries <n> sets the retry budget, --no-init skips the post-deploy init step, --skip-ses-identity for an already-verified SES domain. Set ANTHROPIC_API_KEY (or AI_PROVIDER + its key) to add free-form diagnosis; without a key it falls back to the deterministic advisor + issue matcher. To remove a deployment, add --teardown: docker/minikube stop the stack (on-disk data persists), while EC2/Fargate DELETE their CloudFormation stacks (irreversible) and require you to TYPE the target id to confirm (--force skips it for CI). The underlying bin/setup.sh / bin/shutdown.sh / bin/teardown.sh scripts can always be run directly.',
        },
      ],
    },
    {
      id: 'local',
      title: 'Local Development (Docker Compose)',
      blocks: [
        {
          type: 'code',
          language: 'bash',
          content: `cd deploy/local && chmod +x bin/setup.sh && ./bin/setup.sh`,
        },
        {
          type: 'text',
          content: 'This generates TLS certs, creates volumes, and starts all services. Open https://localhost:8443 to access the dashboard.',
        },
        {
          type: 'code',
          language: 'bash',
          content: `# Shut down
./bin/shutdown.sh`,
        },
      ],
    },
    {
      id: 'local-services',
      title: 'Local Services',
      blocks: [
        {
          type: 'table',
          headers: ['Service', 'URL', 'Description'],
          rows: [
            ['Dashboard', 'https://localhost:8443', 'Next.js frontend'],
            ['API Gateway', 'https://localhost:8443/api/*', 'Nginx reverse proxy'],
            ['PgAdmin', 'http://localhost:5480', 'PostgreSQL admin UI'],
            ['Mongo Express', 'http://localhost:27081', 'MongoDB admin UI'],
            ['Observability', '/dashboard/observability', 'Native dashboards over Prometheus + Loki (sysadmin only)'],
            ['Registry UI', 'http://localhost:5080', 'Docker registry browser'],
          ],
        },
      ],
    },
    {
      id: 'local-env',
      title: 'Key Environment Variables',
      blocks: [
        {
          type: 'text',
          content: 'Set in deploy/local/.env before first run:',
        },
        {
          type: 'table',
          headers: ['Variable', 'Description', 'Default'],
          rows: [
            ['JWT_SECRET', 'Required — 32+ char base64 secret', '—'],
            ['POSTGRES_PASSWORD', 'PostgreSQL password', 'password'],
            ['MONGO_INITDB_ROOT_PASSWORD', 'MongoDB password', 'password'],
            ['LOG_LEVEL', 'Logging verbosity', 'info'],
            ['QUOTA_DEFAULT_PLUGINS', 'Plugin quota per org', '100'],
            ['QUOTA_DEFAULT_PIPELINES', 'Pipeline quota per org', '10'],
            ['BILLING_PROVIDER', 'stub (local) or aws-marketplace (prod)', 'stub'],
          ],
        },
        {
          type: 'note',
          content: 'Databases initialize automatically on first startup — no manual migrations required.',
        },
      ],
    },
    {
      id: 'api-routing',
      title: 'API Routing (NGINX)',
      blocks: [
        {
          type: 'table',
          headers: ['Path', 'Service'],
          rows: [
            ['/api/pipeline/*', 'Pipeline service'],
            ['/api/plugin/*', 'Plugin service'],
            ['/api/quota/*', 'Quota service'],
            ['/api/billing/*', 'Billing service'],
            ['/api/messages/*', 'Message service'],
            ['/auth/*, /users/*, /organizations/*', 'Platform service'],
          ],
        },
      ],
    },
    {
      id: 'minikube',
      title: 'Minikube',
      blocks: [
        {
          type: 'text',
          content: 'Deploy to a local Kubernetes cluster with all services, databases, and observability (Prometheus + Loki, surfaced via the native /dashboard/observability page):',
        },
        {
          type: 'code',
          language: 'bash',
          content: 'kubectl apply -k deploy/minikube/k8s/',
        },
      ],
    },
    {
      id: 'aws',
      title: 'AWS Deployment',
      blocks: [
        {
          type: 'note',
          content: 'Recommended: install with the CLI. `pipeline-manager provision --target fargate --domain … --hosted-zone-id …` checks prerequisites and prints the exact, validated bin/setup.sh command (SES email is provisioned by default; pass `--no-email` to skip); add `--execute` to run it (gated by approval, then verifies /health + /ready and offers init-platform). With an AI key it also parses a natural-language goal and diagnoses failures.',
        },
        {
          type: 'text',
          content: 'Two production-ready AWS deployment options are available, both terminating TLS with an ACM certificate (DNS-validated) at the ALB:',
        },
        {
          type: 'table',
          headers: ['Option', 'Description', 'Best for'],
          rows: [
            ['EC2 (Minikube)', 'Single hardened EC2 instance running Minikube', 'Dev/staging, small teams, cost-focused'],
            ['Fargate', 'Serverless containers on ECS Fargate with ALB', 'Production, high availability, scaling'],
          ],
        },
        {
          type: 'code',
          language: 'bash',
          content: `# EC2: Single CloudFormation stack
cd deploy/aws/ec2
aws cloudformation deploy --stack-name pipeline-builder --template-file template.yaml \\
  --parameter-overrides DomainName=pipeline.example.com HostedZoneId=Z123 KeyPairName=my-key GhcrToken=ghp_xxx \\
  --capabilities CAPABILITY_IAM

# Fargate: 6 CloudFormation stacks
cd deploy/aws/fargate
bash bin/setup.sh --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx`,
        },
      ],
    },
    {
      id: 'aws-email',
      title: 'Transactional Email (SES)',
      blocks: [
        {
          type: 'text',
          content:
            'The platform sends invitations, email verification, and password resets via Amazon SES. It is enabled by default — every AWS deploy provisions it in one shot; pass `--no-email` to skip it.',
        },
        {
          type: 'code',
          language: 'bash',
          content: `# EC2 or Fargate — SES is provisioned by default
bash bin/setup.sh --domain pipeline.example.com --hosted-zone-id Z123 \\
  --ghcr-token ghp_xxx

# Opt out with --no-email
bash bin/setup.sh --domain pipeline.example.com --hosted-zone-id Z123 \\
  --ghcr-token ghp_xxx --no-email`,
        },
        {
          type: 'list',
          items: [
            'Verifies the domain automatically via SES Easy DKIM — 3 CNAMEs are published to your Route 53 zone (works in private mode too; they go to the public zone).',
            'Grants ses:SendEmail to the runtime role (EC2 instance role / Fargate task role) — no access keys are created or stored.',
            'Sets EMAIL_ENABLED, EMAIL_PROVIDER=ses, SES_REGION (pinned to the deploy region), EMAIL_FROM=noreply@<domain>, EMAIL_FROM_NAME=pipeline-builder. Override with --email-from / --email-from-name.',
            'Reuse an already-verified domain with --no-create-ses-identity (skips identity creation; IAM + env still wired).',
            'Routes every send through an SES configuration set wired to an SNS topic that receives bounces and complaints. Pass --alert-email you@example.com to be notified (confirm the SNS subscription), or subscribe the topic later.',
          ],
        },
        {
          type: 'warning',
          content:
            'DKIM verification is asynchronous (minutes to hours). And new SES accounts are sandboxed — you can only send to verified recipients (200/day) until you request production access in the SES console. For a sandbox smoke test, verify a real recipient; never send to admin@internal (bounces hurt your SES reputation).',
        },
      ],
    },
    {
      id: 'event-reporting',
      title: 'Pipeline Event Reporting',
      blocks: [
        {
          type: 'text',
          content:
            'Once deployed, each CodePipeline run shows up on the Reports dashboard automatically. At synth the pipeline is tagged `PIPELINE_EVENT_ID=<pipelineId>` — a stable, opaque id created with the pipeline. EventBridge forwards state-change events to a Lambda that resolves that tag and attributes the run to your pipeline, so the AWS account and ARN never leave AWS and there is no masking secret to manage.',
        },
        {
          type: 'list',
          items: [
            'Run `pipeline-manager setup-events` once per AWS account to provision the EventBridge → SQS → Lambda path.',
            'The Lambda execution role needs `codepipeline:ListTagsForResource` (an AccessDenied fails the batch loudly rather than silently dropping events).',
            'Failed runs carry the failure reason and a link to the build logs.',
            'Plugin Docker builds are reported automatically by the plugin service — no EventBridge needed.',
          ],
        },
        {
          type: 'note',
          content:
            'Events for pipelines that aren\'t registered (no `PIPELINE_EVENT_ID` tag yet) are skipped and logged — deploy/register the pipeline to start seeing its runs.',
        },
      ],
    },
  ],
};
