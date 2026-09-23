// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The in-app help corpus, loaded ON DEMAND.
 *
 * The generated topics are ~1 MB of TypeScript source — `authentication`
 * is 4,050 lines, `env-variables` 2,991, `deployment` 2,240. A static barrel put
 * all of it in whatever chunk touched this module — through the provider tree,
 * onto the signed-out landing page.
 *
 * The category vocabulary lives in `@/lib/plugin-categories`, and the topics
 * are reachable only through {@link loadHelpGroups} — a dynamic import webpack
 * splits into its own chunk, fetched when somebody actually opens Help.
 */

export type { ContentBlock, HelpSection, HelpTopic } from './types';

import type { HelpTopic } from './types';

/** A labelled group of help topics, for the categorized help nav. */
export interface HelpTopicGroup {
  category: string;
  topics: HelpTopic[];
}

/** Memoized so the corpus chunk is fetched and evaluated at most once. */
let corpus: Promise<HelpTopicGroup[]> | null = null;

/**
 * Help topics organized into categories. Each topic mirrors a doc under
 * `docs/` (the source of truth). Order within a group goes overview → detail.
 *
 * Hand-authored topics (getting-started, pipelines, plugins, ai-generation,
 * registry) have no 1:1 doc; the rest are produced from `docs/*.md` by
 * `npm run generate:help` and must not be edited under `./generated/`.
 */
export function loadHelpGroups(): Promise<HelpTopicGroup[]> {
  corpus ??= (async () => {
    const [
      gettingStarted, pipelines, plugins, aiGeneration, registry,
      organizationBenefits, onboarding, architectureFlow, developerGuide, developerPortal, pluginPublishing, pluginInstalling,
      templates, metadataKeys, cdkUsage, samples, deployment, cliReference,
      deployOperations, serviceMesh, observabilityLogs, notifications, doraMetrics, incidentsWebhook,
      authentication, permissions, compliance, auditEvents,
      billingProviders, billingBundles, billingDiscounts,
      apiReference, envVariables, errorHandling,
    ] = await Promise.all([
      import('./getting-started'),
      import('./pipelines'),
      import('./plugins'),
      import('./ai-generation'),
      import('./registry'),
      import('./generated/organization-benefits'),
      import('./generated/onboarding'),
      import('./generated/architecture-flow'),
      import('./generated/developer-guide'),
      import('./generated/developer-portal'),
      import('./generated/plugin-publishing'),
      import('./generated/plugin-installing'),
      import('./generated/templates'),
      import('./generated/metadata-keys'),
      import('./generated/cdk-usage'),
      import('./generated/samples'),
      import('./generated/deployment'),
      import('./generated/cli-reference'),
      import('./generated/deploy-operations'),
      import('./generated/service-mesh'),
      import('./generated/observability-logs'),
      import('./generated/notifications'),
      import('./generated/dora-metrics'),
      import('./generated/incidents-webhook'),
      import('./generated/authentication'),
      import('./generated/permissions'),
      import('./generated/compliance'),
      import('./generated/audit-events'),
      import('./generated/billing-providers'),
      import('./generated/billing-bundles'),
      import('./generated/billing-discounts'),
      import('./generated/api-reference'),
      import('./generated/env-variables'),
      import('./generated/error-handling'),
    ]);

    return [
      {
        category: 'Overview',
        topics: [
          gettingStarted.gettingStartedTopic,
          onboarding.onboardingTopic,
          organizationBenefits.organizationBenefitsTopic,
          architectureFlow.architectureFlowTopic,
          developerGuide.developerGuideTopic,
        ],
      },
      {
        category: 'Building',
        topics: [
          pipelines.pipelinesTopic,
          plugins.pluginsTopic,
          pluginPublishing.pluginPublishingTopic,
          pluginInstalling.pluginInstallingTopic,
          templates.templatesTopic,
          metadataKeys.metadataKeysTopic,
          cdkUsage.cdkUsageTopic,
          aiGeneration.aiGenerationTopic,
          samples.samplesTopic,
          developerPortal.developerPortalTopic,
        ],
      },
      {
        category: 'Deploy & Operate',
        topics: [
          deployment.deploymentTopic,
          cliReference.cliReferenceTopic,
          registry.registryTopic,
          deployOperations.deployOperationsTopic,
          serviceMesh.serviceMeshTopic,
          observabilityLogs.observabilityLogsTopic,
          notifications.notificationsTopic,
          doraMetrics.doraMetricsTopic,
          incidentsWebhook.incidentsWebhookTopic,
        ],
      },
      {
        category: 'Governance',
        topics: [
          authentication.authenticationTopic,
          permissions.permissionsTopic,
          compliance.complianceTopic,
          auditEvents.auditEventsTopic,
          billingProviders.billingProvidersTopic,
          billingBundles.billingBundlesTopic,
          billingDiscounts.billingDiscountsTopic,
        ],
      },
      {
        category: 'Reference',
        topics: [
          apiReference.apiReferenceTopic,
          envVariables.envVariablesTopic,
          errorHandling.errorHandlingTopic,
        ],
      },
    ];
  })();
  return corpus;
}

/** Flat list of all help topics in display order (used for search). */
export async function loadHelpTopics(): Promise<HelpTopic[]> {
  return (await loadHelpGroups()).flatMap((g) => g.topics);
}
