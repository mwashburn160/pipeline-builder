// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ANONYMOUS half of plugin security notifications: confirming an org's
 * external address from the emailed link. Sends no identity (see
 * `../anonymous`). The authenticated settings routes live on the shared client
 * (`pluginsApi`).
 */
import { anonymousRequest } from '../anonymous';

/**
 * Confirm an external address for an org's plugin security notifications with
 * the single-use token from the confirmation email (24 hours). Called only from
 * an explicit button press — never on page load, so a mail scanner that opens
 * the link cannot confirm (or burn) it.
 */
export function confirmPluginSecurityEmail(token: string, opts: { signal?: AbortSignal } = {}): Promise<unknown> {
  return anonymousRequest<unknown>('/api/public/plugin-security-notifications/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    signal: opts.signal,
  });
}
