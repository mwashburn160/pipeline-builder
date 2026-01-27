import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { printError, printInfo, printWarning } from '../utils/output-utils';

/**
 * Configuration interface
 */
export interface Config {
  api: {
    baseUrl: string;
    timeout?: number;
    // Query endpoints
    pipelineUrl: string;
    pipelineListUrl: string;
    pluginUrl: string;
    pluginListUrl: string;
    // Create/Upload endpoints
    pipelinePostUrl: string;
    pluginUploadUrl: string;
  };
  auth: {
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
const defaultConfig: Config = {
  api: {
    baseUrl: 'https://localhost:8443',
    timeout: 30000,
    // Query endpoints (these need IDs appended or query params)
    pipelineUrl: '/api/pipeline', // Use as: /api/pipeline/:id
    pipelineListUrl: '/api/pipelines', // Use as: /api/pipelines?filters
    pluginUrl: '/api/plugin', // Use as: /api/plugin/:id (NOT /api/plugin?name=x)
    pluginListUrl: '/api/plugins', // Use as: /api/plugins?filters
    // Create/Upload endpoints
    pipelinePostUrl: '/api/pipeline',
    pluginUploadUrl: '/api/plugin/upload',
  },
  auth: {
    token: '',
  },
};

/**
 * Load configuration from file or environment
 */
export function getConfig(): Config {
  const configPath = process.env.CLI_CONFIG_PATH || path.join(__dirname, '../config.yml');

  // Start with defaults
  let config: Config = { ...defaultConfig };

  // Load from file if exists
  if (fs.existsSync(configPath)) {
    try {
      printInfo('Loading configuration', { path: configPath });
      const fileContent = fs.readFileSync(configPath, 'utf-8');
      const userConfig = yaml.parse(fileContent);

      // Merge with defaults
      config = {
        api: {
          ...defaultConfig.api,
          ...userConfig.api,
        },
        auth: {
          ...defaultConfig.auth,
          ...userConfig.auth,
        },
      };
    } catch (error) {
      printError('Failed to load configuration', {
        error: error instanceof Error ? error.message : String(error),
      });
      printWarning('Falling back to default configuration');
    }
  } else {
    printWarning('Configuration file not found, using defaults', { path: configPath });
    printInfo('Create cli-config.yaml to customize settings');
  }

  // Override with environment variables
  // PLATFORM_URL is optional - only override if set
  if (process.env.PLATFORM_URL) {
    config.api.baseUrl = process.env.PLATFORM_URL;
    printInfo('Using PLATFORM_URL from environment', { baseUrl: config.api.baseUrl });
  }

  // PLATFORM_TOKEN is required - always check environment variable first
  if (process.env.PLATFORM_TOKEN) {
    config.auth.token = process.env.PLATFORM_TOKEN;
    printInfo('Using PLATFORM_TOKEN from environment');
  }

  // Validate required fields
  if (!config.auth.token) {
    printError('Authentication token is required');
    printWarning('Set PLATFORM_TOKEN environment variable');
    throw new Error('PLATFORM_TOKEN environment variable is required');
  }

  if (!config.api.baseUrl) {
    printWarning('API base URL not configured, using default');
  }

  printInfo('Configuration loaded successfully');
  return config;
}