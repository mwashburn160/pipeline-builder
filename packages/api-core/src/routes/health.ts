/**
 * @module routes/health
 * @description Health check endpoint for API microservices.
 */

import { Request, Response, Router } from 'express';
import { HealthCheckResponse } from '../types/common';

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
 * Create a health check request handler.
 *
 * @param options - Health check options
 * @returns Express request handler
 *
 * @example
 * ```typescript
 * app.get('/health', createHealthCheck({
 *   serviceName: 'get-plugin',
 *   version: '1.0.0',
 *   checkDependencies: async () => ({
 *     database: dbConnection.isConnected() ? 'connected' : 'disconnected',
 *   }),
 * }));
 * ```
 */
export function createHealthCheck(options: HealthCheckOptions) {
  return async (_req: Request, res: Response): Promise<void> => {
    const { serviceName, version, checkDependencies } = options;

    const response: HealthCheckResponse = {
      status: 'healthy',
      service: serviceName,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };

    if (version) {
      response.version = version;
    }

    if (checkDependencies) {
      try {
        response.dependencies = await checkDependencies();

        // Mark as unhealthy if any dependency is disconnected
        const hasDisconnected = Object.values(response.dependencies).some(
          (status) => status === 'disconnected',
        );

        if (hasDisconnected) {
          response.status = 'unhealthy';
          res.status(503).json(response);
          return;
        }
      } catch (error) {
        response.status = 'unhealthy';
        response.dependencies = { check: 'disconnected' };
        res.status(503).json(response);
        return;
      }
    }

    res.status(200).json(response);
  };
}

/**
 * Create a health check router with /health endpoint.
 *
 * @param options - Health check options
 * @returns Express router with health endpoint
 *
 * @example
 * ```typescript
 * const healthRouter = createHealthRouter({
 *   serviceName: 'get-plugin',
 * });
 *
 * app.use(healthRouter);
 * // Endpoint available at GET /health
 * ```
 */
export function createHealthRouter(options: HealthCheckOptions): Router {
  const router = Router();
  router.get('/health', createHealthCheck(options));
  return router;
}
