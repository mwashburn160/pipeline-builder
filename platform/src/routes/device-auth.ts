// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/auth/device/*` — the OAuth 2.0 device authorization grant (RFC 8628).
 *
 * Mounted AHEAD of `/auth` in `routes/mount.ts` so it never shares the strict
 * pre-auth `authLimiter` budget (20 requests / 15 min per IP): a conforming
 * client polls every 5 seconds for up to 10 minutes, which would exhaust that
 * bucket within the first two minutes. Each endpoint here carries the limiter
 * its own traffic shape needs instead — the same reasoning as the alert relay's
 * dedicated bucket.
 */

import { createHash } from 'crypto';
import { audited, requireStepUp } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  approveDeviceRequest,
  denyDeviceRequest,
  deviceToken,
  getDeviceRequest,
  startDeviceCode,
} from '../controllers/device-auth.js';
import { requireAuth } from '../middleware/index.js';
import { extractClientIp } from '../middleware/rate-limit-keys.js';
import { createLimiter, userOrIpKey } from '../middleware/rate-limiter.js';

const router: Router = Router();

/** Opening a flow is a human action ("I typed `auth login`") — a handful a
 *  minute per IP is generous, and a flood here is just pending-state spam. */
const deviceStartLimiter = createLimiter({
  name: 'device-start',
  windowMs: 60_000,
  max: 10,
  keyGenerator: extractClientIp,
  message: 'Too many device sign-in requests. Please wait a minute and try again.',
});

/**
 * Two limiters guard the poll, for the same reason the access-key exchange has
 * two: a legitimate client polls ONE device code (so a per-code bucket bounds
 * it), while an abusive one presents a different code each time (so only the
 * per-IP bucket sees it). The per-code bucket is keyed on the HASH so a live
 * device code never lands in the shared limiter store's key space.
 */
const devicePollCodeLimiter = createLimiter({
  name: 'device-poll-code',
  windowMs: 60_000,
  max: 30, // a conforming client at the 5s interval spends 12
  keyGenerator: (req) => (typeof req.body?.device_code === 'string' && req.body.device_code
    ? `d:${createHash('sha256').update(req.body.device_code).digest('hex')}`
    : extractClientIp(req)),
  message: 'Too many polls for this device code.',
});

const devicePollIpLimiter = createLimiter({
  name: 'device-poll-ip',
  windowMs: 60_000,
  max: 300, // many developers behind one office NAT, each polling their own code
  keyGenerator: extractClientIp,
  message: 'Too many device authorization polls. Please wait a minute and try again.',
});

/**
 * The browser side. This is what bounds guessing the short `user_code`: every
 * lookup and decision is authenticated, so the budget is per USER — 15 attempts
 * a minute against a 20^8 code space, with the code itself living 10 minutes.
 */
const deviceApprovalLimiter = createLimiter({
  name: 'device-approval',
  windowMs: 60_000,
  max: 15,
  keyGenerator: userOrIpKey,
  message: 'Too many attempts. Please wait a minute and try again.',
});

/** POST /auth/device/code - Start a device authorization (pre-auth; the caller
 *  has no identity yet, which is the point of the grant). */
router.post('/code', deviceStartLimiter, audited('device.authorize.start'), startDeviceCode);

/** POST /auth/device/token - The waiting device's poll. Pre-auth: the 256-bit
 *  device code IS the credential, exactly as the key is on /auth/token/exchange. */
router.post('/token', devicePollIpLimiter, devicePollCodeLimiter, audited('device.authorize.expire'), deviceToken);

/** GET /auth/device/authorize - What the signed-in user is being asked to approve. */
router.get('/authorize', requireAuth, deviceApprovalLimiter, getDeviceRequest);

/** POST /auth/device/approve - Grant the waiting device a session. Step-up
 *  gated: handing a shell a session deserves the same fresh proof as signing
 *  another device out, and it is what lets the CLI drop passwords entirely. */
router.post(
  '/approve',
  requireAuth,
  deviceApprovalLimiter,
  requireStepUp,
  audited('device.authorize.approve'),
  approveDeviceRequest,
);

/** POST /auth/device/deny - Refuse the waiting device. No step-up: refusing is
 *  the safe direction, and demanding proof to say "no" invites people to ignore
 *  a code they did not start. */
router.post('/deny', requireAuth, deviceApprovalLimiter, audited('device.authorize.deny'), denyDeviceRequest);

export default router;
