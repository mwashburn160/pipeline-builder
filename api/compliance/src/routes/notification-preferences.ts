// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, audited, validateBody, requirePermission, userHasPermission, ErrorCode, actorId, proposable, recordAudit, withProposalProvenance } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { DIGEST_MODES } from '../helpers/compliance-vocabulary.js';
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

/** A webhook URL reduced to its scheme and host — what a caller who may not
 *  change it is shown. Unparsable → null. */
function redactedWebhookUrl(url: string): string | null {
  const host = webhookHostOf(url);
  return host ? `https://${host}/…` : null;
}

/** Shape returned to clients. `webhookSecret` is never echoed back — only a
 *  `hasWebhookSecret` flag — since it's bearer-equivalent. So, often, is the URL
 *  itself (a Slack/Teams incoming webhook carries its token in the path): with
 *  `revealWebhookUrl: false` only its host is returned. */
export function toApiPreference(
  p: ComplianceNotificationPreference | null,
  { revealWebhookUrl = true }: { revealWebhookUrl?: boolean } = {},
) {
  if (!p) return { ...DEFAULT_PREFERENCE, hasWebhookSecret: false };
  const webhookUrl = p.webhookUrl ?? null;
  return {
    notifyOnBlock: p.notifyOnBlock,
    notifyOnWarning: p.notifyOnWarning,
    emailEnabled: p.emailEnabled,
    digestMode: p.digestMode,
    targetUsers: p.targetUsers ?? null,
    webhookUrl: webhookUrl && !revealWebhookUrl ? redactedWebhookUrl(webhookUrl) : webhookUrl,
    hasWebhookSecret: !!p.webhookSecret,
  };
}

const PreferenceUpdateSchema = z.object({
  notifyOnBlock: z.boolean().optional(),
  notifyOnWarning: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  digestMode: z.enum(DIGEST_MODES).optional(),
  // null clears the list (→ all org admins). Empty array also means "no explicit
  // recipients"; we normalise it to null below.
  targetUsers: z.array(z.string().min(1).max(255)).max(500).nullable().optional(),
  // null clears the webhook; a URL sets it ('' is not a URL and 400s). Require https up
  // front — delivery (resolveSafeWebhookTarget) rejects non-https, so accepting
  // http here would silently fail on every future send instead of 400-ing now.
  // Lengths are the columns' (`VARCHAR(500)` / `VARCHAR(255)`): past them the
  // write failed in Postgres as a 500 rather than a 400 here.
  webhookUrl: z.string().max(500).url().refine((u) => u.startsWith('https://'), 'webhook url must use https').nullable().optional(),
  // Omit to keep the existing secret; '' clears it.
  webhookSecret: z.string().max(255).nullable().optional(),
}).strict();

/** Per-org compliance notification preference (read for members, write for admins). */
export function createNotificationPreferenceRoutes(): Router {
  const router = Router();

  // GET / — the calling org's preference (defaults when unset). The full
  // webhook URL only for a caller who may change it (`compliance:write`).
  router.get('/', requirePermission('compliance:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const pref = await getNotificationPreference(orgId);
    ctx.log('COMPLETED', 'Read notification preference', { hasRow: !!pref });
    return sendSuccess(res, 200, { preference: toApiPreference(pref, { revealWebhookUrl: userHasPermission(req, 'compliance:write') }) });
  }));

  // PUT / — upsert the calling org's preference. Org admin / owner only.
  router.put('/', requirePermission('compliance:write'), audited('compliance.notification-preference.update'), proposable, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, PreferenceUpdateSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);

    const patch = { ...validation.value };
    // Normalise an empty targetUsers array to null (= all org admins).
    if (Array.isArray(patch.targetUsers) && patch.targetUsers.length === 0) patch.targetUsers = null;
    // Treat an empty webhook secret as "clear". (An empty URL never gets here:
    // the schema's `.url()` refuses it, so the URL clears with `null` only.)
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
      details: withProposalProvenance(req.headers, {
        fields: Object.keys(validation.value).sort(),
        webhookHost: webhookHostOf(saved.webhookUrl),
        webhookSecretSet: !!saved.webhookSecret,
      }),
    });

    return sendSuccess(res, 200, { preference: toApiPreference(saved) });
  }));

  return router;
}
