import { Request } from 'express';

/**
 * Identity information extracted from request headers
 */
export interface RequestIdentity {
  /** Organization ID from x-org-id header */
  readonly orgId?: string;
  /** User ID from x-user-id header */
  readonly userId?: string;
  /** Request ID from x-request-id header */
  readonly requestId?: string;
}

/**
 * Extract a single header value from request
 * Handles both string and string[] header values
 * 
 * @param req - Express request object
 * @param name - Header name (case-insensitive)
 * @returns Header value or undefined
 */
export function getHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Extract identity information from request headers
 * 
 * Extracts common identity headers used for multi-tenant authentication:
 * - x-org-id: Organization identifier
 * - x-user-id: User identifier  
 * - x-request-id: Request trace identifier
 * 
 * @param req - Express request object
 * @returns Identity object with orgId, userId, and requestId
 * 
 * @example
 * ```typescript
 * app.post('/api/resource', authenticateToken, async (req, res) => {
 *   const identity = getIdentity(req);
 *   
 *   if (!identity.orgId) {
 *     return res.status(400).json({ error: 'x-org-id header required' });
 *   }
 *   
 *   // Use identity.orgId, identity.userId, etc.
 * });
 * ```
 */
export function getIdentity(req: Request): RequestIdentity {
  return {
    orgId: getHeader(req, 'x-org-id'),
    userId: getHeader(req, 'x-user-id'),
    requestId: getHeader(req, 'x-request-id'),
  };
}

/**
 * Validate that required identity fields are present
 * 
 * @param identity - Identity object to validate
 * @param required - Array of required field names
 * @returns Object with isValid boolean and missing fields array
 * 
 * @example
 * ```typescript
 * const identity = getIdentity(req);
 * const validation = validateIdentity(identity, ['orgId', 'userId']);
 * 
 * if (!validation.isValid) {
 *   return res.status(400).json({ 
 *     error: `Missing required headers: ${validation.missing.join(', ')}` 
 *   });
 * }
 * ```
 */
export function validateIdentity(
  identity: RequestIdentity, 
  required: (keyof RequestIdentity)[]
): { isValid: boolean; missing: string[] } {
  const missing: string[] = [];
  
  for (const field of required) {
    if (!identity[field]) {
      missing.push(`x-${field.replace(/([A-Z])/g, '-$1').toLowerCase()}`);
    }
  }
  
  return {
    isValid: missing.length === 0,
    missing,
  };
}
