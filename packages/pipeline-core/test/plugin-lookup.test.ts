// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { PluginLookup } = await import('../src/pipeline/plugin-lookup.js');

describe('PluginLookup', () => {
  // Every plugin is resolved by the CLI before the CDK app runs, so the lookup
  // deploys nothing: no Lambda, no Provider, no custom resource.
  it('is plain data, not a construct, and needs no scope', () => {
    const lookup = new PluginLookup();
    expect(lookup).not.toHaveProperty('node');
  });

  describe('plugin()', () => {
    // A plugin that did not resolve fails the synth: a step without its record
    // has no image or commands, and must never ship as a placeholder step.
    it('throws for a plugin that was not pre-resolved, ', () => {
      const lookup = new PluginLookup();

      expect(() => lookup.plugin('nodejs-build')).toThrow(/Plugin "nodejs-build" was not resolved before synth/);
    });

    it('names the publisher and the step in the error', () => {
      const lookup = new PluginLookup();

      expect(() => lookup.plugin({ name: 'lint', publisher: 'acme' }, 'Build/lint'))
        .toThrow(/Plugin "acme\/lint" \(step Build\/lint\) was not resolved before synth/);
    });

    it('should return the pre-resolved plugin verbatim', () => {
      const preResolved = {
        id: 'plugin-id',
        name: 'nodejs-build',
        version: '1.2.3',
        commands: ['npm ci', 'npm test'],
        installCommands: [],
        buildType: 'build_image',
      };

      const lookup = new PluginLookup({
        resolvedPlugins: { 'nodejs-build-alias': preResolved as never },
      });

      const result = lookup.plugin('nodejs-build');

      // Returns the pre-resolved plugin verbatim — name, version, commands, etc. intact.
      expect(result).toBe(preResolved);
      expect(result.name).toBe('nodejs-build');
      expect(result.version).toBe('1.2.3');
    });

    it('should match pre-resolved plugin by explicit alias', () => {
      const preResolved = { name: 'snyk-scan', version: '1.0.0', commands: [] };

      const lookup = new PluginLookup({
        resolvedPlugins: { 'snyk-prod': preResolved as never },
      });

      const result = lookup.plugin({ name: 'snyk-scan', alias: 'snyk-prod' });

      expect(result).toBe(preResolved);
    });

    it('refuses a pre-resolved entry that holds a DIFFERENT plugin under this alias', () => {
      // The map is keyed by alias. Two steps sharing an alias across different
      // plugins used to get the first plugin's record back, so the second step
      // silently ran the wrong image and commands.
      const lookup = new PluginLookup({
        resolvedPlugins: { build: { name: 'nodejs-build', version: '1.0.0', commands: [] } as never },
      });

      expect(() => lookup.plugin({ name: 'maven-build', alias: 'build' }))
        .toThrow(/resolves to "nodejs-build", not "maven-build"/);
    });

    it('refuses one alias serving the same plugin under two different version pins', () => {
      const lookup = new PluginLookup({
        resolvedPlugins: { 'nodejs-build-alias': { name: 'nodejs-build', version: '18.2.0', commands: [] } as never },
      });

      expect(lookup.plugin({ name: 'nodejs-build', filter: { version: '18.2.0' } } as never).version).toBe('18.2.0');
      expect(() => lookup.plugin({ name: 'nodejs-build', filter: { version: '20.1.0' } } as never, 'Build/nodejs-build'))
        .toThrow(/alias "nodejs-build-alias" is used for two different plugin references.*own alias/);
    });

    it('refuses a pre-resolved record whose version is not the exact pin', () => {
      const lookup = new PluginLookup({
        resolvedPlugins: { 'nodejs-build-alias': { name: 'nodejs-build', version: '18.2.0', commands: [] } as never },
      });

      expect(() => lookup.plugin({ name: 'nodejs-build', filter: { version: '20.1.0' } } as never))
        .toThrow(/resolves to nodejs-build@18.2.0, not the pinned nodejs-build@20.1.0/);
    });

    it('keys a publisher reference by <publisher>-<name>-alias and refuses a record from another publisher', () => {
      const lookup = new PluginLookup({
        resolvedPlugins: {
          'acme-lint-alias': { name: 'lint', version: '1.0.0', commands: [], publisher: 'acme' } as never,
          'other-lint-alias': { name: 'lint', version: '1.0.0', commands: [], publisher: null } as never,
        },
      });

      expect(lookup.plugin({ name: 'lint', publisher: 'acme' }).version).toBe('1.0.0');
      expect(() => lookup.plugin({ name: 'lint', publisher: 'other' }))
        .toThrow(/resolves to your organization's lint, not other\/lint/);
    });

    it('throws when the pre-resolved map misses this plugin', () => {
      const lookup = new PluginLookup({
        resolvedPlugins: { 'something-else-alias': { name: 'something-else' } as never },
      });

      expect(() => lookup.plugin('not-cached')).toThrow(/"not-cached" was not resolved before synth/);
    });
  });
});
