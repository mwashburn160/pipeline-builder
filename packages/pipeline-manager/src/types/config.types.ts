/**
 * Configuration type definitions
 */

/**
 * API configuration
 */
export interface ApiConfig {
  /**
   * Base URL for the API
   * @example 'https://api.example.com'
   */
  baseUrl: string;

  /**
   * Request timeout in milliseconds
   * @default 30000
   */
  timeout?: number;

  /**
   * Pipeline endpoint URL
   * @default '/api/pipeline'
   */
  pipelineUrl: string;

  /**
   * Pipeline list endpoint URL
   * @default '/api/pipelines'
   */
  pipelineListUrl: string;

  /**
   * Plugin endpoint URL
   * @default '/api/plugin'
   */
  pluginUrl: string;

  /**
   * Plugin list endpoint URL
   * @default '/api/plugins'
   */
  pluginListUrl: string;

  /**
   * Pipeline creation endpoint URL
   * @default '/api/pipeline'
   */
  pipelinePostUrl: string;

  /**
   * Plugin upload endpoint URL
   * @default '/api/plugin/upload'
   */
  pluginUploadUrl: string;

  /**
   * Reject unauthorized SSL certificates
   * @default true
   * @warning Setting to false disables certificate validation
   */
  rejectUnauthorized?: boolean;
}

/**
 * Authentication configuration
 */
export interface AuthConfig {
  /**
   * Authentication token
   * Must be set via PLATFORM_TOKEN environment variable
   */
  token: string;
}

/**
 * Complete application configuration
 */
export interface Config {
  /**
   * API configuration
   */
  api: ApiConfig;

  /**
   * Authentication configuration
   */
  auth: AuthConfig;
}

/**
 * Configuration file structure (without auth)
 */
export interface ConfigFile {
  api: Partial<ApiConfig>;
}
