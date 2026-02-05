/**
 * @module @mwashburn160/pipeline-core
 * @description CDK infrastructure and pipeline building utilities
 *
 * This package contains:
 * - Pipeline builder and configuration
 * - CDK construct helpers
 * - Network resolution (VPC/subnet lookup)
 * - Metadata extraction
 * - Unique ID generation
 * - Lambda handlers
 * - HTTP client for service communication
 */

// Configuration
export * from './config/app-config';
export * from './config/config-types';

// Core utilities and types
export * from './core/pipeline-types';
export * from './core/network-types';
export * from './core/pipeline-helpers';
export * from './core/metadata';
export * from './core/metadata-builder';
export * from './core/network';
export * from './core/id-generator';

// Re-export from api-core for convenience
export {
  ErrorCode,
  ErrorCodeStatus,
  getStatusForErrorCode,
  createLogger,
  // HTTP client utilities
  InternalHttpClient,
  createSafeClient,
  ServiceConfig,
  type RequestOptions,
  type HttpResponse,
} from '@mwashburn160/api-core';

// Handlers (Lambda)
export * from './handlers/plugin-lookup-handler';

// Re-export database and query builders from pipeline-data
export * from '@mwashburn160/pipeline-data';

// Pipeline (CDK constructs)
export * from './pipeline/source-types';
export * from './pipeline/step-types';
export * from './pipeline/pipeline-types';
export * from './pipeline/pipeline-builder';
export * from './pipeline/pipeline-configuration';
export * from './pipeline/plugin-lookup';
