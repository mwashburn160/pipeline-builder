// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The registry's BLOB garbage collection runs in every deploy tree, inside
 * the push freeze image-registry applies around it.
 *
 * Every manifest delete image-registry makes removes a reference only;
 * Distribution never frees the bytes by itself. For a long time no tree ran
 * `registry garbage-collect` at all, while a code comment claimed Distribution
 * "reconciles the blob store on its own schedule". This pins three things,
 * each of which fails silently when it drifts:
 *
 *  - the job exists in every tree (a missing one is unbounded storage growth
 *    that the reference-based quota hides);
 *  - it runs at the window image-registry freezes pushes around
 *    (packages/api-core/src/helpers/blob-gc-window.ts) — a job at another
 *    time sweeps while pushes land, and corrupts images rather than failing;
 *  - it never passes `--delete-untagged`, which would delete the untagged
 *    manifests pipelines pin by digest.
 */

import { describe, it, expect } from '@jest/globals';
import { K8S_TARGETS, read, yamlDocs } from '../src/index.js';

const WINDOW_SRC = read('packages/api-core/src/helpers/blob-gc-window.ts');
const num = (key: string): number => {
  const m = new RegExp(`\\b${key}:\\s*(\\d+)`).exec(WINDOW_SRC);
  if (!m) throw new Error(`blob-gc-window.ts no longer declares ${key}`);
  return Number(m[1]);
};
const DAY = num('dayOfWeekUtc');
const HOUR = num('startHourUtc');
const MINUTE = num('startMinuteUtc');
const MAX_RUN_MINUTES = num('maxRunMinutes');

interface CronJob {
  kind: string;
  metadata: { name: string };
  spec: {
    schedule: string;
    timeZone?: string;
    concurrencyPolicy?: string;
    jobTemplate: { spec: { activeDeadlineSeconds?: number; template: { metadata: { labels: Record<string, string> }; spec: { containers: Array<{ image: string; args?: string[]; command?: string[] }> } } } };
  };
}

describe.each(K8S_TARGETS)('%s — registry-blob-gc CronJob', (target) => {
  const docs = yamlDocs<CronJob>(`${target}/k8s/registry.yaml`);
  const job = docs.find((d) => d.kind === 'CronJob' && d.metadata.name === 'registry-blob-gc');
  const deployment = docs.find((d) => d.kind === 'Deployment') as unknown as { spec: { template: { spec: { containers: Array<{ image: string }> } } } };

  it('exists, in registry.yaml (which the kustomization applies)', () => {
    expect(job).toBeDefined();
    expect(read(`${target}/k8s/kustomization.yaml`)).toMatch(/^\s*- registry\.yaml$/m);
  });

  it('is scheduled at the window image-registry freezes pushes around, in UTC', () => {
    expect(job!.spec.schedule).toBe(`${MINUTE} ${HOUR} * * ${DAY}`);
    expect(job!.spec.timeZone).toBe('Etc/UTC');
    expect(job!.spec.concurrencyPolicy).toBe('Forbid');
  });

  it('is killed before the freeze ends', () => {
    expect(job!.spec.jobTemplate.spec.activeDeadlineSeconds).toBe(MAX_RUN_MINUTES * 60);
  });

  it('refuses to run outside the window, and never deletes untagged manifests', () => {
    const script = (job!.spec.jobTemplate.spec.template.spec.containers[0].args ?? []).join('\n');
    expect(script).toContain('registry garbage-collect /etc/distribution/config.yml');
    expect(script).not.toContain('delete-untagged');
    const start = HOUR * 100 + MINUTE;
    const end = start + MAX_RUN_MINUTES;
    expect(script).toContain(`[ "$hm" -lt ${start} ]`);
    expect(script).toContain(`[ "$hm" -ge ${end} ]`);
    expect(script).toContain(`[ "$dow" != "${DAY}" ]`);
  });

  it('runs the same registry image as the registry, and is not selected by its Service', () => {
    const tmpl = job!.spec.jobTemplate.spec.template;
    expect(tmpl.spec.containers[0].image).toBe(deployment.spec.template.spec.containers[0].image);
    expect(tmpl.metadata.labels.app).toBe('registry-blob-gc');
  });

  it('may reach RustFS', () => {
    const netpol = read(`${target}/k8s/networkpolicy.yaml`);
    const policy = netpol.slice(netpol.indexOf('name: allow-rustfs-from-services'));
    expect(policy.slice(0, policy.indexOf('\n---'))).toContain('registry-blob-gc');
  });
});

describe('deploy/local/docker — registry-blob-gc service', () => {
  const compose = read('deploy/local/docker/docker-compose.yml');
  const svc = compose.slice(compose.indexOf('\n  registry-blob-gc:'));
  const body = svc.slice(0, svc.indexOf('\n\n'));

  it('exists', () => {
    expect(compose).toContain('\n  registry-blob-gc:');
  });

  it('sleeps to the same weekly window and is killed before the freeze ends', () => {
    // seconds after midnight of the window's start
    expect(body).toContain(`+ ${(HOUR * 60 + MINUTE) * 60} ))`);
    expect(body).toContain('((7 - dow) % 7)');
    expect(DAY).toBe(0); // the loop's `(7 - dow) % 7` is "days until Sunday"
    expect(body).toContain(`timeout ${MAX_RUN_MINUTES * 60} registry garbage-collect /etc/distribution/config.yml`);
    expect(body).not.toContain('delete-untagged');
  });
});
