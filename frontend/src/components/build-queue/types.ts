// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** A failed build-queue job as returned by the queue status API. */
export interface FailedJob {
  id: string;
  pluginName?: string;
  version?: string;
  error?: string;
  attemptsMade?: number;
  maxAttempts?: number;
  failedAt?: string;
}

export interface DlqJob extends FailedJob {
  version?: string;
  failureCategory?: string;
  lastError?: string;
  createdAt?: string;
}

export type SortField = 'pluginName' | 'attemptsMade' | 'failedAt' | 'error';
export type SortDir = 'asc' | 'desc';
