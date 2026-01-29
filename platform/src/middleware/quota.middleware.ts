import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { sendError } from '../utils';
import logger from '../utils/logger';

/**
 * Quota configuration for different operations
 */
export interface QuotaConfig {
  limit: number | 'unlimited';
  windowMs: number;
}

/**
 * In-memory store for tracking request counts
 * Key format: `${organizationId}:${operation}`
 */
interface QuotaEntry {
  count: number;
  resetAt: number;
}

const quotaStore: Map<string, QuotaEntry> = new Map();

/**
 * Clean up expired entries periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of quotaStore.entries()) {
    if (entry.resetAt <= now) {
      quotaStore.delete(key);
    }
  }
}, 60000); // Clean up every minute

/**
 * Get quota configuration for an operation from config
 */
function getQuotaConfig(operation: string): QuotaConfig {
  const defaultWindowMs = config.quota.defaultWindowMs;

  switch (operation) {
    case 'create-pipeline':
      return {
        limit: config.quota.pipeline.create.limit,
        windowMs: config.quota.pipeline.create.windowMs,
      };
    case 'get-pipeline':
      return {
        limit: config.quota.pipeline.get.limit,
        windowMs: config.quota.pipeline.get.windowMs,
      };
    case 'list-pipelines':
      return {
        limit: config.quota.pipeline.list.limit,
        windowMs: config.quota.pipeline.list.windowMs,
      };
    case 'create-plugin':
      return {
        limit: config.quota.plugin.create.limit,
        windowMs: config.quota.plugin.create.windowMs,
      };
    case 'get-plugin':
      return {
        limit: config.quota.plugin.get.limit,
        windowMs: config.quota.plugin.get.windowMs,
      };
    case 'list-plugins':
      return {
        limit: config.quota.plugin.list.limit,
        windowMs: config.quota.plugin.list.windowMs,
      };
    default:
      return { limit: 10, windowMs: defaultWindowMs };
  }
}

/**
 * Check and update quota for an organization/operation
 */
function checkQuota(organizationId: string, operation: string): { allowed: boolean; remaining: number; resetAt: number } {
  const quotaConfig = getQuotaConfig(operation);

  // Unlimited quota - always allow
  if (quotaConfig.limit === 'unlimited') {
    return { allowed: true, remaining: -1, resetAt: 0 };
  }

  const key = `${organizationId}:${operation}`;
  const now = Date.now();
  const entry = quotaStore.get(key);

  // No existing entry or expired - create new
  if (!entry || entry.resetAt <= now) {
    const resetAt = now + quotaConfig.windowMs;
    quotaStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: quotaConfig.limit - 1, resetAt };
  }

  // Check if limit exceeded
  if (entry.count >= quotaConfig.limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  // Increment count
  entry.count++;
  quotaStore.set(key, entry);

  return { allowed: true, remaining: quotaConfig.limit - entry.count, resetAt: entry.resetAt };
}

/**
 * Quota middleware factory
 * Creates middleware for a specific operation
 * Rate limits are applied per organization
 * Exception: 'system' organization bypasses all quotas
 */
export function quota(operation: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Require authenticated user
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    // Require organization membership
    const organizationId = req.user.organizationId;
    if (!organizationId) {
      return sendError(res, 400, 'You must belong to an organization');
    }

    // Organization that bypasses all quotas (default: 'system')
    if (organizationId === config.quota.bypassOrgId) {
      logger.debug('[QUOTA] Bypass organization - skipping quota', {
        organizationId,
        userId: req.user.sub,
        operation,
      });
      return next();
    }

    const result = checkQuota(organizationId, operation);

    // Set rate limit headers
    const quotaConfig = getQuotaConfig(operation);
    if (quotaConfig.limit !== 'unlimited') {
      res.setHeader('X-RateLimit-Limit', quotaConfig.limit);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining));
      res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));
    }

    if (!result.allowed) {
      logger.warn('[QUOTA] Rate limit exceeded', {
        organizationId,
        userId: req.user.sub,
        operation,
        resetAt: new Date(result.resetAt).toISOString(),
      });

      res.setHeader('Retry-After', Math.ceil((result.resetAt - Date.now()) / 1000));
      return sendError(res, 429, 'Rate limit exceeded. Please try again later.', 'RATE_LIMIT_EXCEEDED');
    }

    logger.debug('[QUOTA] Request allowed', {
      organizationId,
      userId: req.user.sub,
      operation,
      remaining: result.remaining,
    });

    next();
  };
}

/**
 * Pre-configured quota middlewares for pipeline operations
 */
export const quotaCreatePipeline = quota('create-pipeline');
export const quotaGetPipeline = quota('get-pipeline');
export const quotaListPipelines = quota('list-pipelines');

/**
 * Pre-configured quota middlewares for plugin operations
 */
export const quotaCreatePlugin = quota('create-plugin');
export const quotaGetPlugin = quota('get-plugin');
export const quotaListPlugins = quota('list-plugins');

/**
 * Get current quota status for an organization
 */
export function getQuotaStatus(organizationId: string, operation: string): {
  limit: number | 'unlimited';
  used: number;
  remaining: number | 'unlimited';
  resetAt: number | null;
} {
  const quotaConfig = getQuotaConfig(operation);

  if (quotaConfig.limit === 'unlimited') {
    return { limit: 'unlimited', used: 0, remaining: 'unlimited', resetAt: null };
  }

  const key = `${organizationId}:${operation}`;
  const entry = quotaStore.get(key);
  const now = Date.now();

  if (!entry || entry.resetAt <= now) {
    return { limit: quotaConfig.limit, used: 0, remaining: quotaConfig.limit, resetAt: null };
  }

  return {
    limit: quotaConfig.limit,
    used: entry.count,
    remaining: quotaConfig.limit - entry.count,
    resetAt: entry.resetAt,
  };
}