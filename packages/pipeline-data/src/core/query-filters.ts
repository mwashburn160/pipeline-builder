// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// `CommonFilter` / `PluginFilter` are wire types owned by api-core (so
// pipeline-core can name them without depending on the data layer).
import type {
  CommonFilter, ComplianceCheckVerdict, ComplianceScanStatus, ComplianceScanTarget, ComplianceScanTrigger, RuleTarget,
} from '@pipeline-builder/api-core';
export type { CommonFilter, PluginFilter } from '@pipeline-builder/api-core';

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
   * Sender, relative to the viewer:
   * - `'me'`     → rows the viewing USER authored (`created_by = viewerUserId`);
   *                with no viewer id it matches nothing (fail-closed).
   * - `'org'`    → rows the viewing ORG sent (any member).
   * - `'others'` → rows another org sent (received mail + announcements).
   */
  readonly sentBy?: 'me' | 'org' | 'others';

  /** Rows a specific user authored (`created_by`, compared case-preserving). */
  readonly senderUserId?: string;

  /** Rows exchanged with a specific org: it sent them, or it received them. */
  readonly counterpartyOrgId?: string;

  /**
   * Which side of the requesting org's own `hidden_by` stamp to return:
   * absent/false → the inbox (rows this org has NOT removed — the default);
   * true → only rows this org removed (the "Removed" view, and the scope of
   * an unhide). Never widens visibility.
   */
  readonly hidden?: boolean;

  /**
   * Explicit row selection (`id IN (...)`). Narrows only — AND-ed with the
   * visibility scope like every other field, so it can never reach a row the
   * caller couldn't already list.
   */
  readonly ids?: readonly string[];

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
  readonly target?: RuleTarget;
  readonly action?: string;
  readonly result?: ComplianceCheckVerdict;
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
  readonly target?: ComplianceScanTarget;
  readonly status?: ComplianceScanStatus;
  readonly triggeredBy?: ComplianceScanTrigger;
  readonly limit?: number;
  readonly offset?: number;
}
