// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS Marketplace customer keys and EventBridge events. Pure functions with no
 * AWS client, so the provider, the notification handlers and their tests all
 * share the real implementation.
 */

/**
 * A Marketplace customer is keyed on the `LicenseArn` of their agreement
 * (`metadata.awsLicenseArn`). A license ARN embeds AWS License Manager's
 * account, not the buyer's, so storing it does not store a buyer AWS account id.
 */
const LICENSE_ID_RE = /(?:^|[:/])(l-[0-9a-z]+)$/i;

/** The `l-…` license id at the end of a license ARN. The ARN's prefix is not
 *  written the same way everywhere (ResolveCustomer returns
 *  `arn:aws:license-manager::…:license:l-…`; AWS's EventBridge examples show
 *  `aws:license-manager:<region>:…:l-…`), so matching is on this id. It is also
 *  the short form logs carry. */
export function licenseIdOf(licenseArn: string): string | undefined {
  return licenseArn.includes('license-manager') ? LICENSE_ID_RE.exec(licenseArn)?.[1] : undefined;
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
