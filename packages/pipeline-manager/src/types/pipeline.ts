// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Arbitrary key-value pipeline configuration properties
 * passed through to the CDK builder.
 */
export type PipelineProps = Record<string, unknown>;

/**
 * Pipeline sharing rung — the platform-wide three-rung ladder.
 * `private` is author-only, `org` is the whole owning org, `public` reaches the
 * org's teams (and, from the system org, every org).
 */
export type PipelineVisibility = 'private' | 'org' | 'public';

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
   * Sharing rung: 'private' | 'org' | 'public'.
   */
  visibility?: PipelineVisibility;

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
  visibility?: PipelineVisibility;

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
