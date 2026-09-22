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

  /** Whether this version is the default for its name. */
  isDefault?: boolean;

  /** When the version was deprecated (still resolves, with a warning). */
  deprecatedAt?: string | null;

  /** The publisher's deprecation message. */
  deprecationMessage?: string | null;

  /** When the version was yanked (ranges, `latest` and the default skip it). */
  yankedAt?: string | null;

  /** Why the version was yanked. */
  yankReason?: string | null;
}

/**
 * Response of `POST /plugins/:id/yank`: the yanked version, plus the version
 * promoted to default when the yanked one was the default.
 */
export interface PluginYankResponse {
  plugin: Plugin;
  promotedDefault?: { id: string; version: string };
}

/**
 * Response returned by single-plugin API endpoints (get, upload).
 */
export interface PluginResponse {
  plugin: Plugin;
}
