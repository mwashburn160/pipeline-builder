// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Plugin } from '@pipeline-builder/pipeline-data';

/** How serious a lookup warning is (vulnerability state is graded, never refused). */
export type LookupWarningSeverity = 'info' | 'warning' | 'error' | 'critical';

/** Severities, least to most serious. */
export const LOOKUP_WARNING_SEVERITIES: readonly LookupWarningSeverity[] = ['info', 'warning', 'error', 'critical'];

/** One warning riding beside a resolved plugin. */
export interface LookupWarning {
  readonly code?: string;
  readonly message: string;
  /** Absent on the wire → `warning`. */
  readonly severity: LookupWarningSeverity;
}

/** How a managed toolchain release was chosen for the caller (never anything about other orgs). */
export type ToolchainResolvedVia = 'pin' | 'org-default' | 'canary' | 'default';

export const TOOLCHAIN_RESOLVED_VIA: readonly ToolchainResolvedVia[] = ['pin', 'org-default', 'canary', 'default'];

/** The exact tool versions a toolchain release carries (the bootstrap spec's `toolchain`). */
export interface ToolchainVersions {
  readonly pipelineManager?: string;
  readonly awsCdk?: string;
  readonly cdkAssets?: string;
  readonly esbuild?: string;
  readonly pnpm?: string;
  readonly node?: string;
}

const TOOLCHAIN_VERSION_KEYS: readonly (keyof ToolchainVersions)[] = ['pipelineManager', 'awsCdk', 'cdkAssets', 'esbuild', 'pnpm', 'node'];

/**
 * The release a managed-name lookup (`pipeline-bootstrap`, `cdk-synth`)
 * resolved to: `data.toolchain` of the `/plugins/lookup` answer. `versions`
 * holds the tool versions when the answer (or the plugin record) carries them.
 */
export interface LookupToolchain {
  readonly releaseVersion: string;
  readonly resolvedVia: ToolchainResolvedVia;
  readonly versions: ToolchainVersions;
}

/**
 * The resolved `pipeline-bootstrap` half of a toolchain release: the plugin
 * record the default CodeBuild image is pinned to (by its signed digest) and
 * the release it came from. Produced by `pipeline-manager`'s
 * `resolveBootstrapImage` (or a `--toolchain-file`) and passed to
 * `PipelineBuilder` as `resolvedBootstrap`.
 */
export interface ResolvedBootstrap {
  readonly plugin: Plugin;
  readonly toolchain: LookupToolchain;
}

/** Pick the string tool versions off an object (unknown keys and non-strings ignored). */
function pickVersions(raw: unknown): ToolchainVersions {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const key of TOOLCHAIN_VERSION_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) out[key] = v;
  }
  return out;
}

/**
 * The flat `metadata` key prefix the platform persists a build image's
 * `toolchain` under (`toolchain.awsCdk`, …; api-core `TOOLCHAIN_METADATA_PREFIX`,
 * repeated here so this module stays dependency-free).
 */
const TOOLCHAIN_METADATA_PREFIX = 'toolchain.';

/** The tool versions a plugin row's `metadata` carries as flat `toolchain.<field>` keys. */
function versionsFromMetadata(metadata: unknown): ToolchainVersions {
  if (!metadata || typeof metadata !== 'object') return {};
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata as Record<string, unknown>)) {
    if (k.startsWith(TOOLCHAIN_METADATA_PREFIX)) fields[k.slice(TOOLCHAIN_METADATA_PREFIX.length)] = v;
  }
  return pickVersions(fields);
}

/**
 * Parse a lookup's `toolchain` block. Null unless it carries a release version
 * and a known `resolvedVia`. Tool versions come from, lowest precedence first:
 * the plugin row's `metadata` (`toolchain.<field>` keys, where the platform
 * persists the bootstrap spec's `toolchain`), the record's own `toolchain`,
 * the block's flat fields, then `toolchain.versions`.
 */
export function parseLookupToolchain(raw: unknown, plugin?: unknown): LookupToolchain | null {
  if (!raw || typeof raw !== 'object') return null;
  const { releaseVersion, resolvedVia, versions } = raw as { releaseVersion?: unknown; resolvedVia?: unknown; versions?: unknown };
  if (typeof releaseVersion !== 'string' || releaseVersion.length === 0) return null;
  if (!(TOOLCHAIN_RESOLVED_VIA as readonly unknown[]).includes(resolvedVia)) return null;
  const rec = plugin && typeof plugin === 'object' ? plugin as { toolchain?: unknown; metadata?: unknown } : undefined;
  return {
    releaseVersion,
    resolvedVia: resolvedVia as ToolchainResolvedVia,
    versions: { ...versionsFromMetadata(rec?.metadata), ...pickVersions(rec?.toolchain), ...pickVersions(raw), ...pickVersions(versions) },
  };
}

/**
 * Unwrap a `/plugins/lookup` answer. The platform's success envelope is
 * `{ success, statusCode, data: { plugin, warnings } }` (note the double
 * nesting: `data.plugin`); `{ data: Plugin }`, `{ plugin }` and a bare Plugin
 * are tolerated too. Returns the plugin (null when absent or nameless) and the
 * graded warnings (lifecycle, vulnerability, compliance) that ride beside it,
 * and — for a managed toolchain name — the release it resolved to (`toolchain`).
 *
 * Dependency-free (type-only imports) so the plugin-lookup Lambda can bundle it.
 */
export function unwrapLookup(body: unknown): { plugin: Plugin | null; warnings: LookupWarning[]; toolchain?: LookupToolchain } {
  if (!body || typeof body !== 'object') return { plugin: null, warnings: [] };
  const inner = (body as { data?: unknown }).data;
  const container = (inner && typeof inner === 'object' ? inner : body) as { plugin?: unknown; warnings?: unknown; toolchain?: unknown };
  const candidate = container.plugin ?? container;
  const plugin = candidate && typeof candidate === 'object' && typeof (candidate as { name?: unknown }).name === 'string'
    && (candidate as { name: string }).name.length > 0
    ? candidate as Plugin
    : null;
  const warnings: LookupWarning[] = [];
  if (Array.isArray(container.warnings)) {
    for (const w of container.warnings) {
      if (!w || typeof w !== 'object') continue;
      const { code, message, severity } = w as { code?: unknown; message?: unknown; severity?: unknown };
      if (typeof message !== 'string' || message.length === 0) continue;
      warnings.push({
        ...(typeof code === 'string' ? { code } : {}),
        message,
        severity: (LOOKUP_WARNING_SEVERITIES as readonly unknown[]).includes(severity) ? severity as LookupWarningSeverity : 'warning',
      });
    }
  }
  const toolchain = parseLookupToolchain(container.toolchain, plugin);
  return { plugin, warnings, ...(toolchain && { toolchain }) };
}

/**
 * One line summarizing graded warnings, most serious first —
 * `3 plugin warnings: 1 critical, 2 error`. Null when there are none.
 */
export function summarizeLookupWarnings(warnings: readonly Pick<LookupWarning, 'severity'>[]): string | null {
  if (warnings.length === 0) return null;
  const parts = [...LOOKUP_WARNING_SEVERITIES].reverse()
    .map((sev) => [sev, warnings.filter((w) => w.severity === sev).length] as const)
    .filter(([, n]) => n > 0)
    .map(([sev, n]) => `${n} ${sev}`);
  return `${warnings.length} plugin warning${warnings.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

/** Why a lookup found nothing, as the plugin service's 404 `details.state` reports it. */
export type LookupNotFoundState = 'deleted' | 'inactive' | 'yanked' | 'missing';

const NOT_FOUND_STATES: readonly LookupNotFoundState[] = ['deleted', 'inactive', 'yanked', 'missing'];

/**
 * `details.state` of a refused lookup, read off either an axios-style error
 * (`err.response.data`) or the response body itself. Null when absent/unknown.
 */
export function lookupNotFoundState(errOrBody: unknown): LookupNotFoundState | null {
  if (!errOrBody || typeof errOrBody !== 'object') return null;
  const data = (errOrBody as { response?: { data?: unknown } }).response?.data ?? errOrBody;
  const details = data && typeof data === 'object' ? (data as { details?: unknown }).details : undefined;
  const state = details && typeof details === 'object' ? (details as { state?: unknown }).state : undefined;
  return typeof state === 'string' && (NOT_FOUND_STATES as readonly string[]).includes(state) ? state as LookupNotFoundState : null;
}

/**
 * The message for an exact version pin that did not resolve. Shared by the
 * CLI's pre-resolution and the deploy-time Lambda's CloudFormation reason.
 */
export function exactPinNotFoundMessage(label: string, pin: string, state: LookupNotFoundState | null): string {
  switch (state) {
    case 'deleted': return `Plugin "${label}" version ${pin} was deleted from your organization`;
    case 'inactive': return `Plugin "${label}" version ${pin} is inactive`;
    case 'yanked': return `Plugin "${label}" version ${pin} was yanked`;
    case 'missing': return `Plugin "${label}" version ${pin} does not exist`;
    default: return `Plugin "${label}" version ${pin} does not exist (never published, or refused by its build's vulnerability scan)`;
  }
}
