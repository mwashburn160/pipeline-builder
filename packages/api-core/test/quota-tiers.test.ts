// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import {
  QUOTA_TIERS,
  VALID_TIERS,
  DEFAULT_TIER,
  isValidTier,
  getTierLimits,
} from '../src/types/quota-tiers.js';

// storageBytes sized per tier. Tiers: developer / pro / team / enterprise.
const GB = 1024 * 1024 * 1024;

describe('QUOTA_TIERS', () => {
  it('should define developer tier', () => {
    expect(QUOTA_TIERS.developer).toEqual({
      label: 'Developer',
      // aiCalls is sized smaller than apiCalls because each AI call has
      // external dollar cost; see quota-tiers.ts for rationale.
      // Count caps on user-editable feature tables added to close per-org
      // DoS via spam (dashboards / alertRules / alertDestinations / idpConfigs).
      limits: {
        plugins: 25,
        pipelines: 5,
        apiCalls: 25_000,
        aiCalls: 25,
        storageBytes: 2 * GB,
        dashboards: 20,
        alertRules: 50,
        alertDestinations: 10,
        idpConfigs: 1,
        seats: 1,
      },
    });
  });

  it('should define pro tier', () => {
    expect(QUOTA_TIERS.pro).toEqual({
      label: 'Pro',
      limits: {
        plugins: 50,
        pipelines: 10,
        apiCalls: 500_000,
        aiCalls: 1_000,
        storageBytes: 25 * GB,
        dashboards: 200,
        alertRules: 500,
        alertDestinations: 50,
        idpConfigs: 5,
        seats: 1,
      },
    });
  });

  it('should define team tier', () => {
    expect(QUOTA_TIERS.team).toEqual({
      label: 'Team',
      limits: {
        plugins: 100,
        pipelines: 200,
        apiCalls: 2_000_000,
        aiCalls: 5_000,
        storageBytes: 150 * GB,
        dashboards: -1,
        alertRules: -1,
        alertDestinations: -1,
        idpConfigs: 5,
        seats: 10,
      },
    });
  });

  it('should define enterprise tier', () => {
    expect(QUOTA_TIERS.enterprise).toEqual({
      label: 'Enterprise',
      limits: {
        plugins: 250,
        pipelines: 200,
        apiCalls: 10_000_000,
        aiCalls: 15_000,
        storageBytes: 500 * GB,
        dashboards: -1,
        alertRules: -1,
        alertDestinations: -1,
        idpConfigs: -1,
        seats: 25,
      },
    });
  });
});

describe('VALID_TIERS', () => {
  it('should contain all tier names', () => {
    expect(VALID_TIERS).toContain('developer');
    expect(VALID_TIERS).toContain('pro');
    expect(VALID_TIERS).toContain('team');
    expect(VALID_TIERS).toContain('enterprise');
    // `unlimited` is a valid stored tier (billing-off default) but not a
    // standard/selectable one — see STANDARD_TIERS.
    expect(VALID_TIERS).toContain('unlimited');
    expect(VALID_TIERS).toHaveLength(5);
  });
});

describe('DEFAULT_TIER', () => {
  it('should be developer', () => {
    expect(DEFAULT_TIER).toBe('developer');
  });
});

describe('isValidTier', () => {
  it('should return true for valid tiers', () => {
    expect(isValidTier('developer')).toBe(true);
    expect(isValidTier('pro')).toBe(true);
    expect(isValidTier('team')).toBe(true);
    expect(isValidTier('enterprise')).toBe(true);
  });

  it('should return false for invalid tiers', () => {
    expect(isValidTier('free')).toBe(false);
    expect(isValidTier('basic')).toBe(false);
    expect(isValidTier('')).toBe(false);
    expect(isValidTier('Developer')).toBe(false);
  });
});

describe('getTierLimits', () => {
  const developerLimits = {
    plugins: 25,
    pipelines: 5,
    apiCalls: 25_000,
    aiCalls: 25,
    storageBytes: 2 * GB,
    dashboards: 20,
    alertRules: 50,
    alertDestinations: 10,
    idpConfigs: 1,
    seats: 1,
  };
  it('should return limits for valid tiers', () => {
    expect(getTierLimits('developer')).toEqual(developerLimits);
    expect(getTierLimits('pro')).toEqual({
      plugins: 50,
      pipelines: 10,
      apiCalls: 500_000,
      aiCalls: 1_000,
      storageBytes: 25 * GB,
      dashboards: 200,
      alertRules: 500,
      alertDestinations: 50,
      idpConfigs: 5,
      seats: 1,
    });
    expect(getTierLimits('team')).toEqual({
      plugins: 100,
      pipelines: 200,
      apiCalls: 2_000_000,
      aiCalls: 5_000,
      storageBytes: 150 * GB,
      dashboards: -1,
      alertRules: -1,
      alertDestinations: -1,
      idpConfigs: 5,
      seats: 10,
    });
    expect(getTierLimits('enterprise')).toEqual({
      plugins: 250,
      pipelines: 200,
      apiCalls: 10_000_000,
      aiCalls: 15_000,
      storageBytes: 500 * GB,
      dashboards: -1,
      alertRules: -1,
      alertDestinations: -1,
      idpConfigs: -1,
      seats: 25,
    });
  });

  it('should fall back to developer limits for invalid tiers', () => {
    expect(getTierLimits('invalid')).toEqual(developerLimits);
    expect(getTierLimits('')).toEqual(developerLimits);
  });
});
