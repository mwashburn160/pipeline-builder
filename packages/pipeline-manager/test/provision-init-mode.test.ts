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

  it('ignores a non-string --init (no boolean alias exists any more)', () => {
    // `--init` is a value flag; commander can never hand it `true`/`false`, and the
    // old boolean aliases (--no-init/--auto-init/--no-auto-init) are gone — anything
    // that isn't a string falls through to the default.
    expect(resolveInitMode({ init: false } as { init?: unknown })).toBe('auto');
    expect(resolveInitMode({ init: undefined })).toBe('auto');
  });
});
