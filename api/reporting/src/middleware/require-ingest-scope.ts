// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { hasScope, sendError, ErrorCode, tagRouteGate } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';

/**
 * The capability scope every reporting MACHINE write credential must carry — the
 * AWS event-ingestion Lambda (`/reports/events`, `/reports/ingest-health`) and the
 * user's incident tool (`/reports/incidents` webhooks).
 */
export const INGEST_SCOPE = 'reporting:ingest';

/**
 * Per-route guard for the machine ingest writes: 403 unless the token carries the
 * `reporting:ingest` scope. Without it any authenticated user JWT could forge
 * events/health/incidents (the event path even resolves the org from the pipeline
 * registry, not the caller). Use after `requireAuth` (the routers are mounted
 * behind it in src/index.ts).
 */
export function requireIngestScope(req: Request, res: Response, next: NextFunction): void {
  if (!hasScope(req, INGEST_SCOPE)) {
    return sendError(res, 403, `Token must carry the '${INGEST_SCOPE}' scope`, ErrorCode.INSUFFICIENT_PERMISSIONS);
  }
  next();
}
// Declare what this service-local gate enforces so the introspected route table
// (and the route-coverage test that reads it) records the machine-scope boundary
// instead of seeing an untagged middleware.
tagRouteGate(requireIngestScope, { kind: 'scope', scope: INGEST_SCOPE });
