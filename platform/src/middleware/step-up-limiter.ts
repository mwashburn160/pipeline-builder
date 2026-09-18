// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tight per-user limiter for the whole `/auth/step-up` surface — password,
 * provider re-auth AND passkey. ONE shared budget on purpose: every method
 * proves the same thing, so a brute-force allowance that reset per method would
 * simply be the loosest of them.
 *
 * The endpoints accept credentials from an already-authenticated session. The
 * global `authLimiter` (20 req / 15 min, IP-keyed) is too loose for brute-force
 * protection here — a session pivoter sharing an IP with legitimate users could
 * burn the budget. Per-user keying (requireAuth runs first) with a much tighter
 * window: 5 attempts / minute, allowing for fat-fingers + a retry on a transient
 * error. The StepUpModal surfaces the 429 message verbatim.
 *
 * Lives in its own module (rather than in `routes/auth.ts`) so the passkey
 * routes, which mount from a different file, share this exact instance.
 */

import type { RequestHandler } from 'express';
import { createLimiter, userOrIpKey } from './rate-limiter.js';

export const stepUpLimiter: RequestHandler = createLimiter({
  name: 'step-up',
  windowMs: 60_000,
  max: 5,
  keyGenerator: userOrIpKey,
  message: 'Too many step-up attempts. Please wait a minute and try again.',
});
