// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { isMarketplaceEvent, licenseIdOf } from '../src/helpers/marketplace-license.js';

describe('marketplace license ids', () => {
  const ID = 'l-c650855e87734887b28b61decef25bef';

  it('reads the license id from both ARN forms AWS uses', () => {
    expect(licenseIdOf(`arn:aws:license-manager::111122223333:license:${ID}`)).toBe(ID);
    expect(licenseIdOf(`aws:license-manager:us-east-1:111122223333:${ID}`)).toBe(ID);
  });

  it('returns undefined for anything that is not a license-manager ARN', () => {
    expect(licenseIdOf('')).toBeUndefined();
    expect(licenseIdOf('cust-OPAQUE-xyz')).toBeUndefined();
    expect(licenseIdOf(ID)).toBeUndefined();
  });

  it('recognises only aws.agreement-marketplace events', () => {
    expect(isMarketplaceEvent({ 'source': 'aws.agreement-marketplace', 'detail-type': 'License Updated - Manufacturer' })).toBe(true);
    expect(isMarketplaceEvent({ 'source': 'aws.marketplacecatalog', 'detail-type': 'Offer Released' })).toBe(false);
    expect(isMarketplaceEvent({ 'detail-type': 'License Updated - Manufacturer' })).toBe(false);
    expect(isMarketplaceEvent(null)).toBe(false);
  });
});
