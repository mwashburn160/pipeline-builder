// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS Marketplace customer keys and EventBridge events. Pure functions with no
 * AWS client, so the provider, the notification handlers and their tests all
 * share the real implementation.
 */

/**
 * A stored Marketplace customer key (`metadata.awsCustomerIdentifier`) is one of
 * two things. Products integrated before AWS's Concurrent Agreements change get a
 * `CustomerIdentifier` from ResolveCustomer. Every SaaS product created since
 * June 2026 gets NO CustomerIdentifier, and is identified by its `LicenseArn`
 * instead (one per agreement, so one buyer account can hold several). The key's
 * shape says which API fields it drives, so existing customers keep working
 * unchanged.
 *
 * A license ARN embeds AWS License Manager's account, not the buyer's, so
 * storing it does not store a buyer AWS account id.
 */
const LICENSE_ID_RE = /(?:^|[:/])(l-[0-9a-z]+)$/i;

/** True when the customer key is a license ARN rather than a legacy CustomerIdentifier. */
export function isLicenseKey(key: string): boolean {
  return key.includes('license-manager') && LICENSE_ID_RE.test(key);
}

/** The `l-…` license id at the end of a license ARN. The ARN's prefix is not
 *  written the same way everywhere (ResolveCustomer returns
 *  `arn:aws:license-manager::…:license:l-…`; AWS's EventBridge examples show
 *  `aws:license-manager:<region>:…:l-…`), so matching is on this id. */
export function licenseIdOf(key: string): string | undefined {
  return isLicenseKey(key) ? LICENSE_ID_RE.exec(key)?.[1] : undefined;
}

/**
 * An AWS Marketplace EventBridge event (`source: aws.agreement-marketplace`), as
 * delivered in an SNS Message by the platform's event-forwarding rule. Only the
 * fields billing reads are typed.
 */
export interface MarketplaceEvent {
  'source': string;
  'detail-type': string;
  'detail'?: {
    product?: { code?: string; id?: string };
    license?: { arn?: string };
    agreement?: { id?: string };
  };
}

/** True when an SNS Message body is an AWS Marketplace EventBridge event. */
export function isMarketplaceEvent(body: unknown): body is MarketplaceEvent {
  const b = body as Partial<MarketplaceEvent> | null;
  return !!b && b.source === 'aws.agreement-marketplace' && typeof b['detail-type'] === 'string';
}
