// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  UpdateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';
import { printInfo, printSuccess, printWarning } from './output-utils.js';

/**
 * Options for Secrets Manager operations.
 */
export interface SecretsOptions {
  region?: string;
  profile?: string;
}

function createClient(options: SecretsOptions): SecretsManagerClient {
  // Leave `credentials` unset so the SDK's standard provider chain resolves them:
  // environment variables (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
  // AWS_SESSION_TOKEN) take precedence when set, otherwise the shared
  // ~/.aws/config + ~/.aws/credentials files (honoring AWS_PROFILE). An explicit
  // --profile selects which shared profile to read — but only when env-var creds
  // and an inherited AWS_PROFILE aren't already present, so env vars always win
  // and we never clobber the caller's environment. Region resolves the same way
  // (flag → AWS_REGION / CDK_DEFAULT_REGION).
  if (options.profile && !process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = options.profile;
  } else if (options.profile && options.profile !== 'default') {
    // The flag was set to a non-default profile but ambient env creds win — surface
    // it so an explicit --profile that silently has no effect isn't a surprise.
    printWarning(
      `--profile ${options.profile} ignored: existing AWS credentials in the environment ` +
      `(${process.env.AWS_ACCESS_KEY_ID ? 'AWS_ACCESS_KEY_ID' : 'AWS_PROFILE'}) take precedence.`,
    );
  }
  return new SecretsManagerClient({
    region: options.region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1',
  });
}

/**
 * Create or update a secret in AWS Secrets Manager.
 * Tries create first; if it exists, updates the value and description.
 */
export async function upsertSecret(
  secretName: string,
  secretValue: string,
  description: string,
  options: SecretsOptions,
): Promise<void> {
  const client = createClient(options);

  try {
    await client.send(new CreateSecretCommand({
      Name: secretName,
      Description: description,
      SecretString: secretValue,
    }));
    printSuccess('Secret created in Secrets Manager');
  } catch (error) {
    // AWS SDK v3 carries the modeled exception type on `error.name`; `message` does
    // NOT reliably contain it, so a message-only check would mis-classify an
    // already-exists error as fatal and rethrow instead of updating. Prefer name.
    const err = error as { name?: string; message?: string };
    const errMsg = err?.message ?? '';
    if (err?.name === 'ResourceExistsException' || errMsg.includes('ResourceExistsException') || errMsg.includes('already exists')) {
      printInfo('Secret already exists, updating...');
      await client.send(new PutSecretValueCommand({
        SecretId: secretName,
        SecretString: secretValue,
      }));
      await client.send(new UpdateSecretCommand({
        SecretId: secretName,
        Description: description,
      }));
      printSuccess('Secret updated in Secrets Manager');
    } else {
      throw error;
    }
  }
}

/**
 * Get the ARN of a secret.
 */
export async function getSecretArn(
  secretName: string,
  options: SecretsOptions,
): Promise<string> {
  const client = createClient(options);
  const response = await client.send(new DescribeSecretCommand({
    SecretId: secretName,
  }));
  return response.ARN ?? '(unknown)';
}

/**
 * Get the value of a secret.
 */
export async function getSecretValue(
  secretName: string,
  options: SecretsOptions,
): Promise<string> {
  const client = createClient(options);
  const response = await client.send(new GetSecretValueCommand({
    SecretId: secretName,
  }));
  if (!response.SecretString) {
    throw new Error(`Secret "${secretName}" is empty`);
  }
  return response.SecretString;
}

/** Minimal secret summary returned by listSecrets. */
export interface SecretSummary {
  name: string;
  arn: string;
  description?: string;
  lastChangedDate?: Date;
}

/**
 * List secrets matching a name prefix. Pages internally up to `maxPages` (default 10).
 *
 * @param namePrefix - Filter by `Name` prefix (case-sensitive). Falls back to
 *                    listing all secrets when omitted (use sparingly).
 */
export async function listSecrets(
  namePrefix: string | undefined,
  options: SecretsOptions,
  maxPages = 10,
): Promise<SecretSummary[]> {
  const client = createClient(options);
  const out: SecretSummary[] = [];
  let nextToken: string | undefined;
  let page = 0;
  do {
    const response = await client.send(new ListSecretsCommand({
      MaxResults: 100,
      NextToken: nextToken,
      ...(namePrefix && {
        Filters: [{ Key: 'name', Values: [namePrefix] }],
      }),
    }));
    for (const s of response.SecretList ?? []) {
      if (!s.Name || !s.ARN) continue;
      out.push({
        name: s.Name,
        arn: s.ARN,
        description: s.Description,
        lastChangedDate: s.LastChangedDate,
      });
    }
    nextToken = response.NextToken;
    page++;
  } while (nextToken && page < maxPages);
  return out;
}
