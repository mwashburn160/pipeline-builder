// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The once-a-day "update available" notice (src/utils/update-notice.ts): when
 * it stays silent, what it prints, and when the background refresh is due.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from '@jest/globals';
import { APP_VERSION } from '../src/config/cli.constants.js';
import { CHECK_INTERVAL_MS, isStale, NO_UPDATE_CHECK_ENV, noticeFor, readCache, scheduleUpdateNotice, updateCheckEnabled } from '../src/utils/update-notice.js';

const tty = { argv: ['list-pipelines'], env: {}, isTTY: true };

describe('updateCheckEnabled', () => {
  it('runs for an interactive command', () => {
    expect(updateCheckEnabled(tty)).toBe(true);
  });

  it.each([
    ['the opt-out env', { ...tty, env: { [NO_UPDATE_CHECK_ENV]: '1' } }],
    ['CI', { ...tty, env: { CI: 'true' } }],
    ['tests', { ...tty, env: { NODE_ENV: 'test' } }],
    ['a non-terminal stderr', { ...tty, isTTY: false }],
    ['--quiet', { ...tty, argv: ['status', '--quiet'] }],
    ['--token (captured output)', { ...tty, argv: ['auth', '--token'] }],
    ['--upgrade itself', { ...tty, argv: ['--upgrade'] }],
    ['--upgrade-check itself', { ...tty, argv: ['--upgrade-check'] }],
  ])('is silent under %s', (_why, ctx) => {
    expect(updateCheckEnabled(ctx)).toBe(false);
  });
});

describe('noticeFor', () => {
  it('names the newer release and how to get it', () => {
    const line = noticeFor('4.4.21', { checkedAt: 0, latest: '4.4.23' });
    expect(line).toContain('4.4.21 → ');
    expect(line).toContain('4.4.23');
    expect(line).toContain('--upgrade');
    expect(line).toContain(NO_UPDATE_CHECK_ENV);
  });

  it.each([
    ['no cache', null],
    ['no known latest', { checkedAt: 0 }],
    ['the same version', { checkedAt: 0, latest: '4.4.21' }],
    ['an older latest', { checkedAt: 0, latest: '4.4.20' }],
    ['garbage', { checkedAt: 0, latest: 'not-a-version' }],
  ])('says nothing for %s', (_why, cache) => {
    expect(noticeFor('4.4.21', cache)).toBeNull();
  });
});

describe('isStale', () => {
  const now = 10 * CHECK_INTERVAL_MS;
  it('refreshes with no cache, after a day, or with a future (clock-skewed) stamp', () => {
    expect(isStale(null, now)).toBe(true);
    expect(isStale({ checkedAt: now - CHECK_INTERVAL_MS }, now)).toBe(true);
    expect(isStale({ checkedAt: now + 1000 }, now)).toBe(true);
  });
  it('does not refresh within the day', () => {
    expect(isStale({ checkedAt: now - CHECK_INTERVAL_MS + 1000 }, now)).toBe(false);
  });
});

describe('readCache / scheduleUpdateNotice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-update-notice-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a written cache and rejects a malformed one', () => {
    const f = join(dir, 'ok.json');
    writeFileSync(f, JSON.stringify({ checkedAt: 5, latest: '1.2.3' }));
    expect(readCache(f)).toEqual({ checkedAt: 5, latest: '1.2.3' });
    writeFileSync(join(dir, 'bad.json'), '{nope');
    expect(readCache(join(dir, 'bad.json'))).toBeNull();
    expect(readCache(join(dir, 'missing.json'))).toBeNull();
  });

  it('prints on exit when a fresh cache knows a newer release, and spawns nothing', () => {
    const f = join(dir, 'fresh.json');
    const now = Date.now();
    writeFileSync(f, JSON.stringify({ checkedAt: now, latest: '999.0.0' }));
    const before = process.listenerCount('exit');
    scheduleUpdateNotice(tty, f, now);
    expect(process.listenerCount('exit')).toBe(before + 1);
    const listener = process.listeners('exit').at(-1)!;
    process.removeListener('exit', listener);
    expect(APP_VERSION).not.toBe('999.0.0');
  });

  it('creates the shared ~/.pipeline-manager directory owner-only (it also holds credentials)', () => {
    const f = join(dir, 'fresh-home', '.pipeline-manager', 'update-check.json');
    scheduleUpdateNotice(tty, f, Date.now());
    expect(statSync(join(dir, 'fresh-home', '.pipeline-manager')).mode.toString(8).slice(-3)).toBe('700');
  });

  it('does nothing at all when disabled', () => {
    const before = process.listenerCount('exit');
    scheduleUpdateNotice({ ...tty, isTTY: false }, join(dir, 'never.json'), Date.now());
    expect(process.listenerCount('exit')).toBe(before);
  });
});
