// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pb_wire_ses_provider (deploy/bin/gen-env-secrets.sh) — an existing eks .env
 * that still holds the template's SMTP placeholders is switched to SES on a
 * re-deploy, and nothing else is.
 *
 * Without it, setup.sh wired EMAIL_PROVIDER=ses only when it GENERATED the
 * .env: a re-deploy onto an older one provisioned SES and the Pod Identity
 * grant, then left the platform dialling localhost:587 — every invite failed
 * with "No invitation email went out".
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT, read } from '../src/index.js';

const SCRIPT = join(REPO_ROOT, 'deploy/bin/gen-env-secrets.sh');

/** Run pb_wire_ses_provider over `env` and return the rewritten file. */
function wire(env: string, configSet = 'pipeline-builder-email'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ses-wiring-'));
  try {
    const file = join(dir, '.env');
    writeFileSync(file, env);
    const r = spawnSync('bash', ['-c', '. "$1"; pb_wire_ses_provider "$2" "$3"', '_', SCRIPT, file, configSet], { encoding: 'utf-8' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    return readFileSync(file, 'utf-8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PLACEHOLDER = 'EMAIL_PROVIDER=smtp\nSMTP_HOST=localhost\nSMTP_USER=your-smtp-user\nSES_CONFIGURATION_SET=\n';

describe('pb_wire_ses_provider', () => {
  it('switches the template SMTP placeholder to SES and fills the configuration set', () => {
    const out = wire(PLACEHOLDER);
    expect(out).toMatch(/^EMAIL_PROVIDER=ses$/m);
    expect(out).toMatch(/^SES_CONFIGURATION_SET=pipeline-builder-email$/m);
    // Nothing else is touched.
    expect(out).toMatch(/^SMTP_USER=your-smtp-user$/m);
  });

  it('treats an empty SMTP_HOST as unconfigured too', () => {
    expect(wire('EMAIL_PROVIDER=smtp\nSMTP_HOST=\nSES_CONFIGURATION_SET=\n')).toMatch(/^EMAIL_PROVIDER=ses$/m);
  });

  it('leaves a real SMTP relay alone', () => {
    const env = 'EMAIL_PROVIDER=smtp\nSMTP_HOST=smtp.example.com\nSES_CONFIGURATION_SET=\n';
    expect(wire(env)).toBe(env);
  });

  it('keeps an operator-set configuration set', () => {
    expect(wire('EMAIL_PROVIDER=ses\nSES_CONFIGURATION_SET=custom-set\n')).toMatch(/^SES_CONFIGURATION_SET=custom-set$/m);
  });

  it('fills a blank configuration set on an install already on SES', () => {
    expect(wire('EMAIL_PROVIDER=ses\nSES_CONFIGURATION_SET=\n')).toMatch(/^SES_CONFIGURATION_SET=pipeline-builder-email$/m);
  });

  it('reads quoted values the way `source` does', () => {
    expect(wire('EMAIL_PROVIDER="smtp"\nSMTP_HOST="localhost"\nSES_CONFIGURATION_SET=""\n')).toMatch(/^EMAIL_PROVIDER=ses$/m);
  });
});

describe('eks setup.sh — SES wiring runs on every deploy', () => {
  const setup = read('deploy/aws/eks/bin/setup.sh');

  it('calls pb_wire_ses_provider AFTER the fresh-seed branch, gated on EMAIL_ENABLED', () => {
    const reuse = setup.indexOf('reusing existing .env');
    const call = setup.indexOf('pb_wire_ses_provider "$ENV_FILE"');
    expect(reuse).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(reuse);
    expect(setup.slice(setup.lastIndexOf('\n', setup.lastIndexOf('if', call)), call)).toContain('EMAIL_ENABLED');
  });
});

describe('SES send permission matches how platform sends', () => {
  // platform/src/utils/email.ts sends through nodemailer's SES transport, which
  // submits a RAW message: SES authorizes that as ses:SendRawEmail. It also
  // authorizes every identity on the message (in the sandbox, each recipient's)
  // and the configuration set the send routes through. Granting only
  // ses:SendEmail on the domain identity AccessDenied every send.
  const targets = {
    eks: read('deploy/aws/eks/bin/setup.sh'),
    ec2: read('deploy/aws/ec2/template.yaml'),
  };

  it.each(Object.entries(targets))('%s grants SendRawEmail on identity/* and the configuration set, From-scoped', (_t, src) => {
    expect(src).toContain('ses:SendRawEmail');
    expect(src).toMatch(/identity\/\*/);
    expect(src).toMatch(/configuration-set\//);
    expect(src).toContain('ses:FromAddress');
  });
});
