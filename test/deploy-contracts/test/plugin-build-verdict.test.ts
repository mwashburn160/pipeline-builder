// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * load-plugins.sh's build verdict, run for real against fixture API bodies.
 *
 * A fresh install's plugin service creates its own remediation-canary-* plugins
 * in the system org, and their build failures land in the same queue triage the
 * loader reads. The loader used to add the queue's TOTAL failure count to its
 * own, so an install whose every uploaded plugin built cleanly was declared
 * failed (and init stopped at the toolchain). Only failures of what THIS run
 * uploaded may count.
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

const SCRIPT = join(REPO_ROOT, 'deploy/bin/plugin-build-verdict.py');

function run(mode: 'counts' | 'groups', uploaded: string[][], plugins: unknown[], groups: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
  writeFileSync(join(dir, 'uploaded'), uploaded.map((r) => r.join('\t')).join('\n') + '\n');
  writeFileSync(join(dir, 'list.json'), JSON.stringify({ data: { plugins } }));
  writeFileSync(join(dir, 'triage.json'), JSON.stringify({ data: { totalFailed: 99, groups } }));
  const r = spawnSync('python3', ['-I', SCRIPT, mode, join(dir, 'uploaded'), join(dir, 'list.json'), join(dir, 'triage.json')], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  return r.stdout;
}

const canaryGroup = {
  category: 'validation',
  count: 11,
  pluginNames: Array.from({ length: 11 }, (_, i) => `remediation-canary-${i}`),
  samples: [],
};

describe('plugin-build-verdict.py', () => {
  it('ignores failures of plugins this run did not upload (the canaries)', () => {
    const out = run('counts', [['lint', '1.0.0']], [{ name: 'lint', version: '1.0.0', imageDigest: 'sha256:a' }], [canaryGroup]);
    expect(out.trim()).toBe('1 0 11');
  });

  it('counts an uploaded plugin whose build failed and has not built', () => {
    const out = run('counts', [['lint', '1.0.0'], ['veracode', '2.0.0']],
      [{ name: 'lint', version: '1.0.0', imageDigest: 'sha256:a' }, { name: 'veracode', version: '2.0.0' }],
      [{ category: 'PLUGIN_VULN_GATE', count: 1, pluginNames: ['veracode'], samples: [{ pluginName: 'veracode', version: '2.0.0' }] }, canaryGroup]);
    expect(out.trim()).toBe('1 1 11');
  });

  it('does not count a failure that has since built (a retried build)', () => {
    const out = run('counts', [['lint', '1.0.0']], [{ name: 'lint', version: '1.0.0', imageDigest: 'sha256:a' }],
      [{ category: 'timeout', count: 1, pluginNames: ['lint'], samples: [{ pluginName: 'lint', version: '1.0.0' }] }]);
    expect(out.trim()).toBe('1 0 0');
  });

  it('does not blame a new upload for an OLDER version\'s failed job of the same name', () => {
    const out = run('counts', [['lint', '2.0.0']], [{ name: 'lint', version: '2.0.0' }],
      [{ category: 'timeout', count: 1, pluginNames: ['lint'], samples: [{ pluginName: 'lint', version: '1.0.0' }] }]);
    expect(out.trim()).toBe('0 0 1');
  });

  it('counts a metadata_only plugin as built without an image digest', () => {
    const out = run('counts', [['approve', '1.0.0']], [{ name: 'approve', version: '1.0.0', buildType: 'metadata_only' }], []);
    expect(out.trim()).toBe('1 0 0');
  });

  it('lists only this run\'s failures in the per-category breakdown', () => {
    const out = run('groups', [['veracode', '2.0.0']], [{ name: 'veracode', version: '2.0.0' }],
      [{ category: 'PLUGIN_VULN_GATE', count: 1, pluginNames: ['veracode'], samples: [{ pluginName: 'veracode', version: '2.0.0' }] }, canaryGroup]);
    expect(out).toContain('1x PLUGIN_VULN_GATE - veracode');
    expect(out).not.toContain('remediation-canary');
  });

  it('reads an unreadable API body as nothing built and nothing failed, never a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
    writeFileSync(join(dir, 'uploaded'), 'lint\t1.0.0\n');
    writeFileSync(join(dir, 'list.json'), '<html>502</html>');
    writeFileSync(join(dir, 'triage.json'), '');
    const r = spawnSync('python3', ['-I', SCRIPT, 'counts', join(dir, 'uploaded'), join(dir, 'list.json'), join(dir, 'triage.json')], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('0 0 0');
  });
});
