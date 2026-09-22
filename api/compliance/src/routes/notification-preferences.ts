// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, audited, validateBody, requirePermission, ErrorCode, actorId, recordAudit } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import {
  getNotificationPreference,
  upsertNotificationPreference,
  type ComplianceNotificationPreference,
} from '../services/notification-service.js';

/** Effective defaults when an org has never saved a preference — mirrors the
 *  column defaults so the UI renders a sane initial form. */
const DEFAULT_PREFERENCE = {
  notifyOnBlock: true,
  notifyOnWarning: false,
  emailEnabled: false,
  digestMode: 'immediate',
  targetUsers: null as string[] | null,
  webhookUrl: null as string | null,
};

/** A stored webhook URL's host for the audit trail, or null when absent/unparsable
 *  (the audit must never fail the request that succeeded). Host only — a URL can
 *  carry credentials or a token in its path/query. */
function webhookHostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Shape returned to clients. `webhookSecret` is never echoed back — only a
 *  `hasWebhookSecret` flag — since it's bearer-equivalent. */
export function toApiPreference(p: ComplianceNotificationPreference | null) {
  if (!p) return { ...DEFAULT_PREFERENCE, hasWebhookSecret: false };
  return {
    notifyOnBlock: p.notifyOnBlock,
    notifyOnWarning: p.notifyOnWarning,
    emailEnabled: p.emailEnabled,
    digestMode: p.digestMode,
    targetUsers: p.targetUsers ?? null,
    webhookUrl: p.webhookUrl ?? null,
    hasWebhookSecret: !!p.webhookSecret,
  };
}

const PreferenceUpdateSchema = z.object({
  notifyOnBlock: z.boolean().optional(),
  notifyOnWarning: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  digestMode: z.enum(['immediate', 'daily', 'weekly']).optional(),
  // null clears the list (→ all org admins). Empty array also means "no explicit
  // recipients"; we normalise it to null below.
  targetUsers: z.array(z.string().min(1)).nullable().optional(),
  // null/'' clears the webhook; a non-empty string sets it. Require https up
  // front — delivery (resolveSafeWebhookTarget) rejects non-https, so accepting
  // http here would silently fail on every future send instead of 400-ing now.
  webhookUrl: z.string().url().refine((u) => u.startsWith('https://'), 'webhook url must use https').nullable().optional(),
  // Omit to keep the existing secret; '' clears it.
  webhookSecret: z.string().nullable().optional(),
}).strict();

/** Per-org compliance notification preference (read for members, write for admins). */
export function createNotificationPreferenceRoutes(): Router {
  const router = Router();

  // GET / — the calling org's preference (defaults when unset).
  router.get('/', requirePermission('compliance:read'), withRoute(async ({ res, ctx, orgId }) => {
    const pref = await getNotificationPreference(orgId);
    ctx.log('COMPLETED', 'Read notification preference', { hasRow: !!pref });
    return sendSuccess(res, 200, { preference: toApiPreference(pref) });
  }));

  // PUT / — upsert the calling org's preference. Org admin / owner only.
  router.put('/', requirePermission('compliance:write'), audited('compliance.notification-preference.update'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, PreferenceUpdateSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);

    const patch = { ...validation.value };
    // Normalise an empty targetUsers array to null (= all org admins).
    if (Array.isArray(patch.targetUsers) && patch.targetUsers.length === 0) patch.targetUsers = null;
    // Treat an empty webhook URL/secret as "clear".
    if (patch.webhookUrl === '') patch.webhookUrl = null;
    if (patch.webhookSecret === '') patch.webhookSecret = null;

    const saved = await upsertNotificationPreference(orgId, patch);
    ctx.log('COMPLETED', 'Updated notification preference', { orgId });

    // Best-effort attributed audit — the upsert succeeded. Where violation
    // notices go (recipients + the outbound webhook) is security-relevant
    // config, so a change is recorded. WHICH fields changed only — never the
    // webhook secret, and never the URL's credentials: just its host.
    recordAudit({
      action: 'compliance.notification-preference.update',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'notification-preference',
      targetId: orgId,
      details: {
        fields: Object.keys(validation.value).sort(),
        webhookHost: webhookHostOf(saved.webhookUrl),
        webhookSecretSet: !!saved.webhookSecret,
      },
    });

    return sendSuccess(res, 200, { preference: toApiPreference(saved) });
  }));

  return router;
}
