// Shared magic numbers for the reports page, named for intent. Row caps limit
// the on-screen top-N (CSV export always includes the full dataset).

/** Top-N rows shown in per-pipeline / per-plugin tables (executions, durations, versions). */
export const MAX_TABLE_ROWS = 10;
/** Top-N rows shown in the stage/action failure and bottleneck lists. */
export const MAX_LIST_ROWS = 8;
/** Top-N recent build-failure cards. */
export const MAX_BUILD_FAILURE_ROWS = 6;
/** Top-N plugin-version rows. */
export const MAX_VERSION_ROWS = 15;

/** Change-failure rate (%) at or above which a DORA trend bucket is flagged "elevated". */
export const CFR_ELEVATED_PCT = 30;
/** Sparkline bar-height floors (% of track) so tiny/zero buckets stay visible. */
export const SPARKLINE_MIN_BAR_PCT = 6;
export const SPARKLINE_ZERO_BAR_PCT = 2;
