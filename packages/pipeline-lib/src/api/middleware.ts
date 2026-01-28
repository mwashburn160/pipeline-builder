import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Config } from '../config/app-config';

/**
 * JWT authentication middleware
 *
 * Validates Bearer token from Authorization header against configured secret.
 *
 * @example
 * ```typescript
 * app.post('/api/resource', authenticateToken, async (req, res) => {
 *   // Protected route
 * });
 * ```
 */
export function authenticateToken(req: Request, res: Response, next: Function): void {
  const config = Config.get();
  const auth = req.headers.authorization;
  const token = auth && auth.split(' ')[1];

  if (!token) {
    res.status(401).json({ message: 'Authorization required.' });
    return;
  }

  try {
    jwt.verify(token, config.auth.jwt.secret, {
      algorithms: [config.auth.jwt.algorithm],
    });
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ message: 'Token has expired.' });
      return;
    }
    res.status(403).json({ message: 'Invalid token.' });
    return;
  }
}

/**
 * Creates a JWT authentication middleware with custom config
 *
 * @param secret - JWT secret key
 * @param algorithm - JWT algorithm (default: HS256)
 * @returns Express middleware function
 */
export function createAuthMiddleware(secret: string, algorithm: jwt.Algorithm = 'HS256') {
  return function(req: Request, res: Response, next: Function): void {
    const auth = req.headers.authorization;
    const token = auth && auth.split(' ')[1];

    if (!token) {
      res.status(401).json({ message: 'Authorization required.' });
      return;
    }

    try {
      jwt.verify(token, secret, { algorithms: [algorithm] });
      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        res.status(401).json({ message: 'Token has expired.' });
        return;
      }
      res.status(403).json({ message: 'Invalid token.' });
      return;
    }
  };
}
