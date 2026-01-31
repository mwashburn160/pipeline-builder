import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { Organization } from '../models';
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
 * Organization quota middleware factory
 * Checks organization-level quotas (plugins, pipelines, apiCalls) that reset periodically
 * Automatically resets usage when period expires
 */
export function organizationQuota(quotaType: 'plugins' | 'pipelines' | 'apiCalls') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Require authenticated user
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    // Require organization membership
    const organizationId = req.user.organizationId;
    if (!organizationId) {
      return sendError(res, 400, 'You must belong to an organization');
    }

    // System organization bypasses all quotas
    if (organizationId === config.quota.bypassOrgId || req.user.organizationName === 'system') {
      logger.debug('[ORG_QUOTA] Bypass organization - skipping quota', {
        organizationId,
        userId: req.user.sub,
        quotaType,
      });
      return next();
    }

    try {
      const org = await Organization.findById(organizationId);
      if (!org) {
        return sendError(res, 404, 'Organization not found');
      }

      // Reset quota if period has expired (auto-reset)
      await org.resetUsageIfExpired(quotaType);

      // Check quota
      const quotaStatus = org.checkQuota(quotaType);

      // Set quota headers
      res.setHeader('X-Quota-Limit', quotaStatus.limit);
      res.setHeader('X-Quota-Used', quotaStatus.used);
      res.setHeader('X-Quota-Remaining', quotaStatus.remaining);
      res.setHeader('X-Quota-Reset', quotaStatus.resetAt.toISOString());

      if (!quotaStatus.allowed) {
        const resetIn = Math.ceil((quotaStatus.resetAt.getTime() - Date.now()) / 1000);
        res.setHeader('Retry-After', resetIn);

        logger.warn('[ORG_QUOTA] Organization quota exceeded', {
          organizationId,
          userId: req.user.sub,
          quotaType,
          used: quotaStatus.used,
          limit: quotaStatus.limit,
          resetAt: quotaStatus.resetAt.toISOString(),
        });

        return sendError(
          res,
          429,
          `Organization ${quotaType} quota exceeded (${quotaStatus.used}/${quotaStatus.limit}). Resets at ${quotaStatus.resetAt.toISOString()}.`,
          'ORG_QUOTA_EXCEEDED',
        );
      }

      // Increment usage after successful check
      await org.incrementUsage(quotaType);

      logger.debug('[ORG_QUOTA] Request allowed', {
        organizationId,
        userId: req.user.sub,
        quotaType,
        used: quotaStatus.used + 1,
        limit: quotaStatus.limit,
        remaining: quotaStatus.remaining - 1,
      });

      next();
    } catch (err) {
      logger.error('[ORG_QUOTA] Error checking organization quota', { error: err });
      return sendError(res, 500, 'Error checking organization quota');
    }
  };
}

/**
 * Pre-configured quota middlewares for pipeline operations
 */
export const quotaCreatePipeline = quota('create-pipeline');
export const quotaGetPipeline = quota('get-pipeline');

/**
 * Pre-configured quota middlewares for plugin operations
 */
export const quotaCreatePlugin = quota('create-plugin');
export const quotaGetPlugin = quota('get-plugin');

/**
 * Pre-configured organization quota middlewares
 */
export const orgQuotaPlugins = organizationQuota('plugins');
export const orgQuotaPipelines = organizationQuota('pipelines');
export const orgQuotaApiCalls = organizationQuota('apiCalls');

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

/**
 * Get organization quota status
 */
export async function getOrganizationQuotaStatus(
  organizationId: string,
  quotaType: 'plugins' | 'pipelines' | 'apiCalls',
): Promise<{
  limit: number;
  used: number;
  remaining: number;
  resetAt: Date;
  allowed: boolean;
} | null> {
  try {
    const org = await Organization.findById(organizationId);
    if (!org) {
      return null;
    }

    // Reset if expired
    await org.resetUsageIfExpired(quotaType);

    const status = org.checkQuota(quotaType);
    return status;
  } catch {
    return null;
  }
}