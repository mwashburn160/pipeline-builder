// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Ask agent patch fallback (services/remediation/ask-agent-patch): the
 * agent is shown only the build files, its diff is dropped unless it modifies
 * only those files and only lines naming a targeted package or its fixed
 * version, and a remediation carrying it is always propose-only.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { remediationPublishMode, type RemediationRemainingFinding } from '@pipeline-builder/api-core';

const svc = await import('../src/services/remediation/ask-agent-patch.js');

const finding: RemediationRemainingFinding = {
  id: 'CVE-2026-1000',
  severity: 'critical',
  purl: 'pkg:deb/debian/libssl3@3.0.1',
  packageName: 'libssl3',
  packageType: 'deb',
  packageVersion: '3.0.1',
  fixedIn: ['3.0.2'],
  reason: 'no_patcher',
};

const GOOD = [
  '--- a/build/Dockerfile.custom',
  '+++ b/build/Dockerfile.custom',
  '@@ -2,3 +2,3 @@',
  ' FROM ghcr.io/x/base:1',
  '-RUN install-pkgs libssl3',
  '+RUN install-pkgs libssl3=3.0.2',
  ' USER 1000:1000',
].join('\n');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ask-patch-'));
  await mkdir(join(dir, 'build'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(dir, 'build', 'Dockerfile.custom'), 'FROM ghcr.io/x/base:1\nRUN install-pkgs libssl3\nUSER 1000:1000\n');
  await writeFile(join(dir, 'node_modules', 'x', 'package.json'), '{}');
  await writeFile(join(dir, 'secrets.env'), 'TOKEN=abc');
  await writeFile(join(dir, 'main.go'), 'package main');
});
afterEach(async () => {
  svc.setAskAgentPatchDrafter();
  await rm(dir, { recursive: true, force: true });
});

describe('draftAskAgentPatch', () => {
  it('shows the agent only the build files and keeps an in-scope diff', async () => {
    const drafter = jest.fn(async () => ({ diff: GOOD }));
    svc.setAskAgentPatchDrafter(drafter);
    expect(await svc.draftAskAgentPatch({ remediationId: 'r-1', orgId: 'org-a', workdir: dir, findings: [finding] })).toEqual({ diff: GOOD });
    const req = (drafter.mock.calls[0] as unknown[])[0] as { files: Array<{ path: string }>; findings: unknown[] };
    expect(req.files.map((f) => f.path)).toEqual(['build/Dockerfile.custom']);
    expect(req.findings).toEqual([{ id: 'CVE-2026-1000', severity: 'critical', packageName: 'libssl3', packageType: 'deb', packageVersion: '3.0.1', fixedIn: ['3.0.2'] }]);
  });

  it('drops a diff that touches other files, adds a file, or changes unrelated lines', async () => {
    const out = (diff: string) => { svc.setAskAgentPatchDrafter(async () => ({ diff })); return svc.draftAskAgentPatch({ remediationId: 'r', orgId: 'o', workdir: dir, findings: [finding] }); };
    expect(await out(GOOD.replace(/build\/Dockerfile\.custom/g, 'main.go'))).toBeNull();
    expect(await out('--- /dev/null\n+++ b/build/new.sh\n@@ -0,0 +1 @@\n+libssl3')).toBeNull();
    expect(await out(`${GOOD}\n-USER 1000:1000\n+USER root`)).toBeNull();
    expect(await out('not a diff')).toBeNull();
    expect(await out('')).toBeNull();
  });

  it('answers null when the agent cannot draft one (the live transport until its contract exists), or there are no build files', async () => {
    expect(await svc.draftAskAgentPatch({ remediationId: 'r', orgId: 'o', workdir: dir, findings: [finding] })).toBeNull();
    svc.setAskAgentPatchDrafter(async () => { throw new Error('model down'); });
    expect(await svc.draftAskAgentPatch({ remediationId: 'r', orgId: 'o', workdir: dir, findings: [finding] })).toBeNull();
    const empty = await mkdtemp(join(tmpdir(), 'ask-empty-'));
    const drafter = jest.fn(async () => ({ diff: GOOD }));
    svc.setAskAgentPatchDrafter(drafter);
    expect(await svc.draftAskAgentPatch({ remediationId: 'r', orgId: 'o', workdir: empty, findings: [finding] })).toBeNull();
    expect(drafter).not.toHaveBeenCalled();
    await rm(empty, { recursive: true, force: true });
  });

  it('a remediation carrying an Ask agent patch is propose-only, even in apply mode', () => {
    expect(remediationPublishMode('apply', { majorUpgrade: false, hasSmokeTest: true, askAgentPatch: true })).toEqual({ mode: 'propose', proposeReasons: ['ask_agent_patch'] });
    expect(remediationPublishMode('apply', { majorUpgrade: false, hasSmokeTest: true, askAgentPatch: false }).mode).toBe('apply');
  });
});
