// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An org's resolved feature flags, read from platform (`PLATFORM_INTERNAL.orgFeatures`)
 * by a service that must decide on a feature OUTSIDE any request — where no
 * token's `features` claim is at hand (e.g. the pipeline service's runner
 * dispatcher and sweep). Callers cache the answer themselves.
 */

import { createSafeClient } from './http-client.js';
import { serviceIdentity } from './service-keys.js';
import { callInternal } from '../contracts/call.js';
import { PLATFORM_INTERNAL } from '../contracts/platform.js';
import { getServiceAuthHeader } from '../middleware/service-tokens.js';
import { serviceEndpoint } from '../utils/service-registry.js';

const FEATURES = PLATFORM_INTERNAL.orgFeatures;

let client: ReturnType<typeof createSafeClient> | undefined;
function platform(): ReturnType<typeof createSafeClient> {
  client ??= createSafeClient({ ...serviceEndpoint('platform'), timeout: 5_000 });
  return client;
}

/**
 * The org's feature flags. An unknown (or deleted) org holds none (`[]`);
 * anything else that is not a 200 — platform unreachable, an error — THROWS,
 * so a caller can tell "no feature" from "could not ask".
 */
export async function fetchOrgFeatures(orgId: string): Promise<string[]> {
  const result = await callInternal(platform(), FEATURES, {
    params: { orgId },
    // Scoped to the org asked about: platform binds the read to it.
    options: { headers: { Authorization: getServiceAuthHeader({ serviceName: serviceIdentity(), orgId, role: 'member' }) } },
  });
  if (result.ok && result.status === 200) return result.data.features;
  if (!result.ok && result.reason === 'status' && result.status === 404) return [];
  throw new Error(`org feature lookup failed (${result.ok ? `HTTP ${result.status}` : result.reason})`);
}
