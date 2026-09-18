// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform's `secret_rotation_previous_set` probes — the secrets only platform
 * holds. api-core registers `SERVICE_SIGNING_KEY` for every service (its own
 * internal-token key); these three are platform-only:
 *
 *   - `TOKEN_SIGNING_KEY` — the ES256 user-token key. There is no `*_PREVIOUS`
 *     env value to read here: the overlap is a RETIRING `kid` still published in
 *     `/.well-known/jwks.json`, so the probe asks the signer whether one is
 *     loaded. Same meaning as every other probe — 1 while an old credential is
 *     still accepted fleet-wide.
 *   - `SECRET_ENCRYPTION_KEY` — the at-rest master key; the previous key stays
 *     accepted (decrypt-only) until `scripts/reencrypt-secrets.js` has rewritten
 *     every stored blob under the new one.
 *   - `ALERT_WEBHOOK_INSTANCE_TOKEN` — per-Alertmanager relay bearer; the
 *     outgoing token rides in the instance entry's `previousToken`.
 *
 * `REFRESH_TOKEN_SECRET` is gone: refresh tokens are user tokens now, signed
 * with (and rotated by) the same ES256 key as everything else.
 *
 * Registered at startup (index.ts) alongside the gauge. See
 * docs/runbooks/secret-rotation.md.
 */

import { isEnvSet, registerPreviousSecretProbe } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { isRetiringKeyPublished } from '../services/token-signing/index.js';

export function registerPlatformSecretRotationProbes(): void {
  registerPreviousSecretProbe('TOKEN_SIGNING_KEY', isRetiringKeyPublished);
  registerPreviousSecretProbe('SECRET_ENCRYPTION_KEY', () => isEnvSet('SECRET_ENCRYPTION_KEY_PREVIOUS'));
  registerPreviousSecretProbe( 'ALERT_WEBHOOK_INSTANCE_TOKEN',
    () => config.alertWebhook.instances.some((instance) => !!instance.previousToken),
  );
}
