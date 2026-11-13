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

  describe('managed toolchain tables (dedicated policies, not the generic loop)', () => {
    const SYSTEM_ONLY = ['toolchain_release', 'toolchain_platform_default', 'toolchain_default_history', 'toolchain_rollout'];
    const OWN_ORG = ['org_toolchain_default', 'org_toolchain_default_history'];
    const SYSTEM_SCOPE = "current_is_sysadmin() OR current_org_id() = ''000000000000000000000001''";

    it('none of the six rides the generic org loop (its system-row read carve-out would expose them)', () => {
      const genericList = docker.match(/SELECT unnest\(ARRAY\[([\s\S]*?)\]\)/)![1];
      for (const t of [...SYSTEM_ONLY, ...OWN_ORG]) expect(genericList).not.toContain(`'${t}'`);
    });

    it('the system-only four get system-scope policies for every command, and nothing else', () => {
      const loop = docker.match(/FOREACH t IN ARRAY ARRAY\[\s*'toolchain_release'([\s\S]*?)\]\s*LOOP([\s\S]*?)END LOOP;/);
      expect(loop).not.toBeNull();
      const tables = [...("'toolchain_release'" + loop![1]).matchAll(/'(\w+)'/g)].map((m) => m[1]);
      expect(tables.sort()).toEqual([...SYSTEM_ONLY].sort());
      const body = loop![2];
      expect(body).toContain('PERFORM pb_reset_policies(t)');
      const policies = [...body.matchAll(/CREATE POLICY (\w+) ON %I FOR (\w+)[\s\S]*?\)',\s*t/g)];
      expect(policies.map((m) => `${m[1]} ${m[2]}`)).toEqual([
        'rls_system_read SELECT', 'rls_system_insert INSERT', 'rls_system_update UPDATE', 'rls_system_delete DELETE',
      ]);
      for (const m of policies) {
        // Only the system scope; no own-org leg (a canary row's org_id is a member, not an owner).
        expect(m[0]).toContain(SYSTEM_SCOPE);
        expect(m[0]).not.toMatch(/org_id = current_org_id\(\)/);
      }
    });

    it('org_toolchain_default: own-org read/write, system-org read, no system-row carve-out', () => {
      const readPolicy = docker.match(/CREATE POLICY rls_org_read ON org_toolchain_default FOR SELECT[\s\S]*?;/)![0];
      expect(readPolicy).toContain('org_id = current_org_id()');
      expect(readPolicy).toContain("current_org_id() = '000000000000000000000001'");
      expect(readPolicy).not.toContain("org_id = '000000000000000000000001'");
      for (const cmd of ['insert', 'update', 'delete']) {
        expect(docker).toMatch(new RegExp(`CREATE POLICY rls_org_${cmd} ON org_toolchain_default FOR ${cmd.toUpperCase()}`));
      }
    });

    it('org_toolchain_default_history: own-org read + insert; update/delete are sysadmin-only', () => {
      const readPolicy = docker.match(/CREATE POLICY rls_org_read ON org_toolchain_default_history FOR SELECT[\s\S]*?;/)![0];
      expect(readPolicy).toContain('org_id = current_org_id()');
      expect(readPolicy).not.toContain("org_id = '000000000000000000000001'");
      expect(docker).toContain('CREATE POLICY rls_org_insert ON org_toolchain_default_history FOR INSERT');
      expect(docker).not.toMatch(/CREATE POLICY rls_org_(update|delete) ON org_toolchain_default_history/);
      for (const cmd of ['update', 'delete']) {
        const p = docker.match(new RegExp(`CREATE POLICY rls_staff_${cmd} ON org_toolchain_default_history[\\s\\S]*?;`))![0];
        expect(p).not.toContain('current_org_id()');
      }
    });

    it('all six are ENABLEd and FORCEd', () => {
      for (const t of OWN_ORG) expect(docker).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      for (const t of [...SYSTEM_ONLY, ...OWN_ORG]) expect(docker).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    });
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
