// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { TIMEOUTS } from '../config/cli.constants';
import { Config } from '../types';
import { printDebug, printError, printWarning } from './output-utils';

export type { Config };

/**
 * Default configuration — API endpoint paths and connection settings.
 */
const defaultConfig: Omit<Config, 'auth'> = {
  api: {
    baseUrl: 'https://localhost:8443',
    timeout: TIMEOUTS.HTTP_REQUEST,
    pipelineUrl: '/api/pipeline',
    pipelineListUrl: '/api/pipelines',
    pluginUrl: '/api/plugin',
    pluginListUrl: '/api/plugins',
    pluginUploadUrl: '/api/plugin/upload',
    rejectUnauthorized: true,
  },
};

/** User config file path: ~/.pipeline-manager/config.yml */
const USER_CONFIG_PATH = path.join(os.homedir(), '.pipeline-manager', 'config.yml');

/**
 * Load a YAML config file and merge its `api` section into the config.
 * Returns the merged config or the original if file doesn't exist or fails.
 */
function loadConfigFile(filePath: string, config: Omit<Config, 'auth'>): Omit<Config, 'auth'> {
  if (!fs.existsSync(filePath)) return config;

  try {
    printDebug('Loading configuration', { path: filePath });
    const parsed = yaml.parse(fs.readFileSync(filePath, 'utf-8'));
    if (parsed?.auth) {
      printWarning('Auth section in config file is ignored — use PLATFORM_TOKEN env var');
    }
    return { api: { ...config.api, ...parsed?.api } };
  } catch (error) {
    printWarning('Failed to load config file, using defaults', {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return config;
  }
}

/**
 * Load configuration from files and environment.
 *
 * Priority (last wins):
 * 1. Built-in defaults
 * 2. User config file: ~/.pipeline-manager/config.yml
 * 3. Project config file: CLI_CONFIG_PATH or ./config.yml
 * 4. Environment variables
 *
 * Auth token MUST come from PLATFORM_TOKEN env var (never from config file).
 */
export function getConfig(): Config {
  const projectConfigPath = process.env.CLI_CONFIG_PATH || path.join(__dirname, '../config.yml');

  // Layer 1: defaults → Layer 2: user config → Layer 3: project config
  let config = loadConfigFile(USER_CONFIG_PATH, { ...defaultConfig });
  config = loadConfigFile(projectConfigPath, config);

  // Layer 4: environment variable overrides
  // Layer 4: environment variable overrides
  if (process.env.PLATFORM_BASE_URL) {
    config.api.baseUrl = process.env.PLATFORM_BASE_URL;
    printDebug('Using PLATFORM_BASE_URL from environment', { baseUrl: config.api.baseUrl });
  }

  if (process.env.TLS_REJECT_UNAUTHORIZED !== undefined) {
    const disable = process.env.TLS_REJECT_UNAUTHORIZED === '0';
    if (disable && process.env.NODE_ENV === 'production') {
      printWarning('Ignoring TLS_REJECT_UNAUTHORIZED=0 in production — SSL verification remains enabled');
    } else {
      config.api.rejectUnauthorized = !disable;
      if (disable) {
        printWarning('SSL certificate validation disabled via TLS_REJECT_UNAUTHORIZED=0');
      }
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
 * Return a copy of `config` with SSL verification disabled.
 */
export function withSSLDisabled(config: Config): Config {
  return {
    ...config,
    api: { ...config.api, rejectUnauthorized: false },
  };
}

/**
 * Load configuration, optionally disabling SSL based on command options.
 * Replaces the repeated pattern:
 *   `options.verifySsl === false ? withSSLDisabled(getConfig()) : getConfig()`
 */
export function getConfigWithOptions(options: { verifySsl?: boolean }): Config {
  const config = getConfig();
  return options.verifySsl === false ? withSSLDisabled(config) : config;
}
