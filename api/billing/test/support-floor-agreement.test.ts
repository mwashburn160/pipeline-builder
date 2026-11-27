// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The negotiated support-floor agreement as the admin subscription read shows
 * it: the agreed seats and monthly floor, the note, and when and by whom it was
 * set — dates as ISO strings, and nothing else off the subscription.
 */

import { describe, it, expect } from '@jest/globals';
import { supportFloorAgreementView } from '../src/helpers/support-floor-agreement.js';

describe('supportFloorAgreementView', () => {
  it('is null when no agreement is on file', () => {
    expect(supportFloorAgreementView({})).toBeNull();
    expect(supportFloorAgreementView({ supportFloorOverride: undefined })).toBeNull();
    expect(supportFloorAgreementView({ supportFloorOverride: null })).toBeNull();
  });

  it('carries seats, floor, when and who, and the note', () => {
    expect(supportFloorAgreementView({
      supportFloorOverride: { seats: 2500, floorCents: 800000, agreedAt: new Date('2026-11-27T00:00:00Z'), agreedBy: 'op-1', note: 'MSA 2026' },
    })).toEqual({ seats: 2500, floorCents: 800000, agreedAt: '2026-11-27T00:00:00.000Z', agreedBy: 'op-1', note: 'MSA 2026' });
  });

  it('omits an absent note and copies only the agreement fields', () => {
    const view = supportFloorAgreementView({
      supportFloorOverride: { seats: 10, floorCents: 0, agreedAt: new Date('2026-11-27T00:00:00Z'), agreedBy: 'op-1', extra: 'x' } as never,
    });
    expect(view).toEqual({ seats: 10, floorCents: 0, agreedAt: '2026-11-27T00:00:00.000Z', agreedBy: 'op-1' });
  });
});
