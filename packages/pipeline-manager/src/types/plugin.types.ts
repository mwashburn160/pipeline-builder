/**
 * Plugin type definitions
 */

/**
 * Plugin metadata
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
 * Plugin configuration
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
 * Base plugin information
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
 * Complete plugin
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
 * Plugin upload request
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
 * Plugin list query parameters
 */
export interface PluginListParams {
  /**
   * Filter by organization name
   */
  organization?: string;

  /**
   * Filter by plugin name (exact match)
   */
  name?: string;

  /**
   * Search plugin names (partial match)
   */
  search?: string;

  /**
   * Filter by active status
   */
  isActive?: boolean;

  /**
   * Filter by public status
   */
  isPublic?: boolean;

  /**
   * Page number for pagination
   * @default 1
   */
  page?: number;

  /**
   * Number of items per page
   * @default 20
   */
  limit?: number;

  /**
   * Sort field
   */
  sortBy?: 'createdAt' | 'updatedAt' | 'name' | 'version';

  /**
   * Sort order
   * @default 'desc'
   */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Plugin list response
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
