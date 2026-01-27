import { Response } from 'express';
import { IUser } from '../models/user.model';
import { AccessTokenPayload, RefreshTokenPayload } from '../types/jwt.type';

export const createAccessTokenPayload = (user: IUser): AccessTokenPayload => ({
  sub: user._id.toString(),
  organizationId: user.organizationId?.toString(),
  username: user.username,
  email: user.email,
  role: user.role,
  isAdmin: user.role === 'admin',
  tokenVersion: user.tokenVersion,
  isEmailVerified: user.isEmailVerified,
});

export function createRefreshTokenPayload(user: IUser): RefreshTokenPayload {
  return {
    sub: user._id.toString(),
    tokenVersion: user.tokenVersion,
  };
}

export const sendError = (res: Response, status: number, message: string, code?: string): void => {
  res.status(status).json({ success: false, message, ...(code && { code }) });
};

export const sendUnauthorized = (res: Response, message: string = 'Unauthorized', code?: string): void => {
  sendError(res, 401, message, code);
};