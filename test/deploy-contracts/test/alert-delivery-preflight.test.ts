// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pb_check_alert_delivery (deploy/bin/gen-env-secrets.sh) — the deploy-time gate
 * on ops-team alert delivery. A Slack webhook can be well-formed and still dead
 * (revoked, channel archived); Slack then answers 404/403/410 and every page
 * vanishes exactly as with a placeholder. The pre-flight therefore POSTs a test
 * message and fails the deploy on a definitive rejection — while only WARNING
 * when this host simply cannot reach Slack (the in-cluster path is proven by
 * post-provision-smoke.sh). `curl` is stubbed on PATH so the test never touches
 * the network.
 */

import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

const SCRIPT = join(REPO_ROOT, 'deploy/bin/gen-env-secrets.sh');
const HOOK = 'https://hooks.slack.com/services/T0AAAAAAA/B0BBBBBBB/abcdefghijklmnop';

function runPreflight(curlBehaviour: string, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-alert-preflight-'));
  try {
    const env = join(dir, '.env');
    writeFileSync(env, `SLACK_CRITICAL_WEBHOOK_URL=${HOOK}\nSLACK_WARNING_WEBHOOK_URL=${HOOK}\n`);
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin]);
    // Fake curl: logs that it was called, then behaves as asked.
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\necho called >> "${dir}/curl.log"\n${curlBehaviour}\n`);
    chmodSync(join(bin, 'curl'), 0o755);
    const r = spawnSync('bash', ['-c', `. "${SCRIPT}"; pb_check_alert_delivery "${env}"`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
      encoding: 'utf-8',
    });
    const calls = spawnSync('sh', ['-c', `cat "${dir}/curl.log" 2>/dev/null | wc -l`], { encoding: 'utf-8' }).stdout.trim();
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: Number(calls) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('pb_check_alert_delivery — live Slack test send', () => {
  it('passes when Slack accepts the test message', () => {
    const r = runPreflight("printf '200'");
    expect(r.status).toBe(0);
    expect(r.calls).toBe(2); // critical + warning
    expect(r.out).toContain('accepted a test message');
  });

  it('FAILS the deploy when Slack rejects the webhook (revoked / archived)', () => {
    const r = runPreflight("printf '404'");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('REJECTED');
  });

  it('only warns when this host cannot reach Slack at all', () => {
    const r = runPreflight("printf '000'; exit 7");
    expect(r.status).toBe(0);
    expect(r.out).toContain('could not reach Slack');
  });

  it('can be skipped explicitly', () => {
    const r = runPreflight("printf '404'", { SKIP_ALERT_TEST_SEND: '1' });
    expect(r.status).toBe(0);
    expect(r.calls).toBe(0);
  });
});
