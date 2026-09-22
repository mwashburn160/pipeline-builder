// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rotation-window visibility for "previous" secrets.
 *
 * Every rotatable secret keeps a `*_PREVIOUS` value (or, for the registry
 * signing cert, a second cert in the trust bundle) that is accepted ONLY for
 * the overlap window of a rotation. Leaving it set indefinitely silently keeps
 * the old credential valid — the very thing the rotation was meant to end.
 *
 * Each service registers a probe per secret it owns; the metrics layer exports
 * them as the `secret_rotation_previous_set{secret}` gauge (1 while the previous
 * value is set) and the `SecretRotationPreviousLingering` alert fires when it
 * stays 1 past the overlap window. See docs/runbooks/secret-rotation.md.
 *
 * `SERVICE_SIGNING_KEY` is registered here because every service that loads
 * api-core signs its internal SERVICE tokens with its own key. Its
 * overlap is not an env value: while a rotation is open, the shared key bundle
 * publishes TWO public keys for this service, so the probe asks the key loader
 * whether the retiring one is still trusted. The ES256 user-token signing key is
 * platform's alone, so its probe is registered there.
 */

import { isRetiringServiceKeyPublished } from '../services/service-keys.js';

/** Gauge name exported by api-server and platform. */
export const SECRET_ROTATION_PREVIOUS_GAUGE = 'secret_rotation_previous_set';

/** True when an env var holds a non-empty value (an empty `KEY=` in .env is unset). */
export function isEnvSet(name: string): boolean {
  return (process.env[name] ?? '') !== '';
}

const probes = new Map<string, () => boolean>([
  ['SERVICE_SIGNING_KEY', isRetiringServiceKeyPublished],
]);

/**
 * Register (or replace) the probe for `secret` — the base name, e.g.
 * `SECRET_ENCRYPTION_KEY`, or `TOKEN_SIGNING_KEY` for a credential whose overlap
 * is not an env value at all (there, the probe asks the signer whether a
 * retiring key is still published). The probe is evaluated at every metrics
 * scrape, so it must be cheap and must not throw.
 */
export function registerPreviousSecretProbe(secret: string, isPreviousSet: () => boolean): void {
  probes.set(secret, isPreviousSet);
}

/** Current state of every registered probe; a throwing probe reports `false`. */
export function previousSecretStates(): Array<{ secret: string; previousSet: boolean }> {
  return [...probes.entries()].map(([secret, probe]) => {
    let previousSet = false;
    try { previousSet = probe() === true; } catch { /* a broken probe must not break /metrics */ }
    return { secret, previousSet };
  });
}
