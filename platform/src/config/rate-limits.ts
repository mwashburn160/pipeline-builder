// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The FIXED rate limits — every `createLimiter` bucket whose numbers are not
 * read from the environment. They are security floors (brute-force, enumeration
 * and abuse ceilings), so they are deliberately NOT tunable: an env override
 * would let a typo or a "temporary" change silently loosen protection. Changing
 * one is a reviewed code edit, and `test/rate-limits-table.test.ts` pins every
 * value so the test must change with it.
 *
 * The ONLY env-tunable buckets are the capacity-shaped ones, which a deployment
 * legitimately sizes to its traffic, and which live in `config/index.ts` /
 * `constants/scim.ts`:
 *  - `general` — `LIMITER_MAX` / `LIMITER_WINDOW_MS` (per-tier org budget);
 *  - `sign-in` and `register` — `AUTH_LIMITER_MAX` / `AUTH_LIMITER_WINDOW_MS`
 *    (per-IP, sized to the deployment's NAT/proxy topology);
 *  - `auth-discovery` — `AUTH_DISCOVERY_LIMITER_*`;
 *  - `account-security` — `ACCOUNT_SECURITY_LIMITER_*`;
 *  - `login-account` — `LOGIN_ACCOUNT_LIMITER_*` (kept in step with the durable
 *    Mongo password lockout, which shares those defaults);
 *  - `scim` — `SCIM_RATE_LIMIT_*` (sized to the identity provider's sync bursts).
 */

const MINUTE_MS = 60_000;

export const AUTH_RATE_LIMITS = {
  /** `/auth/step-up` per user: every re-auth method shares one budget; 5/min
   *  allows fat-fingers plus a retry while starving a session pivoter. */
  stepUp: { windowMs: MINUTE_MS, max: 5 },

  /** Access-key exchange per presented key: a service caches its JWT, so
   *  60/min is generous while still bounding one leaked key. */
  exchangeKey: { windowMs: MINUTE_MS, max: 60 },
  /** Access-key exchange per IP: stops key enumeration; well above the per-key
   *  limit because one service pod exchanges for many keys. */
  exchangeIp: { windowMs: MINUTE_MS, max: 300 },

  /** MFA second leg per challenge: one person retrying can't lock out a NAT;
   *  the per-account TOTP lockout is what bounds guessing. */
  mfaVerify: { windowMs: MINUTE_MS, max: 10 },

  /** Forgot-password per IP: the reset token is 256 bits, so this bounds spam
   *  and load, not guessing. */
  passwordResetIp: { windowMs: 15 * MINUTE_MS, max: 20 },
  /** Reset email per address: we can be made to mail a victim, so 3 per 15 min
   *  however many IPs ask. */
  passwordResetEmail: { windowMs: 15 * MINUTE_MS, max: 3 },

  /** Domain-based org discovery/join per user: bounds admin-queue spam and
   *  cheap enumeration probes. */
  domainJoin: { windowMs: MINUTE_MS, max: 15 },

  /** Device-flow start per IP: a human action, so 10/min is generous; a flood
   *  is just pending-state spam. */
  deviceStart: { windowMs: MINUTE_MS, max: 10 },
  /** Device-flow poll per device code: a conforming client at the 5 s interval
   *  spends 12/min. */
  devicePollCode: { windowMs: MINUTE_MS, max: 30 },
  /** Device-flow poll per IP: many developers behind one office NAT, each
   *  polling their own code; catches a client rotating codes. */
  devicePollIp: { windowMs: MINUTE_MS, max: 300 },
  /** Device-flow browser approval per user: bounds guessing the short
   *  `user_code` (15/min against 20^8, code lives 10 min). */
  deviceApproval: { windowMs: MINUTE_MS, max: 15 },

  /** Org domain verification per user: each call makes an outbound DNS TXT
   *  lookup, so tighter than the general limiter. */
  domainVerify: { windowMs: MINUTE_MS, max: 10 },
} as const;

export type AuthRateLimitName = keyof typeof AUTH_RATE_LIMITS;
