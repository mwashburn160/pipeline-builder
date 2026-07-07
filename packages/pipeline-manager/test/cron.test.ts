// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { toEventBridgeCron, assertScheduleInterval, MIN_SCHEDULE_INTERVAL_MIN } from '../src/utils/cron.js';

describe('toEventBridgeCron — 5-field → EventBridge', () => {
  it('daily default: 0 0 * * * → cron(0 0 * * ? *)', () => {
    expect(toEventBridgeCron('0 0 * * *')).toBe('cron(0 0 * * ? *)');
  });

  it('every 15 minutes (densest allowed): */15 * * * * → cron(*/15 * * * ? *)', () => {
    expect(toEventBridgeCron('*/15 * * * *')).toBe('cron(*/15 * * * ? *)');
  });

  it('specific day-of-month pins day-of-week to ?: 30 3 1 * * → cron(30 3 1 * ? *)', () => {
    expect(toEventBridgeCron('30 3 1 * *')).toBe('cron(30 3 1 * ? *)');
  });

  it('day-of-week remaps Sunday 0 → 1 and pins day-of-month to ?: 0 0 * * 0 → cron(0 0 ? * 1 *)', () => {
    expect(toEventBridgeCron('0 0 * * 0')).toBe('cron(0 0 ? * 1 *)');
  });

  it('day-of-week remaps Saturday 6 → 7: 0 0 * * 6 → cron(0 0 ? * 7 *)', () => {
    expect(toEventBridgeCron('0 0 * * 6')).toBe('cron(0 0 ? * 7 *)');
  });

  it('day-of-week 7 (also Sunday) → 1', () => {
    expect(toEventBridgeCron('0 0 * * 7')).toBe('cron(0 0 ? * 1 *)');
  });

  it('day-of-week range remaps each end: 0 0 * * 1-5 → cron(0 0 ? * 2-6 *)', () => {
    expect(toEventBridgeCron('0 0 * * 1-5')).toBe('cron(0 0 ? * 2-6 *)');
  });
});

describe('assertScheduleInterval — 15-minute guard', () => {
  it.each([
    '* * * * *', // every minute
    '*/5 * * * *', // every 5 minutes
    '*/14 * * * *', // every 14 minutes
    '0,10 * * * *', // 10-minute gap
    '0,50 * * * *', // 50 then 10 (cyclic) → 10-minute gap
  ])('rejects sub-15-minute schedule: %s', (expr) => {
    expect(() => assertScheduleInterval(expr)).toThrow(/minimum is 15/);
  });

  it.each([
    '0 0 * * *', // daily
    '*/15 * * * *', // exactly 15
    '*/30 * * * *', // 30
    '0 * * * *', // hourly
    '0,30 * * * *', // 30-minute gap
    '0,45 * * * *', // gaps 45 and 15 → ok
  ])('allows >=15-minute schedule: %s', (expr) => {
    expect(() => assertScheduleInterval(expr)).not.toThrow();
  });

  it('rejects a non-5-field expression', () => {
    expect(() => assertScheduleInterval('0 0 * *')).toThrow(/5-field/);
    expect(() => toEventBridgeCron('cron(0 0 * * ? *)')).toThrow(/5-field/);
  });

  it('exposes the minimum interval constant', () => {
    expect(MIN_SCHEDULE_INTERVAL_MIN).toBe(15);
  });
});
