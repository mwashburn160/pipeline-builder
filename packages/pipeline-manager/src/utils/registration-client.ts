// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '@pipeline-builder/api-core';
import { PIPELINE_REGISTRATION_CAPABILITY, PIPELINE_REGISTRATION_SECRET_ENV, PIPELINE_REGISTRATION_SECRET_LEAF } from '@pipeline-builder/pipeline-core';
import { ApiClient } from './api-client.js';
import { getSecretValue } from './aws-secrets.js';
import { printInfo, printWarning } from './output-utils.js';
import { secretNameForOrg } from './platform-secret.js';

/** The command that provisions the registration key, named in every skip warning. */
export const REGISTRATION_KEY_COMMAND = `pipeline-manager infra store-token --scope ${PIPELINE_REGISTRATION_CAPABILITY} --schedule`;

/**
 * The client a pipeline-registry write (`POST /pipelines/registry`) is made with.
 *
 * - **A person's credential** (`auth login`, or a `PLATFORM_TOKEN` they set):
 *   the same client. People hold `pipeline_registry:write` beside
 *   `pipelines:write` through the Member and Admin Roles.
 * - **The stored machine credential** (`--store-tokens`): NOT that client. The
 *   `platform` key holds the Pipeline Automation Role — pipeline and plugin reads
 *   only — so the registration goes out on the separate `pipeline-register` key,
 *   read from the secret named by `PIPELINE_REGISTRATION_SECRET_NAME` (the synth
 *   CodeBuild project carries it) or derived from the pipeline's org.
 *
 * There is no fallback to the platform key. When the registration key is absent
 * or unreadable this returns `undefined` after a loud warning naming the
 * `store-token` command that provisions it, and the caller skips registering —
 * a stale step manifest is reported, a broken synth is not acceptable.
 */
export async function resolveRegistrationClient(opts: {
  client: ApiClient;
  storeTokens?: boolean;
  orgId?: string;
  region?: string;
  profile?: string;
}): Promise<ApiClient | undefined> {
  if (!opts.storeTokens) return opts.client;

  const secretName = process.env[PIPELINE_REGISTRATION_SECRET_ENV]
    || (opts.orgId ? secretNameForOrg(opts.orgId, PIPELINE_REGISTRATION_SECRET_LEAF) : undefined);
  if (!secretName) {
    printWarning(`SKIPPING pipeline registration: no ${PIPELINE_REGISTRATION_SECRET_ENV} and no orgId to derive the registration key's secret from. `
      + `The stored platform key cannot register pipelines. Provision the registration key with: ${REGISTRATION_KEY_COMMAND}`);
    return undefined;
  }

  let key: string | undefined;
  try {
    const secret = JSON.parse(await getSecretValue(secretName, { region: opts.region, profile: opts.profile })) as { password?: string };
    key = secret.password;
  } catch (err) {
    printWarning(`SKIPPING pipeline registration: could not read the registration key from ${secretName} (${errorMessage(err)}). `
      + 'The stored platform key cannot register pipelines, so the platform\'s step manifest for this pipeline is now stale. '
      + `Provision the registration key with: ${REGISTRATION_KEY_COMMAND}`);
    return undefined;
  }
  if (!key) {
    printWarning(`SKIPPING pipeline registration: ${secretName} holds no key (password field). Re-provision it with: ${REGISTRATION_KEY_COMMAND}`);
    return undefined;
  }

  printInfo('Registering with the pipeline-registration key', { secret: secretName });
  const config = opts.client.getConfig();
  return new ApiClient({ ...config, auth: { ...config.auth, token: key } });
}
