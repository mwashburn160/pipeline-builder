// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared readers for the deploy contract suites. Everything is resolved from
 * the repository root, so a suite reads the same file wherever jest runs.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseAllDocuments } from 'yaml';

/** The repository root (this file lives at test/deploy-contracts/src). */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** The three Kubernetes targets, each with its own standalone manifest tree. */
export const K8S_TARGETS = ['deploy/local/minikube', 'deploy/aws/ec2', 'deploy/aws/eks'] as const;

/** Every deploy target: docker compose plus the Kubernetes targets. */
export const ALL_TARGETS = ['deploy/local/docker', ...K8S_TARGETS] as const;

/** A repository file as text. */
export function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8');
}

/** The non-empty YAML documents of a repository file, as plain objects. */
export function yamlDocs<T = Record<string, unknown>>(rel: string): T[] {
  return parseAllDocuments(read(rel)).map((d) => d.toJSON() as T).filter(Boolean);
}
