// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { UniqueId } from '../src/core/id-generator';

describe('UniqueId', () => {
  let uniqueId: UniqueId;

  beforeEach(() => {
    uniqueId = new UniqueId({ organization: 'Org', project: 'Proj' });
  });

  it('should append counter to label', () => {
    expect(uniqueId.generate('plugin:lookup')).toMatch(/^plugin:[0-9a-f]{8}:lookup:1$/);
  });

  it('should auto-increment counters per label', () => {
    expect(uniqueId.generate('plugin:lookup')).toMatch(/:lookup:1$/);
    expect(uniqueId.generate('plugin:lookup')).toMatch(/:lookup:2$/);
    expect(uniqueId.generate('plugin:lookup')).toMatch(/:lookup:3$/);
  });

  it('should track separate counters for different labels', () => {
    expect(uniqueId.generate('cdk:synth')).toMatch(/:synth:1$/);
    expect(uniqueId.generate('plugin:lookup')).toMatch(/:lookup:1$/);
    expect(uniqueId.generate('cdk:synth')).toMatch(/:synth:2$/);
  });

  it('should return label as-is if it already ends with a counter', () => {
    expect(uniqueId.generate('cdk:pipeline:1')).toBe('cdk:pipeline:1');
    expect(uniqueId.generate('resource:42')).toBe('resource:42');
  });

  it('should throw for empty string', () => {
    expect(() => uniqueId.generate('')).toThrow('Label must be a non-empty string');
  });

  it('should throw for non-string values', () => {
    expect(() => uniqueId.generate(null as any)).toThrow('Label must be a non-empty string');
    expect(() => uniqueId.generate(undefined as any)).toThrow('Label must be a non-empty string');
    expect(() => uniqueId.generate(123 as any)).toThrow('Label must be a non-empty string');
  });

  it('should produce independent counters across instances', () => {
    const id1 = new UniqueId({ organization: 'Org', project: 'Proj' });
    const id2 = new UniqueId({ organization: 'Org', project: 'Proj' });
    // Both start at 1 since they're independent instances
    expect(id1.generate('test')).toMatch(/:1$/);
    expect(id2.generate('test')).toMatch(/:1$/);
  });

  // Stack-identity hash — inserted after the first label segment so resources
  // with explicit names (log groups, IAM roles) don't collide across pipelines
  // deployed to the same AWS account.
  describe('with organization + project (stack-identity hash)', () => {
    it('inserts an 8-char hex hash after the first segment', () => {
      const id = new UniqueId({ organization: 'AcmeCorp', project: 'spring-boot' });
      expect(id.generate('plugin:lookup')).toMatch(/^plugin:[0-9a-f]{8}:lookup:1$/);
      expect(id.generate('log:group')).toMatch(/^log:[0-9a-f]{8}:group:1$/);
    });

    it('produces stable hash for the same org+project pair', () => {
      const a = new UniqueId({ organization: 'AcmeCorp', project: 'spring-boot' });
      const b = new UniqueId({ organization: 'AcmeCorp', project: 'spring-boot' });
      expect(a.stackId).toBe(b.stackId);
      expect(a.generate('plugin:lookup')).toBe(b.generate('plugin:lookup'));
    });

    it('produces different hash for different org or project', () => {
      const acme = new UniqueId({ organization: 'AcmeCorp', project: 'spring-boot' });
      const widgets = new UniqueId({ organization: 'Widgets', project: 'spring-boot' });
      const acmeRust = new UniqueId({ organization: 'AcmeCorp', project: 'rust-api' });
      expect(acme.stackId).not.toBe(widgets.stackId);
      expect(acme.stackId).not.toBe(acmeRust.stackId);
    });

    it('is case-insensitive on org+project so AcmeCorp == acmecorp', () => {
      const upper = new UniqueId({ organization: 'AcmeCorp', project: 'SpringBoot' });
      const lower = new UniqueId({ organization: 'acmecorp', project: 'springboot' });
      expect(upper.stackId).toBe(lower.stackId);
    });

    it('still increments counter per label with the hash present', () => {
      const id = new UniqueId({ organization: 'AcmeCorp', project: 'spring-boot' });
      const first = id.generate('plugin:lookup');
      const second = id.generate('plugin:lookup');
      expect(first).toMatch(/:1$/);
      expect(second).toMatch(/:2$/);
      expect(first.replace(/:\d+$/, '')).toBe(second.replace(/:\d+$/, ''));
    });

    it('appends hash before counter for single-segment labels', () => {
      const id = new UniqueId({ organization: 'AcmeCorp', project: 'spring-boot' });
      expect(id.generate('singleton')).toMatch(/^singleton:[0-9a-f]{8}:1$/);
    });

    it('still passes already-counted labels through unchanged', () => {
      const id = new UniqueId({ organization: 'AcmeCorp', project: 'spring-boot' });
      // No hash insertion when caller already wrote `:N`.
      expect(id.generate('cdk:pipeline:1')).toBe('cdk:pipeline:1');
    });
  });
});
