// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, validateBody, requirePermission } from '@pipeline-builder/api-core';
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
  // null/'' clears the webhook; a non-empty string sets it.
  webhookUrl: z.string().url().nullable().optional(),
  // Omit to keep the existing secret; '' clears it.
  webhookSecret: z.string().nullable().optional(),
}).strict();

/** Per-org compliance notification preference (read for members, write for admins). */
export function createNotificationPreferenceRoutes(): Router {
  const router = Router();

  // GET / — the calling org's preference (defaults when unset).
  router.get('/', withRoute(async ({ res, ctx, orgId }) => {
    const pref = await getNotificationPreference(orgId);
    ctx.log('COMPLETED', 'Read notification preference', { hasRow: !!pref });
    return sendSuccess(res, 200, { preference: toApiPreference(pref) });
  }));

  // PUT / — upsert the calling org's preference. Org admin / owner only.
  router.put('/', requirePermission('compliance:write'), withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, PreferenceUpdateSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error);

    const patch = { ...validation.value };
    // Normalise an empty targetUsers array to null (= all org admins).
    if (Array.isArray(patch.targetUsers) && patch.targetUsers.length === 0) patch.targetUsers = null;
    // Treat an empty webhook URL/secret as "clear".
    if (patch.webhookUrl === '') patch.webhookUrl = null;
    if (patch.webhookSecret === '') patch.webhookSecret = null;

    const saved = await upsertNotificationPreference(orgId, patch);
    ctx.log('COMPLETED', 'Updated notification preference', { orgId });
    return sendSuccess(res, 200, { preference: toApiPreference(saved) });
  }));

  return router;
}
