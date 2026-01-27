import crypto from 'crypto';
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { config } from '../index';
import Organization from '../models/organization.model';
import User from '../models/user.model';
import { createAccessTokenPayload, createRefreshTokenPayload, sendError } from '../utils/auth.utils';
import logger from '../utils/logger.utils';

export async function register(req: Request, res: Response) {
  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      const { username, email, password, organizationName } = req.body;

      if (!username || !email || !password) {
        throw new Error('MISSING_FIELDS');
      }

      const existing = await User.exists({
        $or: [
          { email: email.toLowerCase() },
          { username: username.toLowerCase() },
        ],
      }).session(session);

      if (existing) throw new Error('DUPLICATE_CREDENTIALS');

      const user = new User({
        username,
        email,
        password,
        role: organizationName?.trim() ? 'admin' : 'user',
      });

      if (organizationName?.trim().length >= 2) {
        const [org] = await Organization.create([{
          name: organizationName.trim(),
          owner: user._id,
          members: [user._id],
        }], { session });

        user.organizationId = org._id as Types.ObjectId;
      }

      await user.save({ session });

      result = {
        sub: user._id.toString(),
        email: user.email,
        role: user.role,
        organizationId: user.organizationId?.toString(),
      };
    });

    return res.status(201).json({ success: true, user: result });
  } catch (err: any) {
    if (err.message === 'MISSING_FIELDS') return sendError(res, 400, 'Missing required fields');
    if (err.message === 'DUPLICATE_CREDENTIALS') return sendError(res, 409, 'Credentials already in use');

    logger.error('Registration Failed', err);
    return sendError(res, 500, 'Registration failed');
  } finally {
    await session.endSession();
  }
}

export async function login(req: Request, res: Response) {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return sendError(res, 400, 'Missing required fields');
    }

    const user = await User.findOne({
      $or: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }],
    }).select('+password +tokenVersion');

    if (!user || !(await user.comparePassword(password))) {
      return sendError(res, 401, 'Invalid credentials');
    }

    const accessToken = jwt.sign(createAccessTokenPayload(user), config.auth.jwt.secret, {
      algorithm: config.auth.jwt.algorithm,
      expiresIn: config.auth.jwt.expiresIn,
    });
    const refreshToken = jwt.sign(createRefreshTokenPayload(user), config.auth.refreshToken.secret, {
      algorithm: config.auth.jwt.algorithm,
      expiresIn: config.auth.refreshToken.expiresIn,
    });

    const hashedRefresh = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await User.updateOne({ _id: user._id }, { $set: { refreshToken: hashedRefresh } });

    res.json({ success: true, accessToken, refreshToken });
  } catch (err) {
    logger.error('Login Error', err);
    return sendError(res, 500, 'Login failed');
  }
}

export async function refresh(req: Request, res: Response) {
  try {
    if (!req.user) return sendError(res, 401, 'Unauthorized');

    const user = await User.findById(req.user.sub);
    if (!user) return sendError(res, 404, 'User not found');

    const accessToken = jwt.sign(
      createAccessTokenPayload(user),
      config.auth.jwt.secret,
      {
        algorithm: config.auth.jwt.algorithm,
        expiresIn: config.auth.jwt.expiresIn,
      },
    );

    const refreshToken = jwt.sign(
      createRefreshTokenPayload(user),
      config.auth.refreshToken.secret,
      {
        algorithm: config.auth.jwt.algorithm,
        expiresIn: config.auth.refreshToken.expiresIn,
      },
    );

    const hashedRefresh = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await User.updateOne({ _id: user._id }, { $set: { refreshToken: hashedRefresh } });

    res.json({ success: true, accessToken, refreshToken });
  } catch (err) {
    logger.error('Refresh Error', err);
    return sendError(res, 500, 'Renewal failed');
  }
}

export async function logout(req: Request, res: Response) {
  try {
    const userId = req.user?.sub;
    if (!userId) return sendError(res, 401, 'Unauthorized');

    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 }, $unset: { refreshToken: '' } });
    res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    return sendError(res, 500, 'Logout failed');
  }
}