// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY message.
 *
 *  - notify: a trusted service drops a SYSTEM-authored in-app message into a
 *    recipient org's inbox (api-core `sendSystemNotification`);
 *  - org attachments purge: the platform org-delete cascade reclaims a deleted
 *    org's attachment blobs;
 *  - org data purge: the platform cascade outbox tears a deleted org's
 *    messages, support cases and attachment metadata out of message's tables;
 *  - offers frustration: billing's expansion-offers scheduler asks whether an
 *    account is currently unhappy (a boolean, never the support text).
 */

import { z } from 'zod';
import { CASCADE_LEG_AUTH, CascadeOrgParams, OrgPurgeResponse } from './cascade.js';
import { defineInternalEndpoint } from './define.js';
import { MESSAGE_PRIORITIES, type MessagePriority } from '../types/wire-vocabulary.js';

/** Matches the `subject` varchar(500) column. */
export const NOTIFY_SUBJECT_MAX = 500;
/** A sane bound for a notification body (content is TEXT). */
export const NOTIFY_CONTENT_MAX = 10000;

/**
 * The error code a notify-body issue maps to — carried on the zod issue's
 * `params.errorCode`, so the route answers the same code it always did
 * (MISSING_REQUIRED_FIELD for an absent field, VALIDATION_ERROR otherwise).
 */
export type NotifyBodyErrorCode = 'MISSING_REQUIRED_FIELD' | 'VALIDATION_ERROR';

/** The normalized notify body (what the route stores). */
export interface NotifyBody {
  /** Trimmed and lower-cased. */
  recipientOrgId: string;
  /** Absent when no user is targeted (an empty id is "no target"). */
  recipientUserId?: string;
  subject: string;
  content: string;
  priority?: MessagePriority;
}

/** A field read as a trimmed string, or not at all (a non-string is absent). */
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);

/**
 * The notify body. Each field is read as a string or not at all (a non-string
 * used to throw on `.trim()` and answer 500 for a caller's 400), and the checks
 * run in the route's historical order with its historical messages — only the
 * FIRST failing rule is reported.
 */
const NotifyBodySchema = z.preprocess(
  (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
  z.object({
    recipientOrgId: z.unknown().optional(),
    recipientUserId: z.unknown().optional(),
    subject: z.unknown().optional(),
    content: z.unknown().optional(),
    priority: z.unknown().optional(),
  }),
).superRefine((b, ctx) => {
  const fail = (message: string, errorCode: NotifyBodyErrorCode): void => {
    ctx.addIssue({ code: 'custom', message, params: { errorCode } });
  };
  const recipient = str(b.recipientOrgId)?.toLowerCase();
  const subject = str(b.subject);
  const content = str(b.content);
  if (!recipient || !subject || !content) {
    return fail('recipientOrgId, subject and content are required', 'MISSING_REQUIRED_FIELD');
  }
  // '*' is the announcement-broadcast recipient — a notification is a concrete DM.
  if (recipient === '*') return fail('recipientOrgId "*" is reserved for announcements', 'VALIDATION_ERROR');
  if (subject.length > NOTIFY_SUBJECT_MAX || content.length > NOTIFY_CONTENT_MAX) {
    return fail('subject or content exceeds the maximum length', 'VALIDATION_ERROR');
  }
  if (b.priority !== undefined && (typeof b.priority !== 'string' || !(MESSAGE_PRIORITIES as readonly string[]).includes(b.priority))) {
    return fail(`priority must be one of: ${MESSAGE_PRIORITIES.join(', ')}`, 'VALIDATION_ERROR');
  }
  return undefined;
}).transform((b): NotifyBody => {
  const recipientUserId = str(b.recipientUserId) || undefined;
  const priority = b.priority as MessagePriority | undefined;
  return {
    // Defensive `?? ''`: the refinement above already refused a missing field.
    recipientOrgId: (str(b.recipientOrgId) ?? '').toLowerCase(),
    ...(recipientUserId ? { recipientUserId } : {}),
    subject: str(b.subject) ?? '',
    content: str(b.content) ?? '',
    ...(priority ? { priority } : {}),
  };
});

/** The error code of a failed notify-body parse (see {@link NotifyBodyErrorCode}). */
export function notifyBodyErrorCode(error: z.ZodError | undefined): NotifyBodyErrorCode {
  const issue = error?.issues[0] as { params?: { errorCode?: NotifyBodyErrorCode } } | undefined;
  return issue?.params?.errorCode ?? 'VALIDATION_ERROR';
}

const OrgIdParams = z.object({ orgId: z.string().min(1, 'orgId is required') });

export const MESSAGE_INTERNAL = {
  /**
   * Create a SYSTEM-authored notification. 201 `{ id }`; 400 for an invalid
   * body (see {@link notifyBodyErrorCode}); 500 when the insert fails.
   */
  notify: defineInternalEndpoint({
    id: 'message.notify',
    service: 'message',
    method: 'POST',
    path: '/messages/internal/notify',
    callers: ['platform', 'billing', 'compliance', 'quota', 'reporting'],
    auth: 'Service token from a named caller, scoped to the RECIPIENT org (role member). '
      + 'The row is authored in an explicit system tenant scope, not the token\'s org.',
    params: z.object({}),
    body: NotifyBodySchema,
    response: z.object({ id: z.string() }),
  }),
  /**
   * Reclaim a deleted org's attachment blobs by key prefix. 200
   * `{ orgId, deleted }`; 500 when the purge fails (so the cascade records the
   * cleanup as incomplete).
   */
  purgeOrgAttachments: defineInternalEndpoint({
    id: 'message.purgeOrgAttachments',
    service: 'message',
    method: 'DELETE',
    path: '/messages/internal/org/:orgId/attachments',
    callers: ['platform'],
    auth: 'Service token from platform (the org-delete cascade).',
    params: OrgIdParams,
    response: z.object({ orgId: z.string(), deleted: z.number() }),
  }),
  /** Idempotent: 200 `{ orgId, tables }`; 500 when any table failed (the leg retries). */
  purgeOrgData: defineInternalEndpoint({
    id: 'message.purgeOrgData',
    service: 'message',
    method: 'POST',
    path: '/messages/internal/orgs/:orgId/purge',
    callers: ['platform'],
    auth: CASCADE_LEG_AUTH,
    params: CascadeOrgParams,
    response: OrgPurgeResponse,
  }),
  /**
   * The frustration signal for one org. Never fails for a reachable org: an AI
   * outage answers `degraded: true, frustrated: false`. 500 only for a
   * structural failure, which billing reads as "no signal".
   */
  offersFrustration: defineInternalEndpoint({
    id: 'message.offersFrustration',
    service: 'message',
    method: 'GET',
    path: '/messages/internal/offers/frustration/:orgId',
    callers: ['billing'],
    auth: 'Service token from billing, scoped to the account being evaluated (the path org). '
      + 'Not tenant-bound to the token org: the handler reads only the path org\'s cases.',
    params: OrgIdParams,
    response: z.object({
      signal: z.object({
        orgId: z.string(),
        windowDays: z.number(),
        sampled: z.number(),
        frustrated: z.boolean(),
        confidence: z.number(),
        degraded: z.boolean(),
        promptVersion: z.string(),
      }),
    }),
  }),
} as const;
