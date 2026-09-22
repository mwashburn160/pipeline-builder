// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import * as os from 'os';
import * as path from 'path';
import { errorMessage } from '@pipeline-builder/api-core';
import * as yaml from 'yaml';
import { isSessionUsable, loadSession } from './credential-store.js';
import { printDebug, printError, printWarning } from './output-utils.js';
import { assertSslDisableAllowed, isProductionEnv } from './tls.js';
import { type Config } from '../types/index.js';

// ESM has no __dirname; derive it from this module's URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type { Config };

/**
 * Default configuration — API endpoint paths and connection settings.
 */
const defaultConfig: Omit<Config, 'auth'> = {
  api: {
    baseUrl: 'https://localhost:8443',
    timeout: 30_000,
    pipelineUrl: '/api/pipelines',
    pipelineTemplateUrl: '/api/pipeline-templates',
    pluginUrl: '/api/plugins',
    pluginUploadUrl: '/api/plugins/upload',
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
      error: errorMessage(error),
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
 * Auth token comes from PLATFORM_TOKEN, else the stored `auth login` session —
 * never from a config file.
 */
/**
 * Resolve the API/connection config (base URL, SSL, timeouts) from files and
 * environment WITHOUT requiring `PLATFORM_TOKEN`.
 *
 * This is the token-optional slice of {@link getConfig}. The pre-auth login step
 * (`ensurePlatformToken`) needs the resolved base URL to POST `/api/auth/login`
 * *before* any token exists — calling `getConfig()` there would throw on the
 * missing token and make inline-login dead-on-arrival.
 */
export function getApiConfig(): Omit<Config, 'auth'> {
  const projectConfigPath = process.env.CLI_CONFIG_PATH || path.join(__dirname, '../config.yml');

  // Layer 1: defaults → Layer 2: user config → Layer 3: project config.
  // `api` is copied too: a shallow `{ ...defaultConfig }` shares the SAME `api`
  // object, so the `PLATFORM_BASE_URL` assignment below mutated the module-level
  // defaults and leaked one caller's base URL into every later resolution.
  let config = loadConfigFile(USER_CONFIG_PATH, { api: { ...defaultConfig.api } });
  config = loadConfigFile(projectConfigPath, config);

  // Layer 4: environment variable overrides
  if (process.env.PLATFORM_BASE_URL) {
    config.api.baseUrl = process.env.PLATFORM_BASE_URL;
    printDebug('Using PLATFORM_BASE_URL from environment', { baseUrl: config.api.baseUrl });
  }

  if (process.env.TLS_REJECT_UNAUTHORIZED !== undefined) {
    const disable = process.env.TLS_REJECT_UNAUTHORIZED === '0';
    if (disable && isProductionEnv()) {
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

  return config;
}

export function getConfig(): Config {
  const config = getApiConfig();

  // PLATFORM_TOKEN wins (an access key in CI, or an explicit export); otherwise
  // fall back to the session `auth login` stored for THIS platform. A stored
  // session that has already expired is ignored rather than sent and rejected —
  // the async path (`resolveToken`) refreshes it, and everything else tells the
  // user to sign in again.
  const stored = loadSession(config.api.baseUrl);
  const token = process.env.PLATFORM_TOKEN || (isSessionUsable(stored) ? stored.accessToken : undefined);

  if (!token) {
    printError('Not signed in: no PLATFORM_TOKEN, and no valid stored session for this platform');
    throw new Error('Run "pipeline-manager auth login", or set PLATFORM_TOKEN to an access key');
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
 * Return a copy of `config` with SSL verification disabled. Module-private — the
 * only caller is `getConfigWithOptions` below.
 */
function withSSLDisabled(config: Config): Config {
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
  if (options.verifySsl === false) {
    // Every authenticated command flows its token through here — refuse to
    // disable cert verification in production (mirrors the login/renewal guards)
    // so a MITM can't harvest the Bearer JWT. No-op in non-production.
    assertSslDisableAllowed('authenticated API client (--no-verify-ssl)');
    return withSSLDisabled(config);
  }
  return config;
}
