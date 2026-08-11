// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer-portal catalog metadata shared across catalog entities
 * (pipelines and plugins today; any future catalogable entity next).
 *
 * These are the ownership/lifecycle/classification fields an internal
 * developer portal keys its catalog, "my services" views, and scorecards
 * off of — the counterpart to Backstage's `metadata`/`spec.owner`/
 * `spec.lifecycle`. Kept here (not per-schema) so the DB schema, the Zod
 * validation, and the API all draw from one source of truth.
 */

/** Lifecycle stage of a catalog entity. */
export const LIFECYCLE_STAGES = ['experimental', 'production', 'deprecated'] as const;
export type Lifecycle = (typeof LIFECYCLE_STAGES)[number];

/** Default lifecycle applied when none is supplied (matches the DB column default). */
export const DEFAULT_LIFECYCLE: Lifecycle = 'production';

/** Operational criticality of a catalog entity (optional/unset by default). */
export const CRITICALITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type Criticality = (typeof CRITICALITY_LEVELS)[number];

/** Whether an owner reference points at an individual user or a team/org. */
export const OWNER_TYPES = ['user', 'team'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

/** A titled external link attached to a catalog entity (docs, dashboard, runbook, …). */
export interface EntityLink {
  readonly title: string;
  readonly url: string;
  /** Optional icon hint the UI may map to a glyph (e.g. 'docs', 'dashboard'). */
  readonly icon?: string;
}

/** Free-form typed classification labels: `{ team: 'payments', tier: 'gold' }`. */
export type EntityLabels = Record<string, string>;

/** Owner reference for a catalog entity. */
export interface CatalogOwnership {
  /** User id (ownerType='user') or team/org id (ownerType='team'). */
  readonly ownerId?: string | null;
  readonly ownerType?: OwnerType | null;
}
