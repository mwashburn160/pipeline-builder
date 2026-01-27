import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../index';
import User from '../models/user.model';
import { AccessTokenPayload, RefreshTokenPayload } from '../types/jwt.type';
import { sendError, sendUnauthorized } from '../utils/auth.utils';

export async function isAuthenticated(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return sendUnauthorized(res, 'Invalid header');
  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.auth.jwt.secret, {
      algorithms: [config.auth.jwt.algorithm],
    }) as AccessTokenPayload;
    const user = await User.findById(decoded.sub).select('+tokenVersion').lean();

    if (!user || decoded.tokenVersion !== user.tokenVersion) {
      return sendUnauthorized(res, 'Session invalid');
    }

    req.user = {
      sub: user._id.toString(),
      username: user.username,
      email: user.email,
      role: user.role,
      isAdmin: user.role === 'admin',
      isEmailVerified: user.isEmailVerified,
      organizationId: user.organizationId?.toString(),
      tokenVersion: user.tokenVersion,
    };

    next();
  } catch (err) {
    return sendUnauthorized(res, 'Token invalid');
  }
}

export const isOrgMember = (req: Request, res: Response, next: NextFunction) => {
  const orgId = req.params.orgId || req.body.organizationId;

  if (!req.user?.organizationId || req.user.organizationId !== orgId) {
    if (!req.user?.isAdmin) {
      return sendError(res, 403, 'You do not belong to this organization');
    }
  }
  next();
};

export async function isValidRefreshToken(req: Request, res: Response, next: NextFunction) {
  const { refreshToken } = req.body;
  if (!refreshToken) return sendUnauthorized(res, 'Token required');

  try {
    const decoded = jwt.verify(refreshToken, config.auth.refreshToken.secret, {
      algorithms: [config.auth.jwt.algorithm],
    });

    if (typeof decoded === 'string' || !decoded || !('sub' in decoded) || !('tokenVersion' in decoded)) {
      return sendUnauthorized(res, 'Token invalid');
    }

    const payload = decoded as RefreshTokenPayload;
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const user = await User.findById(payload.sub).select('+refreshToken +tokenVersion');

    if (!user || user.refreshToken !== hash || user.tokenVersion !== payload.tokenVersion) {
      return sendUnauthorized(res, 'Session invalid');
    }

    req.user = {
      sub: user._id.toString(),
      username: user.username,
      email: user.email,
      role: user.role,
      isAdmin: user.role === 'admin',
      isEmailVerified: user.isEmailVerified,
      organizationId: user.organizationId?.toString(),
      tokenVersion: user.tokenVersion,
    };

    next();
  } catch (err) {
    return sendUnauthorized(res, 'Token invalid');
  }
}

export const authorize = (...roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || !roles.includes(req.user.role)) return sendError(res, 403, 'Forbidden');
  next();
};