// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requirePermission, requireStepUp, type QuotaService, type SseTicketStore } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, registerSseTicketChannel, type SSEManager } from '@pipeline-builder/api-server';
import type { Express, RequestHandler } from 'express';

import { createAttachmentRoutes } from './routes/attachment-routes.js';
import { createCreateMessageRoutes } from './routes/create-message.js';
import { createDeleteMessageRoutes } from './routes/delete-message.js';
import { createInternalNotifyRoutes } from './routes/internal-notify.js';
import { createInternalOrgPurgeRoutes } from './routes/internal-org-purge.js';
import { createPurgeMessageRoutes } from './routes/purge-message.js';
import { createReadMessageRoutes } from './routes/read-messages.js';
import { createRestoreMessageRoutes } from './routes/restore-message.js';
import { createUpdateMessageRoutes } from './routes/update-message.js';

/** Dependencies the route factories need. */
export interface MessageRouteDeps {
  quotaService: QuotaService;
  sseManager: SSEManager;
  /** Org-bound, single-use SSE ticket store backing the notification channel. */
  ticketStore: SseTicketStore;
}

/**
 * Mount every message-service route on `app`. Shared by `index.ts` (the running
 * service) and the route-coverage test, so the route table the test checks is
 * the one production serves. Mount ORDER is load-bearing — see the comments.
 */
export function mountRoutes(app: Express, { quotaService, sseManager, ticketStore }: MessageRouteDeps): void {
  // Per-org notification SSE channel via the shared helper (POST …/ticket exchanges
  // the JWT for a single-use org-bound ticket; GET …/notifications redeems it and
  // attaches an EventSource keyed by the org). The reporting execution-status
  // channel uses the same helper. Registered BEFORE the /messages routers so the
  // literal `/messages/notifications` path isn't swallowed by the read router's
  // `/:id` matcher. The mint is gated on `messages:read` — the same authority the
  // inbox reads require, so the live channel can't outrun the data route (the
  // stream itself is authorized by the single-use ticket).
  registerSseTicketChannel(app, {
    ticketPath: '/messages/notifications/ticket',
    streamPath: '/messages/notifications',
    ticketStore,
    sseManager,
    label: 'notification',
    ticketGuards: [requirePermission('messages:read') as RequestHandler],
  });

  // -- /messages routes ---------------------------------------------------------
  // Each route attaches its own auth/quota middleware so that mounting these
  // at a shared prefix never causes middleware to bleed across verbs.
  // Attachment upload/download — mounted BEFORE the read routes so the literal
  // `/attachments` + `/attachments/:id` paths resolve here and aren't swallowed by
  // the read router's `/:id` matcher. Each route owns its auth (messages:write to
  // upload, messages:read to download).
  app.use('/messages', createAttachmentRoutes(quotaService));
  app.use('/messages', createReadMessageRoutes(quotaService));
  app.use('/messages', createCreateMessageRoutes(sseManager));
  app.use('/messages', createUpdateMessageRoutes(sseManager));
  app.use('/messages', createDeleteMessageRoutes(sseManager));

  // Internal org-purge (service-to-service): the platform cascade calls
  // DELETE /messages/internal/org/:orgId/attachments to reclaim the org's MinIO
  // blobs. Its own requireAuth + requireServicePrincipal gate it — no user chain.
  // Internal notify (service-to-service): a trusted platform service posts a
  // SYSTEM-authored in-app message + SSE ping to a recipient org/user (domain-join
  // notifications). Its own requireAuth + requireServicePrincipal gate it.
  //
  // Both MUST be mounted BEFORE the step-up mount below. That mount applies its
  // chain as prefix middleware to every /messages request that reaches it, so an
  // internal route mounted after it inherited `requirePermission('messages:write')`
  // — which a service token (no permission claims) fails with 403 — plus a second
  // pass through the idempotency middleware.
  app.use('/messages', createInternalOrgPurgeRoutes());
  app.use('/messages', createInternalNotifyRoutes(sseManager));

  // -- Purge + Restore routes — auth + orgId + messages:write + step-up --------
  // Both are permanently-consequential soft-delete operations and BOTH require a
  // step-up (password re-verify) beyond messages:write:
  //   - Restore: undo a soft-delete within the retention window.
  //   - Purge:   permanent hard-delete of an already soft-deleted tombstone.
  // They share ONE mount so each request clears the chain exactly once.
  // `requireStepUp` consumes the step-up token's `jti` a single time, so two
  // separate step-up mounts made every request for the SECOND router fall through
  // the first mount's step-up (consuming the jti) and then 401 as STEP_UP_REPLAY
  // at its own. The same stacking ran the idempotency middleware twice with the
  // same key, 409'ing any request that sent an Idempotency-Key. Mounted LAST so
  // no other /messages route falls through this chain.
  app.use('/messages', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), requireStepUp, createRestoreMessageRoutes(), createPurgeMessageRoutes());
}
