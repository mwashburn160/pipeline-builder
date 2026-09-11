// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export type { ContentBlock, HelpSection, HelpTopic } from './types';
export type { PluginCategory } from './plugins';
export { PLUGIN_CATEGORIES, CATEGORY_DISPLAY_NAMES, PLUGIN_CATALOG } from './plugins';

// Hand-authored topics — no 1:1 doc under docs/ (getting-started/ai-generation
// have no doc; pipelines/plugins/registry map only fuzzily). These stay authored
// here; `plugins` also backs the plugin catalog data.
import { gettingStartedTopic } from './getting-started';
import { pipelinesTopic } from './pipelines';
import { pluginsTopic } from './plugins';
import { aiGenerationTopic } from './ai-generation';
import { registryTopic } from './registry';
// GENERATED topics — produced from docs/*.md by `npm run generate:help`. docs are
// the single source of truth (also what the Ask agent grounds on), so these can
// no longer drift from the docs. Do NOT edit files under ./generated/.
import { organizationBenefitsTopic } from './generated/organization-benefits';
import { architectureFlowTopic } from './generated/architecture-flow';
import { developerGuideTopic } from './generated/developer-guide';
import { templatesTopic } from './generated/templates';
import { metadataKeysTopic } from './generated/metadata-keys';
import { cdkUsageTopic } from './generated/cdk-usage';
import { samplesTopic } from './generated/samples';
import { deploymentTopic } from './generated/deployment';
import { cliReferenceTopic } from './generated/cli-reference';
import { complianceTopic } from './generated/compliance';
import { auditEventsTopic } from './generated/audit-events';
import { apiReferenceTopic } from './generated/api-reference';
import { envVariablesTopic } from './generated/env-variables';
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
