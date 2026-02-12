/**
 * User model
 */
export interface User {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  organizationId?: string;
  organizationName?: string;
  isEmailVerified: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Check if user is system admin
 */
export function isSystemAdmin(user: User | null): boolean {
  if (!user || user.role !== 'admin') return false;
  const orgId = user.organizationId?.toLowerCase();
  const orgName = user.organizationName?.toLowerCase();
  return orgId === 'system' || orgName === 'system';
}

/**
 * Check if user is organization admin
 */
export function isOrgAdmin(user: User | null): boolean {
  return user?.role === 'admin' && !isSystemAdmin(user);
}

/**
 * Organization member
 */
export interface OrganizationMember {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  isOwner: boolean;
  isEmailVerified: boolean;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Quota summary per type (matches backend OrgQuotaResponse.quotas[type])
 */
export interface QuotaSummary {
  limit: number;
  used: number;
  remaining: number;
  unlimited: boolean;
  resetAt: string;
}

/**
 * Quota type identifiers
 */
export type QuotaType = 'plugins' | 'pipelines' | 'apiCalls';

/**
 * Unified org quota response (matches backend OrgQuotaResponse)
 */
export interface OrgQuotaResponse {
  orgId: string;
  name: string;
  slug: string;
  quotas: Record<QuotaType, QuotaSummary>;
  isDefault?: boolean;
}

/**
 * Organization model
 */
export interface Organization {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  ownerId: string;
  memberCount: number;
  quotas?: Record<QuotaType, QuotaSummary>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Plugin model
 */
export interface Plugin {
  // Primary key
  id: string;
  
  // Organization and access control
  orgId: string;
  
  // Audit fields
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  
  // Core plugin information
  name: string;
  description?: string;
  keywords: string[];
  version: string;
  
  // Plugin configuration
  metadata: Record<string, string | number | boolean>;
  pluginType: string;
  computeType: string;
  
  // Build configuration
  env: Record<string, string>;
  installCommands: string[];
  commands: string[];
  
  // Output configuration
  primaryOutputDirectory?: string;

  // Docker configuration
  imageTag: string;
  dockerfile?: string;
  
  // Access and visibility
  accessModifier: 'public' | 'private';
  isDefault: boolean;
  isActive: boolean;
  
  // Deletion tracking (soft delete)
  deletedAt?: string;
  deletedBy?: string;
}

/**
 * Builder props for pipeline configuration.
 * Mirrors the canonical BuilderProps from @mwashburn160/pipeline-core
 * but without CDK-specific type imports.
 */
export interface BuilderProps {
  project: string;
  organization: string;
  pipelineName?: string;
  global?: Record<string, string | number | boolean>;
  defaults?: Record<string, unknown>;
  role?: Record<string, unknown>;
  synth: Record<string, unknown>;
  stages?: Record<string, unknown>[];
}

/**
 * Create pipeline request data
 * Only props (based on BuilderProps) and accessModifier are required
 */
export interface CreatePipelineData {
  project: string;
  organization: string;
  pipelineName?: string;
  description?: string;
  keywords?: string[];
  props: BuilderProps;
  accessModifier?: 'public' | 'private';
}

/**
 * Pipeline model
 */
export interface Pipeline {
  // Primary key
  id: string;
  
  // Organization and access control
  orgId: string;
  
  // Audit fields
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  
  // Core pipeline information
  project: string;
  organization: string;
  pipelineName?: string;
  description?: string;
  keywords: string[];
  
  // Pipeline configuration
  props: BuilderProps;
  
  // Access and visibility
  accessModifier: 'public' | 'private';
  isDefault: boolean;
  isActive: boolean;
  
  // Deletion tracking (soft delete)
  deletedAt?: string;
  deletedBy?: string;
}

/**
 * Invitation model
 */
export interface Invitation {
  id: string;
  email: string;
  role: 'user' | 'admin';
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invitedBy: string;
  inviterName: string;
  organizationId: string;
  organizationName: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Auth tokens
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Standard API response format (matches backend)
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  statusCode: number;
  data?: T;
  message?: string;
  code?: string;
  details?: Record<string, unknown>;
  timestamp?: string;
}

/**
 * Paginated API response format (matches backend)
 */
export interface PaginatedResponse<T = unknown> {
  success: boolean;
  statusCode: number;
  data?: T[];
  // Backend uses specific field names for different resources
  pipelines?: T[];
  plugins?: T[];
  users?: T[];
  pagination?: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  meta?: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
  timestamp?: string;
}

/**
 * Standard error codes from backend
 */
export const ErrorCode = {
  // Authentication errors
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  SESSION_INVALID: 'SESSION_INVALID',
  
  // Authorization errors
  FORBIDDEN: 'FORBIDDEN',
  ADMIN_REQUIRED: 'ADMIN_REQUIRED',
  SYSTEM_ADMIN_REQUIRED: 'SYSTEM_ADMIN_REQUIRED',
  ORG_ADMIN_REQUIRED: 'ORG_ADMIN_REQUIRED',
  
  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MISSING_FIELDS: 'MISSING_FIELDS',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_FORMAT: 'INVALID_FORMAT',
  
  // Resource errors
  NOT_FOUND: 'NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  ORG_NOT_FOUND: 'ORG_NOT_FOUND',
  INVITATION_NOT_FOUND: 'INVITATION_NOT_FOUND',
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  PIPELINE_NOT_FOUND: 'PIPELINE_NOT_FOUND',
  
  // Conflict errors
  CONFLICT: 'CONFLICT',
  DUPLICATE: 'DUPLICATE',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  
  // Rate limiting errors
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  ORG_QUOTA_EXCEEDED: 'ORG_QUOTA_EXCEEDED',
  
  // Server errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_ERROR: 'SERVICE_ERROR',
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

/**
 * Check if an API error has a specific code
 */
export function hasErrorCode(error: unknown, code: ErrorCodeType): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    return (error as { code: string }).code === code;
  }
  return false;
}

/**
 * Get user-friendly error message
 */
export function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    if ('message' in error && typeof (error as { message: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unexpected error occurred';
}