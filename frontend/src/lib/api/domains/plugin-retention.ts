// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { ApiResponse } from '@/types';
import type { RetentionReport } from '@/types/plugin-retention';

/**
 * Superseded system plugin version retention (plugin service). System org
 * only: both routes need `plugins:moderate` on an aal2 session; the run also
 * needs a step-up token and is audited (`plugin.version.retire`).
 */
export function pluginRetentionApi(core: ApiCore) {
  return {
    /** The dry run: every system plugin's versions, what a pass would do and why. Changes nothing. */
    getRetentionPlan: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<RetentionReport>>('/api/plugins/retention/plan', { signal: opts?.signal }),

    /** Run one pass now, whether or not the scheduled pass is enabled; the same report with each action taken. */
    runRetentionPass: async (stepUpToken?: string) =>
      core.request<ApiResponse<RetentionReport>>('/api/plugins/retention/run', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: core.stepUpHeader(stepUpToken),
      }),
  };
}
