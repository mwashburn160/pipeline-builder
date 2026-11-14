// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A fixed instant OUTSIDE the weekly blob-GC push freeze (services/blob-gc-window.ts):
 * Wednesday 2026-11-18 12:00 UTC.
 *
 * Every suite that issues a registry token through the real `authorizeAndIssue` and
 * expects `push` in it pins the freeze clock here (`setBlobGcClockForTests(() =>
 * OUTSIDE_BLOB_GC_WINDOW_MS)` in a `beforeEach`). Without it the suite reads the wall
 * clock and fails every Sunday from ~03:04 to 03:40 UTC, when push is withheld.
 * test/blob-gc-window.test.ts proves this instant really is outside the freeze.
 */
export const OUTSIDE_BLOB_GC_WINDOW_MS = Date.parse('2026-11-18T12:00:00Z');
