// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounds of a `<input type="date">` day (`YYYY-MM-DD`) in the VIEWER's time
 * zone, as ISO instants — what an inclusive "From … To …" filter means to the
 * person who typed it. A malformed value passes through unchanged (the server
 * answers it with a 400 rather than this silently dropping the filter).
 */
function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 00:00:00.000 local on `day`. */
export function localDayStartIso(day: string): string {
  const d = parseDay(day);
  return d ? d.toISOString() : day;
}

/** 23:59:59.999 local on `day` — the last instant an inclusive "To" covers. */
export function localDayEndIso(day: string): string {
  const d = parseDay(day);
  if (!d) return day;
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}
