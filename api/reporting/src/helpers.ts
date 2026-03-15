import { CoreConstants } from '@mwashburn160/pipeline-core';

/** Valid time intervals for time-series reports. */
export const VALID_INTERVALS = ['day', 'week', 'month'] as const;

/** Parse from/to query params with configurable default range. */
export function parseRange(query: Record<string, unknown>): { from: string; to: string } {
  const to = String(query.to || new Date().toISOString());
  const from = String(query.from || new Date(Date.now() - CoreConstants.DEFAULT_REPORT_RANGE_DAYS * 86400000).toISOString());
  return { from, to };
}
