// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Request, Response, Router } from 'express';
import { HealthCheckResponse } from '../types/common';
import { sendSuccess, sendError } from '../utils/response';

const startTime = Date.now();

/**
 * Options for health check endpoint.
 */
export interface HealthCheckOptions {
  /** Service name */
  serviceName: string;
  /** Service version (optional) */
  version?: string;
  /** Custom health check function for dependencies */
  checkDependencies?: () => Promise<Record<string, 'connected' | 'disconnected' | 'unknown'>>;
}

/**
 * Build a HealthCheckResponse + collect dependency status.
 * Shared between /health (liveness) and /ready (readiness).
 */
async function buildHealthResponse(options: HealthCheckOptions): Promise<{
  response: HealthCheckResponse;
  hasDisconnected: boolean;
  checkFailed: boolean;
}> {
  const { serviceName, version, checkDependencies } = options;
  const response: HealthCheckResponse = {
    status: 'healthy',
    service: serviceName,
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
  if (version) response.version = version;

  if (!checkDependencies) {
    return { response, hasDisconnected: false, checkFailed: false };
  }

  try {
    response.dependencies = await checkDependencies();
    const hasDisconnected = Object.values(response.dependencies).some(
      (status) => status === 'disconnected',
    );
    return { response, hasDisconnected, checkFailed: false };
  } catch {
    response.dependencies = { check: 'disconnected' };
    return { response, hasDisconnected: true, checkFailed: true };
  }
}

/**
 * Liveness handler — returns 200 as long as the process is alive enough to
 * respond. Dependency status is reported in the body as informational, but a
 * disconnected dependency does NOT fail the probe (use /ready for that).
 *
 * Use as the Kubernetes / ECS LIVENESS probe — it should only fail when the
 * process is genuinely stuck and needs to be restarted.
 */
export function createHealthCheck(options: HealthCheckOptions) {
  return async (_req: Request, res: Response): Promise<void> => {
    const { response } = await buildHealthResponse(options);
    sendSuccess(res, 200, response);
  };
}

/**
 * Readiness handler — returns 503 if any dependency is `disconnected` (or
 * the dependency check itself threw). Returns 200 only when the service is
 * fully ready to serve traffic.
 *
 * Use as the Kubernetes / ECS READINESS probe — when this fails, the
 * orchestrator stops routing traffic to this pod but does NOT restart it.
 */
export function createReadinessCheck(options: HealthCheckOptions) {
  return async (_req: Request, res: Response): Promise<void> => {
    const { response, hasDisconnected } = await buildHealthResponse(options);
    if (hasDisconnected) {
      response.status = 'unhealthy';
      sendError(res, 503, 'Service not ready', undefined, response);
      return;
    }
    sendSuccess(res, 200, response);
  };
}

/**
 * Create a health/readiness router exposing:
 * - GET /health — liveness (always 200 unless process is dead)
 * - GET /ready  — readiness (503 if dependencies are disconnected)
 *
 * @example
 * ```typescript
 * app.use(createHealthRouter({ serviceName: 'plugin' }));
 * ```
 */
export function createHealthRouter(options: HealthCheckOptions): Router {
  const router = Router();
  router.get('/health', createHealthCheck(options));
  router.get('/ready', createReadinessCheck(options));
  return router;
}
