// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `../src/config/index.js` mock for platform suites: the REAL config (loaded
 * with test-safe environment defaults) with the suite's `overrides` laid over
 * it — so a suite states only the settings it is about, and a module that
 * reads any other setting gets the real default rather than `undefined`.
 *
 * The overrides object IS the returned config's object graph (defaults are
 * filled INTO it, never copied out of it), so a suite that mutates its own
 * override object — or defines a getter — between tests is still seen live.
 */
import { jest } from '@jest/globals';

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** Deep copy of a plain-object tree that keeps accessors as accessors. */
function copy(v: unknown): unknown {
  if (Array.isArray(v)) return v.slice();
  if (!isPlain(v)) return v;
  const out: Plain = {};
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
    Object.defineProperty(out, k, 'value' in d ? { ...d, value: copy(d.value), writable: true, configurable: true } : { ...d, configurable: true });
  }
  return out;
}

/** Fill every key `defaults` has and `target` lacks, recursing into plain objects both have. */
function fillDefaults(target: Plain, defaults: Plain): Plain {
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(defaults))) {
    const own = Object.getOwnPropertyDescriptor(target, k);
    if (!own) {
      Object.defineProperty(target, k, 'value' in d ? { ...d, value: copy(d.value), writable: true, configurable: true } : { ...d, configurable: true });
    } else if ('value' in own && 'value' in d && isPlain(own.value) && isPlain(d.value)) {
      fillDefaults(own.value, d.value);
    }
  }
  return target;
}

let real: Plain | null | undefined;

/**
 * The real config, or null when it can't load in this suite — e.g. the suite
 * stubs api-core without the tier presets the config is built from. Then the
 * overrides alone are the config, exactly as a hand-written mock would be.
 */
function realConfig(): Plain | null {
  if (real === undefined) {
    // The real module refuses to load without these outside development.
    process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
    process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
    try {
      real = (jest.requireActual('../../src/config/index.js') as { config: Plain }).config;
    } catch {
      real = null;
    }
  }
  return real;
}

/** The mock module: `{ config }` = the real config under `overrides`. */
export function mockConfig(overrides: Plain = {}): { config: Plain } {
  const defaults = realConfig();
  return { config: defaults ? fillDefaults(overrides, defaults) : overrides };
}
