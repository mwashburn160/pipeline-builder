// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The account's MFA recovery codes — one set per person, whichever second
 * factor they hold (see `services/recovery-codes-service.ts`).
 *
 *   GET  /auth/recovery-codes   — how many are left (never a code)
 *   POST /auth/recovery-codes   — replace the set (step-up + interactive session)
 */

import { sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { withController } from '../helpers/controller-helper.js';
import {
  getRecoveryCodeStatus,
  regenerateRecoveryCodes as regenerate,
} from '../services/recovery-codes-service.js';
import { RECOVERY_CODES_ERROR_MAP } from '../services/totp-errors.js';


/** GET /auth/recovery-codes — remaining / total / when the set was minted. */
export const recoveryCodeStatus = withController('Recovery code status', async (req, res) => {
  const status = await getRecoveryCodeStatus(req.user!.sub);
  sendSuccess(res, 200, {
    recoveryCodes: {
      remaining: status.remaining,
      total: status.total,
      generatedAt: status.generatedAt ? status.generatedAt.toISOString() : null,
    },
  });
}, RECOVERY_CODES_ERROR_MAP);

/** POST /auth/recovery-codes — replace the set; the new codes are shown once. */
export const regenerateRecoveryCodes = withController('Regenerate recovery codes', async (req, res) => {
  const userId = req.user!.sub;
  const { recoveryCodes } = await regenerate(userId);
  audit(req, 'user.mfa.recovery_regenerate', {
    targetType: 'user',
    targetId: userId,
    details: { count: recoveryCodes.length },
  });
  sendSuccess(res, 201, { recoveryCodes });
}, RECOVERY_CODES_ERROR_MAP);
