// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which social sign-in providers this deployment has credentials for.
 *
 * Deliberately tiny and dependency-free (it reads `config` and nothing else):
 * the step-up factor list has to answer "can this account still re-authenticate
 * with the provider it's linked to?" without importing the OAuth controller and
 * its whole provider/validation/model graph.
 */

import { config } from '../config/index.js';
import { isOAuthProviderName } from '../types/oauth-provider.js';

/** Whether `name` is a configured (and therefore usable) social provider. */
export function isOAuthProviderEnabled(name: string): boolean {
  // Narrowed from the provider catalog, where this used to launder `config.oauth`
  // through `as unknown as Record<string, { enabled?: boolean } | undefined>`.
  // That cast was needed only because `config.oauth` holds the six providers
  // ALONGSIDE unrelated keys (callbackBaseUrl, the SAML timings), so it cannot be
  // indexed by a bare string — and it cost the one thing this function exists to
  // decide: `enabled?: boolean` made a provider whose config had no `enabled`
  // field read as "not enabled" instead of failing to compile.
  return isOAuthProviderName(name) && config.oauth[name].enabled === true;
}
