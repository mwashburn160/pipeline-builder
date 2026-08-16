// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift-guard for the four shipped `postgres-init.sql` copies (docker, minikube,
 * ec2, eks). They MUST stay byte-identical — RLS policies are security-relevant
 * and a copy that silently diverges is how a tenant-isolation gap ships to one
 * environment only.
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
const INIT_FILES = [
  'deploy/local/docker/postgres-init.sql',
  'deploy/local/minikube/postgres-init.sql',
  'deploy/aws/ec2/postgres-init.sql',
  'deploy/aws/eks/postgres-init.sql',
];

const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

describe('postgres-init.sql RLS drift-guard', () => {
  const docker = read(INIT_FILES[0]);

  it('all four environment copies are byte-identical', () => {
    for (const rel of INIT_FILES.slice(1)) {
      // Compared to the docker copy; a diff points at whichever env drifted.
      expect({ file: rel, content: read(rel) }).toEqual({ file: rel, content: docker });
    }
  });

  it('messages has a dedicated RLS policy with the recipient + broadcast carve-outs', () => {
    // Recipient org can read a message addressed to it…
    expect(docker).toContain('recipient_org_id = current_org_id()');
    // …and everyone sees a '*' broadcast announcement.
    expect(docker).toMatch(/recipient_org_id = '\*'/);
    expect(docker).toContain('CREATE POLICY rls_org_scope ON messages');
  });

  it('message_attachments visibility follows the parent message (EXISTS carve-out)', () => {
    expect(docker).toContain('CREATE POLICY rls_org_scope ON message_attachments');
    expect(docker).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM messages m/);
    expect(docker).toContain('m.id = message_attachments.message_id');
  });

  it('messages/message_attachments are NOT in the generic sender-only loop', () => {
    // The generic loop builds `rls_org_scope` from an ARRAY[...] of table names.
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
});
