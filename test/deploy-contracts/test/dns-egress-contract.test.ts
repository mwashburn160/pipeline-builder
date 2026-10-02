// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard for the one shape of `allow-dns-egress` that actually works on EKS.
 *
 * The natural way to write "all pods may do DNS" is a rule with ports and no
 * `to:`. On EKS that silently does not work: the AWS VPC CNI NetworkPolicy
 * controller does not let a `to`-less allow override the `except` deny carried by
 * the per-app egress policies, which allow 0.0.0.0/0 EXCEPT the private ranges —
 * and `10.0.0.0/8` contains the kube-dns ClusterIP. Every pod selected by one of
 * those policies then cannot reach the cluster resolver at all.
 *
 * Measured both directions on 8 services: ports-only SERVFAILed, an explicit
 * `<dns-ip>/32` ipBlock resolved everything in 0-2ms, and `0.0.0.0/0` behaved
 * like `to`-less. It presented as platform CrashLooping on KMS `EAI_AGAIN`,
 * plugin stuck at 1/2 with 0 endpoints, and redis replicas on a stale master IP.
 *
 * So: on eks the rule must name its destination explicitly AND that destination
 * must be the substituted token (the service CIDR is a cluster creation
 * parameter, so a hardcoded IP would be wrong on some clusters). ec2 and
 * minikube do NOT run the VPC CNI policy controller and keep the permissive
 * `to`-less rule, which works there — asserted too, so the divergence stays
 * deliberate rather than drifting.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

const NETPOL = (t: string): string => readFileSync(join(REPO_ROOT, 'deploy', t, 'k8s/networkpolicy.yaml'), 'utf8');

/** The `allow-dns-egress` document out of a multi-doc manifest. */
function dnsEgressDoc(target: string): string {
  const doc = NETPOL(target).split(/^---$/m).find((d) => /name:\s*allow-dns-egress\b/.test(d));
  if (!doc) throw new Error(`${target}: no allow-dns-egress policy`);
  return doc;
}

/**
 * The same document with comments dropped. The comment explains the `0.0.0.0/0`
 * and `to`-less shapes that were measured NOT to work, so asserting on the raw
 * text would match the explanation rather than the rule.
 */
function dnsEgressRule(target: string): string {
  return dnsEgressDoc(target).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
}

describe('allow-dns-egress contract', () => {
  it('names its destination explicitly on eks, via the substituted token', () => {
    const rule = dnsEgressRule('aws/eks');
    expect(rule).toContain('to:');
    expect(rule).toContain('${DNS_CLUSTER_IP}/32');
    // 0.0.0.0/0 was measured to behave like `to`-less — it must not creep back.
    expect(rule).not.toContain('0.0.0.0/0');
  });

  it('has setup.sh read that ClusterIP and substitute the token', () => {
    const sh = readFileSync(join(REPO_ROOT, 'deploy/aws/eks/bin/setup.sh'), 'utf8');
    // Read from the cluster, never assumed.
    expect(sh).toContain("get svc kube-dns -o jsonpath='{.spec.clusterIP}'");
    expect(sh).toContain('{DNS_CLUSTER_IP}|${PB_DNS_CLUSTER_IP}|g');
    // And fail loudly rather than shipping an empty ipBlock.
    expect(sh).toContain('could not read the kube-dns ClusterIP');
  });

  it('keeps the permissive rule on the targets without the VPC CNI policy controller', () => {
    for (const t of ['aws/ec2', 'local/minikube']) {
      const rule = dnsEgressRule(t);
      expect(rule).toContain('port: 53');
      expect(rule).not.toContain('DNS_CLUSTER_IP');
    }
  });

  it('still allows DNS over both UDP and TCP everywhere', () => {
    for (const t of ['aws/eks', 'aws/ec2', 'local/minikube']) {
      const rule = dnsEgressRule(t);
      expect(rule).toContain('protocol: UDP');
      expect(rule).toContain('protocol: TCP');
    }
  });
});
