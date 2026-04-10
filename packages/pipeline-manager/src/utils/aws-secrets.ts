// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  UpdateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
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
