// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AI_KEY_PROVIDER_IDS } from '@pipeline-builder/api-core';
import { ORG_AI_KEY_TOO_LONG } from './org-errors.js';
import { wrapEncrypted } from '../utils/secret-blob.js';
import { isReasonableString } from '../utils/string-guards.js';

/**
 * The providers an org can hold its own key for — the catalog's key-based ones
 * ({@link AI_KEY_PROVIDER_IDS}), never a hand-kept copy.
 *
 * A keyless provider (Amazon Bedrock authenticates with the deployment's IAM
 * role) is absent, so a key for one is not accepted, not stored, not reported
 * `configured` and not re-encrypted. This list used to include it: the settings
 * picker offered the slot, an admin cleared a step-up to paste a key, it was
 * encrypted and shown as configured — and no AI call could ever use it, because
 * both the internal read route and org-aware model selection refuse a keyless
 * provider.
 */
const AI_PROVIDERS = AI_KEY_PROVIDER_IDS;

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
 * The AI-provider field NAMES present in an update body (value !== undefined) —
 * i.e. the provider slots this update would set or clear. Mirrors the skip logic
 * in {@link applyAIProviderKeyUpdates}. Used for audit `details`: it records
 * WHICH provider keys changed and never any key value (the values are secrets).
 */
export function changedAiProviderFields(body: Record<string, unknown>): string[] {
  return AI_PROVIDERS.filter((p) => body[p] !== undefined);
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
export async function applyAIProviderKeyUpdates(
  keys: Record<string, string | undefined>,
  body: Record<string, unknown>,
  orgIdStr: string,
): Promise<void> {
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
      keys[p] = await wrapEncrypted(value, orgIdStr);
    }
  }
}
