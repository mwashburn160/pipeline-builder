import net from 'net';
import { Request, Response } from 'express';
import rateLimit, { Options, RateLimitRequestHandler } from 'express-rate-limit';

/**
 * Standard rate limit response format
 */
interface RateLimitResponse {
  success: false;
  statusCode: 429;
  message: string;
  code: string;
  retryAfter?: number;
}

/**
 * Extract client IP from request, handling proxies
 */
function getClientIp(req: Request): string {
  let ip = req.ip || 'unknown';

  if (req.headers['x-forwarded-for']) {
    ip = (req.headers['x-forwarded-for'] as string).split(',')[0].trim();
  }

  // For IPv6, normalize to a /64 block for rate limiting
  if (ip && net.isIPv6(ip)) {
    // Simple IPv6 normalization - use first 4 groups
    const parts = ip.split(':').slice(0, 4);
    ip = parts.join(':') + '::';
  }

  return ip;
}

/**
 * Create a rate limiter with custom configuration
 */
function createRateLimiter(options: Partial<Options> & {
  windowMs: number;
  max: number;
  code?: string;
}): RateLimitRequestHandler {
  const { windowMs, max, code = 'RATE_LIMIT_EXCEEDED', ...rest } = options;

  return rateLimit({
    windowMs,
    max,
    keyGenerator: getClientIp,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      const response: RateLimitResponse = {
        success: false,
        statusCode: 429,
        message: 'Too many requests. Please try again later.',
        code,
        retryAfter: Math.ceil(windowMs / 1000),
      };
      res.status(429).json(response);
    },
    ...rest,
  });
}

/**
 * Authentication rate limiters
 * Strict limits to prevent brute force attacks
 */
export const authRateLimiters = {
  /**
   * Login endpoint - very strict
   * 5 attempts per 15 minutes per IP
   */
  login: createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    code: 'LOGIN_RATE_LIMIT_EXCEEDED',
    skipSuccessfulRequests: false,
  }),

  /**
   * Registration endpoint
   * 3 registrations per hour per IP
   */
  register: createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3,
    code: 'REGISTER_RATE_LIMIT_EXCEEDED',
  }),

  /**
   * Token refresh endpoint
   * 30 refreshes per hour per IP
   */
  refresh: createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 30,
    code: 'REFRESH_RATE_LIMIT_EXCEEDED',
  }),

  /**
   * Password change endpoint
   * 5 attempts per hour per IP
   */
  passwordChange: createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    code: 'PASSWORD_CHANGE_RATE_LIMIT_EXCEEDED',
  }),
};

/**
 * API rate limiters
 * More permissive limits for general API usage
 */
export const apiRateLimiters = {
  /**
   * Standard API endpoints
   * 100 requests per minute per IP
   */
  standard: createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 100,
    code: 'API_RATE_LIMIT_EXCEEDED',
  }),

  /**
   * Read-heavy endpoints (GET requests)
   * 200 requests per minute per IP
   */
  read: createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 200,
    code: 'READ_RATE_LIMIT_EXCEEDED',
  }),

  /**
   * Write endpoints (POST, PUT, DELETE)
   * 50 requests per minute per IP
   */
  write: createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 50,
    code: 'WRITE_RATE_LIMIT_EXCEEDED',
  }),

  /**
   * File upload endpoints
   * 10 uploads per hour per IP
   */
  upload: createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    code: 'UPLOAD_RATE_LIMIT_EXCEEDED',
  }),

  /**
   * Search endpoints
   * 60 searches per minute per IP
   */
  search: createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 60,
    code: 'SEARCH_RATE_LIMIT_EXCEEDED',
  }),
};

/**
 * Admin rate limiters
 * For administrative operations
 */
export const adminRateLimiters = {
  /**
   * User management endpoints
   * 30 requests per minute per IP
   */
  userManagement: createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 30,
    code: 'ADMIN_RATE_LIMIT_EXCEEDED',
  }),

  /**
   * Organization management endpoints
   * 20 requests per minute per IP
   */
  orgManagement: createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 20,
    code: 'ORG_ADMIN_RATE_LIMIT_EXCEEDED',
  }),

  /**
   * Invitation management
   * 10 invitations per hour per IP
   */
  invitations: createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    code: 'INVITATION_RATE_LIMIT_EXCEEDED',
  }),
};

/**
 * Sensitive operation rate limiters
 */
export const sensitiveRateLimiters = {
  /**
   * Account deletion
   * 1 attempt per hour per IP
   */
  accountDeletion: createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 1,
    code: 'ACCOUNT_DELETION_RATE_LIMIT_EXCEEDED',
  }),

  /**
   * Token generation
   * 10 per hour per IP
   */
  tokenGeneration: createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    code: 'TOKEN_GEN_RATE_LIMIT_EXCEEDED',
  }),
};

/**
 * Create a custom rate limiter with specific options
 */
export function customRateLimiter(
  windowMs: number,
  max: number,
  code: string = 'RATE_LIMIT_EXCEEDED',
): RateLimitRequestHandler {
  return createRateLimiter({ windowMs, max, code });
}

/**
 * Skip rate limiting for certain conditions
 * Useful for trusted IPs or development
 */
export function createSkippableRateLimiter(
  baseOptions: { windowMs: number; max: number; code?: string },
  skipCondition: (req: Request) => boolean,
): RateLimitRequestHandler {
  return createRateLimiter({
    ...baseOptions,
    skip: skipCondition,
  });
}
