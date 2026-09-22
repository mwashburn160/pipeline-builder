// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Visibility } from '@pipeline-builder/api-core';

/**
 * Base filter interface containing common filter properties shared across all entity types.
 *
 * @example
 * ```typescript
 * const filter: CommonFilter = {
 *   id: '123',
 *   orgId: 'my-org',
 *   visibility: 'public',
 *   isDefault: true,
 *   isActive: true
 * };
 * ```
 */
export interface CommonFilter {
  /**
   * Unique identifier for the entity
   * Can be a single ID or array of IDs for batch filtering
   */
  readonly id?: string | string[];

  // --- Viewer context (server-set, NEVER client-supplied) ---------------------
  // Only entities whose visibility predicate has a PER-USER rung read these —
  // pipeline templates (`private` is author-only) and messages (a per-user
  // targeted row is visible only to its target). Their services stamp them from
  // the request's `TenantContext` via `withViewerContext`, so no route or query
  // string can inject them. Everything else ignores them.
  //
  // Both fail CLOSED when absent: no viewer means the per-user rung matches
  // NOTHING, never everything.

  /** Caller's user id, matched against the entity's per-user column. */
  readonly viewerUserId?: string;
  /** Whether the caller is a platform super-admin (sees every rung). */
  readonly viewerIsSuperAdmin?: boolean;

  /**
   * Organization identifier to filter entities by organization
   * Can be a single org ID or array for multi-org filtering
   */
  readonly orgId?: string | string[];

  /**
   * Narrow to one rung of the shared three-rung sharing ladder. Applied WITHIN
   * what the caller can already see — never widens it.
   * @see Visibility
   */
  readonly visibility?: Visibility | string;

  /**
   * Filter by default status
   * - true: Only default entities
   * - false: Only non-default entities
   * - undefined: All entities
   */
  readonly isDefault?: boolean;

  /**
   * Filter by active/inactive status
   * - true: Only active entities
   * - false: Only inactive entities
   * - undefined: All entities
   */
  readonly isActive?: boolean;

  /**
   * Number of results to return
   * @minimum 1
   * @maximum 1000
   */
  readonly limit?: number;

  /**
   * Number of results to skip (for pagination)
   * @minimum 0
   */
  readonly offset?: number;

  /**
   * Sort field and direction
   * @example "name:asc", "createdAt:desc"
   */
  readonly sort?: string;

  /**
   * Filter by catalog owner (developer-portal "my services" view).
   * Matches the entity's `ownerId` exactly (a user id or team id).
   * Only applied by builders for entities that carry an owner column
   * (pipelines, plugins); ignored elsewhere.
   */
  readonly ownerId?: string;

  /**
   * Filter by lifecycle stage (experimental | production | deprecated).
   * Only applied by builders for entities that carry a lifecycle column.
   */
  readonly lifecycle?: string;
}

/**
 * Filter interface for plugin-specific properties.
 * Extends CommonFilter to include plugin-related filter options.
 *
 * @example
 * ```typescript
 * const filter: PluginFilter = {
 *   name: 'nodejs-build',
 *   version: '1.0.0',
 *   isActive: true
 * };
 * ```
 */
export interface PluginFilter extends CommonFilter {
  /**
   * Plugin name to filter by
   */
  readonly name?: string;

  /**
   * How `name` matches: `contains` (default — case-insensitive substring, for
   * list/search) or `exact` (resolution — the lookup path). Internal: not in
   * the public filter schema.
   */
  readonly nameMatch?: 'exact' | 'contains';

  /**
   * Publisher handle of an installed listing to resolve through (plan §3.5).
   * Lookup only: a `plugins` row query ignores it (the resolver routes a
   * qualified reference to the listing, never to an org's own rows).
   */
  readonly publisher?: string;

  /**
   * Plugin version spec: exact (`1.2.3`), caret (`^1.2.3`), tilde (`~1.2.3`),
   * partial (`1`, `1.2`, `1.x`) or `latest` — see semver-range.ts. A range never
   * matches a yanked version.
   * @example "1.0.0", "^2.0.0", "~1.2.3", "latest"
   */
  readonly version?: string;

  /** Exclude yanked versions (resolution without a version spec). Internal. */
  readonly excludeYanked?: boolean;

  /**
   * Keyword to search within the keywords JSONB array (case-insensitive contains)
   */
  readonly keyword?: string;

  /**
   * Plugin category to filter by
   * @example "language", "security", "testing"
   */
  readonly category?: string;
}

/**
 * Filter interface for pipeline-specific properties.
 * Extends CommonFilter to include pipeline-related filter options.
 *
 * @example
 * ```typescript
 * const filter: PipelineFilter = {
 *   project: 'my-app',
 *   organization: 'my-org',
 *   pipelineName: 'my-pipeline',
 *   isActive: true
 * };
 * ```
 */
export interface PipelineFilter extends CommonFilter {
  /**
   * Project name associated with the pipeline
   */
  readonly project?: string;

  /**
   * Organization name associated with the pipeline
   */
  readonly organization?: string;

  /**
   * Pipeline name to filter by
   */
  readonly pipelineName?: string;

  /**
   * Keyword to search within the keywords JSONB array (case-insensitive contains)
   */
  readonly keyword?: string;
}

/** Filter interface for pipeline-template queries (golden-path catalog). */
export interface PipelineTemplateFilter extends CommonFilter {
  /** Template name (case-insensitive contains). */
  readonly name?: string;
  /** Category to filter by (e.g. 'language', 'general'). */
  readonly category?: string;
  /** Keyword search within the keywords JSONB array. */
  readonly keyword?: string;
  // Sharing rung + viewer context are inherited from CommonFilter.
}

/**
 * Filter interface for message-specific properties.
 * Extends CommonFilter to include message-related filter options.
 */
export interface MessageFilter extends CommonFilter {
  /**
   * Thread ID to filter by (for fetching thread replies).
   * Pass `null` to filter for root messages only (threadId IS NULL).
   */
  readonly threadId?: string | null;

  /**
   * Recipient organization ID to filter by
   * Use '*' for broadcast announcements
   */
  readonly recipientOrgId?: string;

  /**
   * Recipient user ID to filter by (per-user targeting within the recipient
   * org). Pass `null` to match org-wide messages only (recipient_user_id IS
   * NULL). Rarely set directly by callers — see `viewerUserId` for the
   * visibility-scoping variant.
   */
  readonly recipientUserId?: string | null;

  // NOTE: the VIEWER's user id (`viewerUserId`) is inherited from CommonFilter.
  // For messages it is NOT a column filter: when present, the recipient-side
  // branch in `buildMessageConditions` widens to include rows targeted at this
  // user (recipient_user_id = viewerUserId) ALONGSIDE org-wide ones
  // (recipient_user_id IS NULL). When absent, only org-wide recipient rows are
  // visible, so a user-targeted message stays private to its target, the sender,
  // and the system org. MessageService stamps it from the tenant context.

  /**
   * Message type filter
   */
  readonly messageType?: 'announcement' | 'conversation';

  /**
   * Filter by priority level
   */
  readonly priority?: 'normal' | 'high' | 'urgent';

  /**
   * Channel/inbox-bucket filter (e.g. 'support', 'help'). Matches rows
   * exactly; pass null to match channel IS NULL (org-to-org messages).
   */
  readonly channel?: string | null;

  /**
   * Filter by read state for the requesting org.
   * Implemented as a JSONB key-existence check against `messages.read_by`
   * (a `{ [orgId]: isoTimestamp }` map), using the orgId passed to
   * `buildMessageConditions`.
   * - true  → only messages the org has read (orgId key exists in read_by)
   * - false → only messages the org has NOT read
   * - undefined → no read-state filter
   */
  readonly isRead?: boolean;

  /**
   * Free-text inbox search. Case-insensitive substring match against the
   * message `subject` OR `content` (LIKE wildcards in the term are escaped, so a
   * literal `%`/`_` matches itself). Applied on top of the visibility scope, so
   * it never widens what the caller can see.
   */
  readonly search?: string;
}

// ========================================
// Compliance Filters
// ========================================

/**
 * Filter for compliance policies.
 */
export interface CompliancePolicyFilter extends CommonFilter {
  readonly name?: string;
  readonly isTemplate?: boolean;
}

/**
 * Filter for compliance rules.
 */
export interface ComplianceRuleFilter extends CommonFilter {
  readonly name?: string;
  readonly policyId?: string;
  readonly target?: 'plugin' | 'pipeline';
  readonly field?: string;
  readonly severity?: 'warning' | 'error' | 'critical';
  readonly scope?: 'org' | 'published';
  readonly tag?: string;
}

/**
 * Filter for compliance exemptions.
 */
export interface ComplianceExemptionFilter {
  readonly orgId?: string;
  readonly ruleId?: string;
  readonly entityType?: 'plugin' | 'pipeline';
  readonly entityId?: string;
  readonly status?: 'pending' | 'approved' | 'rejected' | 'expired';
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Filter for compliance audit log entries.
 */
export interface ComplianceAuditFilter {
  readonly orgId?: string;
  readonly target?: 'plugin' | 'pipeline';
  readonly action?: string;
  readonly result?: 'pass' | 'warn' | 'block';
  readonly scanId?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Filter for compliance scans.
 */
export interface ComplianceScanFilter {
  readonly orgId?: string;
  readonly target?: 'plugin' | 'pipeline' | 'all';
  readonly status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly triggeredBy?: 'manual' | 'scheduled' | 'rule-change' | 'rule-dry-run';
  readonly limit?: number;
  readonly offset?: number;
}
