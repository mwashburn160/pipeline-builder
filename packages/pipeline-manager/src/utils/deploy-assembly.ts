// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What the runner's deploy job (`pipeline deploy-job`) reads from the cloud
 * assembly it synthesized, BEFORE `cdk deploy` runs:
 *  - the stack it is about to deploy, by name (the request's stack name must
 *    be the one the synth produced, in the request's region);
 *  - Docker image assets — the deploy build is NOT privileged (no Docker
 *    daemon). The stacks this product synthesizes have none (pipeline-core
 *    builds every image from the registry, pinned by digest, and bundles no
 *    asset: test/deploy-assembly.test.ts), so any found means the definition
 *    changed in a way the runner cannot deploy → DEPLOY_NEEDS_PRIVILEGED;
 *  - the Secrets Manager names its CodeBuild projects read, so a missing one
 *    is reported up front (ACCOUNT_SECRETS_MISSING) instead of as a failed
 *    first execution.
 * Plain file reads: no AWS call, no CDK library.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface AssemblyManifest {
  artifacts?: Record<string, {
    type?: string;
    environment?: string;
    properties?: { templateFile?: string; stackName?: string };
    displayName?: string;
  }>;
}

export interface AssemblyStack {
  stackName: string;
  /** From the artifact's `aws://<account>/<region>` environment (`unknown-region` when environment-agnostic). */
  region: string;
  template: Record<string, unknown>;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf-8'));

/** The stack `stackName` of the cloud assembly in `dir`, or undefined when it holds none of that name. */
export function assemblyStack(dir: string, stackName: string): AssemblyStack | undefined {
  const manifest = readJson(join(dir, 'manifest.json')) as AssemblyManifest;
  for (const [id, a] of Object.entries(manifest.artifacts ?? {})) {
    if (a.type !== 'aws:cloudformation:stack') continue;
    const name = a.properties?.stackName ?? id;
    if (name !== stackName) continue;
    const region = /^aws:\/\/[^/]*\/(.+)$/.exec(a.environment ?? '')?.[1] ?? 'unknown-region';
    const template = readJson(join(dir, a.properties?.templateFile ?? `${id}.template.json`)) as Record<string, unknown>;
    return { stackName: name, region, template };
  }
  return undefined;
}

/** How many Docker image assets the assembly's asset manifests declare (nested assemblies included). */
export function dockerImageAssetCount(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name.startsWith('assembly-')) {count += dockerImageAssetCount(path);} else if (entry.isFile() && entry.name.endsWith('.assets.json')) {
      const assets = readJson(path) as { dockerImages?: Record<string, unknown> };
      count += Object.keys(assets.dockerImages ?? {}).length;
    }
  }
  return count;
}

/** A Secrets Manager reference as CodeBuild takes it: a name, `name:json-key:…`, or an ARN — to the bare name. */
function secretName(ref: unknown): string | undefined {
  if (typeof ref === 'string') {
    const arn = /:secretsmanager:[^:]*:[^:]*:secret:(.+)$/.exec(ref);
    const raw = arn ? arn[1]! : ref;
    return raw.split(':')[0] || undefined;
  }
  // CDK renders an imported secret's ARN as Fn::Join of literal parts: the last literal holds `secret:<name>`.
  const join = (ref as { 'Fn::Join'?: [string, unknown[]] } | null)?.['Fn::Join'];
  if (join && Array.isArray(join[1])) return secretName(join[1].filter((p) => typeof p === 'string').join(''));
  return undefined;
}

/**
 * Every Secrets Manager name the template's CodeBuild projects read: their
 * SECRETS_MANAGER env vars, registry credentials and the PLATFORM_SECRET_NAME
 * the synth reads itself. Only `pipeline-builder/…` names — the platform's
 * naming (the deploy role may describe nothing else). Sorted, de-duplicated.
 */
export function templateSecretNames(template: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const resources = (template.Resources ?? {}) as Record<string, { Type?: string; Properties?: Record<string, any> }>;
  for (const r of Object.values(resources)) {
    if (r.Type !== 'AWS::CodeBuild::Project') continue;
    const env = r.Properties?.Environment as { RegistryCredential?: { Credential?: unknown }; EnvironmentVariables?: Array<{ Name?: string; Type?: string; Value?: unknown }> } | undefined;
    const add = (ref: unknown) => { const n = secretName(ref); if (n?.startsWith('pipeline-builder/')) out.add(n); };
    add(env?.RegistryCredential?.Credential);
    for (const v of env?.EnvironmentVariables ?? []) {
      if (v.Type === 'SECRETS_MANAGER' || v.Name === 'PLATFORM_SECRET_NAME') add(v.Value);
    }
  }
  return [...out].sort();
}
