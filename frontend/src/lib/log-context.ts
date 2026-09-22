// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { LogEntry } from '@/types/logs';

/** The same line — Loki stamps nanoseconds, the API milliseconds, so time alone
 *  is not identity. */
function sameEntry(a: LogEntry, b: LogEntry): boolean {
  return a.time === b.time && a.line === b.line
    && JSON.stringify(a.labels) === JSON.stringify(b.labels);
}

/**
 * The context endpoint's `after` STARTS AT the anchor's millisecond (so lines
 * sharing it are not lost), which put the anchor on screen twice — once
 * highlighted, once again right under it. Drop that one copy from either side.
 */
export function withoutAnchor(anchor: LogEntry, before: LogEntry[], after: LogEntry[]) {
  const drop = (list: LogEntry[]) => {
    const i = list.findIndex((e) => sameEntry(e, anchor));
    return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
  };
  return { anchor, before: drop(before), after: drop(after) };
}
