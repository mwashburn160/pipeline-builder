// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SAML sign-in → session-slot record Single Logout matches on (see
 * models/saml-session.ts). Written when a SAML sign-in opens a session
 * (controllers/saml.ts), read and cleared by the SLO endpoints
 * (controllers/saml-slo.ts).
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import type { SamlSessionRef } from './saml-service.js';
import { config } from '../config/index.js';
import { toOrgId } from '../helpers/org-id.js';
import SamlSession from '../models/saml-session.js';

const logger = createLogger('saml-sessions');

/** The `sid` claim of an access token this deployment just minted. */
function sessionIdOf(accessToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sid?: unknown };
    return typeof payload.sid === 'string' ? payload.sid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record the IdP's handle on a SAML sign-in against the session slot it opened.
 * Best-effort: a failure here costs only the ability to single-log-out that one
 * session, so it is logged, never allowed to fail the sign-in.
 */
export async function recordSamlSession(input: {
  userId: string;
  orgId: string;
  accessToken: string;
  issuer: string;
  session: SamlSessionRef;
}): Promise<void> {
  const sessionId = sessionIdOf(input.accessToken);
  if (!sessionId) return;
  try {
    await SamlSession.updateOne(
      { userId: input.userId, sessionId },
      {
        $set: {
          organizationId: toOrgId(input.orgId),
          issuer: input.issuer,
          nameID: input.session.nameID,
          nameIDFormat: input.session.nameIDFormat,
          sessionIndex: input.session.sessionIndex,
          expiresAt: new Date(Date.now() + config.auth.refreshToken.expiresIn * 1000),
        },
      },
      { upsert: true },
    );
  } catch (err) {
    logger.warn('Could not record the SAML session for single logout', {
      orgId: input.orgId, error: errorMessage(err),
    });
  }
}
