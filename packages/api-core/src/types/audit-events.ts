// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-service audit events emitted via structured logs.
 *
 * Platform's own audit events (user.login, org.create, …) live in MongoDB
 * via the AuditEvent model — that's a separate persistence path scoped to
 * the platform service. The events below are emitted by other services
 * (image-registry, etc.) via the `emitAudit` helper as structured log
 * lines with `eventCategory: 'audit'`, scraped by Loki for queryable
 * audit history.
 *
 * Add a new event:
 *   1. Extend the union type below.
 *   2. Document it in `docs/audit-events.md` (or wherever the audit-events
 *      doc lives) including any payload-specific fields.
 *   3. Emit via `emitAudit(logger, 'event.name', { … })` from the route.
 */

/**
 * Correlation context shared by every cross-service audit event. Optional so
 * existing emit sites compile unchanged; when populated, these let an operator
 * pivot a Loki audit line to the originating HTTP request (`requestId`) or the
 * end-to-end distributed trace (`traceId`) — and line them up with platform's
 * MongoDB audit events, which carry the same two fields.
 */
export interface AuditCorrelation {
  /** Originating request id (propagated `x-request-id`). */
  requestId?: string;
  /** OpenTelemetry trace id of the active span, when tracing is enabled. */
  traceId?: string;
}

/** Tag-copy emitted from image-registry's POST /api/images/copy. */
export interface RegistryTagCopyAudit extends AuditCorrelation {
  event: 'registry.tag.copy';
  actor: string;
  source: string;
  target: string;
  sourceDigest: string;
  targetDigest: string;
  /** True when target's repo starts with `system/` — the highest-privilege case. */
  isPromotionToSystem: boolean;
  mounted: { manifests: number; blobs: number };
}

/** Tag-delete emitted from image-registry's DELETE /api/images/:name/manifests/:reference. */
export interface RegistryTagDeleteAudit extends AuditCorrelation {
  event: 'registry.tag.delete';
  actor: string;
  repo: string;
  ref: string;
  digest: string;
}

/**
 * Repository prune emitted from image-registry's DELETE /api/images/:name —
 * deletes every manifest in a repo (used to remove empty/dead repos from the
 * catalog). Unlike the tag-delete above, there's no single `ref`/`digest`:
 * the counts summarize the whole repo.
 */
export interface RegistryRepoDeleteAudit extends AuditCorrelation {
  event: 'registry.repo.delete';
  actor: string;
  repo: string;
  /** Count of unique manifest digests actually deleted. */
  deletedManifests: number;
  /** Count of tags the repo held before the prune. */
  deletedTags: number;
}

/** Union of every cross-service audit event currently emitted. */
export type AuditEvent = RegistryTagCopyAudit | RegistryTagDeleteAudit | RegistryRepoDeleteAudit;
