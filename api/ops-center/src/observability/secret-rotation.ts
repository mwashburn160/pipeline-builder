// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ops-center's half of the `secret_rotation_previous_set` gauge
 * (docs/runbooks/secret-rotation.md): `ALERT_WEBHOOK_INSTANCE_TOKEN`, the
 * per-Alertmanager relay bearer, whose outgoing token rides in the instance
 * entry's `previousToken`. It moved here from platform with the relay; without
 * it a half-finished bearer rotation is invisible and the
 * SecretRotationPreviousLingering alert never fires for it.
 */

import { registerPreviousSecretProbe } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';

export function registerOpsSecretRotationProbes(): void {
  registerPreviousSecretProbe('ALERT_WEBHOOK_INSTANCE_TOKEN',
    () => config.alertWebhook.instances.some((instance) => !!instance.previousToken));
}
