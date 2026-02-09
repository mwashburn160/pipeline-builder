import { config } from '../config';
import logger from './logger';
import { ServiceError, BaseServiceClient } from './base-service';

/**
 * Plugin filter parameters for list/get operations
 */
export interface PluginFilter {
  id?: string;
  name?: string;
  version?: string;
  pluginType?: string;
  computeType?: string;
  isActive?: boolean;
  isDefault?: boolean;
  accessModifier?: 'public' | 'private';
  page?: number;
  limit?: number;
}

/**
 * Plugin data structure returned from plugin microservices
 */
export interface Plugin {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  version: string;
  metadata?: Record<string, unknown>;
  pluginType: string;
  computeType: string;
  dockerfile?: string;
  env?: Record<string, string>;
  installCommands?: string[];
  commands: string[];
  imageTag: string;
  accessModifier: 'public' | 'private';
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * Plugin list response
 */
export interface PluginListResponse {
  plugins: Plugin[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Plugin upload request data
 */
export interface PluginUploadData {
  file: Buffer;
  filename: string;
  accessModifier?: 'public' | 'private';
}

/**
 * Plugin upload response
 */
export interface PluginUploadResponse {
  id: string;
  name: string;
  version: string;
  imageTag: string;
  fullImage: string;
  accessModifier: 'public' | 'private';
  isDefault: boolean;
  isActive: boolean;
  createdBy: string;
  message: string;
}

/**
 * Service error class
 */
export class PluginServiceError extends ServiceError {
  constructor(message: string, statusCode: number, code?: string) {
    super(message, statusCode, code);
    this.name = 'PluginServiceError';
  }
}

/**
 * Plugin Service Client
 * Handles communication with plugin microservices
 */
class PluginServiceClient extends BaseServiceClient {
  protected serviceName = 'PluginService';
  private listPluginsUrl: string;
  private getPluginUrl: string;
  private uploadPluginUrl: string;

  constructor() {
    super(config.services.timeout);
    this.listPluginsUrl = config.services.listPlugins;
    this.getPluginUrl = config.services.getPlugin;
    this.uploadPluginUrl = config.services.uploadPlugin;
  }

  protected createError(message: string, statusCode: number, code?: string): PluginServiceError {
    return new PluginServiceError(message, statusCode, code);
  }

  /**
   * Make multipart form request for file uploads
   */
  private async uploadRequest<T>(
    url: string,
    options: {
      orgId: string;
      userId?: string;
      token: string;
      file: Buffer;
      filename: string;
      fields?: Record<string, string>;
    },
  ): Promise<T> {
    const { orgId, userId, token, file, filename, fields } = options;

    if (!token) {
      throw new PluginServiceError('Authentication token is required', 401, 'TOKEN_REQUIRED');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout * 3); // Longer timeout for uploads

    try {
      // Create form data manually for Node.js
      const boundary = `----formdata-${Date.now()}`;
      const parts: Buffer[] = [];

      // Add file part
      parts.push(
        Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="plugin"; filename="${filename}"\r\n` +
          'Content-Type: application/zip\r\n\r\n',
        ),
      );
      parts.push(file);
      parts.push(Buffer.from('\r\n'));

      // Add additional fields
      if (fields) {
        for (const [key, value] of Object.entries(fields)) {
          parts.push(
            Buffer.from(
              `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
              `${value}\r\n`,
            ),
          );
        }
      }

      // Add closing boundary
      parts.push(Buffer.from(`--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      logger.debug(`[PluginService] Upload request: POST ${url}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'x-org-id': orgId,
          ...(userId && { 'x-user-id': userId }),
          'Authorization': `Bearer ${token}`,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json() as Record<string, unknown>;

      if (!response.ok) {
        throw new PluginServiceError(
          String(data.message || data.error || 'Upload failed'),
          response.status,
          data.code as string | undefined,
        );
      }

      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof PluginServiceError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new PluginServiceError('Upload timeout', 504, 'TIMEOUT');
        }
        throw new PluginServiceError(error.message, 500, 'SERVICE_ERROR');
      }

      throw new PluginServiceError('Unknown error', 500, 'UNKNOWN_ERROR');
    }
  }

  /**
   * List plugins with optional filters
   */
  async listPlugins(
    orgId: string,
    filter: PluginFilter = {},
    options: { userId?: string; token: string },
  ): Promise<PluginListResponse> {
    const queryString = this.buildQueryString(filter);
    const url = `${this.listPluginsUrl}${queryString}`;

    logger.info('[PluginService] Listing plugins', { orgId, filter });

    return this.request<PluginListResponse>(url, {
      method: 'GET',
      orgId,
      userId: options.userId,
      token: options.token,
    });
  }

  /**
   * Get a single plugin by ID
   */
  async getPluginById(
    orgId: string,
    pluginId: string,
    options: { userId?: string; token: string },
  ): Promise<Plugin> {
    const url = `${this.getPluginUrl}/${pluginId}`;

    logger.info('[PluginService] Getting plugin by ID', { orgId, pluginId });

    return this.request<Plugin>(url, {
      method: 'GET',
      orgId,
      userId: options.userId,
      token: options.token,
    });
  }

  /**
   * Get a single plugin by filters (name, version, etc.)
   */
  async getPlugin(
    orgId: string,
    filter: PluginFilter,
    options: { userId?: string; token: string },
  ): Promise<Plugin> {
    const queryString = this.buildQueryString(filter);
    const url = `${this.getPluginUrl}${queryString}`;

    logger.info('[PluginService] Getting plugin', { orgId, filter });

    return this.request<Plugin>(url, {
      method: 'GET',
      orgId,
      userId: options.userId,
      token: options.token,
    });
  }

  /**
   * Upload and deploy a new plugin
   */
  async uploadPlugin(
    orgId: string,
    data: PluginUploadData,
    options: { userId?: string; token: string },
  ): Promise<PluginUploadResponse> {
    logger.info('[PluginService] Uploading plugin', {
      orgId,
      filename: data.filename,
      accessModifier: data.accessModifier,
    });

    return this.uploadRequest<PluginUploadResponse>(this.uploadPluginUrl, {
      orgId,
      userId: options.userId,
      token: options.token,
      file: data.file,
      filename: data.filename,
      fields: data.accessModifier ? { accessModifier: data.accessModifier } : undefined,
    });
  }
}

// Export singleton instance
export const pluginService = new PluginServiceClient();
