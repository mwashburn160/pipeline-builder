export type { ContentBlock, HelpSection, HelpTopic } from './types';
export type { PluginEntry } from './plugins';
export { PLUGIN_CATEGORIES, PLUGIN_CATALOG } from './plugins';

import { gettingStartedTopic } from './getting-started';
import { pipelinesTopic } from './pipelines';
import { pluginsTopic } from './plugins';
import { aiGenerationTopic } from './ai-generation';
import { cliReferenceTopic } from './cli-reference';
import { deploymentTopic } from './deployment';
import { apiReferenceTopic } from './api-reference';
import { envVariablesTopic } from './env-variables';
import type { HelpTopic } from './types';

/** All help topics in display order. */
export const HELP_TOPICS: HelpTopic[] = [
  gettingStartedTopic,
  pipelinesTopic,
  pluginsTopic,
  aiGenerationTopic,
  cliReferenceTopic,
  deploymentTopic,
  apiReferenceTopic,
  envVariablesTopic,
];
