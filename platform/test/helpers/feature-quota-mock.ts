// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `middleware/quota.js` mock whose `withFeatureQuota` is the REAL composition of
 * the suite's own `reserveFeatureQuota` / `releaseFeatureQuota` stubs — so a
 * suite driving the reservation still sees the denial, rollback-on-throw and
 * rollback-on-`false` behaviour.
 */

type AnyFn = (...a: any[]) => any;

export function featureQuotaMock<T extends { reserveFeatureQuota: AnyFn; releaseFeatureQuota: AnyFn }>(fns: T) {
  return {
    ...fns,
    withFeatureQuota: async (res: unknown, orgId: string, quotaType: string, write: () => Promise<boolean | void>) => {
      const reservation = await fns.reserveFeatureQuota(orgId, quotaType);
      if (reservation?.exceeded) {
        // Resolved at call time so the suite's api-core mock is the one used.
        const { sendQuotaReserveDenied } = await import('@pipeline-builder/api-core');
        sendQuotaReserveDenied(res as never, quotaType as never, reservation);
        return;
      }
      const release = () => fns.releaseFeatureQuota(orgId, quotaType, () => undefined, reservation);
      let kept: boolean | void;
      try {
        kept = await write();
      } catch (err) {
        release();
        throw err;
      }
      if (kept === false) release();
    },
  };
}
