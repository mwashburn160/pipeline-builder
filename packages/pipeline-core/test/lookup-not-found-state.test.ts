// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from '@jest/globals';
import { exactPinNotFoundMessage, LOOKUP_NOT_FOUND_STATES, lookupNotFoundState } from '../src/core/plugin-lookup-envelope.js';

describe('lookupNotFoundState', () => {
  it('reads every catalogued state off an axios error or a bare body', () => {
    for (const state of Object.keys(LOOKUP_NOT_FOUND_STATES)) {
      expect(lookupNotFoundState({ response: { data: { details: { state } } } })).toBe(state);
      expect(lookupNotFoundState({ details: { state } })).toBe(state);
    }
  });

  it('is null for absent, unknown and prototype-named states', () => {
    expect(lookupNotFoundState(undefined)).toBeNull();
    expect(lookupNotFoundState({ details: {} })).toBeNull();
    expect(lookupNotFoundState({ details: { state: 'live' } })).toBeNull();
    expect(lookupNotFoundState({ details: { state: 'constructor' } })).toBeNull();
    expect(lookupNotFoundState({ details: { state: 'toString' } })).toBeNull();
  });
});

describe('exactPinNotFoundMessage', () => {
  it('words each state, with a fallback for none', () => {
    expect(exactPinNotFoundMessage('trivy', '1.2.3', 'deleted')).toBe('Plugin "trivy" version 1.2.3 was deleted from your organization');
    expect(exactPinNotFoundMessage('trivy', '1.2.3', 'inactive')).toBe('Plugin "trivy" version 1.2.3 is inactive');
    expect(exactPinNotFoundMessage('trivy', '1.2.3', 'yanked')).toBe('Plugin "trivy" version 1.2.3 was yanked');
    expect(exactPinNotFoundMessage('trivy', '1.2.3', 'missing')).toBe('Plugin "trivy" version 1.2.3 does not exist');
    expect(exactPinNotFoundMessage('trivy', '1.2.3', null))
      .toBe('Plugin "trivy" version 1.2.3 does not exist (never published, or refused by its build\'s vulnerability scan)');
  });
});
