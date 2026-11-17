// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Thrown by a pending-state store's `put` in production when the shared Redis
 * store can't take the write (helpers/pending-state-store.ts). Dependency-free
 * so `controller-helper.ts` can answer it 503 without loading the store.
 */
export const PENDING_STATE_UNAVAILABLE = 'PENDING_STATE_UNAVAILABLE';
