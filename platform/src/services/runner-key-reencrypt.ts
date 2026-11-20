// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline half of a secret-encryption rotation: re-wrap the runner
 * signing keys the pipeline service holds in Postgres
 * (`PIPELINE_INTERNAL.reencryptRunnerSigningKeys`). Platform's own
 * `secret-reencrypt.ts` covers MongoDB only, so every rotation flow here —
 * the per-org KMS config PUT / DELETE and the `reencrypt-secrets` script after a
 * SECRET_ENCRYPTION_KEY rotation — calls this AFTER its own Mongo pass.
 *
 * Never swallowed: the result is an explicit ok / failure the caller reports
 * (HTTP response, audit details, script exit code). A row the pipeline service
 * could not re-wrap is a failure too, because that org's runners stop signing.
 * No key material crosses this call; failures carry org id, kid and a message.
 */

import {
  PIPELINE_INTERNAL,
  SYSTEM_ORG_ID,
  callInternal,
  createSafeClient,
  errorMessage,
  getServiceAuthHeader,
} from '@pipeline-builder/api-core';
import { config } from '../config/index.js';

const REENCRYPT = PIPELINE_INTERNAL.reencryptRunnerSigningKeys;

/** The job rewrites every non-retired key row, one transaction each. */
const REENCRYPT_TIMEOUT_MS = 120_000;

export interface RunnerKeyReencryptCounts {
  scanned: number;
  reencrypted: number;
  failures: Array<{ orgId: string; kid: string; error: string }>;
}

/** `ok: false` = the job did not run or some rows stayed unreadable; `error` says which. */
export type RunnerKeyReencryptResult =
  | { ok: true; counts: RunnerKeyReencryptCounts }
  | { ok: false; error: string; counts?: RunnerKeyReencryptCounts };

/**
 * Ask the pipeline service to re-encrypt its runner signing keys.
 *
 *  - no `orgId`: every org (after a SECRET_ENCRYPTION_KEY rotation);
 *  - `orgId` + `previousKmsConfig`: one org after its per-org KMS config changed
 *    (`null` = the rows were under the shared provider).
 */
export async function reencryptRunnerSigningKeys(
  input: { orgId?: string; previousKmsConfig?: { keyId: string; ciphertextBase64: string } | null } = {},
): Promise<RunnerKeyReencryptResult> {
  const body = input.orgId
    ? { orgId: input.orgId, previousKmsConfig: input.previousKmsConfig ?? null }
    : {};
  try {
    const client = createSafeClient({
      host: config.pipeline.serviceHost,
      port: config.pipeline.servicePort,
      timeout: REENCRYPT_TIMEOUT_MS,
    });
    const result = await callInternal(client, REENCRYPT, {
      body,
      options: { headers: { Authorization: getServiceAuthHeader({ serviceName: 'platform', orgId: SYSTEM_ORG_ID, role: 'owner' }) } },
    });
    if (!result.ok) {
      const why = result.reason === 'unreachable' ? 'pipeline service unreachable'
        : result.reason === 'status' ? `pipeline service responded HTTP ${result.status}`
          : `unreadable pipeline response (${result.error})`;
      return { ok: false, error: `Runner signing key re-encryption failed: ${why}` };
    }
    const counts = result.data;
    if (counts.failures.length > 0) {
      return {
        ok: false,
        counts,
        error: `Runner signing key re-encryption left ${counts.failures.length} key(s) unreadable: `
          + counts.failures.map((f) => `${f.orgId}/${f.kid}`).join(', '),
      };
    }
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, error: `Runner signing key re-encryption failed: ${errorMessage(err)}` };
  }
}
