// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org-aware model selection: which provider, model and KEY serve an AI request made
 * on behalf of an organization.
 *
 * Precedence, per request:
 *   1. the caller's own bring-your-own key (`apiKey`) — billed to it;
 *   2. the ORGANIZATION's configured key for the provider (Settings → AI providers);
 *   3. the platform's env-configured key / IAM role.
 *
 * With no `provider` named, an org that configured its own provider(s) is served by
 * the first of them (catalog order) on its own key — the org's choice of provider IS
 * having configured one — and otherwise the platform default applies.
 *
 * Never a silent downgrade to the platform's key: when the org configured a key for
 * the provider and it cannot be loaded, the request FAILS (`AIConfigurationError`)
 * instead of quietly spending the platform's budget on a request the org meant to
 * pay for — and an org whose administrators switched AI off is refused outright
 * (`AIDisabledError`), so every caller of this function honours the switch.
 */

import {
  AI_PROVIDER_CATALOG,
  AIConfigurationError,
  ErrorCode,
  assertOrgAIEnabled,
  fetchOrgAIKey,
  type OrgAIAccess,
} from '@pipeline-builder/api-core';

import { createModelWithKey, isKeylessProvider, resolveModelSelection, type ModelSelection, type ResolvedModelSelection } from './provider-registry.js';

/** What a caller asked for, on behalf of an org. */
export interface OrgModelSelection extends ModelSelection {
  /** The AUTHENTICATED org the call is made for (never a model- or body-supplied id). */
  orgId: string;
}

/** Injected for tests; default to the platform-backed client in api-core. */
export interface OrgSelectionDeps {
  assertEnabled?: (orgId: string) => Promise<OrgAIAccess>;
  fetchKey?: (orgId: string, provider: string) => Promise<string>;
}

/**
 * Resolve the model for an org's AI request (see the module comment for precedence).
 *
 * @throws AIDisabledError (403) when the org switched AI off
 * @throws AIConfigurationError when the org's settings or key cannot be loaded, or
 *         a bring-your-own key names a keyless provider
 * @throws Error from {@link resolveModelSelection} when nothing is configured
 */
export async function resolveOrgModelSelection(
  selection: OrgModelSelection,
  deps: OrgSelectionDeps = {},
): Promise<ResolvedModelSelection> {
  const { orgId, provider, model, apiKey, fallbacks } = selection;
  const access = await (deps.assertEnabled ?? assertOrgAIEnabled)(orgId);

  // 1. Bring-your-own key: the caller pays. The registry already refuses
  //    fallbacks for it; nothing org-side applies.
  if (apiKey) return resolveModelSelection({ provider, model, apiKey });

  if (model && !provider) {
    throw new AIConfigurationError('A `model` was supplied without a `provider` — specify both, or neither.', 400, ErrorCode.VALIDATION_ERROR);
  }

  // 2. The org's own key — for the named provider, or (none named) the first
  //    provider the org configured, in catalog order.
  //    A keyless provider (Bedrock) has no org key to use — a value stored in its
  //    slot is ignored, and Bedrock is served on the platform's role as before.
  const orgProviders = Object.keys(AI_PROVIDER_CATALOG).filter((id) => access.providers.includes(id) && !isKeylessProvider(id));
  const orgProvider = provider ? (orgProviders.includes(provider) ? provider : undefined) : orgProviders[0];
  if (orgProvider) {
    // `orgProvider` came from the catalog's own keys, so it has a default model.
    const modelId = model ?? AI_PROVIDER_CATALOG[orgProvider]!.models[0]!.id;
    // Throws (no platform fallback) when the key cannot be loaded.
    const key = await (deps.fetchKey ?? fetchOrgAIKey)(orgId, orgProvider);
    return { model: createModelWithKey(orgProvider, modelId, key), provider: orgProvider, modelId, keySource: 'org' };
  }

  // 3. The platform's own key, with its configured fallbacks.
  return resolveModelSelection({ provider, model, fallbacks });
}
