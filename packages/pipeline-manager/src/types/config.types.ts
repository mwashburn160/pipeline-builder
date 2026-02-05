/**
 * Configuration type definitions
 */

/**
 * API configuration
 */
export interface ApiConfig {
  baseUrl: string;
  timeout?: number;
  uploadTimeout?: number;
  pipelineUrl: string;
  pipelineListUrl: string;
  pluginUrl: string;
  pluginListUrl: string;
  pipelinePostUrl: string;
  pluginUploadUrl: string;
  rejectUnauthorized?: boolean;
}

/**
 * Authentication configuration
 */
export interface AuthConfig {
  token: string;
}

/**
 * Complete application configuration
 */
export interface Config {
  api: ApiConfig;
  auth: AuthConfig;
}
