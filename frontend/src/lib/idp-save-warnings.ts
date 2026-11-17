// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { IdpSaveWarning } from '@/types';

/**
 * Toast each NON-BLOCKING note an IdP config save answered (`warnings`, which
 * rides only when there are any — e.g. `IDP_GOOGLE_NO_VERIFIED_DOMAIN`). Call
 * it after a SUCCESSFUL PUT/PATCH (own-org or sysadmin): the save went through,
 * the warning only explains a consequence. A toast rather than an inline alert,
 * because most save paths move on (next wizard step, modal closes) at once.
 */
export function showIdpSaveWarnings(
  response: { data?: { warnings?: IdpSaveWarning[] } } | null | undefined,
  toast: { warning: (message: string) => void },
): void {
  for (const w of response?.data?.warnings ?? []) toast.warning(w.message);
}
