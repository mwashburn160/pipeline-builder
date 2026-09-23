// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import path from 'path';

import {
  SYSTEM_ACTOR_ID,
  audited,
  isSystemAdmin,
  requirePermission,
  resolveVisibility,
  sendBadRequest,
  sendError,
  sendQuotaReserveDenied,
  sendSuccess,
  validateBody,
  errorMessage,
  ErrorCode,
  getServiceAuthHeader,
  PluginDeployGeneratedSchema,
  userHasPermission,
  actorId,
  proposable,
  recordAudit,
  withProposalProvenance,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { getIdempotencyStore, withRoute, withQuotaReservation, type QuotaSlot, type SSEManager } from '@pipeline-builder/api-server';
import { Config, CoreConstants } from '@pipeline-builder/pipeline-core';
import AdmZip from 'adm-zip';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { v7 as uuid } from 'uuid';

import { compliancePreflight, queuePluginBuild } from '../helpers/build-submission.js';
import { BUILD_TEMP_ROOT } from '../helpers/docker-build.js';
import { createBuildJobData } from '../helpers/plugin-helpers.js';
import { validateBuildArgs } from '../helpers/plugin-spec.js';
import { deletePluginArtifact, pluginArtifactKey, putPluginArtifact } from '../services/plugin-artifact-storage.js';
import { pluginService } from '../services/plugin-service.js';

/** Best-effort removal of a local scratch context that will never be built. */
function removeScratchDir(dir: string | undefined): void {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the stale-temp sweep reclaims it */ }
}

/**
 * Create and register the deploy-generated plugin route.
 *
 * Builds a Docker image from an AI-generated Dockerfile and persists
 * the plugin record to the database via the build queue.
 *
 * Requires `plugins:write` (auth + orgId come from the parent mount). Validated
 * with {@link PluginDeployGeneratedSchema}.
 */
export function createDeployGeneratedPluginRoutes( quotaService: QuotaService,
  sseManager: SSEManager,
): Router {
  const router: Router = Router();

  router.post( '/deploy-generated',
    // Permission check BEFORE quota — callers without plugins:write are rejected
    // without consuming quota. The quota reservation happens inside the handler
    // (atomic) so two concurrent deploys at the limit can't both succeed; on any
    // failure path the slot is given back (by the handler pre-enqueue, by the
    // worker after).
    requirePermission('plugins:write') as RequestHandler,
    audited('plugin.deploy'),
    proposable,
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const registry = Config.get('registry');
      // Service-minted auth for downstream calls (quota, tier, compliance). The
      // caller's admin bearer may carry only end-user scopes that won't pass
      // service-to-service authorization; mint a service token instead (matches
      // the upload-plugin path).
      const authHeader = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });

      const validation = validateBody(req, PluginDeployGeneratedSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const {
        name, description, version, pluginType, computeType, keywords,
        primaryOutputDirectory, installCommands, commands, env, buildArgs,
        dockerfile, visibility: rawAccess,
      } = validation.value;

      const visibility = resolveVisibility(req, rawAccess, 'plugins:publish', 'org');

      // Validate buildArgs (throws ValidationError → handled by withRoute)
      validateBuildArgs(buildArgs);

      // Refuse (typed 403/409 → withRoute) a deploy that would overwrite a
      // (name, version) the caller can't write or un-delete a tombstone — before
      // the idempotency claim, quota and the image build. The worker's
      // deployVersion re-checks under its lock with the same snapshot.
      const access = { isSystemAdmin: isSystemAdmin(req), canPublish: userHasPermission(req, 'plugins:publish') };
      await pluginService.assertDeployable(orgId, name, version, userId || SYSTEM_ACTOR_ID, access);

      // -- Idempotency guard (Redis IdempotencyStore) -----------------------
      // The auto-plugin-creation path sends `Idempotency-Key: <requestId>:<name>`
      // (generate-pipeline.ts) so a client retrying a failed SSE generate doesn't
      // enqueue duplicate buildkit builds + double the `plugins` quota. Claim the
      // key BEFORE reserving quota / enqueuing. This is a defense-in-depth
      // complement to the generic response-replay middleware: keyed on the HEADER
      // ALONE (not the body), it also suppresses a retry whose body drifted
      // slightly (a differing body would mint a fresh response-cache key and slip
      // past the middleware). Uses the process-wide store createApp wired to the
      // shared env Redis (SET…NX across replicas); falls back to the in-memory
      // store single-replica when Redis isn't configured.
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      const idemKey = idempotencyKey ? `plugin:deploy-generated:${orgId}:${idempotencyKey}` : undefined;
      const idemStore = getIdempotencyStore();
      const idemTtlMs = CoreConstants.IDEMPOTENCY_TTL_MS;
      let idemReserved = false;
      if (idemKey) {
        // Store THIS request's id in the reservation body at claim time. The
        // build streams its logs under the winning (original) request's id, so a
        // later duplicate must return that original id — not its own — or the
        // retried client would tail an empty stream (the build it "shares" is
        // keyed on the first requestId).
        const won = await idemStore.reserve(
          idemKey,
          { statusCode: 202, body: { requestId: ctx.requestId }, pending: true, expiresAt: Date.now() + idemTtlMs },
          Math.floor(idemTtlMs / 1000),
        );
        if (!won) {
          // The same key is already in-flight or was recently accepted — the
          // original reserved quota + queued the build, so suppress this duplicate.
          // Return the ORIGINAL request's id (persisted in the reservation body)
          // so the caller tails the real build stream; fall back to this
          // request's id if the record can't be read.
          const existing = await idemStore.get(idemKey).catch(() => null);
          const originalRequestId =
            (existing?.body as { requestId?: string } | null | undefined)?.requestId ?? ctx.requestId;
          ctx.log('INFO', 'Duplicate deploy-generated suppressed by Idempotency-Key', { orgId, pluginName: name, version });
          return sendSuccess(res, 202, {
            requestId: originalRequestId,
            pluginName: name,
            version,
            idempotent: true,
          }, 'Plugin build already queued');
        }
        idemReserved = true;
      }
      // Release the idempotency reservation on any pre-enqueue failure so a
      // legitimate retry can proceed (nothing durable happened). Only a
      // successfully-queued build KEEPS the key, deduping retries for its TTL.
      const releaseIdem = (): void => {
        if (!idemReserved || !idemKey) return;
        idemReserved = false;
        void idemStore.delete(idemKey).catch((err) =>
          ctx.log('WARN', 'Idempotency reservation release failed', { error: errorMessage(err) }));
      };

      // Reserve the plugins quota slot atomically. Worker decrements on
      // permanent failure; success keeps the reservation. An unreachable quota
      // service does NOT throw — it comes back as an `unavailable` reservation
      // (503 below).
      //
      // The shared guard owns the slot for the whole body: it refunds on an
      // unexpected throw, and `markConsumed()` after a successful enqueue hands
      // ownership to the build job (which refunds on permanent failure). The
      // outer try only guards a throw out of the guard itself, so it can never
      // strand the idempotency claim for its TTL (a false 202 + no build on retry).
      const logWarn = ctx.log.bind(null, 'WARN');
      let outcome;
      try {
        outcome = await withQuotaReservation(
          { quotaService, orgId, type: 'plugins', serviceName: 'plugin', logWarn },
          async (slot: QuotaSlot) => {
            // -- Compliance check (fail-closed) -----------------------------------
            // AI-generated plugins satisfy the same org compliance rules as uploaded
            // ones, with the same deferred image facts (evaluated post-build).
            const preflight = await compliancePreflight(orgId, authHeader, {
              attributes: {
                name,
                version,
                pluginType: pluginType || 'CodeBuildStep',
                computeType: computeType || 'MEDIUM',
                env: env || {},
                buildArgs: buildArgs || {},
                installCommands: installCommands || [],
                commands,
                visibility,
              },
              buildType: 'build_image',
              pluginType: pluginType || 'CodeBuildStep',
              keywords: keywords || [],
              action: 'deploy-generated',
            });
            if (preflight.status === 'blocked') {
              ctx.log('WARN', 'AI-generated plugin blocked by compliance', { pluginName: name, violations: preflight.violations.length });
              slot.refund();
              releaseIdem();
              return sendError(res, 403, 'Plugin deploy blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
                violations: preflight.violations,
              });
            }
            if (preflight.status === 'unavailable') {
              // Fail-closed: compliance unreachable → reject the deploy and release the slot.
              ctx.log('ERROR', 'Compliance service unavailable', { error: preflight.error });
              slot.refund();
              releaseIdem();
              return sendError(res, 503, 'Compliance service unavailable — plugin deploy rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
            }
            if (preflight.warnings > 0) {
              ctx.log('WARN', 'Compliance warnings on AI-generated plugin', { pluginName: name, warnings: preflight.warnings });
            }

            ctx.log('INFO', 'Deploying AI-generated plugin', {
              pluginName: name,
              version,
              visibility,
            });

            // Local scratch context (same-replica fast path) — created inside the try
            // below so a failure after it can clean it up.
            let tempDir: string | undefined;
            let s3Key: string | undefined;
            try {
              tempDir = path.join(BUILD_TEMP_ROOT, uuid());
              fs.mkdirSync(tempDir, { recursive: true });
              fs.writeFileSync(path.join(tempDir, 'Dockerfile'), dockerfile, 'utf-8');

              // -- Stage the build context in object storage ----------------------
              // The build worker runs on EVERY replica and BullMQ may hand this job to
              // a different one; `tempDir` is per-pod scratch, so a build elsewhere
              // would find no context. Stage the context as a ZIP first (exactly like
              // upload-plugin.ts) so any replica can re-materialize it; never queue a
              // build whose context can't be reconstructed.
              const stagedKey = pluginArtifactKey(orgId, ctx.requestId);
              const contextZip = new AdmZip();
              contextZip.addFile('Dockerfile', Buffer.from(dockerfile, 'utf-8'));
              try {
                await putPluginArtifact(stagedKey, contextZip.toBuffer());
              } catch (s3Err) {
                ctx.log('ERROR', 'Failed to stage build context in object storage', { error: errorMessage(s3Err) });
                slot.refund();
                releaseIdem();
                removeScratchDir(tempDir);
                return sendError(res, 503, 'Object storage unavailable — please retry', ErrorCode.SERVICE_UNAVAILABLE);
              }
              s3Key = stagedKey;

              // Queue build job (returns immediately)
              const jobData = createBuildJobData({
                requestId: ctx.requestId,
                orgId,
                userId: userId || SYSTEM_ACTOR_ID,
                access,
                // Period snapshot for the reserved slot so a DLQ retry spanning a
                // quota reset refunds the correct period (see releasePluginQuota).
                reservedResetAt: slot.reservation.quota.resetAt,
                buildRequest: {
                  contextDir: tempDir,
                  s3Key,
                  dockerfile: 'Dockerfile',
                  name,
                  version,
                  orgId,
                  registry,
                  buildArgs: buildArgs || {},
                  buildType: 'build_image',
                },
                pluginRecord: {
                  orgId,
                  name,
                  description: description || null,
                  version,
                  pluginType: pluginType || 'CodeBuildStep',
                  computeType: computeType || 'MEDIUM',
                  primaryOutputDirectory: primaryOutputDirectory || null,
                  dockerfile,
                  env: env || {},
                  buildArgs: buildArgs || {},
                  keywords: keywords || [],
                  installCommands: installCommands || [],
                  commands,
                  visibility,
                  buildType: 'build_image',
                  // The period this deploy's `plugins` slot was charged to (refunded on delete).
                  quotaResetAt: slot.reservation.quota.resetAt ?? null,
                },
              });

              await queuePluginBuild({ quotaService, sseManager, orgId, authHeader, jobName: `deploy-generated-${name}-${version}`, jobData, logWarn });
              // Queued: the build job owns the slot now (it refunds on permanent
              // failure), so a later throw in this handler must NOT refund it too.
              slot.markConsumed();

              ctx.log('INFO', 'Build queued', {
                pluginName: name,
                version,
              });

              // Best-effort attributed audit — the deploy action was accepted and the
              // build queued. No plugin id exists yet (the worker persists the record
              // on build completion, where plugin.build.completed carries the id), so
              // `targetId` is omitted here; name/version identify the plugin.
              recordAudit({
                action: 'plugin.deploy',
                actorId: actorId({ userId }),
                orgId,
                targetType: 'plugin',
                // The handler's details stay authoritative; `proposedBy: 'ask-agent'`
                // is added only when the request carried the provenance header — this
                // is the plugin the Ask panel's generate/confirm path deploys.
                details: withProposalProvenance(req.headers, {
                  pluginName: name,
                  version,
                  visibility,
                  buildType: 'build_image',
                }),
              });

              return sendSuccess(res, 202, {
                requestId: ctx.requestId,
                pluginName: name,
                version,
              }, 'Plugin build queued');
            } catch (err) {
              // Roll back the reserved slot if anything between reserve and the
              // successful queue.add throws (fs operations, queue down). Release the
              // idempotency key too so the client's retry isn't wrongly suppressed —
              // the build was never queued — and drop the staged context so it
              // doesn't orphan (best-effort; the bucket's expiry rule is the backstop).
              releaseIdem();
              await deletePluginArtifact(s3Key);
              removeScratchDir(tempDir);
              throw err;
            }
          },
        );
      } catch (err) {
        releaseIdem();
        throw err;
      }
      if (outcome.status === 'denied') {
        const { reservation } = outcome;
        ctx.log('WARN', reservation.unavailable ? 'Plugin quota unconfirmable (quota service unavailable)' : 'Plugin quota exceeded', { orgId, used: reservation.quota.used, limit: reservation.quota.limit });
        releaseIdem();
        // 503 + Retry-After when the quota service couldn't confirm; 429 when over limit.
        return sendQuotaReserveDenied(res, 'plugins', reservation);
      }
    }),
  );

  return router;
}
