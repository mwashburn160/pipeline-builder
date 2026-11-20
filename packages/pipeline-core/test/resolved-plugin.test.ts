// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolved plugin records come without the fields no pipeline build reads.
 * They travel to the CDK app whole, and a couple of 500-finding scan summaries once
 * pushed the props past what one environment variable can hold (E2BIG).
 * The plugin service's `/plugins/lookup` answers through {@link toResolvedPlugin}.
 */

import { describe, it, expect } from '@jest/globals';
import { RESOLVED_PLUGIN_OMITTED_FIELDS, toResolvedPlugin, unwrapLookup } from '../src/core/plugin-lookup-envelope.js';

const full = {
  id: 'p-1',
  name: 'go',
  version: '1.0.0',
  commands: ['go build'],
  imageDigest: `sha256:${'a'.repeat(64)}`,
  readmeMd: '# go',
  readmeHtml: '<h1>go</h1>',
  changelog: 'notes',
  dockerfile: 'FROM golang',
  icon: 'go',
  uploadedIcon: 'data:image/png;base64,AAAA',
  scanSummary: { findings: Array.from({ length: 500 }, (_, i) => ({ id: `CVE-${i}`, severity: 'high' })) },
};

describe('resolved plugin records', () => {
  it('omits the display and scan fields, keeping everything else', () => {
    const slim = toResolvedPlugin(full);
    for (const field of RESOLVED_PLUGIN_OMITTED_FIELDS) expect(slim).not.toHaveProperty(field);
    expect(slim).toEqual({ id: 'p-1', name: 'go', version: '1.0.0', commands: ['go build'], imageDigest: full.imageDigest });
    expect(full).toHaveProperty('scanSummary');
  });

  it('unwrapLookup reads the plugin from the platform envelope only', () => {
    const slim = toResolvedPlugin(full);
    expect(unwrapLookup({ success: true, data: { plugin: slim, warnings: [] } }).plugin).toEqual(slim);
    expect(unwrapLookup({ plugin: slim }).plugin).toBeNull();
    expect(unwrapLookup({ data: slim }).plugin).toBeNull();
    expect(unwrapLookup(slim).plugin).toBeNull();
  });
});

describe('resolved plugin records: kept build sources', () => {
  it('never carries the kept-source pointer or delete batch into a resolved record', () => {
    const resolved = toResolvedPlugin({
      ...full,
      sourceKey: 'org-1/p-1/1.0.0/abc.zip',
      sourceSha256: 'abc',
      sourceSizeBytes: 1234,
      sourceKind: 'zip',
      sourceKeptAt: new Date(),
      deleteBatchId: null,
    }) as Record<string, unknown>;
    for (const field of ['sourceKey', 'sourceSha256', 'sourceSizeBytes', 'sourceKind', 'sourceKeptAt', 'deleteBatchId']) {
      expect(Object.hasOwn(resolved, field)).toBe(false);
    }
    expect(resolved.commands).toEqual(['go build']);
  });
});

describe('resolved plugin records: automatic tidying bookkeeping', () => {
  it('never carries the tidy clock or the hourly last-used stamp into a resolved record (CDK props would diff every synth)', () => {
    const resolved = toResolvedPlugin({
      ...full,
      lastUsedAt: new Date(),
      tidyKeptAt: null,
      tidyWarnedAt: new Date(),
      tidyDeactivateAfter: new Date(),
      tidyDeactivatedAt: null,
    }) as Record<string, unknown>;
    for (const field of ['lastUsedAt', 'tidyKeptAt', 'tidyWarnedAt', 'tidyDeactivateAfter', 'tidyDeactivatedAt']) {
      expect(Object.hasOwn(resolved, field)).toBe(false);
    }
  });
});
