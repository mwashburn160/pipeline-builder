// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { type Command } from 'commander';
import { ensureCdkAvailable } from './cdk-utils.js';

export type LocalTool = 'cdk';

/**
 * Per-command local-tool requirements, checked by the CLI's `preAction` hook
 * BEFORE a command's action runs — so a missing tool fails fast with an
 * actionable message instead of deep inside a cdk run. Keyed by full command
 * path (e.g. "pipeline deploy").
 *
 * Only `pipeline synth`/`deploy` and `infra bootstrap` shell out to cdk
 * (nothing is bundled locally). Every
 * other command is API-only and requires nothing local, so it's absent here
 * and never gated — as are version / help / completions. (`infra provision`
 * runs its own target-specific prereq checks.)
 */
const COMMAND_TOOL_REQUIREMENTS: Record<string, LocalTool[]> = {
  'pipeline synth': ['cdk'],
  'pipeline deploy': ['cdk'],
  'infra bootstrap': ['cdk'],
};

/** Full space-joined command path for a Commander command, e.g. "pipeline deploy". */
export function commandPath(cmd: Command): string {
  const parts: string[] = [];
  let c: Command | undefined = cmd;
  while (c && c.parent) {
    parts.unshift(c.name());
    c = c.parent ?? undefined;
  }
  return parts.join(' ');
}

/** The local tools a command declares it needs (empty when it needs nothing). */
export function requiredToolsFor(cmd: Command): LocalTool[] {
  return COMMAND_TOOL_REQUIREMENTS[commandPath(cmd)] ?? [];
}

/**
 * Preflight the local tools an about-to-run command declares. Reuses the tools'
 * `ensureX` helpers (which print the actionable message + install hint on
 * failure), then exits non-zero so the command body never runs. No-op for any
 * command without requirements (API-only commands, version/help/completions).
 */
export function preflightCommandTools(actionCommand: Command): void {
  const reqs = requiredToolsFor(actionCommand);
  if (reqs.length === 0) return;
  try {
    if (reqs.includes('cdk')) ensureCdkAvailable();
  } catch {
    // Message already printed by ensureX. Halt before the action runs so the
    // command doesn't proceed with a broken toolchain.
    process.exit(1);
  }
}
