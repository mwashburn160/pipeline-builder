// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org half of every AI call: is AI switched on for this organization, which
 * providers has it configured its OWN key for, and — when the call is going to
 * use one — the decrypted key.
 *
 * Platform holds both facts (the org's `aiEnabled` switch and its encrypted
 * `aiProviderKeys`), so they are two INTERNAL reads on platform, gated by
 * `requireInternalService` to the four AI callers (ask, pipeline, plugin,
 * reporting) and by the mesh on the Istio targets:
 *
 *  - `GET /internal/ai/access/:orgId`         → `{ aiEnabled, providers: string[] }`
 *  - `GET /internal/ai/keys/:orgId/:provider` → `{ provider, apiKey }` (audited on platform)
 *
 * KEY MATERIAL HANDLING. A key fetched here is held in process memory for at most
 * {@link ORG_AI_KEY_TTL_MS} (so a rotated or cleared key stops being used within
 * that window, and platform's read audit is not one row per model call), is never
 * logged, never written to Redis or any shared cache, and never placed in an error
 * message. Callers hand it straight to a model factory.
 *
 * FAILURE IS NOT A FALLBACK. An unreachable platform makes {@link fetchOrgAIAccess}
 * throw an {@link AIConfigurationError} rather than answer "enabled, no org keys":
 * that answer would silently bill the platform's key for an org that configured its
 * own, and would run AI for an org whose administrators switched it off.
 */

import type { NextFunction, Request, Response } from 'express';
import { createSafeClient } from './http-client.js';
import { serviceIdentity } from './service-keys.js';
import { AIConfigurationError, AIDisabledError } from '../errors/app-errors.js';
import { getServiceAuthHeader } from '../middleware/service-tokens.js';
import { ErrorCode } from '../types/error-codes.js';
import { envInt } from '../utils/env.js';
import { sendError } from '../utils/response.js';
import { serviceEndpoint } from '../utils/service-registry.js';

/** Platform paths (exported for the platform route-coverage + mesh declarations). */
export const ORG_AI_ACCESS_PATH = '/internal/ai/access';
export const ORG_AI_KEYS_PATH = '/internal/ai/keys';

/** How long an org's switch + configured-provider list is reused (default 30s). */
export const ORG_AI_ACCESS_TTL_MS = envInt('ORG_AI_ACCESS_TTL_MS', 30_000, { min: 0 });
/** How long a decrypted org key is held in memory (default 60s; 0 disables caching). */
export const ORG_AI_KEY_TTL_MS = envInt('ORG_AI_KEY_TTL_MS', 60_000, { min: 0, max: 300_000 });

/** An org's AI posture, as platform reports it. */
export interface OrgAIAccess {
  /** False when the org's administrators switched AI features off. */
  aiEnabled: boolean;
  /** Provider ids the org has configured its OWN key for (catalog ids). */
  providers: string[];
}

interface Cached<T> { value: T; expiresAt: number }

const accessCache = new Map<string, Cached<OrgAIAccess>>();
const keyCache = new Map<string, Cached<string>>();

let client: ReturnType<typeof createSafeClient> | undefined;
function platform(): ReturnType<typeof createSafeClient> {
  client ??= createSafeClient({ ...serviceEndpoint('platform'), timeout: 5_000 });
  return client;
}

/** A service token scoped to the org being asked about — platform binds the read to it. */
function authFor(orgId: string): Record<string, string> {
  return { Authorization: getServiceAuthHeader({ serviceName: serviceIdentity(), orgId, role: 'member' }) };
}

/**
 * The org's AI switch and the providers it has its own key for. Cached
 * {@link ORG_AI_ACCESS_TTL_MS}. Throws {@link AIConfigurationError} (503) when platform
 * cannot answer — see the module comment for why that is not "enabled".
 */
export async function fetchOrgAIAccess(orgId: string): Promise<OrgAIAccess> {
  const hit = accessCache.get(orgId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const response = await platform().get<{ data?: Partial<OrgAIAccess> } & Partial<OrgAIAccess>>(
    `${ORG_AI_ACCESS_PATH}/${encodeURIComponent(orgId)}`, { headers: authFor(orgId) },
  );
  const body = response?.body;
  const data = body?.data ?? body;
  if (!response || response.statusCode !== 200 || typeof data?.aiEnabled !== 'boolean') {
    throw new AIConfigurationError('The organization\'s AI settings could not be read, so no AI request was made. Try again shortly.');
  }
  const value: OrgAIAccess = {
    aiEnabled: data.aiEnabled,
    providers: Array.isArray(data.providers) ? data.providers.filter((p): p is string => typeof p === 'string') : [],
  };
  if (ORG_AI_ACCESS_TTL_MS > 0) accessCache.set(orgId, { value, expiresAt: Date.now() + ORG_AI_ACCESS_TTL_MS });
  return value;
}

/**
 * The org's decrypted key for `provider`. Call ONLY after {@link fetchOrgAIAccess}
 * listed the provider. Throws {@link AIConfigurationError} when the key cannot be
 * loaded — the caller must then fail the request, never fall back to the platform key.
 */
export async function fetchOrgAIKey(orgId: string, provider: string): Promise<string> {
  const cacheKey = `${orgId}\u0000${provider}`;
  const hit = keyCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const response = await platform().get<{ data?: { apiKey?: unknown }; apiKey?: unknown }>(
    `${ORG_AI_KEYS_PATH}/${encodeURIComponent(orgId)}/${encodeURIComponent(provider)}`, { headers: authFor(orgId) },
  );
  const apiKey = response?.body?.data?.apiKey ?? response?.body?.apiKey;
  if (!response || response.statusCode !== 200 || typeof apiKey !== 'string' || apiKey.length === 0) {
    // Status only: the body is never echoed, and the key is never in a message.
    throw new AIConfigurationError(
      `The organization's ${provider} API key could not be loaded, so the request was not sent. `
      + 'It was NOT retried on the platform\'s key — re-save the key in Settings, or try again shortly.',
    );
  }
  if (ORG_AI_KEY_TTL_MS > 0) keyCache.set(cacheKey, { value: apiKey, expiresAt: Date.now() + ORG_AI_KEY_TTL_MS });
  return apiKey;
}

/** Throw {@link AIDisabledError} (403 `AI_DISABLED`) when the org switched AI off. */
export async function assertOrgAIEnabled(orgId: string): Promise<OrgAIAccess> {
  const access = await fetchOrgAIAccess(orgId);
  if (!access.aiEnabled) throw new AIDisabledError();
  return access;
}

/**
 * Route guard: refuse every AI entry point for an org whose administrators switched
 * AI off (403 `AI_DISABLED`), or whose settings platform cannot confirm (503). Mount
 * AFTER auth and BEFORE any quota reservation, so a disabled org is never charged.
 */
export async function requireOrgAIEnabled(req: Request, res: Response, next: NextFunction): Promise<void> {
  const orgId = req.user?.organizationId;
  if (!orgId) {
    sendError(res, 403, 'No organization associated with this request', ErrorCode.INSUFFICIENT_PERMISSIONS);
    return;
  }
  try {
    await assertOrgAIEnabled(String(orgId));
    next();
  } catch (err) {
    const e = err as AIDisabledError | AIConfigurationError;
    sendError(res, e.statusCode ?? 503, e.message, e.code);
  }
}

/** Drop the cached org AI posture + keys (tests; an org whose settings just changed). */
export function resetOrgAICache(orgId?: string): void {
  if (orgId === undefined) {
    accessCache.clear();
    keyCache.clear();
    return;
  }
  accessCache.delete(orgId);
  for (const k of keyCache.keys()) if (k.startsWith(`${orgId}\u0000`)) keyCache.delete(k);
}
