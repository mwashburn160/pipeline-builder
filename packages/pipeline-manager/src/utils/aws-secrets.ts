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
import { applyAwsProfile, resolveAwsRegion } from './aws-env.js';
import { printInfo, printSuccess } from './output-utils.js';

/**
 * Options for Secrets Manager operations.
 */
export interface SecretsOptions {
  region?: string;
  profile?: string;
}

function createClient(options: SecretsOptions): SecretsManagerClient {
  // Leave `credentials` unset so the SDK's standard provider chain resolves them
  // (env vars win, else the shared profile). See applyAwsProfile for the exact
  // --profile precedence, and resolveAwsRegion for the region fallback.
  applyAwsProfile(options.profile);
  return new SecretsManagerClient({ region: resolveAwsRegion(options.region) });
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

/** Result of a paginated {@link listSecrets} sweep. */
export interface ListSecretsResult {
  secrets: SecretSummary[];
  /**
   * True when `maxPages` was hit while AWS still had a NextToken — i.e. the
   * result is INCOMPLETE. Callers (e.g. audit-tokens) must surface this rather
   * than silently under-reporting, since a truncated scan can miss an expiring
   * token past the cap.
   */
  truncated: boolean;
}

/**
 * List secrets matching a name prefix. Pages internally up to `maxPages` (default 20).
 *
 * @param namePrefix - Filter by `Name` prefix (case-sensitive). Falls back to
 *                    listing all secrets when omitted (use sparingly).
 * @returns the collected secrets plus a `truncated` flag signalling the cap was
 *          hit with more pages remaining.
 */
export async function listSecrets(
  namePrefix: string | undefined,
  options: SecretsOptions,
  maxPages = 20,
): Promise<ListSecretsResult> {
  const client = createClient(options);
  const out: SecretSummary[] = [];
  let nextToken: string | undefined;
  let page = 0;
  let truncated = false;
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
    // More pages exist but we've hit the cap — signal an incomplete sweep.
    if (nextToken && page >= maxPages) { truncated = true; break; }
  } while (nextToken);
  return { secrets: out, truncated };
}
