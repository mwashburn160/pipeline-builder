import { config } from '../config';
import { ServiceError, BaseServiceClient } from './base-service';
import logger from './logger';

/**
 * Pipeline filter parameters for list/get operations
 */
export interface PipelineFilter {
  id?: string;
  project?: string;
  organization?: string;
  pipelineName?: string;
  isActive?: boolean;
  isDefault?: boolean;
  accessModifier?: 'public' | 'private';
  page?: number;
  limit?: number;
}

/**
 * Builder props structure for pipeline configuration
 */
export interface BuilderProps {
  [key: string]: unknown;
}

/**
 * Pipeline data structure returned from pipeline microservices
 */
export interface Pipeline {
  id: string;
  orgId: string;
  project: string;
  organization: string;
  pipelineName?: string;
  props: BuilderProps;
  accessModifier: 'public' | 'private';
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * Pipeline list response
 */
export interface PipelineListResponse {
  pipelines: Pipeline[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Pipeline create request data
 */
export interface PipelineCreateData {
  project: string;
  organization: string;
  pipelineName?: string;
  props: BuilderProps;
  accessModifier?: 'public' | 'private';
}

/**
 * Pipeline create response
 */
export interface PipelineCreateResponse {
  id: string;
  project: string;
  organization: string;
  pipelineName?: string;
  accessModifier: 'public' | 'private';
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
  message: string;
}

/**
 * Service error class
 */
export class PipelineServiceError extends ServiceError {
  constructor(message: string, statusCode: number, code?: string) {
    super(message, statusCode, code);
    this.name = 'PipelineServiceError';
  }
}

/**
 * Pipeline Service Client
 * Handles communication with pipeline microservices
 */
class PipelineServiceClient extends BaseServiceClient {
  protected serviceName = 'PipelineService';
  private listPipelinesUrl: string;
  private getPipelineUrl: string;
  private createPipelineUrl: string;

  constructor() {
    super(config.services.timeout);
    this.listPipelinesUrl = config.services.listPipelines;
    this.getPipelineUrl = config.services.getPipeline;
    this.createPipelineUrl = config.services.createPipeline;
  }

  protected createError(message: string, statusCode: number, code?: string): PipelineServiceError {
    return new PipelineServiceError(message, statusCode, code);
  }

  /**
   * List pipelines with optional filters
   */
  async listPipelines(
    orgId: string,
    filter: PipelineFilter = {},
    options: { userId?: string; token: string },
  ): Promise<PipelineListResponse> {
    const queryString = this.buildQueryString(filter);
    const url = `${this.listPipelinesUrl}${queryString}`;

    logger.info('[PipelineService] Listing pipelines', { orgId, filter });

    return this.request<PipelineListResponse>(url, {
      method: 'GET',
      orgId,
      userId: options.userId,
      token: options.token,
    });
  }

  /**
   * Get a single pipeline by ID
   */
  async getPipelineById(
    orgId: string,
    pipelineId: string,
    options: { userId?: string; token: string },
  ): Promise<Pipeline> {
    const url = `${this.getPipelineUrl}/${pipelineId}`;

    logger.info('[PipelineService] Getting pipeline by ID', { orgId, pipelineId });

    return this.request<Pipeline>(url, {
      method: 'GET',
      orgId,
      userId: options.userId,
      token: options.token,
    });
  }

  /**
   * Get a single pipeline by filters (project, organization, etc.)
   */
  async getPipeline(
    orgId: string,
    filter: PipelineFilter,
    options: { userId?: string; token: string },
  ): Promise<Pipeline> {
    const queryString = this.buildQueryString(filter);
    const url = `${this.getPipelineUrl}${queryString}`;

    logger.info('[PipelineService] Getting pipeline', { orgId, filter });

    return this.request<Pipeline>(url, {
      method: 'GET',
      orgId,
      userId: options.userId,
      token: options.token,
    });
  }

  /**
   * Create a new pipeline configuration
   */
  async createPipeline(
    orgId: string,
    data: PipelineCreateData,
    options: { userId?: string; token: string },
  ): Promise<PipelineCreateResponse> {
    logger.info('[PipelineService] Creating pipeline', {
      orgId,
      project: data.project,
      organization: data.organization,
      accessModifier: data.accessModifier,
    });

    return this.request<PipelineCreateResponse>(this.createPipelineUrl, {
      method: 'POST',
      orgId,
      userId: options.userId,
      token: options.token,
      body: JSON.stringify(data),
    });
  }
}

// Export singleton instance
export const pipelineService = new PipelineServiceClient();
