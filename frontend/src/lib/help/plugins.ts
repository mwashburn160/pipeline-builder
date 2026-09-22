// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Puzzle } from 'lucide-react';
import type { HelpTopic } from './types';
import {
  CATEGORY_DESCRIPTIONS, CATEGORY_DISPLAY_NAMES, CATEGORY_STAGES, PLUGIN_CATEGORIES,
} from '@/lib/plugin-categories';

// The category vocabulary itself lives in `@/lib/plugin-categories`: it is read
// by `usePlugins` (and therefore by the provider tree on every route), and must
// not drag this file's help corpus along with it. The live plugin list is the
// public directory at /plugins — there is deliberately no hand-kept copy here.

export const pluginsTopic: HelpTopic = {
  id: 'plugins',
  title: 'Plugins',
  description: 'Plugin directory, installs, consumption policy, publisher references, reviews and ratings, structure, spec fields, lifecycle, supply chain and secrets',
  icon: Puzzle,
  sections: [
    {
      id: 'what-are-plugins',
      title: 'What Are Plugins?',
      blocks: [
        {
          type: 'text',
          content:
            'Plugins are reusable build step definitions — a Dockerfile and plugin-spec.yaml packaged as a ZIP. Create them once, reference them across pipelines. Every plugin runs as an isolated container step inside AWS CodePipeline.',
        },
      ],
    },
    {
      id: 'categories',
      title: 'Plugin Categories',
      blocks: [
        {
          type: 'text',
          content: 'Plugins are grouped into 10 categories covering the full CI/CD lifecycle. Live counts and the top plugins in each are on the public plugin directory (/plugins).',
        },
        {
          type: 'table',
          headers: ['Category', 'Description', 'Pipeline stage'],
          rows: PLUGIN_CATEGORIES.map((id) => [CATEGORY_DISPLAY_NAMES[id], CATEGORY_DESCRIPTIONS[id], CATEGORY_STAGES[id]]),
        },
      ],
    },
    {
      id: 'plugin-catalog',
      title: 'Browse the Plugin Directory',
      blocks: [
        {
          type: 'text',
          content: 'Every listed plugin has a public page in the plugin directory at /plugins — no sign-in needed. Search as you type (press / to jump to the search box), filter by category, trust tier, licence, compute size or whether a plugin needs secrets, and open a plugin to see its README, versions, required configuration and supply-chain details (signature, image digest, vulnerability scan, SBOM).',
        },
        {
          type: 'list',
          items: [
            'Official plugins (publisher pipeline-builder) are available in every workspace without installing.',
            'Each plugin page shows a copyable pipeline reference, e.g. plugin: { name: trivy, filter: { version: \'^1\' } }, or plugin: { publisher: acme, name: terraform-plan } for another publisher\'s listing. Put the version in filter — a version key beside name is refused, not silently ignored.',
            'Signed in, the in-app catalog (Plugins) shows the same listings with your organization\'s state: installed or not, the version your pipelines resolve to, whether installing needs approval, and whether your policy blocks it.',
            'The trust-tier badge (Official, Verified, Community, Unverified) always sits beside the plugin icon — a vendor logo alone never signals trust.',
            'Signed out? "Sign in to install" takes you through sign-in and straight back to the same plugin. The sign-in link /login?returnTo=<page> works as a bookmark too.',
          ],
        },
      ],
    },
    {
      id: 'installs',
      title: 'Installing Plugins',
      blocks: [
        {
          type: 'text',
          content: 'To use a plugin another publisher listed, your organization installs it: from the catalog, choose Install. Your own organization\'s plugins need no install, and Official plugins (publisher pipeline-builder) are installed implicitly for everyone. Installing is free on every plan and uses no quota.',
        },
        {
          type: 'table',
          headers: ['Version policy', 'New synths resolve to'],
          rows: [
            ['pinned', 'Exactly the installed version'],
            ['patch', 'New patch versions (~installed)'],
            ['minor (default)', 'New minor and patch versions (^installed)'],
            ['latest', 'The newest stable version, never across a version the publisher marked breaking'],
          ],
        },
        {
          type: 'list',
          items: [
            'A new major never flows in automatically. Approvers are told it is available, with the changelog and vulnerability delta; upgrade by changing the install\'s version or policy.',
            'Implicit Official installs use policy minor inside the lowest live major. Create an explicit install to pin a version, change the policy or move to a new major; uninstalling it falls back to the implicit one.',
            'Installing needs plugins:install. If your policy requires approval for the listing\'s tier (by default Community and Unverified), the install becomes a request that holders of plugin_installs:manage approve or deny under Plugins → Approvals. You are told the outcome.',
            'Yanked versions never resolve for a listing. Paused versions are skipped by ranges (unless you are already on it or pin it). A paused listing takes no new installs; existing installs keep working.',
            'A team inherits its root organization\'s installs and policy. It may add its own installs, and its own policy can only be stricter.',
          ],
        },
      ],
    },
    {
      id: 'consumption-policy',
      title: 'Consumption Policy',
      blocks: [
        {
          type: 'text',
          content: 'Your organization\'s consumption policy decides what your pipelines may use from the ecosystem. It never affects anyone else. Edit it under Plugins → Policy (needs plugin_installs:manage and a recent re-authentication; every change is audited). No safety control is plan-gated.',
        },
        {
          type: 'table',
          headers: ['Setting', 'Default', 'Effect'],
          rows: [
            ['allowedTiers', 'Official + Verified', 'Other tiers can\'t be installed or resolve (PLUGIN_BLOCKED_BY_POLICY)'],
            ['requireApprovalTiers', 'Community + Unverified', 'Installs from these tiers need an approver'],
            ['secretsAllowedTiers', 'Official + Verified', 'Other tiers get no secrets, even if the spec declares them (warning PLUGIN_SECRETS_WITHHELD)'],
            ['blockOnAdvisory', 'critical', 'Versions with a published advisory at or above this level don\'t resolve (critical, high or never)'],
            ['officialInstalls', 'implicit', 'explicit turns off implicit Official installs, for regulated organizations'],
            ['blockedListings', 'none', 'These publisher/name listings never resolve and can\'t be installed, including Official ones'],
          ],
        },
      ],
    },
    {
      id: 'publisher-references',
      title: 'Publisher References & Shadowing',
      blocks: [
        {
          type: 'code',
          language: 'yaml',
          content: "plugin: { name: trivy }                                    # own org, parent org, then Official\nplugin: { publisher: acme, name: terraform-plan, filter: { version: '^1' } }  # only acme's listing, via your install\nplugin: { publisher: pipeline-builder, name: trivy }       # the Official listing, by name",
        },
        {
          type: 'list',
          items: [
            'Without a publisher: your organization\'s plugin, then (for a team) the parent organization\'s shared plugin, then the Official listing through your install.',
            'With a publisher: only that publisher\'s listing, and only through an install. Your own plugins are never considered. Public visibility never reaches other organizations — only listings do.',
            'Shadowing: your own plugin with the same name as an Official listing wins for references without a publisher. The Plugins page and the pipeline editor flag it, and synth warns PLUGIN_SHADOWS_LISTING. Add publisher: pipeline-builder to use the listing.',
            'Pipeline create and update refuse a publisher reference that isn\'t installed, is blocked by policy or can\'t resolve (PLUGIN_NOT_INSTALLED, PLUGIN_BLOCKED_BY_POLICY, PLUGIN_UNAVAILABLE).',
            'See the Plugin Installing topic for approvals, notifications, the API and every error code.',
          ],
        },
      ],
    },
    {
      id: 'reviews',
      title: 'Reviews & Ratings',
      blocks: [
        {
          type: 'text',
          content: 'Anyone can read reviews on a plugin\'s public page (Reviews tab). Sign in to write one: one review per person per plugin, 1 to 5 stars with an optional title and Markdown body, editable and deletable at any time. Only your display name is shown, never your organization.',
        },
        {
          type: 'list',
          items: [
            'Verified use: the badge appears when your organization ran the plugin successfully in the last 90 days. It never names the organization.',
            'The score is a Bayesian average (every plugin starts at 3.5 stars worth 10 votes). Verified-use reviews count fully and other reviews count half. A Recent versions score covers the last two minor versions.',
            'You can\'t review your own organization\'s plugins or vote on their reviews (REVIEW_SELF_PROMOTION). Service accounts and access keys can\'t write, vote, report or reply (HUMAN_SESSION_REQUIRED).',
            'Each organization, and each network address, can post 20 new reviews a day. A review with more than three links, part of a burst of unverified reviews, or reported by several people is held for moderation.',
            'Report a review as spam, abuse, off-topic or a security issue. A security report is never posted: the review is hidden and the publisher and the platform moderators are told privately.',
            'Publishers reply once per review (publishers:manage). The in-app catalog shows each listing\'s rating and install count.',
          ],
        },
      ],
    },
    {
      id: 'publishing',
      title: 'Publishing to the Ecosystem',
      blocks: [
        {
          type: 'text',
          content: 'Setting a plugin to public shares it with your organization and its teams only. To share it with other organizations, publish it to the plugin ecosystem from the Publisher page: claim a publisher handle, accept the publisher terms, then request a listing for one of your public versions. The system organization reviews every request before anything appears in the directory.',
        },
        {
          type: 'list',
          items: [
            'A version request needs a public version with an SPDX license, a README and a passing vulnerability scan. Its image digest is pinned when you submit, so the version can no longer be re-uploaded.',
            'Catalog details (summary, description, links, icon, README) are pre-filled from your package. Accept or edit each one; a live card preview shows the directory entry.',
            'You can pause your own listing or version at once. Yanks, unpausing, transfers, handle changes and the Verified badge are requests.',
            'Every plan can publish within its listings limit (Developer 3, Pro 10, Team 25, Enterprise 100). Team and Enterprise publishers can apply for Verified.',
            'See the Plugin Publishing topic for the full walkthrough.',
          ],
        },
      ],
    },
    {
      id: 'create-plugins',
      title: 'Creating Plugins',
      blocks: [
        {
          type: 'text',
          content: 'You can create plugins in several ways:',
        },
        {
          type: 'list',
          items: [
            'Dashboard — On the Plugins page click "Create plugin" and upload a ZIP, or use the AI Builder tab to describe the plugin in plain language.',
            'CLI — pipeline-manager plugin upload --file ./my-plugin.zip (the name and version always come from the package\'s plugin-spec.yaml and the organization from your session; --public makes it public, --dry-run validates without uploading).',
            'REST API — POST /api/plugins/upload with a multipart form containing the ZIP, plus an optional metadata part carrying catalog-detail edits.',
          ],
        },
        {
          type: 'text',
          content: 'Before the upload, the dialog\'s Catalog details step reads the package (POST /api/plugins/inspect — a dry run that stores nothing) and pre-fills every descriptive field. Each field shows where its value came from (Spec, README, Dockerfile or Generated); Accept it, Edit it, or Accept all.',
        },
        {
          type: 'list',
          items: [
            'Sources, highest priority first: plugin-spec.yaml, then README.md, then the plugin\'s own Dockerfile OCI labels (org.opencontainers.image.description, .licenses, .source, .url, .documentation, .title). Labels inherited from a base image are never used.',
            'The summary (the one-line card text) falls back to the first sentence of the description.',
            'Only descriptive fields are editable after upload. Commands, secrets, env, egress, compute type and the other execution fields come from the spec only — changing them means uploading a new version.',
          ],
        },
      ],
    },
    {
      id: 'plugin-structure',
      title: 'Plugin Structure',
      blocks: [
        {
          type: 'text',
          content: 'A plugin is a ZIP containing:',
        },
        {
          type: 'list',
          items: [
            'plugin-spec.yaml — metadata, commands, secrets, environment and the input contract (required).',
            'Dockerfile — the step\'s build environment. Every image must end as a non-root user (USER 1000:1000) and download tools only through checksum-verified, pinned URLs.',
            'README.md — optional long description (≤ 64 KB), rendered to sanitized HTML on the plugin page.',
            'config.yaml — optional; buildType is build_image (default: the platform builds the Dockerfile), prebuilt (an image you supply, no Dockerfile) or metadata_only (no image, e.g. a manual approval step).',
          ],
        },
        {
          type: 'code',
          language: 'yaml',
          content: `name: my-plugin
summary: Build and unit-test a Node.js service
description: Installs dependencies, builds and runs unit tests.
version: 1.0.0
category: language
keywords: [nodejs, build]
license: Apache-2.0
sourceUrl: https://github.com/acme/my-plugin
pluginType: CodeBuildStep
computeType: SMALL
timeout: 15
failureBehavior: fail
secrets:
  - name: MY_TOKEN
    required: true
    description: "API token for the service"
requiredMetadata: [nodeVersion]
metadataTypes:
  nodeVersion: string
network:
  egress: [registry.npmjs.org]
primaryOutputDirectory: output-dir
dockerfile: Dockerfile
installCommands:
  - npm ci
commands:
  - npm run build
env:
  NODE_ENV: production`,
        },
      ],
    },
    {
      id: 'spec-fields',
      title: 'Spec Fields',
      blocks: [
        {
          type: 'table',
          headers: ['Field', 'Description'],
          rows: [
            ['name', 'Plugin identifier used in pipeline definitions (lowercase letters, digits, . _ -)'],
            ['version', 'Semantic version. A new major, a prerelease or an older version never becomes the default automatically'],
            ['summary', 'One-line card text (≤ 160 characters); defaults to the first sentence of the description'],
            ['description', 'Human-readable description shown in the catalog'],
            ['category, keywords', 'Directory category and search keywords'],
            ['license', 'SPDX license identifier (e.g. Apache-2.0, MIT) — required to publish to the ecosystem'],
            ['homepageUrl, sourceUrl, documentationUrl', 'Project links: https only, no URL shorteners, no embedded credentials'],
            ['changelog', 'Release notes for this version (≤ 32 KB)'],
            ['icon', 'A curated icon key (or { key, badge }); vendor marks are reserved for Official and Verified publishers'],
            ['pluginType', 'CodeBuildStep, ShellStep or ManualApprovalStep'],
            ['computeType', 'CodeBuild size: SMALL (3 GB / 2 vCPU), MEDIUM (7 GB / 4 vCPU), LARGE (15 GB / 8 vCPU) or X2_LARGE (145 GB / 72 vCPU)'],
            ['timeout', 'Maximum execution time in minutes'],
            ['failureBehavior', 'What happens on failure: fail, warn, or ignore'],
            ['secrets', 'Required secrets: name, required (boolean), description'],
            ['requiredMetadata, requiredVars', 'Inputs the pipeline must supply; a pipeline that doesn\'t is refused at create and at synth'],
            ['metadataTypes, varsTypes', 'Declared types of those inputs (string, number, boolean); ill-typed values are refused too'],
            ['network.egress', 'Hostnames the step contacts (bare names, one leading *. allowed, at most 50) — shown to consumers and compared in review'],
            ['smokeTest', 'A command the build tooling runs in the built image to prove the tool works'],
            ['primaryOutputDirectory', 'Directory where build artifacts are written'],
            ['installCommands, commands', 'Commands run in the install and build phases'],
            ['env, buildArgs', 'Default environment variables and Docker build args (non-secret values only)'],
          ],
        },
      ],
    },
    {
      id: 'lifecycle',
      title: 'Versions & Lifecycle',
      blocks: [
        {
          type: 'list',
          items: [
            'Deprecate a version (row action, or pipeline-manager plugin deprecate --id <id> --message "…") — lookups and synth warn, AI pipeline generation stops choosing it, and orgs whose pipelines use it are notified. It keeps working.',
            'Yank a version (pipeline-manager plugin yank --id <id> --reason "…") — new resolutions skip it; a pipeline that pins that exact version still gets it, with a warning. Existing deployed pipelines keep running (they pull by digest).',
            'Deleting a version a pipeline still uses, or one that is listed in the directory, is refused (409) unless you force it — and forcing asks you to re-enter your password. Deleting the default promotes the next one automatically, and the plugin quota is refunded.',
            'A listed version is frozen: the same version can never point at a different image. Fix a mistake by yanking it and publishing a new version.',
          ],
        },
      ],
    },
    {
      id: 'supply-chain',
      title: 'Supply Chain & Security',
      blocks: [
        {
          type: 'list',
          items: [
            'Every built image gets an SPDX SBOM and a cosign signature from the platform key; pipelines are pinned to the verified image digest at synth. An image whose signature doesn\'t verify is refused (409 IMAGE_VERIFICATION_FAILED).',
            'Images are scanned for vulnerabilities at build (grype over the SBOM) and rescanned nightly; the critical/high counts and scan date show on the plugin and feed compliance rules along with signed, runAsRoot and the image\'s packages.',
            'Download the SBOM from the plugin (GET /api/plugins/{id}/sbom), or for a listed version from its public directory page.',
            'Reports → Plugins → Runs shows how each plugin version behaves when your pipelines run it: runs, success rate and p50/p95 duration.',
          ],
        },
      ],
    },
    {
      id: 'secrets',
      title: 'How Secrets Work',
      blocks: [
        {
          type: 'text',
          content:
            'Plugin secrets are resolved at pipeline synth time through AWS Secrets Manager. Each organization stores secrets in their own AWS account using a naming convention:',
        },
        {
          type: 'code',
          language: 'text',
          content: 'pipeline-builder/{orgId}/{secretName}',
        },
        {
          type: 'list',
          items: [
            'Check which secrets a plugin requires — look at the secrets field in the spec or the catalog above.',
            'Create secrets in AWS Secrets Manager: aws secretsmanager create-secret --name "pipeline-builder/my-org/SNYK_TOKEN" --secret-string "your-token"',
            'Deploy your pipeline — the builder automatically injects each declared secret as a SECRETS_MANAGER-type environment variable.',
          ],
        },
        {
          type: 'note',
          content:
            'Secrets are scoped by organization ID, so different orgs manage their own tokens independently and secrets never cross organizational boundaries.',
        },
      ],
    },
  ],
};
