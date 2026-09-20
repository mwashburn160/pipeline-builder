// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The metadata-key catalog is the SINGLE source for two consumers that used to
 * hand-mirror each other: pipeline-core's `MetadataKeys` constants and the
 * frontend's metadata picker. These tests pin the invariants that made the old
 * mirror drift (62 picker keys vs 80 constants, plus three `aws:cdk:build:*`
 * keys the synth had already dropped).
 */
import { describe, it, expect } from '@jest/globals';
import {
  METADATA_KEY_CATALOG,
  METADATA_KEY_GROUPS,
  MetadataKeys,
} from '../src/types/metadata-keys.js';

const entries = Object.entries(METADATA_KEY_CATALOG);

describe('METADATA_KEY_CATALOG', () => {
  it('has no duplicate wire keys', () => {
    const keys = entries.map(([, e]) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses the lowercase `aws:cdk:` key format throughout', () => {
    for (const [, e] of entries) {
      expect(e.key).toBe(e.key.toLowerCase());
      expect(e.key.startsWith('aws:cdk:')).toBe(true);
    }
  });

  it('does not resurrect the removed build.* aliases', () => {
    expect(entries.some(([, e]) => e.key.startsWith('aws:cdk:build:'))).toBe(false);
  });

  it('gives every entry a label and a supported editor type', () => {
    for (const [name, e] of entries) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(['boolean', 'string']).toContain(e.type);
      expect(e.category.length).toBeGreaterThan(0);
      expect(name).toBe(name.toUpperCase());
    }
  });
});

describe('MetadataKeys', () => {
  it('mirrors the catalog exactly — one constant per entry', () => {
    expect(Object.keys(MetadataKeys)).toEqual(entries.map(([name]) => name));
    for (const [name, e] of entries) {
      expect(MetadataKeys[name as keyof typeof MetadataKeys]).toBe(e.key);
    }
  });

  it('keeps the well-known constants stable', () => {
    expect(MetadataKeys.SELF_MUTATION).toBe('aws:cdk:pipelines:codepipeline:selfmutation');
    expect(MetadataKeys.COMPUTE_TYPE).toBe('aws:cdk:codebuild:buildenvironment:computetype');
    expect(MetadataKeys.KMS_KEY_ARN).toBe('aws:cdk:encryption:kmskeyarn');
  });
});

describe('METADATA_KEY_GROUPS', () => {
  it('covers every catalog entry exactly once (the old picker was missing 21)', () => {
    const picker = METADATA_KEY_GROUPS.flatMap((g) => g.keys.map((k) => k.key));
    expect(picker.sort()).toEqual(entries.map(([, e]) => e.key).sort());
  });

  it('emits one group per category, in declaration order', () => {
    const categories = METADATA_KEY_GROUPS.map((g) => g.category);
    expect(new Set(categories).size).toBe(categories.length);
    expect(categories[0]).toBe('CodePipeline');
    for (const g of METADATA_KEY_GROUPS) {
      for (const k of g.keys) {
        expect(METADATA_KEY_CATALOG[
          entries.find(([, e]) => e.key === k.key)![0] as keyof typeof METADATA_KEY_CATALOG
        ].category).toBe(g.category);
      }
    }
  });
});
