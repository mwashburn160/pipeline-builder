/**
 * @module services
 * @description Service clients for communicating with microservices.
 */

export { ServiceError, BaseServiceClient } from './base-service';
export type { ServiceRequestOptions } from './base-service';
export { pluginService, PluginServiceError } from './plugin-service';
export type { Plugin, PluginFilter, PluginListResponse, PluginUploadData, PluginUploadResponse } from './plugin-service';
export { pipelineService, PipelineServiceError } from './pipeline-service';
export type { Pipeline, PipelineFilter, PipelineListResponse, PipelineCreateData, PipelineCreateResponse, BuilderProps } from './pipeline-service';
