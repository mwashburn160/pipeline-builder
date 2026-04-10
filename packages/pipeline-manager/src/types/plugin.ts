// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Package-level metadata extracted from the plugin archive.
 */
export interface PluginMetadata {
  /**
   * Plugin name
   */
  name: string;

  /**
   * Plugin version
   */
  version: string;

  /**
   * Plugin description
   */
  description?: string;

  /**
   * Plugin author
   */
  author?: string;

  /**
   * Plugin license
   */
  license?: string;

  /**
   * Plugin homepage URL
   */
  homepage?: string;

  /**
   * Plugin repository URL
   */
  repository?: string;

  /**
   * Plugin keywords/tags
   */
  keywords?: string[];

  /**
   * Plugin dependencies
   */
  dependencies?: Record<string, string>;
}

/**
 * Runtime configuration for a plugin, including its entry point and schema.
 */
export interface PluginConfig {
  /**
   * Plugin entry point
   */
  main?: string;

  /**
   * Plugin configuration schema
   */
  schema?: Record<string, unknown>;

  /**
   * Plugin default configuration
   */
  defaults?: Record<string, unknown>;
}

/**
 * Core plugin fields required on every plugin record.
 */
export interface PluginBase {
  /**
   * Unique plugin identifier
   */
  id: string;

  /**
   * Plugin name
   */
  name: string;

  /**
   * Plugin version
   */
  version: string;

  /**
   * Organization that owns the plugin
   */
  organization: string;
}

/**
 * Complete plugin entity combining core fields with optional detail fields.
 */
export interface Plugin extends PluginBase {
  /**
   * Plugin description
   */
  description?: string;

  /**
   * Plugin metadata
   */
  metadata?: PluginMetadata;

  /**
   * Plugin configuration
   */
  config?: PluginConfig;

  /**
   * Plugin file URL
   */
  fileUrl?: string;

  /**
   * Plugin file size in bytes
   */
  fileSize?: number;

  /**
   * Plugin checksum (SHA256)
   */
  checksum?: string;

  /**
   * Whether the plugin is active
   */
  isActive?: boolean;

  /**
   * Whether the plugin is public
   */
  isPublic?: boolean;

  /**
   * Plugin creation timestamp
   */
  createdAt?: string;

  /**
   * Plugin last update timestamp
   */
  updatedAt?: string;

  /**
   * User who uploaded the plugin
   */
  uploadedBy?: string;
}

/**
 * Metadata fields sent alongside the plugin archive in an upload request.
 */
export interface PluginUploadRequest {
  /**
   * Organization name
   */
  organization: string;

  /**
   * Plugin name (optional, can be extracted from file)
   */
  name?: string;

  /**
   * Plugin version (optional, can be extracted from file)
   */
  version?: string;

  /**
   * Whether the plugin is public
   * @default false
   */
  isPublic?: boolean;

  /**
   * Whether the plugin is active
   * @default true
   */
  isActive?: boolean;

  /**
   * Additional metadata
   */
  metadata?: Record<string, unknown>;
}

/**
 * Response returned by single-plugin API endpoints (get, upload).
 */
export interface PluginResponse {
  plugin: Plugin;
}

/**
 * Paginated response returned by the plugin list API endpoint.
 */
export interface PluginListResponse {
  /**
   * List of plugins
   */
  plugins: Plugin[];

  /**
   * Total number of plugins (for pagination)
   */
  total: number;

  /**
   * Current page number
   */
  page: number;

  /**
   * Number of items per page
   */
  limit: number;

  /**
   * Whether there are more pages
   */
  hasMore: boolean;
}
