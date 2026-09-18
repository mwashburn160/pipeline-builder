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
import { type OAuthProviderName } from '../types/oauth-provider.js';

/** Whether `name` is a configured (and therefore usable) social provider. */
export function isOAuthProviderEnabled(name: string): boolean {
  const providers = config.oauth as unknown as Record<string, { enabled?: boolean } | undefined>;
  return providers[name as OAuthProviderName]?.enabled === true;
}
