// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The observability request-body schemas (moved from platform's
 * validation-body-schemas suite with utils/validation-observability.ts): the
 * lenient fields stay lenient (a non-boolean `enabled` is ignored, not refused).
 */

import { jest, describe, it, expect } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig());

const obs = await import('../src/utils/validation-observability.js');

describe('alert destination schemas', () => {
  it('defaults a non-string target to empty and ignores a non-boolean enabled', () => {
    expect(obs.createAlertDestinationSchema.parse({ channel: 'in-app', label: 'x', target: 5, enabled: 'yes' }))
      .toEqual({ channel: 'in-app', label: 'x', target: '', enabled: undefined });
  });

  it('refuses an unknown channel and a bad severity', () => {
    expect(obs.createAlertDestinationSchema.safeParse({ channel: 'fax', label: 'x' }).success).toBe(false);
    expect(obs.updateAlertDestinationSchema.safeParse({ minSeverity: 'info' }).success).toBe(false);
  });
});

describe('dashboard schemas', () => {
  it('accepts a null description, ignores a non-object layout and keeps panel extras only when typed', () => {
    const parsed = obs.updateDashboardSchema.parse({
      description: null,
      layoutJson: 'nope',
      panels: [{ queryKey: 'k', title: 't', groupBy: 3, format: 'bytes', position: 'x' }],
    });
    expect(parsed.description).toBeNull();
    expect(parsed.layoutJson).toBeUndefined();
    expect(parsed.panels?.[0]).toEqual({ queryKey: 'k', title: 't', groupBy: null, format: 'bytes', position: undefined });
  });

  it('refuses an empty name, an unknown visibility and a panel span out of range', () => {
    expect(obs.createDashboardSchema.safeParse({ name: '' }).success).toBe(false);
    expect(obs.createDashboardSchema.safeParse({ name: 'd', visibility: 'world' }).success).toBe(false);
    expect(obs.createDashboardSchema.safeParse({ name: 'd', panels: [{ queryKey: 'k', title: 't', span: 13 }] }).success).toBe(false);
  });
});

