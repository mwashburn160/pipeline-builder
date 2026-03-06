// Configuration
export * from './config/app-config';
export * from './config/config-types';

// Core types (public surface)
export * from './core/pipeline-types';
export * from './core/network-types';
export * from './core/role-types';
export * from './core/security-group-types';
export * from './core/id-generator';
export { replaceNonAlphanumeric, extractMetadataEnv } from './core/pipeline-helpers';
export {
  buildConfigFromMetadata,
  metadataForCodePipeline,
  metadataForCodeBuildStep,
  metadataForShellStep,
  metadataForBuildEnvironment,
} from './core/metadata-builder';
export * from './core/artifact-manager';

// Re-export from api-core (only items consumed by external packages)
export {
  ErrorCode,
  createLogger,
} from '@mwashburn160/api-core';

// Re-export database layer from pipeline-data (only items consumed externally)
export {
  // Database connection
  db,
  getConnection,
  closeConnection,

  // Schema & tables
  schema,

  // Query builders
  buildPluginConditions,
  buildPipelineConditions,
  buildMessageConditions,
  validateMessageFilter,

  // Query filter types
  type PluginFilter,
  type PipelineFilter,
  type MessageFilter,

  // Plugin types
  type PluginSecret,

  // CRUD service
  CrudService,
  type BaseEntity,
} from '@mwashburn160/pipeline-data';

// Pipeline (CDK constructs)
export * from './pipeline/source-types';
export * from './pipeline/step-types';
export * from './pipeline/stage-builder';
export * from './pipeline/pipeline-builder';
export * from './pipeline/plugin-lookup';
export { PipelineConfiguration } from './pipeline/pipeline-configuration';
