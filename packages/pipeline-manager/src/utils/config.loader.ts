import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { Config } from '../types';
import { printDebug, printError, printWarning } from './output.utils';

export type { Config };

/**
 * Default configuration
 *
 * Endpoint paths must match nginx routes:
 * - GET  /api/pipeline/:id  → Get single pipeline
 * - GET  /api/pipelines     → List pipelines
 * - POST /api/pipeline      → Create pipeline
 * - GET  /api/plugin/:id    → Get single plugin
 * - GET  /api/plugins       → List plugins
 * - POST /api/plugin/upload → Upload plugin
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
    rejectUnauthorized: true,
  },
};

/**
 * Load configuration from file and environment.
 *
 * Priority: environment variables > config file > defaults.
 * Auth token MUST come from PLATFORM_TOKEN env var (never from config file).
 */
export function getConfig(): Config {
  const configPath = process.env.CLI_CONFIG_PATH || path.join(__dirname, '../config.yml');

  let config: Omit<Config, 'auth'> = { ...defaultConfig };

  // Load from file if exists
  if (fs.existsSync(configPath)) {
    try {
      printDebug('Loading configuration', { path: configPath });
      const fileContent = fs.readFileSync(configPath, 'utf-8');
      const userConfig = yaml.parse(fileContent);

      config = {
        api: { ...defaultConfig.api, ...userConfig.api },
      };

      if (userConfig.auth) {
        printWarning('Auth section in config file is ignored — use PLATFORM_TOKEN env var');
      }
    } catch (error) {
      printWarning('Failed to load config file, using defaults', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    printDebug('No config file found, using defaults', { path: configPath });
  }

  // Override with environment variables
  if (process.env.PLATFORM_BASE_URL) {
    config.api.baseUrl = process.env.PLATFORM_BASE_URL;
    printDebug('Using PLATFORM_BASE_URL from environment', { baseUrl: config.api.baseUrl });
  }

  if (process.env.TLS_REJECT_UNAUTHORIZED !== undefined) {
    config.api.rejectUnauthorized = process.env.TLS_REJECT_UNAUTHORIZED !== '0';
    if (!config.api.rejectUnauthorized) {
      printWarning('SSL certificate validation disabled via TLS_REJECT_UNAUTHORIZED=0');
    }
  }

  if (process.env.UPLOAD_TIMEOUT) {
    const parsed = parseInt(process.env.UPLOAD_TIMEOUT, 10);
    if (!isNaN(parsed) && parsed > 0) {
      config.api.uploadTimeout = parsed;
      printDebug('Using UPLOAD_TIMEOUT from environment', { uploadTimeout: `${parsed}ms` });
    } else {
      printWarning('Invalid UPLOAD_TIMEOUT value, using default', { provided: process.env.UPLOAD_TIMEOUT });
    }
  }

  // Token is REQUIRED from environment
  const token = process.env.PLATFORM_TOKEN;

  if (!token) {
    printError('PLATFORM_TOKEN environment variable is not set');
    throw new Error('PLATFORM_TOKEN environment variable is required');
  }

  if (token.trim().length === 0) {
    throw new Error('PLATFORM_TOKEN must be a non-empty string');
  }

  if (token.includes(' ')) {
    printWarning('PLATFORM_TOKEN contains whitespace — this may cause issues');
  }

  printDebug('Configuration loaded successfully');

  return {
    ...config,
    auth: { token },
  };
}

/**
 * Get token from environment
 * @throws Error if PLATFORM_TOKEN is not set
 */
export function getToken(): string {
  const token = process.env.PLATFORM_TOKEN;
  if (!token) throw new Error('PLATFORM_TOKEN environment variable is required');
  return token;
}

/**
 * Check if token is set
 */
export function hasToken(): boolean {
  return !!process.env.PLATFORM_TOKEN;
}
