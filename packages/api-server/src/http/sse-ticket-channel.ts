// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireAuth, sendSuccess, sendError, ErrorCode, createLogger, writeSseHeaders, type SseTicketStore } from '@pipeline-builder/api-core';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { SSEManager } from './sse-connection-manager.js';

const logger = createLogger('sse-ticket-channel');

export interface SseTicketChannelOptions {
  /** POST route that exchanges the JWT for a single-use ticket (e.g. '/messages/notifications/ticket'). */
  ticketPath: string;
  /** GET route that redeems the ticket and opens the EventSource (e.g. '/messages/notifications'). */
  streamPath: string;
  /** Org-scoped, single-use ticket store (Redis-backed for multi-replica). */
  ticketStore: SseTicketStore;
  /** SSE manager — the org id is the stream subject (`sseManager.send(orgId, …)`). */
  sseManager: SSEManager;
  /** Noun used in capacity/connection error messages (e.g. 'notification', 'execution-stream'). */
  label: string;
  /** Extra middleware applied AFTER requireAuth on the mint route (e.g. requirePermission('reports:read')). */
  ticketGuards?: RequestHandler[];
}

/**
 * Register a per-ORG SSE channel: a POST that exchanges the caller's VERIFIED JWT
 * org for a single-use, org-bound ticket, and a GET that redeems the ticket and
 * attaches an EventSource keyed by that org. The org IS the stream subject, so a
 * producer reaches subscribers with `sseManager.send(orgId, …)`. Registering a
 * channel turns on the manager's cross-pod relay (this service's own relay
 * channel), so a frame produced on one replica reaches a subscriber on another.
 * Shared by the message-notification and reporting execution-status
 * channels so the subtle bits — the ticket→addClient→flushHeaders ordering (a 429
 * MUST precede flushHeaders, which commits the 200) and the capacity semantics —
 * live in exactly one place.
 *
 * Distinct from app-factory's `/logs` channel, which is SUBJECT-bound (per build,
 * via SSEManager.createTicket) rather than org-bound.
 */
export function registerSseTicketChannel(app: Express, opts: SseTicketChannelOptions): void {
  const { ticketPath, streamPath, ticketStore, sseManager, label, ticketGuards = [] } = opts;
  sseManager.enableRelay();

  app.post(ticketPath, requireAuth, ...ticketGuards, async (req: Request, res: Response) => {
    const orgId = req.user?.organizationId?.toLowerCase();
    if (!orgId) return sendError(res, 400, 'Token missing organization', ErrorCode.VALIDATION_ERROR);
    const result = await ticketStore.issue(orgId);
    if (!result.ok) {
      return result.reason === 'total'
        ? sendError(res, 503, `The ${label} subsystem is at capacity`, ErrorCode.QUOTA_EXCEEDED)
        : sendError(res, 429, `Too many ${label} tickets issued`, ErrorCode.QUOTA_EXCEEDED);
    }
    return sendSuccess(res, 200, { ticket: result.ticket });
  });

  app.get(streamPath, async (req: Request, res: Response) => {
    const ticketId = req.query.ticket as string | undefined;
    if (!ticketId) return void sendError(res, 401, 'Missing ticket parameter', ErrorCode.UNAUTHORIZED);
    const ticket = await ticketStore.consume(ticketId); // atomic single-use
    // An org channel's ticket is org-bound only; a subject-bound ticket (e.g. a
    // build-log ticket from a store sharing this namespace) doesn't open it.
    if (!ticket || ticket.subject !== undefined) return void sendError(res, 401, 'Invalid or expired ticket', ErrorCode.UNAUTHORIZED);
    // Reserve the connection slot BEFORE flushing SSE headers: once flushHeaders
    // runs the response is committed at 200 and a later 429 is silently dropped.
    // The org is the subject, so the per-ORG cap applies (not the per-request one).
    const added = sseManager.addOrgClient(ticket.orgId, res);
    if (!added) return void sendError(res, 429, `Too many ${label} connections`, ErrorCode.QUOTA_EXCEEDED);
    writeSseHeaders(res);
    res.flushHeaders();
    logger.info('SSE client connected', { channel: label, orgId: ticket.orgId });
  });
}
