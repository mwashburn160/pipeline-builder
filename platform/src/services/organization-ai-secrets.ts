// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { wrapEncrypted } from '../utils/secret-blob.js';
import { isReasonableString } from '../utils/string-guards.js';

/** An AI provider key value exceeded {@link AI_PROVIDER_KEY_MAX_LEN} characters. */
export const ORG_AI_KEY_TOO_LONG = 'ORG_AI_KEY_TOO_LONG';

/** Supported AI provider identifiers. */
const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'amazon-bedrock'] as const;

/** Max accepted length of an AI provider key before encryption — a defense-in-depth
 *  bound so an over-long value can't be wrapped/persisted. */
const AI_PROVIDER_KEY_MAX_LEN = 1024;

/** Build a `{ provider: { configured, hint? } }` map from a keys object.
 * All on-disk values are encrypted blobs, so every configured slot
 * reports the generic `***encrypted` hint — operators only need
 * "set / not set", not a ciphertext suffix. */
export function buildProvidersMap(keys: Record<string, string | undefined>): Record<string, { configured: boolean; hint?: string }> {
  const providers: Record<string, { configured: boolean; hint?: string }> = {};
  for (const p of AI_PROVIDERS) {
    const key = keys[p];
    providers[p] = key
      ? { configured: true, hint: '***encrypted' }
      : { configured: false };
  }
  return providers;
}

/**
 * Apply an AI-provider-key update onto `keys` in place. `null`/`''` clears a
 * key; an unset field is left untouched. String values are bounded then
 * encrypted (JSON-stringified `EncryptedBlob`). Throws {@link ORG_AI_KEY_TOO_LONG}
 * when a value exceeds {@link AI_PROVIDER_KEY_MAX_LEN}.
 *
 * `SECRET_ENCRYPTION_KEY` is a hard requirement at platform boot
 * (config/index.ts), so this path is encrypted-only — there is no clear-text
 * fallback.
 */
export function applyAIProviderKeyUpdates(
  keys: Record<string, string | undefined>,
  body: Record<string, unknown>,
  orgIdStr: string,
): void {
  for (const p of AI_PROVIDERS) {
    const value = body[p];
    if (value === undefined) continue;
    if (value === null || value === '') {
      keys[p] = undefined;
    } else if (typeof value === 'string') {
      // Bound the key length before encrypting/persisting — a real provider key
      // is well under this cap; an over-long value is rejected rather than
      // wrapped into an unbounded ciphertext blob on the org doc.
      if (!isReasonableString(value, AI_PROVIDER_KEY_MAX_LEN)) {
        throw new Error(ORG_AI_KEY_TOO_LONG);
      }
      keys[p] = wrapEncrypted(value, orgIdStr);
    }
  }
}
