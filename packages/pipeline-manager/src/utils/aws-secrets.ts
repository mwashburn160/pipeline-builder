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
import { printInfo, printSuccess } from './output-utils';

/**
 * Options for Secrets Manager operations.
 */
export interface SecretsOptions {
  region?: string;
  profile?: string;
}

function createClient(options: SecretsOptions): SecretsManagerClient {
  return new SecretsManagerClient({
    region: options.region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION,
    ...(options.profile && {
      credentials: undefined, // profile is handled by AWS SDK credential chain
    }),
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
    const errMsg = error instanceof Error ? error.message : '';
    if (errMsg.includes('ResourceExistsException') || errMsg.includes('already exists')) {
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
