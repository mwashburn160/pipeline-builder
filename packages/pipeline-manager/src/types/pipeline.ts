// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Arbitrary key-value pipeline configuration properties
 * passed through to the CDK builder.
 */
export type PipelineProps = Record<string, unknown>;

/**
 * Pipeline visibility level.
 */
export type PipelineAccessModifier = 'public' | 'private';

/**
 * Core pipeline fields required on every pipeline record.
 */
export interface PipelineBase {
  /**
   * Unique pipeline identifier
   */
  id: string;

  /**
   * Project name
   */
  project: string;

  /**
   * Organization name
   */
  organization: string;

  /**
   * Tenant identifier (from API response, used for per-org secret resolution)
   */
  orgId?: string;

  /**
   * Pipeline properties/configuration
   */
  props: PipelineProps;
}

/**
 * Optional metadata fields attached to a pipeline record.
 */
export interface PipelineMetadata {
  /**
   * Human-readable pipeline name
   */
  pipelineName?: string;

  /**
   * Access modifier (public or private)
   */
  accessModifier?: PipelineAccessModifier;

  /**
   * Whether this is the default pipeline
   */
  isDefault?: boolean;

  /**
   * Whether the pipeline is active
   */
  isActive?: boolean;

  /**
   * Pipeline creation timestamp
   */
  createdAt?: string;

  /**
   * Pipeline last update timestamp
   */
  updatedAt?: string;

  /**
   * User who created the pipeline
   */
  createdBy?: string;

  /**
   * User who last updated the pipeline
   */
  updatedBy?: string;
}

/**
 * Complete pipeline entity combining core fields and metadata.
 */
export interface Pipeline extends PipelineBase, PipelineMetadata {}

/**
 * Request payload for creating a new pipeline via the platform API.
 */
export interface CreatePipelineRequest {
  /**
   * Project name
   */
  project: string;

  /**
   * Organization name
   */
  organization: string;

  /**
   * Pipeline properties/configuration
   */
  props: PipelineProps;

  /**
   * Human-readable pipeline name
   */
  pipelineName?: string;

  /**
   * Access modifier (public or private)
   * @default 'private'
   */
  accessModifier?: PipelineAccessModifier;

  /**
   * Whether this is the default pipeline
   * @default false
   */
  isDefault?: boolean;

  /**
   * Whether the pipeline is active
   * @default true
   */
  isActive?: boolean;
}

/**
 * Response returned by single-pipeline API endpoints (get, create).
 */
export interface PipelineResponse {
  pipeline: Pipeline;
}

/**
 * Paginated response returned by the pipeline list API endpoint.
 */
export interface PipelineListResponse {
  /**
   * List of pipelines
   */
  pipelines: Pipeline[];

  /**
   * Total number of pipelines (for pagination)
   */
  total: number;

  /**
   * Current page number
   */
  page: number;

  /**
   * Number of items per page
   */
  limit: number;

  /**
   * Whether there are more pages
   */
  hasMore: boolean;
}
