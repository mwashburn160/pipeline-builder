// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift-guard for the shipped `postgres-init.sql`. Each of the four targets
 * (docker, minikube, ec2, eks) ships its own copy, and the copies are held
 * BYTE-identical by a deploy contract (test/deploy-contracts,
 * bringup-contract.test.ts) — RLS policies are security-relevant and a copy
 * that silently diverges is how a tenant-isolation gap ships to one
 * environment only. This suite reads the docker copy, the one the PGlite
 * harness boots from.
 *
 * It also pins the messaging RLS RECIPIENT carve-out: `messages` /
 * `message_attachments` need a dedicated policy so a recipient org can read a
 * message addressed to it (the generic sender-only scope would block org<->org
 * messaging). A refactor that folds them back into the generic loop, or drops
 * the carve-out, would reintroduce the latent block — this test fails loudly if so.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from '@jest/globals';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const INIT_FILE = 'deploy/local/docker/postgres-init.sql';

const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

describe('postgres-init.sql RLS drift-guard', () => {
  const docker = read(INIT_FILE);

  it('messages has a dedicated RLS policy with the recipient + broadcast carve-outs', () => {
    // Recipient org can read a message addressed to it…
    expect(docker).toContain('recipient_org_id = current_org_id()');
    // …and everyone sees a '*' broadcast announcement.
    expect(docker).toMatch(/recipient_org_id = '\*'/);
    expect(docker).toContain('CREATE POLICY rls_org_read ON messages FOR SELECT');
  });

  it('message_attachments visibility follows the parent message (EXISTS carve-out)', () => {
    expect(docker).toContain('CREATE POLICY rls_org_read ON message_attachments FOR SELECT');
    expect(docker).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM messages m/);
    expect(docker).toContain('m.id = message_attachments.message_id');
  });

  it('messages/message_attachments are NOT in the generic sender-only loop', () => {
    // The generic loop builds the `rls_org_*` policies from an ARRAY[...] of table names.
    // Extract that array literal and assert the messaging tables were pulled out
    // (they must use their dedicated recipient-aware policy instead).
    const arrayMatch = docker.match(/SELECT unnest\(ARRAY\[([\s\S]*?)\]\)/);
    expect(arrayMatch).not.toBeNull();
    const genericList = arrayMatch![1];
    expect(genericList).not.toMatch(/'messages'/);
    expect(genericList).not.toMatch(/'message_attachments'/);
  });

  it('messaging tables still FORCE row level security (owner is not exempt)', () => {
    expect(docker).toContain('ALTER TABLE messages FORCE ROW LEVEL SECURITY');
    expect(docker).toContain('ALTER TABLE message_attachments FORCE ROW LEVEL SECURITY');
  });

  it('no policy is FOR ALL on a tenant table — read carve-outs never become write carve-outs', () => {
    // Everything before the ecosystem-GLOBAL loop (whose app-role policy is FOR ALL by design).
    const tenantSection = docker.slice(docker.indexOf('ROW-LEVEL SECURITY (multi-tenancy'), docker.indexOf('Plugin ecosystem, GLOBAL half'));
    expect(tenantSection).not.toMatch(/CREATE POLICY[^;]*FOR ALL/);
    expect(tenantSection).not.toMatch(/CREATE POLICY rls_org_scope/);
    // Every write policy is own-org only — the system-org / recipient carve-outs appear only in reads.
    for (const m of tenantSection.matchAll(/CREATE POLICY rls_org_(insert|update|delete)[\s\S]*?;/g)) {
      expect(m[0]).not.toContain("'000000000000000000000001'");
      expect(m[0]).not.toContain('recipient_org_id');
    }
  });

  it('pipeline_templates and compliance_entitlement_watermark are RLS-scoped and FORCEd', () => {
    const arrayMatch = docker.match(/SELECT unnest\(ARRAY\[([\s\S]*?)\]\)/);
    expect(arrayMatch![1]).toContain("'compliance_entitlement_watermark'");
    expect(docker).toContain('CREATE POLICY rls_org_read ON pipeline_templates FOR SELECT');
    expect(docker).toMatch(/org_id = '000000000000000000000001' AND visibility = 'public'/);
    expect(docker).toContain('ALTER TABLE pipeline_templates FORCE ROW LEVEL SECURITY');
    expect(docker).toContain('ALTER TABLE compliance_entitlement_watermark FORCE ROW LEVEL SECURITY');
  });

  it('a recipient may update messages only through the read-state guard trigger', () => {
    expect(docker).toContain('CREATE POLICY rls_recipient_update ON messages FOR UPDATE');
    expect(docker).toContain('CREATE TRIGGER messages_participant_update_guard');
    expect(docker).toMatch(/BEFORE UPDATE ON messages/);
  });

  it('the banner counts the FORCEd tenant tables it lists', () => {
    const forced = new Set([...docker.matchAll(/ALTER TABLE (\w+) FORCE ROW LEVEL SECURITY/g)].map((m) => m[1]));
    const loopForced = docker.match(/FOREACH t IN ARRAY ARRAY\[|FOR t IN\s+SELECT unnest\(ARRAY\[\s*'compliance_policies'[\s\S]*?\]\)/);
    expect(loopForced).not.toBeNull();
    const complianceLoop = docker.match(/SELECT unnest\(ARRAY\[\s*'compliance_policies'([\s\S]*?)\]\)\s*LOOP\s*EXECUTE format\('ALTER TABLE %I FORCE/);
    const compliance = [...(("'compliance_policies'" + complianceLoop![1]).matchAll(/'(\w+)'/g))].map((m) => m[1]);
    compliance.forEach((t) => forced.add(t));
    const banner = docker.match(/on every tenant table \((\d+)\/(\d+)\)/);
    expect(banner).not.toBeNull();
    expect(Number(banner![1])).toBe(forced.size);
    expect(Number(banner![2])).toBe(forced.size);
  });
});
