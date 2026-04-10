// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform API connection settings.
 */
export interface ApiConfig {
  /** Base URL of the platform API (e.g., `https://api.example.com`). */
  baseUrl: string;
  /** Default request timeout in milliseconds. */
  timeout?: number;
  /** Extended timeout for plugin upload requests (large files). */
  uploadTimeout?: number;
  /** URL path for single-pipeline CRUD operations. */
  pipelineUrl: string;
  /** URL path for pipeline list/query operations. */
  pipelineListUrl: string;
  /** URL path for single-plugin CRUD operations. */
  pluginUrl: string;
  /** URL path for plugin list/query operations. */
  pluginListUrl: string;
  /** URL path for pipeline creation (POST). */
  pipelinePostUrl: string;
  /** URL path for plugin upload (multipart POST). */
  pluginUploadUrl: string;
  /** When `false`, disables TLS certificate verification. */
  rejectUnauthorized?: boolean;
}

/**
 * Authentication credentials for platform API access.
 */
export interface AuthConfig {
  /** JWT bearer token obtained from the platform. */
  token: string;
}

/**
 * Complete CLI application configuration combining API and auth settings.
 */
export interface Config {
  /** Platform API connection settings. */
  api: ApiConfig;
  /** Authentication credentials. */
  auth: AuthConfig;
  /** Default AWS region (from user config or environment). */
  region?: string;
  /** Default AWS CLI profile (from user config or environment). */
  profile?: string;
}
