// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  createLogger,
  decrementQuota,
  errorMessage,
  getServiceAuthHeader,
  handleAIError,
  initSSEStream,
  requireFeature,
  requirePermission,
  reserveQuota,
  sendBadRequest,
  sendQuotaReserveDenied,
  sendSuccess,
  validateBody,
  AIGenerateBodySchema,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute, rateLimitByOrg } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router, type Request } from 'express';

import {
  AIEmptyOutputError, dockerfileViolations, getAvailableProviders, generatePluginConfig, streamPluginConfig,
} from '../services/ai-plugin-generation-service.js';
import { findSimilarPlugins } from '../services/similar-plugin-lookup.js';

const logger = createLogger('generate-plugin');

/** The caller's parent-org id (org→team hierarchy), carried in the JWT; absent for root orgs. */
function parentOrgIdOf(req: Request): string | undefined {
  return (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
}

/**
 * Create and register AI plugin generation routes.
 *
 * AI calls consume the org's `aiCalls` quota, bounding AI usage per-org so an
 * org can't spam the platform AI provider key beyond their tier. The quota slot
 * is reserved/rolled back with a service-minted auth header (the quota
 * `/increment` endpoint rejects non-service principals), NOT the caller's user
 * bearer — mirrors upload-plugin.ts / deploy-generated-plugin.ts.
 *
 * The `ai_generation` feature gate and the permission gate (`plugins:read` to
 * list providers, `plugins:write` to generate a draft) are attached to each
 * route here, not to the parent '/plugins' mount, so they can't leak onto
 * sibling `GET /plugins` reads. Auth + orgId is still applied at the mount in
 * app-routes.ts, which reads require anyway.
 *
 * Both generate routes first look up the closest existing catalog plugins
 * (`findSimilarPlugins`, fail-soft to `[]`), tell the model not to duplicate
 * them, and return them as `similarPlugins` (the `done` event's data on the
 * stream) so the UI can point the user at a plugin to reuse.
 *
 * @returns Express Router with AI generation endpoints
 */
export function createGeneratePluginRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  // -- GET /providers  list configured AI providers --------------------------
  router.get('/providers', requireFeature('ai_generation'), requirePermission('plugins:read'), withRoute(async ({ res }) => {
    const providers = getAvailableProviders();
    return sendSuccess(res, 200, { providers });
  }));

  // -- POST /generate  generate plugin config from natural language ----------
  router.post('/generate', requireFeature('ai_generation'), requirePermission('plugins:write'), rateLimitByOrg({ name: 'plugin-generate', max: 20, windowMs: 60_000, message: 'Too many plugin generation requests, please slow down.' }), withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, AIGenerateBodySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error);
    }
    const { prompt, provider, model, apiKey } = validation.value;
    // Service-minted auth for the quota reserve/decrement calls. The caller's
    // user bearer would be rejected by the quota `/increment` endpoint (non-service
    // principal → 403), so mint a service token instead (mirrors upload-plugin.ts).
    const authHeader = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });

    // Reserve the aiCalls slot atomically; refund it only if the provider was
    // never reached (see the catch).
    const reservation = await reserveQuota(quotaService, orgId, 'aiCalls', authHeader);
    if (reservation.exceeded) {
      return sendQuotaReserveDenied(res, 'aiCalls', reservation);
    }

    try {
      ctx.log('INFO', 'AI plugin generation requested', {
        promptLength: prompt.length,
        provider,
        model,
      });

      const similarPlugins = await findSimilarPlugins(prompt, orgId, parentOrgIdOf(req));
      const result = await generatePluginConfig({
        prompt: prompt.trim(),
        orgId,
        provider,
        model,
        ...(apiKey ? { apiKey }: {}),
        similarPlugins,
      });

      ctx.log('COMPLETED', 'AI plugin generation completed');

      // The catalog Dockerfile rules the draft breaks (empty when compliant):
      // returned, never accepted silently.
      return sendSuccess(res, 200, {
        config: result.config,
        dockerfile: result.dockerfile,
        dockerfileViolations: result.dockerfileViolations,
        similarPlugins,
      });
    } catch (error) {
      const message = errorMessage(error);
      logger.error('AI plugin generation failed', { requestId: ctx.requestId, error: message });
      // Keep-on-provider-contact (same rule as generate-pipeline.ts): an empty /
      // unparseable output AFTER the provider round-trip still incurred its
      // external cost, so the slot is KEPT. Only pre-provider failures (model
      // resolution, connectivity) refund.
      if (!(error instanceof AIEmptyOutputError)) {
        decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
      }
      return handleAIError(res, message, 'Failed to generate plugin configuration');
    }
  }));

  // -- POST /generate/stream  stream plugin config as SSE events -------------
  router.post('/generate/stream', requireFeature('ai_generation'), requirePermission('plugins:write'), rateLimitByOrg({ name: 'plugin-generate', max: 20, windowMs: 60_000, message: 'Too many plugin generation requests, please slow down.' }), withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, AIGenerateBodySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error);
    }
    const { prompt, provider, model, apiKey } = validation.value;
    // Service-minted auth for the quota reserve/decrement calls (see /generate above).
    const authHeader = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });

    const reservation = await reserveQuota(quotaService, orgId, 'aiCalls', authHeader);
    if (reservation.exceeded) {
      return sendQuotaReserveDenied(res, 'aiCalls', reservation);
    }
    let reserved = true;
    // True once the FIRST partial flows — proof the provider responded (and its
    // cost was incurred). A failure after this keeps the slot; a pre-provider
    // failure refunds it.
    let providerContacted = false;

    try {
      ctx.log('INFO', 'AI plugin streaming generation requested', {
        promptLength: prompt.length,
        provider,
        model,
      });

      const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);

      const similarPlugins = await findSimilarPlugins(prompt, orgId, parentOrgIdOf(req));
      const result = streamPluginConfig({
        prompt: prompt.trim(),
        orgId,
        provider,
        model,
        ...(apiKey ? { apiKey }: {}),
        similarPlugins,
      });

      for await (const partialObject of result.partialOutputStream) {
        providerContacted = true;
        if (sse.aborted()) break;
        try {
          res.write(`data: ${JSON.stringify({ type: 'partial', data: partialObject })}\n\n`);
        } catch (serializeError) {
          logger.warn('Failed to serialize partial object', { requestId: ctx.requestId, error: errorMessage(serializeError) });
        }
      }

      if (!sse.aborted()) {
        // Get final validated output
        const finalOutput = await result.output;
        if (finalOutput) {
          const { dockerfile, ...config } = finalOutput;
          res.write(`data: ${JSON.stringify({
            type: 'done',
            data: {
              config: {
                ...config,
                description: config.description ?? undefined,
                primaryOutputDirectory: config.primaryOutputDirectory ?? undefined,
                env: config.env ?? undefined,
              },
              dockerfile,
              dockerfileViolations: dockerfileViolations(dockerfile),
              similarPlugins,
            },
          })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        // Quota policy: a COMPLETED stream keeps the reserved `aiCalls` slot even
        // when `finalOutput` is empty/unparseable — the provider round-trip (and
        // its external $ cost) was already incurred. An ABORT (client
        // disconnect, below) refunds the slot. Mirrors generate-pipeline.ts.
      } else {
        decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
        reserved = false;
      }

      res.end();
    } catch (error) {
      const message = errorMessage(error);
      logger.error('AI plugin streaming generation failed', { requestId: ctx.requestId, error: message });
      // Keep-on-provider-contact: refund only when the provider was NEVER reached
      // (a mid-stream failure arrives after the round-trip's cost was incurred).
      if (reserved && !providerContacted) {
        decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
      }
      handleAIError(res, message, 'Failed to stream plugin configuration');
    }
  }));

  return router;
}
