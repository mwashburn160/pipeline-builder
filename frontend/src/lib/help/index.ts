// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export type { ContentBlock, HelpSection, HelpTopic } from './types';
export type { PluginEntry, PluginCategory } from './plugins';
export { PLUGIN_CATEGORIES, CATEGORY_DISPLAY_NAMES, PLUGIN_CATALOG } from './plugins';

import { gettingStartedTopic } from './getting-started';
import { organizationBenefitsTopic } from './organization-benefits';
import { architectureFlowTopic } from './architecture-flow';
import { developerGuideTopic } from './developer-guide';
import { pipelinesTopic } from './pipelines';
import { pluginsTopic } from './plugins';
import { templatesTopic } from './templates';
import { metadataKeysTopic } from './metadata-keys';
import { cdkUsageTopic } from './cdk-usage';
import { aiGenerationTopic } from './ai-generation';
import { samplesTopic } from './samples';
import { deploymentTopic } from './deployment';
import { cliReferenceTopic } from './cli-reference';
import { registryTopic } from './registry';
import { complianceTopic } from './compliance';
import { auditEventsTopic } from './audit-events';
import { apiReferenceTopic } from './api-reference';
import { envVariablesTopic } from './env-variables';
import type { HelpTopic } from './types';

/** A labelled group of help topics, for the categorized help nav. */
export interface HelpTopicGroup {
  category: string;
  topics: HelpTopic[];
}

/**
 * Help topics organized into categories. Each topic mirrors a doc under
 * `docs/` (the source of truth). Order within a group goes overview → detail.
 */
export const HELP_GROUPS: HelpTopicGroup[] = [
  {
    category: 'Overview',
    topics: [gettingStartedTopic, organizationBenefitsTopic, architectureFlowTopic, developerGuideTopic],
  },
  {
    category: 'Building',
    topics: [pipelinesTopic, pluginsTopic, templatesTopic, metadataKeysTopic, cdkUsageTopic, aiGenerationTopic, samplesTopic],
  },
  {
    category: 'Deploy & Operate',
    topics: [deploymentTopic, cliReferenceTopic, registryTopic],
  },
  {
    category: 'Governance',
    topics: [complianceTopic, auditEventsTopic],
  },
  {
    category: 'Reference',
    topics: [apiReferenceTopic, envVariablesTopic],
  },
];

/** Flat list of all help topics in display order (used for search). */
export const HELP_TOPICS: HelpTopic[] = HELP_GROUPS.flatMap((g) => g.topics);
