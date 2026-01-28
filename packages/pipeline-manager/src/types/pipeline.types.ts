/**
 * Pipeline type definitions
 */

/**
 * Pipeline properties (generic)
 */
export type PipelineProps = Record<string, unknown>;

/**
 * Pipeline access modifier
 */
export type PipelineAccessModifier = 'public' | 'private';

/**
 * Base pipeline information
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
   * Pipeline properties/configuration
   */
  props: PipelineProps;
}

/**
 * Pipeline metadata
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
 * Complete pipeline (with all fields)
 */
export interface Pipeline extends PipelineBase, PipelineMetadata {}

/**
 * Pipeline creation request payload
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
 * Pipeline update request payload
 */
export interface UpdatePipelineRequest {
  /**
   * Pipeline properties/configuration (partial update)
   */
  props?: PipelineProps;

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
}

/**
 * Pipeline list query parameters
 */
export interface PipelineListParams {
  /**
   * Filter by project name
   */
  project?: string;

  /**
   * Filter by organization name
   */
  organization?: string;

  /**
   * Filter by active status
   */
  isActive?: boolean;

  /**
   * Filter by default status
   */
  isDefault?: boolean;

  /**
   * Page number for pagination
   * @default 1
   */
  page?: number;

  /**
   * Number of items per page
   * @default 20
   */
  limit?: number;

  /**
   * Sort field
   */
  sortBy?: 'createdAt' | 'updatedAt' | 'pipelineName';

  /**
   * Sort order
   * @default 'desc'
   */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Pipeline list response
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
