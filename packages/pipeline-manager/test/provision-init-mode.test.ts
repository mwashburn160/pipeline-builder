// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// child_process is mocked so importing the provision command (which pulls in prereq/agent
// modules) stays hermetic — resolveInitMode itself is pure.
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('child_process', () => ({
  execSync: jest.fn(() => {
    throw new Error('mocked: command unavailable');
  }),
}));

import { resolveInitMode } from '../src/commands/provision.js';

describe('resolveInitMode', () => {
  it('defaults to auto when nothing is passed', () => {
    expect(resolveInitMode({})).toBe('auto');
  });

  it('honors --init <mode> (case-insensitive)', () => {
    expect(resolveInitMode({ init: 'auto' })).toBe('auto');
    expect(resolveInitMode({ init: 'manual' })).toBe('manual');
    expect(resolveInitMode({ init: 'skip' })).toBe('skip');
    expect(resolveInitMode({ init: 'MANUAL' })).toBe('manual');
  });

  it('returns null for an invalid --init value (caller errors)', () => {
    expect(resolveInitMode({ init: 'bogus' })).toBeNull();
    expect(resolveInitMode({ init: '' })).toBeNull();
  });

  it('maps the deprecated aliases', () => {
    expect(resolveInitMode({ init: false })).toBe('skip'); // --no-init
    expect(resolveInitMode({ autoInit: true })).toBe('auto'); // --auto-init
    expect(resolveInitMode({ autoInit: false })).toBe('manual'); // --no-auto-init
  });

  it('lets the new --init flag win over a deprecated alias', () => {
    // e.g. `--init manual --auto-init` → manual (the new flag is authoritative).
    expect(resolveInitMode({ init: 'manual', autoInit: true })).toBe('manual');
    expect(resolveInitMode({ init: 'skip', autoInit: false })).toBe('skip');
  });
});
