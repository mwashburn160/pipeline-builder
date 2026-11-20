// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Ask agent patch fallback of Stage 2 (docs/plugin-publishing.md "Scan
 * gates"): when no patcher fits a finding (an unusual Dockerfile or build
 * layout, reason `no_patcher`), the Ask agent drafts a patch for the remaining
 * findings.
 *
 * The draft is only ever a CANDIDATE:
 *  - it is pre-checked here (a unified diff that only modifies the build
 *    files it was shown, only lines naming a targeted package or its fixed
 *    version, within size caps) and dropped otherwise;
 *  - the engine then runs it through the same verification as any patch (full
 *    build gate, targeted findings gone, no new findings, contract check,
 *    smokeTest, diff scope);
 *  - and a remediation carrying it is ALWAYS propose-only
 *    (`remediationPublishMode(…, { askAgentPatch: true })` adds
 *    `ask_agent_patch`): never auto-published, whatever the org mode.
 *
 * Transport: the drafter is pluggable. The live one needs an ask-agent
 * internal endpoint that is not in the api-core contracts yet; until it is,
 * the live drafter answers "unavailable" and the findings go to the owner as
 * `no_patcher`.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { createLogger, errorMessage, type RemediationRemainingFinding } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';

const logger = createLogger('remediation-ask-agent-patch');

/** Build files shown to the agent: Dockerfiles and package manifests / lockfile inputs. */
const BUILD_FILE = /(^|\/)(Dockerfile(\.[\w-]+)?|plugin-spec\.ya?ml|package\.json|requirements[\w.-]*\.txt|constraints[\w.-]*\.txt|pyproject\.toml|Pipfile|go\.mod|pom\.xml|build\.gradle(\.kts)?|Gemfile|Cargo\.toml|[\w.-]+\.csproj|Directory\.Packages\.props)$/;
/** Per-file and total caps on what is shown. */
export const ASK_PATCH_FILE_MAX_BYTES = 64 * 1024;
export const ASK_PATCH_TOTAL_MAX_BYTES = 256 * 1024;
export const ASK_PATCH_MAX_FILES = 40;
/** The largest diff accepted back. */
export const ASK_PATCH_DIFF_MAX_BYTES = 64 * 1024;
/** Directories never walked. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv', 'target', 'dist', '__pycache__']);

/** One build file the agent may edit. */
export interface AskPatchFile { path: string; content: string }

/** What the drafter receives. Findings carry ids, packages and versions only. */
export interface AskPatchRequest {
  remediationId: string;
  orgId: string;
  files: AskPatchFile[];
  findings: Array<Pick<RemediationRemainingFinding, 'id' | 'severity' | 'packageName' | 'packageType' | 'packageVersion' | 'fixedIn'>>;
}

/** The drafter's answer: a unified diff, or null (it could not draft one). */
export type AskPatchDrafter = (req: AskPatchRequest) => Promise<{ diff: string } | null>;

/**
 * The live drafter. GAP: the ask-agent internal endpoint (for example
 * `ASK_AGENT_INTERNAL.draftRemediationPatch`, callers `plugin`) is not in the
 * api-core contracts, so there is nothing to call yet; it answers null.
 */
const liveDrafter: AskPatchDrafter = async () => null;

let drafter: AskPatchDrafter = liveDrafter;

/** Test / wiring hook: set the drafter (pass nothing to restore the live one). */
export function setAskAgentPatchDrafter(fn?: AskPatchDrafter): void {
  drafter = fn ?? liveDrafter;
}

/** The build files under `workdir` the agent is shown (capped, sorted by path). */
export async function collectBuildFiles(workdir: string): Promise<AskPatchFile[]> {
  const out: AskPatchFile[] = [];
  let total = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || out.length >= ASK_PATCH_MAX_FILES) return;
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= ASK_PATCH_MAX_FILES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue; // never follow a symlink out of the context
      const rel = relative(workdir, full).split('\\').join('/');
      if (!BUILD_FILE.test(rel)) continue;
      const size = (await stat(full)).size;
      if (size > ASK_PATCH_FILE_MAX_BYTES || total + size > ASK_PATCH_TOTAL_MAX_BYTES) continue;
      total += size;
      out.push({ path: rel, content: await readFile(full, 'utf-8') });
    }
  };
  await walk(workdir, 0);
  return out;
}

/** Why a drafted diff was refused, or null when it passes the pre-check. */
export function askPatchScopeError(diff: string, files: readonly AskPatchFile[], findings: AskPatchRequest['findings']): string | null {
  if (diff.length === 0 || Buffer.byteLength(diff) > ASK_PATCH_DIFF_MAX_BYTES) return 'size';
  const allowed = new Set(files.map((f) => f.path));
  const tokens = [...new Set(findings.flatMap((f) => [f.packageName, ...f.fixedIn]).filter((t) => t.length > 0))].map((t) => t.toLowerCase());
  const strip = (p: string) => p.replace(/^[ab]\//, '');
  let touched = 0;
  let changes = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const path = line.slice(4).split('\t')[0]!.trim();
      // Only modifications of the files shown: no new, deleted or other files.
      if (path === '/dev/null' || !allowed.has(strip(path))) return 'file_out_of_scope';
      touched += 1;
      continue;
    }
    if (/^(diff --git|index |@@ |\\ No newline)/.test(line) || line === '') continue;
    if (/^(new|deleted) file mode|^(rename|copy) (from|to)|^(old|new) mode|^similarity index/.test(line)) return 'file_out_of_scope';
    if (line.startsWith('+') || line.startsWith('-')) {
      changes += 1;
      const text = line.slice(1).toLowerCase();
      // Every changed line names a targeted package or its fixed version (blank lines are allowed).
      if (text.trim() !== '' && !tokens.some((t) => text.includes(t))) return 'line_out_of_scope';
      continue;
    }
    if (!line.startsWith(' ')) return 'malformed';
  }
  if (touched === 0 || changes === 0) return 'malformed';
  return null;
}

/**
 * Ask the agent for a patch of the build files in `workdir` that clears
 * `findings`. Returns the diff when it passes the pre-check, else null (the
 * findings stay `no_patcher` for the owner). The caller verifies the patch like
 * any other and publishes it only through approval (`ask_agent_patch`).
 * Never throws.
 */
export async function draftAskAgentPatch(input: { remediationId: string; orgId: string; workdir: string; findings: RemediationRemainingFinding[] }): Promise<{ diff: string } | null> {
  if (input.findings.length === 0) return null;
  try {
    const files = await collectBuildFiles(input.workdir);
    if (files.length === 0) {
      incCounter('plugin_remediation_ask_agent_drafts_total', { outcome: 'no_files' });
      return null;
    }
    const findings = input.findings.map((f) => ({ id: f.id, severity: f.severity, packageName: f.packageName, packageType: f.packageType, packageVersion: f.packageVersion, fixedIn: f.fixedIn }));
    const drafted = await drafter({ remediationId: input.remediationId, orgId: input.orgId, files, findings });
    if (!drafted || typeof drafted.diff !== 'string') {
      incCounter('plugin_remediation_ask_agent_drafts_total', { outcome: 'none' });
      return null;
    }
    const refusal = askPatchScopeError(drafted.diff, files, findings);
    if (refusal) {
      incCounter('plugin_remediation_ask_agent_drafts_total', { outcome: 'out_of_scope' });
      // The refusal code only: never the diff or the files.
      logger.warn('Ask agent patch dropped by the scope pre-check', { remediationId: input.remediationId, refusal });
      return null;
    }
    incCounter('plugin_remediation_ask_agent_drafts_total', { outcome: 'drafted' });
    return { diff: drafted.diff };
  } catch (err) {
    incCounter('plugin_remediation_ask_agent_drafts_total', { outcome: 'error' });
    logger.warn('Ask agent patch draft failed', { remediationId: input.remediationId, error: errorMessage(err) });
    return null;
  }
}
