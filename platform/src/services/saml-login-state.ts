// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SP-initiated SAML sign-in's one-time `state` (sent to the IdP as
 * `RelayState`): minted by `beginSamlLogin` from the shared `/authorize` entry
 * point (controllers/sso.ts) and consumed by the Assertion Consumer Service
 * (controllers/saml.ts).
 */

import crypto from 'crypto';
import { buildSamlAuthorizeUrl } from './saml-service.js';
import { config } from '../config/index.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';
import { getEnforcedSamlConfig } from '../helpers/sso-enforcement.js';

/**
 * The one-time `state` of an in-flight SP-initiated sign-in, bound to the org
 * that minted it — the same shape and the same store the OIDC flow uses, so a
 * multi-replica deployment behaves identically on both protocols. It travels to
 * the IdP as `RelayState` and comes back on the assertion POST.
 */
const pendingSamlStates = createPendingStateStore<{ orgId: string; binding: string }>({
  prefix: 'saml:state:',
  ttlMs: config.oauth.samlRequestTtlMs,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.oauth.maxPendingStates,
});

/**
 * Begin an SP-initiated SAML sign-in: mint the one-time state, build the
 * AuthnRequest redirect, and return the same `{ url, state }` the OIDC initiate
 * returns — the client redirects to `url` either way and needs to know nothing
 * about the protocol.
 *
 * Called from `controllers/sso.ts` after it has resolved the org's protocol, so
 * the enforcement gates (enabled + `sso`-entitled) have already run; the config
 * resolver below re-applies them regardless.
 */
export async function beginSamlLogin(orgId: string, binding: string): Promise<{ url: string; state: string }> {
  const cfg = await getEnforcedSamlConfig(orgId);
  const state = crypto.randomBytes(32).toString('hex');
  const url = await buildSamlAuthorizeUrl(cfg, state);
  // The browser binding rides the state to the ACS (which can't see the Lax
  // cookie — it is a cross-site POST) and from there onto the handoff.
  await pendingSamlStates.put(state, { orgId, binding });
  return { url, state };
}

/** Consume the RelayState and confirm it was minted for THIS org. Consumed on
 *  ANY lookup — valid or not — so a state can never be probed or replayed, the
 *  same one-time contract the OIDC callback keeps. */
export async function consumeSamlRelayState(orgId: string, relayState: string | undefined): Promise<{ state: string; binding: string }> {
  if (!relayState) throw new Error('SAML_IDP_INITIATED');
  const pending = await pendingSamlStates.consume(relayState);
  if (!pending || pending.orgId !== orgId) throw new Error('SAML_INVALID_STATE');
  return { state: relayState, binding: pending.binding };
}
