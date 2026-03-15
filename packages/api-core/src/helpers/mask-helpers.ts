import { createHash } from 'crypto';

/**
 * Mask the middle digits of a sensitive identifier.
 * Preserves the first and last `visible` characters, replacing the rest with asterisks.
 *
 * @param value - The string to mask
 * @param visible - Number of characters to keep visible on each side (default: 4)
 * @returns Masked string, or '****' if the input is too short
 *
 * @example maskId('123456789012') → '1234****9012'
 */
export function maskId(value: string, visible = 4): string {
  if (!value || value.length <= visible * 2) return '****';
  return value.slice(0, visible) + '*'.repeat(value.length - visible * 2) + value.slice(-visible);
}

/**
 * One-way hash of a sensitive identifier using SHA-256.
 * Returns a deterministic, fixed-length hex string that cannot be reversed.
 *
 * @param value - The sensitive value to hash (e.g. AWS account number)
 * @param length - Number of hex characters to return (default: 12, matching AWS account length)
 * @returns Truncated SHA-256 hex digest
 *
 * @example hashId('123456789012') → 'a1b2c3d4e5f6'
 */
export function hashId(value: string, length = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/**
 * Replace the AWS account number in an ARN with its SHA-256 hash.
 * Both the deploy registration and event ingestion sides call this function,
 * so registry lookups still match — the real account never reaches the database.
 *
 * ARN format: `arn:partition:service:region:account:resource`
 *
 * @example hashAccountInArn('arn:aws:codepipeline:us-east-1:123456789012:my-pipeline')
 *   → 'arn:aws:codepipeline:us-east-1:a1b2c3d4e5f6:my-pipeline'
 */
export function hashAccountInArn(arn: string): string {
  const parts = arn.split(':');
  if (parts.length < 5 || !parts[4]) return arn;
  parts[4] = hashId(parts[4]);
  return parts.join(':');
}

/**
 * @deprecated Use {@link hashAccountInArn} instead. Masking is lossy;
 * hashing is deterministic and enables lookups without storing the real account.
 */
export function maskAccountInArn(arn: string): string {
  return hashAccountInArn(arn);
}
