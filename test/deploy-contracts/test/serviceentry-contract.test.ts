// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract for the mesh-egress `ServiceEntry` manifests.
 *
 * Ambient runs ztunnel's DNS proxy (AMBIENT_DNS_CAPTURE, pinned true in
 * deploy/bin/k8s-resources.sh), so a meshed pod's DNS is answered from the mesh
 * registry — Kubernetes Services plus these ServiceEntries. A host in neither
 * gets SERVFAIL rather than a forwarded query, so an UNDECLARED host does not
 * degrade gracefully: its feature fails at DNS and reads like the remote service
 * being down. That is how platform's KMS key load and every OAuth provider came
 * to be broken at the same time.
 *
 * These assertions are the cheap half of that lesson:
 *   - the hosts whose absence silently breaks a feature are present,
 *   - no host is a wildcard (Istio allocates no address for one — measured:
 *     `*.amazonaws.com` left sts/codepipeline SERVFAILing while an explicit
 *     host resolved),
 *   - the AWS hosts stay region-templated AND both AWS bin scripts actually
 *     substitute that token, so a manifest cannot ship a literal `${AWS_REGION}`,
 *   - the two aws/ copies do not drift (no shared kustomize base, by policy),
 *   - every target's kustomization includes the file at all.
 *
 * Assertions collect failures into a list and compare against `[]` so one run
 * names every offending target/host instead of stopping at the first.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

const SE = (t: string): string => readFileSync(join(REPO_ROOT, 'deploy', t, 'k8s/serviceentry.yaml'), 'utf8');
const KUST = (t: string): string => readFileSync(join(REPO_ROOT, 'deploy', t, 'k8s/kustomization.yaml'), 'utf8');

const AWS_TARGETS = ['aws/eks', 'aws/ec2'];
const ALL_TARGETS = [...AWS_TARGETS, 'local/minikube'];

/** `- host` entries, ignoring comments and `- name:`/`- number:` port fields. */
function hosts(yaml: string): string[] {
  return yaml.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') && l.includes('.') && !l.includes(':'))
    .map((l) => l.slice(2).trim());
}

/** Absence of any of these is a silent feature outage, not a config nicety. */
const REQUIRED_AWS = ['kms.${AWS_REGION}.amazonaws.com', 'sts.${AWS_REGION}.amazonaws.com'];
const REQUIRED_SAAS = [
  'accounts.google.com', 'oauth2.googleapis.com', 'login.microsoftonline.com',
  'api.github.com', 'github.com', 'gitlab.com', 'api.bitbucket.org',
  'hooks.slack.com', 'api.pwnedpasswords.com',
];

describe('ServiceEntry egress contract', () => {
  it('declares the SaaS hosts on every meshed target', () => {
    const missing: string[] = [];
    for (const t of ALL_TARGETS) {
      const h = hosts(SE(t));
      for (const want of REQUIRED_SAAS) if (!h.includes(want)) missing.push(`${t}: ${want}`);
    }
    expect(missing).toEqual([]);
  });

  it('declares the AWS hosts on the AWS targets, and none on minikube', () => {
    const missing: string[] = [];
    for (const t of AWS_TARGETS) {
      const h = hosts(SE(t));
      for (const want of REQUIRED_AWS) if (!h.includes(want)) missing.push(`${t}: ${want}`);
    }
    expect(missing).toEqual([]);
    // minikube has no AWS dependency (env-mode secret encryption, no KMS); an
    // AWS host there would carry a region token nothing substitutes.
    expect(hosts(SE('local/minikube')).filter((h) => h.includes('amazonaws.com'))).toEqual([]);
  });

  it('uses no wildcard host, because Istio allocates no address for one', () => {
    const wild: string[] = [];
    for (const t of ALL_TARGETS) {
      for (const h of hosts(SE(t))) if (h.includes('*')) wild.push(`${t}: ${h}`);
    }
    expect(wild).toEqual([]);
  });

  it('keeps the AWS hosts region-templated', () => {
    const hardcoded: string[] = [];
    for (const t of AWS_TARGETS) {
      const awsHosts = hosts(SE(t)).filter((h) => h.includes('amazonaws.com'));
      expect(awsHosts.length).toBeGreaterThan(0);
      for (const h of awsHosts) if (!h.includes('${AWS_REGION}')) hardcoded.push(`${t}: ${h}`);
    }
    expect(hardcoded).toEqual([]);
  });

  it('substitutes that token in both AWS bin scripts', () => {
    // A template nothing expands would ship a literal `${AWS_REGION}` as a host.
    const unsubstituted = ['aws/eks/bin/setup.sh', 'aws/ec2/bin/startup.sh']
      .filter((rel) => !readFileSync(join(REPO_ROOT, 'deploy', rel), 'utf8').includes('{AWS_REGION}|${AWS_REGION}|g'));
    expect(unsubstituted).toEqual([]);
  });

  it('does not drift between the two aws/ copies', () => {
    expect(SE('aws/ec2')).toEqual(SE('aws/eks'));
  });

  it('is wired into every target kustomization', () => {
    const unwired = ALL_TARGETS.filter((t) => !KUST(t).includes('- serviceentry.yaml'));
    expect(unwired).toEqual([]);
  });
});
