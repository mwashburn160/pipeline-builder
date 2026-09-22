// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * stubModule: every manifest export is present, overrides win, the rest are
 * LOUD stubs, and an override the real module does not export is refused.
 */

import { describe, it, expect } from '@jest/globals';
import { loadExportManifest, stubModule, type ExportManifest } from '../src/testing/stub-module.js';

const manifest: ExportManifest = {
  package: '@pipeline-builder/fake',
  entries: {
    '.': { doThing: 'function', Thing: 'class', CONSTANTS: 'value' },
    './cdk': { Construct: 'class' },
  },
};

describe('stubModule', () => {
  it('exports every manifest name, with overrides layered on top', () => {
    const doThing = () => 42;
    const mod = stubModule({ manifest }, { doThing });
    expect(Object.keys(mod).sort()).toEqual(['CONSTANTS', 'Thing', 'doThing']);
    expect(mod.doThing).toBe(doThing);
  });

  it('a non-overridden function/class throws, naming the module and export', () => {
    const mod = stubModule({ manifest }, {});
    expect(() => (mod.doThing as () => void)()).toThrow(/stubModule\('@pipeline-builder\/fake'\): export 'doThing' was called/);
    const Thing = mod.Thing as new () => unknown;
    expect(() => new Thing()).toThrow(/export 'Thing' was called\/constructed/);
    // instanceof against a stub class is a harmless false, not a throw.
    expect({} instanceof Thing).toBe(false);
  });

  it('a non-overridden value throws on property read, but stays inspectable', () => {
    const mod = stubModule({ manifest }, {});
    const constants = mod.CONSTANTS as Record<string, unknown>;
    expect(() => constants.MAX).toThrow(/export 'CONSTANTS\.MAX' was read/);
    // jest/pretty-format probes these; they must not throw.
    expect((constants as { then?: unknown }).then).toBeUndefined();
    expect(Object.keys(constants)).toEqual([]);
  });

  it('refuses an override the real module does not export', () => {
    expect(() => stubModule({ manifest }, { doThnig: () => 1 })).toThrow(/override\(s\) 'doThnig' are not exports/);
  });

  it('drops non-exports instead when asked (suites assembling the module from internals)', () => {
    const mod = stubModule({ manifest }, { doThing: () => 1, internalHelper: () => 2 }, { extraOverrides: 'drop' });
    expect(Object.hasOwn(mod, 'internalHelper')).toBe(false);
  });

  it('selects a subpath entry', () => {
    const mod = stubModule({ manifest, entry: './cdk' }, {});
    expect(Object.keys(mod)).toEqual(['Construct']);
    expect(() => stubModule({ manifest, entry: './nope' }, {})).toThrow(/has no entry '\.\/nope'/);
  });

  it('loads a real package manifest by specifier (this package emits its own at compile)', () => {
    const own = loadExportManifest('@pipeline-builder/api-core');
    expect(own.package).toBe('@pipeline-builder/api-core');
    expect(own.entries['.']).toHaveProperty('sendError', 'function');
    // Type-only exports never appear: they do not exist at runtime.
    expect(own.entries['./testing']).toHaveProperty('stubModule', 'function');
    expect(own.entries['./testing']).not.toHaveProperty('AnyFn');
  });
});
