// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * User model.
 *
 * Users can belong to multiple organizations via {@link UserOrgMembership}.
 * The `role` here is the user's role in their **active** organization (from
 * the JWT), not a global role. Use `organizations` to see all memberships.
 * `organizationId` / `organizationName` reflect the currently active org.
 */
export interface User {
  id: string;
  username: string;
  email: string;
  /** Per-org role in the active organization. Derived from UserOrganization, not a global role. */
  role: 'owner' | 'admin' | 'member';
  /** Active organization ID (user may belong to multiple orgs; see `organizations`) */
  organizationId?: string;
  /** Active organization name */
  organizationName?: string;
  isEmailVerified: boolean;
  tier?: QuotaTier;
  features?: string[];
  featureOverrides?: Record<string, boolean>;
  /** All organizations this user belongs to, with per-org roles */
  organizations?: UserOrgMembership[];
  createdAt?: string;
  updatedAt?: string;
}

/** A user's membership in an organization. */
export interface UserOrgMembership {
  id: string;
  name: string;
  slug?: string;
  role: 'owner' | 'admin' | 'member';
}

/** System organization identifier (must match backend SYSTEM_ORG_ID). */
const SYSTEM_ORG_ID = 'system';

/**
 * Check if user belongs to the system organization
 */
export function isSystemOrg(user: User | null): boolean {
  if (!user) return false;
  const orgId = user.organizationId?.toLowerCase();
  const orgName = user.organizationName?.toLowerCase();
  return orgId === SYSTEM_ORG_ID || orgName === SYSTEM_ORG_ID;
}

/**
 * Check if user is system admin
 */
export function isSystemAdmin(user: User | null): boolean {
  if (!user) return false;
  if (user.role !== 'admin' && user.role !== 'owner') return false;
  return isSystemOrg(user);
}

/**
 * Check if user is organization admin (admin or owner, not in system org)
 */
export function isOrgAdmin(user: User | null): boolean {
  return (user?.role === 'admin' || user?.role === 'owner') && !isSystemAdmin(user);
}

/**
 * Organization member
 */
export interface OrganizationMember {
  id: string;
  username: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  isOwner: boolean;
  isActive: boolean;
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
 * Quota tier identifiers.
 * Source of truth: packages/api-core/src/types/quota-tiers.ts
 */
export type QuotaTier = 'developer' | 'pro' | 'unlimited';

/**
 * Unified org quota response (matches backend OrgQuotaResponse)
 */
export interface OrgQuotaResponse {
  orgId: string;
  name: string;
  slug: string;
  tier?: QuotaTier;
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
 * Organization AI provider configuration
 */
export interface AIProviderStatus {
  configured: boolean;
  hint?: string;
}

export interface OrgAIConfig {
  providers: Record<string, AIProviderStatus>;
}

/**
 * BullMQ build queue job counts (admin-only)
 */
export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface QueueStatus extends QueueCounts {
  dlq?: QueueCounts;
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
  category?: string;
  version: string;
  
  // Plugin configuration
  metadata: Record<string, string | number | boolean>;
  pluginType: string;
  computeType: string;
  timeout?: number;
  failureBehavior?: 'fail' | 'warn' | 'ignore';
  secrets?: Array<{ name: string; required: boolean; description?: string }>;

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
 * Typed views for AI-generated BuilderProps structure.
 * Used by GitUrlTab to safely access nested plugin references
 * within the loosely-typed BuilderProps.synth / BuilderProps.stages.
 */

/** Plugin reference as it appears in AI-generated BuilderProps JSON. */
export interface GeneratedPluginRef {
  name: string;
  alias?: string;
  filter?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Typed view of an AI-generated stage step. */
export interface GeneratedStageStep {
  plugin: GeneratedPluginRef;
  [key: string]: unknown;
}

/** Typed view of an AI-generated stage. */
export interface GeneratedStage {
  stageName: string;
  alias?: string;
  steps: GeneratedStageStep[];
}

/** Typed view of the AI-generated synth section. */
export interface GeneratedSynth {
  plugin: GeneratedPluginRef;
  [key: string]: unknown;
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
  role: 'owner' | 'admin' | 'member';
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invitedBy: string;
  inviterName: string;
  organizationId: string;
  organizationName: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Log entry from Loki
 */
export interface LogEntry {
  timestamp: string;
  line: string;
  labels: Record<string, string>;
  parsed: Record<string, unknown>;
}

/**
 * Log query result from platform API
 */
export interface LogQueryResult {
  entries: LogEntry[];
  stats: { entriesReturned: number; query: string };
}

/**
 * Billing interval for subscriptions
 */
export type BillingInterval = 'monthly' | 'annual';

/**
 * Subscription lifecycle status
 */
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete';

/**
 * Plan definition from the billing API
 */
export interface Plan {
  id: string;
  name: string;
  description: string;
  tier: QuotaTier;
  prices: {
    monthly: number;
    annual: number;
  };
  features: string[];
  isDefault: boolean;
  sortOrder: number;
}

/**
 * Subscription info from the billing API
 */
export interface Subscription {
  id: string;
  orgId: string;
  planId: string;
  planName?: string;
  tier?: QuotaTier;
  status: SubscriptionStatus;
  interval: BillingInterval;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Billing event from the admin API
 */
export interface BillingEvent {
  id: string;
  orgId: string;
  subscriptionId?: string;
  type: string;
  details: Record<string, unknown>;
  createdAt: string;
}

/**
 * Message type identifiers
 */
export type MessageType = 'announcement' | 'conversation';

/**
 * Message priority levels
 */
export type MessagePriority = 'normal' | 'high' | 'urgent';

/**
 * Internal message model
 */
export interface Message {
  id: string;
  orgId: string;
  threadId: string | null;
  recipientOrgId: string;
  messageType: MessageType;
  subject: string;
  content: string;
  isRead: boolean;
  priority: MessagePriority;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  accessModifier: 'public' | 'private';
  isDefault: boolean;
  isActive: boolean;
  deletedAt?: string;
  deletedBy?: string;
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

