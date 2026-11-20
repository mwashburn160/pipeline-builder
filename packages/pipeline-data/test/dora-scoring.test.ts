// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DORA bands need a minimum sample. One deploy in a window is not "elite", and one
 * slow recovery is not "low": below MIN_DORA_SAMPLE the band is `insufficient`,
 * and with no sample at all it stays `null`.
 */

import { describe, it, expect } from '@jest/globals';
import { MIN_DORA_SAMPLE } from '@pipeline-builder/api-core';
import {
  doraLevelForFrequency, doraLevelForChangeFailure, doraLevelForRestore, doraLevelForLeadTime,
} from '../src/api/reporting/dora-scoring.js';

describe('DORA minimum sample', () => {
  it('is five', () => {
    expect(MIN_DORA_SAMPLE).toBe(5);
  });

  it('deployment frequency: one deploy is insufficient, not elite or low', () => {
    expect(doraLevelForFrequency(1, 1)).toBe('insufficient');
    expect(doraLevelForFrequency(0.01, 1)).toBe('insufficient');
    expect(doraLevelForFrequency(1, MIN_DORA_SAMPLE - 1)).toBe('insufficient');
    expect(doraLevelForFrequency(1, MIN_DORA_SAMPLE)).toBe('elite');
    expect(doraLevelForFrequency(0, 0)).toBeNull();
  });

  it('change failure rate: one failed attempt is insufficient, not low', () => {
    expect(doraLevelForChangeFailure(100, 1)).toBe('insufficient');
    expect(doraLevelForChangeFailure(0, 4)).toBe('insufficient');
    expect(doraLevelForChangeFailure(0, 5)).toBe('elite');
    expect(doraLevelForChangeFailure(20, 5)).toBe('low');
    expect(doraLevelForChangeFailure(0, 0)).toBeNull();
  });

  it('lead time: banded only on five measurements', () => {
    expect(doraLevelForLeadTime(60, 1)).toBe('insufficient');
    expect(doraLevelForLeadTime(60, 5)).toBe('elite');
    expect(doraLevelForLeadTime(null, 0)).toBeNull();
  });

  it('time to restore: banded only on five recoveries', () => {
    expect(doraLevelForRestore(10 * 86400, 1)).toBe('insufficient');
    expect(doraLevelForRestore(10 * 86400, 5)).toBe('low');
    expect(doraLevelForRestore(null, 0)).toBeNull();
  });
});
