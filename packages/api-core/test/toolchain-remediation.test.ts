// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, jest } from '@jest/globals';
import { PLUGIN_REMEDIATION_ENV } from '../src/types/plugin-remediation.js';
import { REMOTE_AUDIT_ACTIONS } from '../src/types/remote-audit-actions.js';
import {
  DEFAULT_REMEDIATION_TOOLCHAINS,
  parseRemediationToolchains,
  TOOLCHAIN_IMAGE_LABELS,
  toolchainFromImageLabels,
  toolchainVersionChanges,
} from '../src/types/toolchain-remediation.js';

describe('PLUGIN_REMEDIATION_TOOLCHAINS', () => {
  it('is documented beside the other remediation knobs, default propose', () => {
    expect(PLUGIN_REMEDIATION_ENV.toolchains).toEqual({ name: 'PLUGIN_REMEDIATION_TOOLCHAINS', default: 'propose' });
    expect(DEFAULT_REMEDIATION_TOOLCHAINS).toBe('propose');
  });

  it('unset or blank → propose, silently', () => {
    const warn = jest.fn();
    expect(parseRemediationToolchains(undefined, warn)).toBe('propose');
    expect(parseRemediationToolchains(null, warn)).toBe('propose');
    expect(parseRemediationToolchains('  ', warn)).toBe('propose');
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts propose and off, trimmed and case-insensitive', () => {
    const warn = jest.fn();
    expect(parseRemediationToolchains('off', warn)).toBe('off');
    expect(parseRemediationToolchains(' OFF ', warn)).toBe('off');
    expect(parseRemediationToolchains('Propose', warn)).toBe('propose');
    expect(warn).not.toHaveBeenCalled();
  });

  it('an invalid value (apply included: toolchains are never published automatically) → propose with ONE warning naming it', () => {
    for (const bad of ['apply', 'true', 'on', 'propose,off']) {
      const warn = jest.fn();
      expect(parseRemediationToolchains(bad, warn)).toBe('propose');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(JSON.stringify(bad));
    }
  });
});

describe('toolchain image labels', () => {
  const labels = {
    'org.pipeline-builder.toolchain.pipeline-manager': '6.3.1',
    'org.pipeline-builder.toolchain.aws-cdk': '2.1148.1',
    'org.pipeline-builder.toolchain.cdk-assets': '4.8.0',
    'org.pipeline-builder.toolchain.node': '26.13.1',
    'org.opencontainers.image.created': 'x',
  };

  it('names one label per toolchain field (the bootstrap Dockerfile LABELs)', () => {
    expect(TOOLCHAIN_IMAGE_LABELS).toEqual({
      pipelineManager: 'org.pipeline-builder.toolchain.pipeline-manager',
      awsCdk: 'org.pipeline-builder.toolchain.aws-cdk',
      cdkAssets: 'org.pipeline-builder.toolchain.cdk-assets',
      node: 'org.pipeline-builder.toolchain.node',
    });
  });

  it('reads the toolchain an image carries', () => {
    expect(toolchainFromImageLabels(labels)).toEqual({ pipelineManager: '6.3.1', awsCdk: '2.1148.1', cdkAssets: '4.8.0', node: '26.13.1' });
  });

  it('null when a label is missing or not an exact version', () => {
    const { ['org.pipeline-builder.toolchain.node']: _n, ...noNode } = labels;
    expect(toolchainFromImageLabels(noNode)).toBeNull();
    expect(toolchainFromImageLabels({ ...labels, 'org.pipeline-builder.toolchain.aws-cdk': '^2' })).toBeNull();
    expect(toolchainFromImageLabels(null)).toBeNull();
  });

  it('lists every tool whose version differs (a missing side counts as changed)', () => {
    const a = { pipelineManager: '6.3.1', awsCdk: '2.1148.1', cdkAssets: '4.8.0', node: '26.13.1' };
    expect(toolchainVersionChanges(a, a)).toEqual([]);
    expect(toolchainVersionChanges(a, { ...a, awsCdk: '2.1149.0' })).toEqual([{ tool: 'awsCdk', from: '2.1148.1', to: '2.1149.0' }]);
    expect(toolchainVersionChanges(a, null)).toEqual([
      { tool: 'pipelineManager', from: '6.3.1', to: null },
      { tool: 'awsCdk', from: '2.1148.1', to: null },
      { tool: 'cdkAssets', from: '4.8.0', to: null },
      { tool: 'node', from: '26.13.1', to: null },
    ]);
  });
});

describe('toolchain fix audit actions', () => {
  it('a remote service may emit the proposed / approved / rejected trail', () => {
    for (const a of ['toolchain.fix.proposed', 'toolchain.fix.approved', 'toolchain.fix.rejected']) {
      expect(REMOTE_AUDIT_ACTIONS).toContain(a);
    }
  });
});
