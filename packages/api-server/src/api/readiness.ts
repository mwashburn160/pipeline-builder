// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendError } from '@pipeline-builder/api-core';
import type { Request, RequestHandler, Response } from 'express';

/**
 * Service readiness state.
 *
 * Flipped by startServer's dependency supervisor: set false the instant we
 * start listening, true once the backing store(s) connect, and back to false
 * if they later drop. Read by the readiness-guard middleware (and tests).
 *
 * Module-level singleton: each service runs as its own process with exactly
 * one server, so a single flag is sufficient and avoids threading state
 * through createApp + startServer.
 *
 * Defaults to `true` so an app built with createApp but NOT started via
 * startServer — every route unit test, which drives the app directly with
 * supertest — is never blocked by the guard. startServer flips it to false
 * synchronously before it opens the port, so the production path is gated.
 */
let serviceReady = true;

/** True once dependencies have connected (and remain connected). */
export function isReady(): boolean {
  return serviceReady;
}

/** Set by the startup supervisor (and tests). */
export function setReady(ready: boolean): void {
  serviceReady = ready;
}

/**
 * Default infra endpoints that must stay reachable while NotReady, so
 * orchestrators can probe liveness/readiness, scrape metrics, warm pools,
 * serve docs, and relay SSE logs during startup or a dependency outage. This
 * matches what `createApp` mounts. A service whose own routes COLLIDE with one
 * of these prefixes (e.g. platform serves a tenant log API at `/logs`) must
 * pass a narrower list to `readinessGuard()` so its business routes stay gated.
 */
export const DEFAULT_READINESS_BYPASS = ['/health', '/ready', '/metrics', '/warmup', '/docs', '/logs'];

function isBypassed(path: string, bypass: readonly string[]): boolean {
  return bypass.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Readiness guard — while the service is NotReady (dependencies not yet
 * connected, or dropped), reject business requests with 503 + Retry-After
 * instead of letting them hit a disconnected datastore and 500.
 *
 * This is the portable, app-level readiness mechanism that works on every
 * deploy target — including Docker Compose (single replica, no orchestrator
 * traffic-draining) and Fargate (ECS exposes only one per-service health
 * signal, which is also a kill trigger). k8s readiness probes layer on top.
 *
 * @param bypassPaths Infra prefixes that always pass through even while
 *   NotReady. Defaults to {@link DEFAULT_READINESS_BYPASS}; pass a custom list
 *   when a business route would otherwise collide with a default prefix.
 */
export function readinessGuard(bypassPaths: readonly string[] = DEFAULT_READINESS_BYPASS): RequestHandler {
  return (req: Request, res: Response, next): void => {
    if (serviceReady || isBypassed(req.path, bypassPaths)) {
      next();
      return;
    }
    res.setHeader('Retry-After', '5');
    sendError(res, 503, 'Service not ready — dependencies are still connecting');
  };
}
