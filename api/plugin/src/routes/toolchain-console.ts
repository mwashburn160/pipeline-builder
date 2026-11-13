// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Toolchain CONSOLE routes (docs/plans/bootstrap-image-versioning.md §5,
 * §6, §8, §9, §11, D9, Phase 5) — the API of
 * `frontend/pages/dashboard/toolchain.tsx`. Mounted at `/plugins/toolchain`
 * behind the shared auth + org chain.
 *
 * EVERY route is `requireSystemOrgPermission('toolchain:operate')`: the
 * caller's ACTIVE org is the system org, it holds `toolchain:operate` (system-
 * org-only, Platform Operator), and its session is MFA-grade (aal2). A tenant
 * Admin, and a holder of the org-level `toolchain:manage`, get 403. Every
 * WRITE also needs `requireStepUp` (always on; it refuses machines) and is
 * audited by the service it wraps; reads never step up.
 *
 *   GET    /releases                         the Releases panel
 *   GET    /releases/:v/adoption             the Adoption panel
 *   GET    /releases/:v/canary               canary members + the §6 gate (?n=&m=&t=)
 *   PUT    /releases/:v/rollout              replace the canary set              toolchain.rollout.update
 *   GET    /releases/:v/default-preview      blast radius + §8 guards (?n=&m=&t=)
 *   POST   /releases/:v/default              set as platform default            toolchain.default.set
 *   PATCH  /releases/:v                      release notes                       toolchain.release.notes
 *   POST   /releases/:v/deprecate                                                toolchain.release.deprecate
 *   POST   /releases/:v/yank                 (yanking the default restores the previous one)  toolchain.release.yank (+ .default.restore)
 *   DELETE /releases/:v                                                          toolchain.release.delete
 *   GET    /history                          toolchain_default_history
 *   GET    /affected?release=                §9 Affected view
 *   POST   /affected/notify                  "Notify affected owners"            toolchain.recovery.notify
 *   GET    /cleanup                          Cleanup candidates
 */

import {
  audited, ErrorCode, requireStepUp, requireSystemOrgPermission, sendBadRequest, sendSuccess, TOOLCHAIN_RELEASE_VERSION_PATTERN, validateBody, validateQuery,
} from '@pipeline-builder/api-core';
import { withRoute, type RouteContext } from '@pipeline-builder/api-server';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import {
  deleteConsoleRelease, deprecateConsoleRelease, getAffected, getCanary, getCleanupCandidates, getDefaultHistory, getReleaseAdoption,
  listConsoleReleases, notifyAffected, previewDefault, promoteRelease, replaceRollout, setReleaseNotes, yankConsoleRelease,
  type CanaryThresholds,
} from '../services/toolchain-console-service.js';

export const CONSOLE_RELEASES_PATH = '/releases';

const releaseVersion = z.string().trim().regex(TOOLCHAIN_RELEASE_VERSION_PATTERN, 'releaseVersion must be a plain MAJOR.MINOR.PATCH release');

const ThresholdsSchema = z.object({
  n: z.coerce.number().int().min(1).max(100_000).optional(),
  m: z.coerce.number().int().min(1).max(10_000).optional(),
  t: z.coerce.number().min(0).max(100).optional(),
}).strict();

const RolloutBodySchema = z.object({
  orgIds: z.array(z.string().trim().min(1).max(255)).max(1000),
}).strict();

const DefaultBodySchema = z.object({
  expectedCurrentDefault: releaseVersion.nullable(),
  overrideReason: z.string().trim().min(1, 'overrideReason needs a reason').max(1000).optional(),
  canaryGate: ThresholdsSchema.optional(),
}).strict();

const NotesBodySchema = z.object({ releaseNotes: z.string().max(20_000) }).strict();
const DeprecateBodySchema = z.object({ message: z.string().trim().max(1000).optional() }).strict();
const YankBodySchema = z.object({ reason: z.string().trim().min(1, 'A yank needs a reason').max(1000) }).strict();
const AffectedQuerySchema = z.object({ release: releaseVersion }).strict();
const NotifyBodySchema = z.object({ releaseVersion }).strict();

/** The `:v` path parameter, or a 400 already sent. */
function versionParam({ req, res }: RouteContext): string | null {
  const parsed = releaseVersion.safeParse(req.params.v);
  if (parsed.success) return parsed.data;
  sendBadRequest(res, 'The release version must be a plain MAJOR.MINOR.PATCH release', ErrorCode.VALIDATION_ERROR);
  return null;
}

function thresholdsOf(rc: RouteContext): Partial<CanaryThresholds> | null {
  const q = validateQuery(rc.req, ThresholdsSchema);
  if (!q.ok) {
    sendBadRequest(rc.res, q.error, ErrorCode.VALIDATION_ERROR);
    return null;
  }
  return q.value;
}

/** Build the console router (mounted at `/plugins/toolchain`, behind the shared auth + org chain). */
export function createToolchainConsoleRoutes(): Router {
  const router = Router();
  const operate = requireSystemOrgPermission('toolchain:operate');
  const stepUp = requireStepUp as RequestHandler;
  const a = (action: string, ...more: string[]) => audited(action, ...more) as RequestHandler;
  const R = CONSOLE_RELEASES_PATH;

  // -- Reads (no step-up) ----------------------------------------------------
  router.get(R, ...operate, withRoute(async ({ res }) => {
    sendSuccess(res, 200, await listConsoleReleases());
  }));

  router.get(`${R}/:v/adoption`, ...operate, withRoute(async (rc) => {
    const v = versionParam(rc);
    if (v) sendSuccess(rc.res, 200, await getReleaseAdoption(v));
  }));

  router.get(`${R}/:v/canary`, ...operate, withRoute(async (rc) => {
    const v = versionParam(rc);
    if (!v) return;
    const t = thresholdsOf(rc);
    if (t) sendSuccess(rc.res, 200, await getCanary(v, t));
  }));

  router.get(`${R}/:v/default-preview`, ...operate, withRoute(async (rc) => {
    const v = versionParam(rc);
    if (!v) return;
    const t = thresholdsOf(rc);
    if (t) sendSuccess(rc.res, 200, await previewDefault(v, t));
  }));

  router.get('/history', ...operate, withRoute(async ({ res }) => {
    sendSuccess(res, 200, await getDefaultHistory());
  }));

  router.get('/affected', ...operate, withRoute(async ({ req, res }) => {
    const q = validateQuery(req, AffectedQuerySchema);
    if (!q.ok) return sendBadRequest(res, q.error, ErrorCode.VALIDATION_ERROR);
    return sendSuccess(res, 200, await getAffected(q.value.release));
  }));

  router.get('/cleanup', ...operate, withRoute(async ({ res }) => {
    sendSuccess(res, 200, await getCleanupCandidates());
  }));

  // -- Writes (step-up, audited) ---------------------------------------------
  router.put(`${R}/:v/rollout`, ...operate, stepUp, a('toolchain.rollout.update'), withRoute(async (rc) => {
    const v = versionParam(rc);
    if (!v) return;
    const body = validateBody(rc.req, RolloutBodySchema);
    if (!body.ok) return sendBadRequest(rc.res, body.error, ErrorCode.VALIDATION_ERROR);
    const out = await replaceRollout(v, body.value.orgIds, rc.userId);
    rc.ctx.log('COMPLETED', 'Toolchain canary updated', { releaseVersion: v, added: out.added.length, removed: out.removed.length, moved: out.moved.length });
    return sendSuccess(rc.res, 200, out);
  }));

  router.post(`${R}/:v/default`, ...operate, stepUp, a('toolchain.default.set'), withRoute(async (rc) => {
    const v = versionParam(rc);
    if (!v) return;
    const body = validateBody(rc.req, DefaultBodySchema);
    if (!body.ok) return sendBadRequest(rc.res, body.error, ErrorCode.VALIDATION_ERROR);
    const out = await promoteRelease(v, {
      expectedCurrentDefault: body.value.expectedCurrentDefault,
      ...(body.value.overrideReason ? { overrideReason: body.value.overrideReason } : {}),
      ...(body.value.canaryGate ? { canaryGate: body.value.canaryGate } : {}),
    }, rc.userId);
    rc.ctx.log('COMPLETED', 'Platform toolchain default set', { releaseVersion: v, changed: out.changed });
    return sendSuccess(rc.res, 200, { platformDefault: out.platformDefault });
  }));

  router.patch(`${R}/:v`, ...operate, stepUp, a('toolchain.release.notes'), withRoute(async (rc) => {
    const v = versionParam(rc);
    if (!v) return;
    const body = validateBody(rc.req, NotesBodySchema);
    if (!body.ok) return sendBadRequest(rc.res, body.error, ErrorCode.VALIDATION_ERROR);
    return sendSuccess(rc.res, 200, await setReleaseNotes(v, body.value.releaseNotes, rc.userId));
  }));

  router.post(`${R}/:v/deprecate`, ...operate, stepUp, a('toolchain.release.deprecate'), withRoute(async (rc) => {
    const v = versionParam(rc);
    if (!v) return;
    const body = validateBody(rc.req, DeprecateBodySchema.optional().transform((b) => b ?? {}));
    if (!body.ok) return sendBadRequest(rc.res, body.error, ErrorCode.VALIDATION_ERROR);
    await deprecateConsoleRelease(v, rc.userId, body.value.message ?? null);
    return sendSuccess(rc.res, 200, {});
  }));

  router.post(`${R}/:v/yank`, ...operate, stepUp, a('toolchain.release.yank', 'toolchain.default.restore'), withRoute(async (rc) => {
    const v = versionParam(rc);
    if (!v) return;
    const body = validateBody(rc.req, YankBodySchema);
    if (!body.ok) return sendBadRequest(rc.res, body.error, ErrorCode.VALIDATION_ERROR);
    return sendSuccess(rc.res, 200, await yankConsoleRelease(v, body.value.reason, rc.userId));
  }));

  router.delete(`${R}/:v`, ...operate, stepUp, a('toolchain.release.delete'), withRoute(async (rc) => {
    const v = versionParam(rc);
    if (!v) return;
    await deleteConsoleRelease(v, rc.userId);
    return sendSuccess(rc.res, 200, {});
  }));

  router.post('/affected/notify', ...operate, stepUp, a('toolchain.recovery.notify'), withRoute(async ({ req, res, userId }) => {
    const body = validateBody(req, NotifyBodySchema);
    if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
    return sendSuccess(res, 200, await notifyAffected(body.value.releaseVersion, userId));
  }));

  return router;
}
