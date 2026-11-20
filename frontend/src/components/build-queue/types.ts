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
  /**
   * False once the build context has been deleted, which the terminal failure
   * path does. Such a build can never be retried — the re-enqueued job dies
   * immediately with "Build context missing" — so the row offers re-upload
   * instead of a button that only produces an error that reads like data loss.
   * Absent on the DLQ view, where replay sources differently.
   */
  contextAvailable?: boolean;
  /**
   * The tier queue holding the job. BullMQ ids are counted per queue, so the
   * same id can exist in several tiers; retry sends this (`?tier=`) to name the
   * exact job — a bare id that matches more than one answers 409.
   */
  tier?: string;
  /**
   * The job's queue name / kind when the listing carries it. A remediation
   * build is `plugin-remediation` (its id is also `remediation-<id>`).
   */
  name?: string;
  kind?: string;
}

export interface DlqJob extends FailedJob {
  version?: string;
  failureCategory?: string;
  lastError?: string;
  createdAt?: string;
}

