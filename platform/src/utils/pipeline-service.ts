import { config } from '../config';
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
export class PipelineServiceError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'PipelineServiceError';
  }
}

/**
 * Pipeline Service Client
 * Handles communication with pipeline microservices
 */
class PipelineServiceClient {
  private listPipelinesUrl: string;
  private getPipelineUrl: string;
  private createPipelineUrl: string;
  private timeout: number;

  constructor() {
    this.listPipelinesUrl = config.services.listPipelines;
    this.getPipelineUrl = config.services.getPipeline;
    this.createPipelineUrl = config.services.createPipeline;
    this.timeout = config.services.timeout;
  }

  /**
   * Build query string from filter object
   */
  private buildQueryString(filter: PipelineFilter): string {
    const params = new URLSearchParams();

    Object.entries(filter).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        params.append(key, String(value));
      }
    });

    const query = params.toString();
    return query ? `?${query}` : '';
  }

  /**
   * Make HTTP request with timeout and error handling
   */
  private async request<T>(
    url: string,
    options: RequestInit & { orgId: string; userId?: string; token: string },
  ): Promise<T> {
    const { orgId, userId, token, ...fetchOptions } = options;

    if (!token) {
      throw new PipelineServiceError('Authentication token is required', 401, 'TOKEN_REQUIRED');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-org-id': orgId,
      ...(userId && { 'x-user-id': userId }),
      'Authorization': `Bearer ${token}`,
      ...(fetchOptions.headers as Record<string, string>),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      logger.debug(`[PipelineService] Request: ${fetchOptions.method || 'GET'} ${url}`);

      const response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json() as Record<string, unknown>;

      if (!response.ok) {
        throw new PipelineServiceError(
          String(data.message || data.error || 'Request failed'),
          response.status,
          data.code as string | undefined,
        );
      }

      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof PipelineServiceError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new PipelineServiceError('Request timeout', 504, 'TIMEOUT');
        }
        throw new PipelineServiceError(error.message, 500, 'SERVICE_ERROR');
      }

      throw new PipelineServiceError('Unknown error', 500, 'UNKNOWN_ERROR');
    }
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
