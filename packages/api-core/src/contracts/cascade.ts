// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared shapes for the platform CASCADE legs: the idempotent endpoints each
 * owning service serves so platform's durable outbox (`cascade_outbox`) can
 * tear a deleted org — or an erased user — out of that service's own store.
 *
 * Each endpoint is defined in its serving service's area file
 * (`PIPELINE_INTERNAL.purgeOrg`, `PLUGIN_INTERNAL.eraseUser`, …); this file
 * only holds what they have in common, so every leg answers the same way:
 *
 *  - 2xx is the ACK. The handler is idempotent (a second delivery of the same
 *    leg matches nothing and still answers 2xx), so the outbox may redeliver
 *    freely and marks the leg done on the first 2xx it sees.
 *  - Anything else — non-2xx, unreachable, timeout — is a retry with backoff.
 */

import { z } from 'zod';

/** `:orgId` of an org-purge leg. */
export const CascadeOrgParams = z.object({ orgId: z.string().min(1, 'orgId is required') });

/** `:userId` of a user-erasure leg. */
export const CascadeUserParams = z.object({ userId: z.string().min(1, 'userId is required') });

/** An org-purge leg's success `data`: the rows it tombstoned/removed, per table. */
export const OrgPurgeResponse = z.object({
  orgId: z.string(),
  tables: z.record(z.string(), z.number()),
});

/** The auth prose every cascade leg shares. */
export const CASCADE_LEG_AUTH = 'Service token from platform (the durable cascade outbox), system-org binding. '
  + 'The target is the PATH param; the handler runs under a sysadmin tenant context and is idempotent.';
