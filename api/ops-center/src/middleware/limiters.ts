// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The rate-limit buckets ops-center serves (moved with the routes from
 * platform's middleware/limiters.ts).
 *
 *  - `alertWebhookLimiter` — the Alertmanager relay. Machine-to-machine and
 *    unauthenticated at middleware time (it checks a per-instance bearer inside
 *    the handler), so it gets one generous per-IP bucket sized for burst
 *    fan-out: a 429 is a failed notification to Alertmanager, which silently
 *    delays alerts to the next group_interval.
 *  - `generalLimiter` — the per-org general budget for the tenant surfaces.
 *  - `observabilityLimiter` — a tighter per-org budget for the
 *    Prometheus/Loki-backed reads, so one noisy tenant cannot saturate the
 *    shared upstream (every org's dashboards go blank).
 *
 * The two per-org buckets are keyed by the VERIFIED token's org (api-server
 * `rateLimitByOrg` reads `req.user`), so they run AFTER `requireAuth` on each
 * tenant route; an unauthenticated request (a machine webhook) falls back to
 * the client IP. Service principals skip them.
 */

import { rateLimitByOrg } from '@pipeline-builder/api-server';
import type { RequestHandler } from 'express';
import { config } from '../config/index.js';

export const alertWebhookLimiter: RequestHandler = rateLimitByOrg({
  name: 'alert-webhook',
  keyBy: 'ip',
  windowMs: config.rateLimit.alertWebhook.windowMs,
  max: config.rateLimit.alertWebhook.max,
  message: 'Alert webhook rate limit exceeded.',
});

export const generalLimiter: RequestHandler = rateLimitByOrg({
  name: 'general',
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: 'Too many requests. Please try again later.',
});

export const observabilityLimiter: RequestHandler = rateLimitByOrg({
  name: 'observability',
  windowMs: config.rateLimit.observability.windowMs,
  max: config.rateLimit.observability.max,
  message: 'Observability rate limit exceeded for your organization. Please slow down or batch your queries.',
});
