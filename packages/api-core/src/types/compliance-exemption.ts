// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `POST /compliance/exemptions` request body.
 *
 * It lives here because it crosses a SERVICE boundary: the Ask agent drafts one
 * (`api/ask` — a proposal the user reviews and commits through their own
 * session) and the compliance service inserts it (`api/compliance`). Each side
 * had its own six-field declaration, so a field added on one side was invisible
 * to the other until a request failed validation at runtime.
 */

/** A request to waive one compliance rule for one entity. */
export interface ComplianceExemptionRequest {
  /** The rule being waived. */
  ruleId: string;
  /** Which kind of entity the waiver covers. */
  entityType: 'plugin' | 'pipeline';
  /** The entity the waiver applies to. */
  entityId: string;
  /** Display label for the entity, for the review queue and the audit trail. */
  entityName?: string;
  /** Why the waiver is being asked for; shown to the approver. */
  reason: string;
  /** ISO-8601 expiry. Omitted means the waiver does not self-expire. */
  expiresAt?: string;
}
