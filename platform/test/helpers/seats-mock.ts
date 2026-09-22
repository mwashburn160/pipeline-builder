// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `helpers/seats.js` mock whose `withSeatGuard` is the REAL composition of the
 * suite's own stubbed primitives — so a suite that drives `seatCapacityAvailable`
 * / `seatCapacityStillWithinCap` / `userHasSeatInAccount` still sees the guard
 * honour them (pre-check, write, post-check, already-seated skip).
 */

type AnyAsync = (...a: any[]) => Promise<any> | any;

export function seatsMock<T extends Record<string, unknown>>(fns: T): T & { withSeatGuard: AnyAsync } {
  const call = (name: string, ...a: unknown[]) => (fns[name] as AnyAsync)(...a);
  return {
    ...fns,
    withSeatGuard: async (
      opts: { userId?: unknown; orgId: string; session?: unknown; errorCode?: string; refuse?: () => Promise<Error> | Error; consumesSeat?: boolean },
      insert: () => Promise<unknown>,
    ) => {
      const refusal = async () => (opts.refuse ? opts.refuse() : new Error(opts.errorCode));
      const consumes = opts.consumesSeat !== false
        && !(opts.userId !== undefined && await call('userHasSeatInAccount', opts.userId, opts.orgId, opts.session ?? null));
      if (consumes && !(await call('seatCapacityAvailable', opts.orgId, 1, opts.session ?? null))) throw await refusal();
      const result = await insert();
      if (consumes && !(await call('seatCapacityStillWithinCap', opts.orgId, opts.session ?? null))) throw await refusal();
      return result;
    },
  };
}
