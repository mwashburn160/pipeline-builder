// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The default-version rule (plugin-ecosystem §3.4): a new major, a prerelease
 * or an older version never takes over the default; a same-major stable newer
 * version does.
 */

import { describe, it, expect } from '@jest/globals';

const { shouldBecomeDefault } = await import('../src/helpers/default-version.js');

const defaults = (...versions: string[]) => versions.map((version) => ({ version }));

describe('shouldBecomeDefault', () => {
  it('makes the first version of a plugin the default', () => {
    expect(shouldBecomeDefault('1.0.0', false, [])).toBe(true);
    expect(shouldBecomeDefault('0.1.0-beta.1', false, [])).toBe(true);
  });

  it('keeps a re-uploaded default as the default', () => {
    expect(shouldBecomeDefault('1.2.0', true, defaults('1.2.0'))).toBe(true);
  });

  it.each([
    ['patch', '1.2.1'],
    ['minor', '1.3.0'],
  ])('promotes a same-major %s release', (_kind, version) => {
    expect(shouldBecomeDefault(version, false, defaults('1.2.0'))).toBe(true);
  });

  it('never auto-promotes a new major', () => {
    expect(shouldBecomeDefault('2.0.0', false, defaults('1.9.9'))).toBe(false);
  });

  it('never promotes a prerelease over an existing default', () => {
    expect(shouldBecomeDefault('1.3.0-rc.1', false, defaults('1.2.0'))).toBe(false);
  });

  it('never demotes the default to an older version', () => {
    expect(shouldBecomeDefault('1.1.9', false, defaults('1.2.0'))).toBe(false);
    expect(shouldBecomeDefault('0.9.0', false, defaults('1.2.0'))).toBe(false);
  });

  it('does not re-promote the same version when it is not already the default', () => {
    expect(shouldBecomeDefault('1.2.0', false, defaults('1.2.0'))).toBe(false);
  });

  it('compares against the highest of several transient defaults', () => {
    expect(shouldBecomeDefault('1.4.0', false, defaults('1.2.0', '1.3.0'))).toBe(true);
    expect(shouldBecomeDefault('1.2.5', false, defaults('1.2.0', '1.3.0'))).toBe(false);
  });
});
