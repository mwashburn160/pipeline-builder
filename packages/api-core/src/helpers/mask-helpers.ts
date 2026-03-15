/**
 * Mask the middle digits of a sensitive identifier.
 * Preserves the first and last `visible` characters, replacing the rest with asterisks.
 *
 * @param value - The string to mask
 * @param visible - Number of characters to keep visible on each side (default: 4)
 * @returns Masked string, or '****' if the input is too short
 *
 * @example maskId('123456789012') → '1234****9012'
 * @example maskId('AKIAIOSFODNN7EXAMPLE', 4) → 'AKIA************MPLE'
 */
export function maskId(value: string, visible = 4): string {
  if (!value || value.length <= visible * 2) return '****';
  return value.slice(0, visible) + '*'.repeat(value.length - visible * 2) + value.slice(-visible);
}

/**
 * Mask the AWS account number within an ARN string.
 * ARN format: `arn:partition:service:region:account:resource`
 *
 * @example maskAccountInArn('arn:aws:codepipeline:us-east-1:123456789012:my-pipeline')
 *   → 'arn:aws:codepipeline:us-east-1:1234****9012:my-pipeline'
 */
export function maskAccountInArn(arn: string): string {
  const parts = arn.split(':');
  if (parts.length < 5) return arn;
  parts[4] = maskId(parts[4]);
  return parts.join(':');
}
