// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-org namespace manifest the platform serves
 * (GET /api/admin/orgs/:orgId/k8s-namespace.yaml) is built inline so the
 * platform pod needs no deploy files mounted — which is exactly how it can
 * silently drift from the checked-in templates operators apply by hand.
 * Both are compared document by document, after substituting the same values.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import { parseAllDocuments } from 'yaml';
import { renderManifest } from '../src/helpers/org-namespace-manifest.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const TARGETS = ['deploy/local/minikube', 'deploy/aws/ec2', 'deploy/aws/eks'];
const TEMPLATES = ['namespace-template.yaml', 'network-policy-template.yaml'];
const VARS = { slug: 'acme', nsName: 'pb-org-acme', createdAt: '2026-01-01T00:00:00.000Z' };

type Doc = { kind: string; metadata: { name: string } };

/** Non-empty YAML documents, keyed `Kind/name`. */
function byKey(text: string): Record<string, Doc> {
  const out: Record<string, Doc> = {};
  for (const d of parseAllDocuments(text)) {
    const doc = d.toJSON() as Doc | null;
    if (doc) out[`${doc.kind}/${doc.metadata.name}`] = doc;
  }
  return out;
}

function renderTemplates(target: string): string {
  return TEMPLATES.map((f) => readFileSync(join(REPO_ROOT, target, 'k8s/per-org', f), 'utf8'))
    .join('\n---\n')
    .replaceAll('${ORG_SLUG}', VARS.slug)
    .replaceAll('${CREATED_AT}', VARS.createdAt);
}

describe('per-org namespace manifest', () => {
  it('keeps one identical template set in every k8s target', () => {
    const [first, ...rest] = TARGETS;
    for (const t of rest) {
      for (const f of [...TEMPLATES, 'README.md']) {
        expect([t, f, readFileSync(join(REPO_ROOT, t, 'k8s/per-org', f), 'utf8')])
          .toEqual([t, f, readFileSync(join(REPO_ROOT, first!, 'k8s/per-org', f), 'utf8')]);
      }
    }
  });

  it('serves exactly the documents the templates define', () => {
    const served = byKey(renderManifest(VARS));
    const templated = byKey(renderTemplates(TARGETS[0]!));
    expect(Object.keys(served).sort()).toEqual(Object.keys(templated).sort());
    for (const key of Object.keys(templated)) expect([key, served[key]]).toEqual([key, templated[key]]);
  });
});
