// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Building2 } from 'lucide-react';
import type { HelpTopic } from './types';

export const organizationBenefitsTopic: HelpTopic = {
  id: 'organization-benefits',
  title: 'Organization Benefits',
  description: 'How Pipeline Builder transforms CI/CD for engineering organizations',
  icon: Building2,
  sections: [
    {
      id: 'the-problem',
      title: 'The Problem',
      blocks: [
        {
          type: 'text',
          content:
            'Most organizations struggle with the same CI/CD challenges as they scale — inconsistent pipelines, optional security, AWS expertise bottlenecks, and no cross-team visibility.',
        },
        {
          type: 'list',
          items: [
            'Every team builds pipelines differently — knowledge is siloed and becomes unmaintainable when people leave.',
            'Security is opt-in — teams skip vulnerability scanning until something breaks in production.',
            'AWS expertise is a bottleneck — CodePipeline, CodeBuild, IAM, and Docker setup requires deep knowledge most developers shouldn\'t need.',
            'No visibility across teams — leadership can\'t answer how many pipelines exist, the failure rate, or CI/CD cost per team.',
            'Vendor lock-in — third-party platforms own the execution environment, so migrating away means rebuilding everything.',
          ],
        },
      ],
    },
    {
      id: 'self-service',
      title: 'Self-Service Pipeline Creation',
      blocks: [
        {
          type: 'text',
          content:
            'Developers create production-ready pipelines without writing CDK, CloudFormation, or buildspec files. A team gets build, test, lint, security scan, and deploy stages in minutes — not days.',
        },
        {
          type: 'table',
          headers: ['Interface', 'Use Case'],
          rows: [
            ['Dashboard', 'Visual builder — select plugins, configure stages, deploy'],
            ['AI Prompt', 'Paste a Git URL, get a complete pipeline generated from repo analysis'],
            ['CLI', 'pipeline-manager create-pipeline for scripted workflows'],
            ['REST API', 'Programmatic control for platform teams'],
            ['CDK Construct', 'PipelineBuilder for infrastructure-as-code'],
          ],
        },
      ],
    },
    {
      id: 'plugin-catalog',
      title: 'Shared Plugin Catalog',
      blocks: [
        {
          type: 'text',
          content:
            '125 pre-built, containerized plugins cover the full CI/CD lifecycle. Every plugin is versioned, tested, and shared across the organization — teams use the same tools instead of maintaining their own Docker images and build scripts.',
        },
        {
          type: 'table',
          headers: ['Category', 'What It Covers'],
          rows: [
            ['Language (11)', 'Java (Corretto/Oracle), Python, Node.js, Go, Rust, .NET, C++, PHP, Ruby'],
            ['Security (40)', 'Snyk, SonarCloud, Trivy, Semgrep, Veracode, Checkmarx, Fortify'],
            ['Quality (17)', 'ESLint, Prettier, Checkstyle, Clippy, Ruff, ShellCheck'],
            ['Testing (14)', 'Jest, Pytest, Cypress, Playwright, k6, Postman, Artillery'],
            ['Artifact (16)', 'Docker, ECR, GHCR, npm, PyPI, Maven, NuGet, Cargo'],
            ['Deploy (13)', 'Terraform, CloudFormation, Kubernetes, Helm, Pulumi, ECS, Lambda'],
            ['Notification (5)', 'Slack, Microsoft Teams, email, PagerDuty, GitHub status'],
            ['Infrastructure (5)', 'CDK synth, S3 cache, manual approval, shell'],
            ['Monitoring (3)', 'Datadog, New Relic, Sentry'],
            ['AI (1)', 'Multi-provider Dockerfile generation'],
          ],
        },
      ],
    },
    {
      id: 'compliance-enforcement',
      title: 'Compliance Enforcement',
      blocks: [
        {
          type: 'text',
          content:
            'The compliance engine validates every pipeline and plugin before creation — not after deployment. Platform teams define rules such as "all pipelines must include a security scan stage" or "plugins must not use privileged containers," evaluated against 18 operators with optional scoped exemptions and an audit trail.',
        },
        {
          type: 'list',
          items: [
            'Security scanning is mandatory, not optional.',
            'Compliance is enforced at the gate, not discovered in audit.',
            'Platform teams set policy once — every team follows it automatically.',
            'Audit trail captures every compliance decision.',
          ],
        },
        {
          type: 'note',
          content:
            'Violations at error or critical severity block creation (HTTP 403). Violations at warning severity log and allow.',
        },
      ],
    },
    {
      id: 'isolation-and-portability',
      title: 'Multi-Team Isolation & Zero Lock-In',
      blocks: [
        {
          type: 'text',
          content:
            'Every resource is scoped to an organization with role-based access control. Teams can\'t see or modify each other\'s resources — public plugins are shared, private plugins are org-only.',
        },
        {
          type: 'table',
          headers: ['Resource', 'Isolation'],
          rows: [
            ['Pipelines', 'Scoped to (project, organization, orgId)'],
            ['Plugins', 'Scoped by orgId + accessModifier (public/private)'],
            ['Secrets', 'AWS Secrets Manager path: {prefix}/{orgId}/{secretName}'],
            ['Quotas', 'Per-org limits on plugins, pipelines, API/AI calls, storage'],
            ['Compliance', 'Per-org rules and policies'],
            ['Billing', 'Per-org subscription tiers and usage tracking'],
          ],
        },
        {
          type: 'text',
          content:
            'Pipelines deploy as native AWS CodePipeline + CodeBuild in the customer\'s own AWS account. No proprietary runtime or agent, no SaaS dependency at execution time. If the organization stops using Pipeline Builder, every deployed pipeline keeps running as standard CloudFormation stacks.',
        },
      ],
    },
    {
      id: 'quantified-benefits',
      title: 'Quantified Benefits',
      blocks: [
        {
          type: 'text',
          content:
            'EventBridge captures every CodePipeline and CodeBuild state change, feeding execution analytics — success rates, duration statistics, stage failure heatmaps, and error categorization per team and project.',
        },
        {
          type: 'table',
          headers: ['Metric', 'Without Pipeline Builder', 'With Pipeline Builder'],
          rows: [
            ['Time to first pipeline', '2-5 days', '5-15 minutes'],
            ['Pipelines with security scanning', '~30% (opt-in)', '100% (enforced)'],
            ['Unique CI/CD configurations', 'N (one per team)', '1 (shared catalog)'],
            ['Docker images to maintain', 'N (per team)', '0 (pre-built plugins)'],
            ['AWS expertise required', 'Deep (CDK/CFN/IAM)', 'None (dashboard/CLI)'],
            ['Visibility into CI/CD health', 'Manual/none', 'Real-time dashboards'],
            ['Vendor lock-in', 'Yes (SaaS CI/CD)', 'None (native AWS)'],
          ],
        },
      ],
    },
  ],
};
