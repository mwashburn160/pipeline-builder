// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CACHE_TTL_BILLING_PLANS_SECS, envBool, envInt } from '@pipeline-builder/api-core';
import { SUPPORT_LEVELS } from './support-levels.js';

/**
 * Billing tunables that used to be read inline where they were used. Exposed as
 * `config.tunables` by `../config.ts`.
 *
 * Kept in its own module, with no required variables, because `../config.ts`
 * throws without `MONGODB_URI` and is replaced by partial mocks in most suites;
 * the helpers that need only one of these import this module directly so a
 * suite's `config` mock does not silently turn them `undefined`.
 *
 * Every value is read through api-core's `envInt` / `envBool` so the docs-drift
 * guard (`packages/api-core/test/env-documented.test.ts`) sees it. Plain values
 * resolve once at import time; members declared as getters re-read the
 * environment on every access, exactly as their original call sites did.
 */
export interface BillingTunables {
  /** In-progress webhook dedupe lease (seconds); baked into the Mongo TTL index. */
  webhookInProgressTtlSeconds: number;
  /** TTL (seconds) of the cached plan catalog. */
  plansCacheTtlSeconds: number;
  /** Discount-code preview checks per org per minute. */
  discountProbeRatePerMin: number;
  /** Discount-code redemptions per org per minute. */
  discountRedeemRatePerMin: number;
  /** Whether purchasable add-on bundles are offered. Read per call. */
  readonly bundlesEnabled: boolean;
  /** Half-width (days) of the usage window shown to an org with no subscription period. Read per call. */
  readonly usageFallbackDays: number;
  /** Support seat floor (see helpers/support-floor.ts). Every member is read per call. */
  supportFloor: {
    readonly enabled: boolean;
    readonly perSeatCents: number;
    readonly freeSeats: number;
    readonly weightStandardPercent: number;
    readonly weightPriorityPercent: number;
    readonly weightPremiumPercent: number;
  };
}

export const tunables: BillingTunables = {
  // Long enough to outlast the slowest handler, short enough that a crashed
  // handler's event is retried promptly.
  webhookInProgressTtlSeconds: envInt('BILLING_WEBHOOK_INPROGRESS_TTL_SECONDS', 15 * 60, { min: 1 }),
  plansCacheTtlSeconds: envInt('CACHE_TTL_BILLING_PLANS_SECONDS', CACHE_TTL_BILLING_PLANS_SECS, { min: 1 }),
  discountProbeRatePerMin: envInt('BILLING_DISCOUNT_PROBE_RATE_LIMIT_PER_MIN', 10, { min: 1 }),
  discountRedeemRatePerMin: envInt('BILLING_DISCOUNT_REDEEM_RATE_LIMIT_PER_MIN', 5, { min: 1 }),
  get bundlesEnabled() {
    return envBool('BILLING_BUNDLES_ENABLED', true);
  },
  get usageFallbackDays() {
    return envInt('BILLING_USAGE_FALLBACK_DAYS', 30, { min: 1 });
  },
  supportFloor: {
    get enabled() {
      return envBool('BILLING_SUPPORT_FLOOR_ENABLED', true);
    },
    get perSeatCents() {
      return envInt('BILLING_SUPPORT_FLOOR_PER_SEAT_CENTS', 499, { min: 0 });
    },
    // Defaults to enterprise's own seat base — see helpers/support-floor.ts.
    get freeSeats() {
      return envInt('BILLING_SUPPORT_FLOOR_FREE_SEATS', 15, { min: 0 });
    },
    // Env names stay literal (api-core's env-documented scanner matches literal reader calls).
    get weightStandardPercent() {
      return envInt('BILLING_SUPPORT_FLOOR_WEIGHT_STANDARD', SUPPORT_LEVELS.support_standard.defaultFloorWeightPercent, { min: 0 });
    },
    get weightPriorityPercent() {
      return envInt('BILLING_SUPPORT_FLOOR_WEIGHT_PRIORITY', SUPPORT_LEVELS.support_priority.defaultFloorWeightPercent, { min: 0 });
    },
    get weightPremiumPercent() {
      return envInt('BILLING_SUPPORT_FLOOR_WEIGHT_PREMIUM', SUPPORT_LEVELS.support_premium.defaultFloorWeightPercent, { min: 0 });
    },
  },
};
