import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { printError, printInfo, printWarning } from './output.utils';

/**
 * Configuration interface
 */
export interface Config {
  api: {
    baseUrl: string;
    timeout?: number;
    pipelineUrl: string;
    pipelineListUrl: string;
    pluginUrl: string;
    pluginListUrl: string;
    pipelinePostUrl: string;
    pluginUploadUrl: string;
    /**
     * Reject unauthorized SSL certificates
     * @default true
     * @warning Setting to false disables certificate validation and should only be used in development
     */
    rejectUnauthorized?: boolean;
  };
  auth: {
    /**
     * Authentication token
     * Must be set via PLATFORM_TOKEN environment variable
     */
    token: string;
  };
}

/**
 * Default configuration
 *
 * IMPORTANT: These URLs must match the nginx routes:
 * - GET /api/pipeline/:id -> Get single pipeline
 * - GET /api/pipelines -> List pipelines
 * - POST /api/pipeline -> Create pipeline
 * - GET /api/plugin/:id -> Get single plugin (NOTE: requires ID in path, not query)
 * - GET /api/plugins -> List plugins
 * - POST /api/plugin/upload -> Upload plugin
 */
const defaultConfig: Omit<Config, 'auth'> = {
  api: {
    baseUrl: 'https://localhost:8443',
    timeout: 30000,
    pipelineUrl: '/api/pipeline',
    pipelineListUrl: '/api/pipelines',
    pluginUrl: '/api/plugin',
    pluginListUrl: '/api/plugins',
    pipelinePostUrl: '/api/pipeline',
    pluginUploadUrl: '/api/plugin/upload',
    rejectUnauthorized: true, // Secure by default
  },
};

/**
 * Load configuration from file or environment
 */
export function getConfig(): Config {
  const configPath = process.env.CLI_CONFIG_PATH || path.join(__dirname, '../config.yml');

  // Start with defaults
  let config: Omit<Config, 'auth'> = { ...defaultConfig };

  // Load from file if exists
  if (fs.existsSync(configPath)) {
    try {
      printInfo('Loading configuration', { path: configPath });
      const fileContent = fs.readFileSync(configPath, 'utf-8');
      const userConfig = yaml.parse(fileContent);

      // Merge with defaults (only API config, ignore auth if present)
      config = {
        api: {
          ...defaultConfig.api,
          ...userConfig.api,
        },
      };

      // Warn if auth section is present in config file
      if (userConfig.auth) {
        printWarning('Auth configuration in config file is ignored');
        printWarning('Use PLATFORM_TOKEN environment variable instead');
      }
    } catch (error) {
      printError('Failed to load configuration', {
        error: error instanceof Error ? error.message : String(error),
      });
      printWarning('Falling back to default configuration');
    }
  } else {
    printWarning('Configuration file not found, using defaults', { path: configPath });
    printInfo('Create config.yml to customize settings');
  }

  // Override with environment variables
  // PLATFORM_URL is optional - only override if set
  if (process.env.PLATFORM_URL) {
    config.api.baseUrl = process.env.PLATFORM_URL;
    printInfo('Using PLATFORM_URL from environment', { baseUrl: config.api.baseUrl });
  }

  // REJECT_UNAUTHORIZED can be overridden via environment variable
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined) {
    const envValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    config.api.rejectUnauthorized = envValue !== '0';

    if (!config.api.rejectUnauthorized) {
      printWarning('SSL certificate validation is disabled via NODE_TLS_REJECT_UNAUTHORIZED=0');
      printWarning('This should only be used in development environments');
    }
  }

  // PLATFORM_TOKEN is REQUIRED and must come from environment variable
  const token = process.env.PLATFORM_TOKEN;

  if (!token) {
    printError('Authentication token is required');
    printError('PLATFORM_TOKEN environment variable is not set');
    printInfo('Set it with: export PLATFORM_TOKEN="your-token-here"');
    throw new Error('PLATFORM_TOKEN environment variable is required');
  }

  // Validate token format
  if (token.trim().length === 0) {
    printError('PLATFORM_TOKEN cannot be empty');
    throw new Error('PLATFORM_TOKEN must be a non-empty string');
  }

  if (token.includes(' ')) {
    printWarning('PLATFORM_TOKEN contains whitespace - this may cause issues');
  }

  printInfo('Authentication token loaded from environment');

  // Validate API base URL
  if (!config.api.baseUrl) {
    printWarning('API base URL not configured, using default');
  }

  // Validate rejectUnauthorized value
  if (config.api.rejectUnauthorized !== undefined && typeof config.api.rejectUnauthorized !== 'boolean') {
    printWarning('Invalid rejectUnauthorized value, using default (true)');
    config.api.rejectUnauthorized = true;
  }

  printInfo('Configuration loaded successfully');

  // Return complete config with auth
  return {
    ...config,
    auth: {
      token,
    },
  };
}

/**
 * Get token from environment (helper function)
 * @throws Error if PLATFORM_TOKEN is not set
 */
export function getToken(): string {
  const token = process.env.PLATFORM_TOKEN;

  if (!token) {
    throw new Error('PLATFORM_TOKEN environment variable is required');
  }

  return token;
}

/**
 * Check if token is set
 */
export function hasToken(): boolean {
  return !!process.env.PLATFORM_TOKEN;
}
