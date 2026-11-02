// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, errorMessage } from '@pipeline-builder/api-core';
import {
  collectPluginSteps, exactPinNotFoundMessage, lookupNotFoundState, type LookupWarning, type LookupWarningSeverity,
  pluginArtifactAlias, pluginLookupFilter, summarizeLookupWarnings, unwrapLookup,
} from '@pipeline-builder/pipeline-core';
import pico from 'picocolors';
import { ApiClient } from './api-client.js';
import { printWarning } from './output-utils.js';

/** Minimal plugin reference shape — matches PluginOptions from pipeline-core. */
interface PluginRef {
  name: string;
  /** Publisher handle of an installed listing. */
  publisher?: string;
  alias?: string;
  filter?: Record<string, unknown>;
}

/**
 * Cache key matching `PluginLookup.normalize()`: the explicit alias when set,
 * otherwise `[<publisher>-]<name>-alias` — pipeline-core's
 * `pluginArtifactAlias`, the one rule every consumer of this map uses.
 */
function cacheKey(ref: PluginRef): string {
  return pluginArtifactAlias(ref);
}

/**
 * Walk the pipeline props tree to collect every plugin reference. Plugins
 * appear at `synth.plugin` and at `stages[].steps[].plugin`. Entries are
 * de-duplicated by `cacheKey()` — the same key `PluginLookup.plugin()` uses,
 * so the resolved-plugins map lookups match downstream.
 */
function collectPluginRefs(props: Record<string, unknown>): PluginRef[] {
  const refs: PluginRef[] = [];
  const seen = new Map<string, string>();

  const push = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as PluginRef;
    if (!r.name) return;
    const key = cacheKey(r);
    // The name the lookup will TARGET — an explicit `filter.name` wins (see
    // below), so two refs that resolve to the same plugin are not a collision.
    const name = (r.filter?.name as string | undefined) ?? r.name;
    const target = r.publisher ? `${r.publisher}/${name}` : name;
    const holder = seen.get(key);
    if (holder !== undefined) {
      // One alias can only ever mean one plugin. Deduplicating on the alias
      // alone kept the FIRST plugin and silently dropped the second, so a step
      // declaring `{ name: 'maven-build', alias: 'build' }` after another
      // declaring `{ name: 'nodejs-build', alias: 'build' }` ran nodejs-build's
      // image and commands — no error, just the wrong build.
      if (holder !== target) {
        throw new Error(
          `Plugin alias "${key}" is used for two different plugins ("${holder}" and "${target}"). `
          + 'Give each plugin its own alias.',
        );
      }
      return;
    }
    seen.set(key, target);
    refs.push(r);
  };

  const synth = props.synth as { plugin?: unknown } | undefined;
  push(synth?.plugin);

  const stages = props.stages as Array<{ steps?: Array<{ plugin?: unknown }> }> | undefined;
  for (const stage of stages ?? []) {
    for (const step of stage.steps ?? []) {
      push(step.plugin);
    }
  }

  return refs;
}

/**
 * Lookup refusals that must STOP the synth rather than fall back to
 * deploy-time resolution: an image whose signature doesn't verify, a listing
 * the org can't use (not installed, blocked by its allow/deny policy, yanked
 * or suspended), and an org plugin that was deleted. Falling back would
 * quietly turn each into an unresolved step that fails at run time instead of
 * now. Vulnerability state is NEVER one of these: it arrives as graded
 * warnings beside a resolved plugin.
 */
const FATAL_LOOKUP_CODES: readonly string[] = [
  ErrorCode.IMAGE_VERIFICATION_FAILED,
  ErrorCode.PLUGIN_NOT_INSTALLED,
  ErrorCode.PLUGIN_BLOCKED_BY_POLICY,
  ErrorCode.PLUGIN_UNAVAILABLE,
  // The org's own plugin was deleted: the lookup refuses it rather than fall
  // through to a same-name listing. (Plugin service code; matched as a string.)
  'PLUGIN_DELETED',
];

/** The error code of a plugin service answer, when it is one of {@link FATAL_LOOKUP_CODES}. */
function fatalLookupCode(err: unknown): string | null {
  const data = (err as { response?: { data?: unknown } } | undefined)?.response?.data;
  const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined;
  return typeof code === 'string' && FATAL_LOOKUP_CODES.includes(code) ? code : null;
}

/** Whether the plugin service answered "no such plugin/version" (404 NOT_FOUND). */
function isNotFound(err: unknown): boolean {
  const response = (err as { response?: { status?: unknown; data?: unknown } } | undefined)?.response;
  const code = response?.data && typeof response.data === 'object' ? (response.data as { code?: unknown }).code : undefined;
  return response?.status === 404 || code === ErrorCode.NOT_FOUND;
}

/**
 * The version a reference PINS — one exact `x.y.z[-pre]`, not a range or
 * `latest`. A pin names a version that must exist: if it doesn't (never
 * published, or refused by the build's vulnerability gate, which saves
 * nothing), there is no outage to ride out and nothing for the deploy-time
 * lookup to find either.
 */
function exactVersionPin(ref: PluginRef): string | null {
  const version = ref.filter?.version;
  return typeof version === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

/** One plugin the synth could not use, as {@link PluginResolutionError} reports it. */
export interface PluginRefusal {
  /** `[<publisher>/]<name>` of the reference. */
  readonly plugin: string;
  /** The plugin service's error code, or a local one (`PLUGIN_VERSION_NOT_FOUND`). */
  readonly code: string;
  readonly message: string;
}

/**
 * Every fatal refusal of one pre-resolution pass. Carries the structured list
 * as well as the human message, so the synth can emit a machine-readable
 * failure line (`PB_SYNTH_FAILURE`) the execution events pick up.
 */
export class PluginResolutionError extends Error {
  constructor(readonly refusals: readonly PluginRefusal[]) {
    super(refusals.length === 1
      ? refusals[0]!.message
      : `${refusals.length} plugins can't be used:\n${refusals.map((r) => `  - ${r.message}`).join('\n')}`);
    this.name = 'PluginResolutionError';
  }
}

/**
 * Why an exact pin was not found, phrased from the 404's `details.state`
 * (`deleted` / `inactive` / `yanked` / `missing`). Without a state the answer
 * cannot tell the cases apart, so the message names the two likeliest.
 * Shared with the deploy-time Lambda's CloudFormation reason (pipeline-core).
 */
function pinNotFoundMessage(label: string, pin: string, err?: unknown): string {
  return exactPinNotFoundMessage(label, pin, lookupNotFoundState(err));
}

const SEVERITY_STYLE: Record<LookupWarningSeverity, (s: string) => string> = {
  info: pico.cyan,
  warning: pico.yellow,
  error: pico.red,
  critical: (t) => pico.bold(pico.red(t)),
};

/** Print one lookup warning, prefixed and coloured by its severity. */
export function printLookupWarning(label: string, warning: LookupWarning): void {
  const tag = SEVERITY_STYLE[warning.severity](`[${warning.severity.toUpperCase()}]`);
  printWarning(`${tag} Plugin "${label}": ${warning.message}`);
}

/** Print the one-line severity summary of a synth's lookup warnings (nothing when none). */
export function printLookupWarningSummary(warnings: readonly LookupWarning[]): void {
  const line = summarizeLookupWarnings(warnings);
  if (!line) return;
  const worst = warnings.some((w) => w.severity === 'critical') ? 'critical'
    : warnings.some((w) => w.severity === 'error') ? 'error'
      : warnings.some((w) => w.severity === 'warning') ? 'warning' : 'info';
  printWarning(SEVERITY_STYLE[worst](line));
}

/** The plugin service's own refusal message, when the answer carries one. */
function serviceMessage(err: unknown): string | null {
  const data = (err as { response?: { data?: unknown } } | undefined)?.response?.data;
  const message = data && typeof data === 'object' ? (data as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

/**
 * Pre-resolve plugins by calling the same `POST /api/plugins/lookup` endpoint
 * the deploy-time custom resource Lambda uses. Returning the full Plugin
 * record at synth time is what allows the resulting CFN template to ship
 * with real CodeBuild image URIs (`<host>/<ns>/<name>:<version>`) rather than
 * the `aws/codebuild/standard:7.0` fallback that the synth-time token path
 * forces.
 *
 * Failures are non-fatal: a missing plugin or unreachable API logs a warning
 * and falls through to the deploy-time custom resource path so partial
 * platform outages don't block synth/deploy. The exceptions abort the synth:
 * the {@link FATAL_LOOKUP_CODES} refusals, and an exact version pin that does
 * not exist.
 *
 * Every reference is looked up before anything is thrown, and ALL fatal
 * refusals are reported together. Stopping at the first meant a pipeline with
 * three refused plugins took three synth attempts to learn about all three.
 *
 * Every lookup warning is printed, graded by severity, and appended to
 * `warningSink` when given (the synth prints a one-line summary at its end).
 * A warning never fails the synth — vulnerability state is reported, not
 * enforced.
 *
 * When the props carry a `pipelineId`, each lookup also sends
 * `context: { pipelineId, stepKeys }` — the label (`pluginStepLabel`: `synth` or
 * `<stage>/<alias ?? name>`) of EVERY step the de-duplicated reference serves —
 * so the plugin service can record the warnings it returns against each of
 * those pipeline steps, not only print them into this synth's log.
 *
 * Keyed by `alias || name` to match `PluginLookup.plugin()`.
 */
export async function resolvePluginsForProps(
  client: ApiClient,
  props: Record<string, unknown>,
  warningSink?: LookupWarning[],
): Promise<Record<string, unknown>> {
  const refs = collectPluginRefs(props);
  if (refs.length === 0) return {};

  const pipelineId = typeof props.pipelineId === 'string' && props.pipelineId.length > 0 ? props.pipelineId : undefined;
  // One lookup per alias may serve several steps: the labels of each, by alias.
  const stepKeys = new Map<string, string[]>();
  for (const step of collectPluginSteps(props)) {
    const key = cacheKey(step);
    stepKeys.set(key, [...(stepKeys.get(key) ?? []), step.label]);
  }
  const resolved: Record<string, unknown> = {};
  const fatal: PluginRefusal[] = [];

  await Promise.all(refs.map(async (ref) => {
    const key = cacheKey(ref);
    const label = ref.publisher ? `${ref.publisher}/${ref.name}` : ref.name;
    // The plugin NAME lives on the ref (a sibling of `filter`), NOT inside the
    // filter object — but the lookup matches on the filter. A filter without
    // `name` (e.g. `{version, visibility, isActive, isDefault}`) matches ANY
    // plugin with those attributes, and the endpoint returns an arbitrary one
    // (seen: `dockerfile-multi-provider`). That made the synth and every step
    // resolve to the WRONG plugin. So when the filter omits `name`, fall back to
    // the ref's plugin name; an explicit filter `name` still takes precedence.
    // Shared with the pipeline service's contract check (same filter, same plugin).
    const filter = pluginLookupFilter(ref);
    const pin = exactVersionPin(ref);
    const refuse = (code: string, message: string): void => { fatal.push({ plugin: label, code, message }); };
    try {
      const res = await client.post<unknown>('/api/plugins/lookup', {
        filter,
        ...(pipelineId && stepKeys.has(key) ? { context: { pipelineId, stepKeys: stepKeys.get(key) } } : {}),
      });
      const { plugin, warnings } = unwrapLookup(res);
      for (const warning of warnings) {
        printLookupWarning(label, warning);
        warningSink?.push(warning);
      }
      if (plugin) {
        resolved[key] = plugin;
      } else if (pin) {
        refuse('PLUGIN_VERSION_NOT_FOUND', pinNotFoundMessage(label, pin));
      } else {
        printWarning(`Plugin "${label}" lookup returned no record — falling back to deploy-time resolution`);
      }
    } catch (err) {
      // A plugin whose image signature doesn't verify, or a listing the org
      // can't use, is NOT an outage to ride out: falling back would quietly
      // turn it into an unresolved step. Stop.
      const code = fatalLookupCode(err);
      if (code === ErrorCode.IMAGE_VERIFICATION_FAILED) {
        refuse(code, `Plugin "${label}" image failed signature verification: ${errorMessage(err)}`);
        return;
      }
      if (code) {
        refuse(code, `Plugin "${label}" can't be used (${code}): ${serviceMessage(err) ?? errorMessage(err)}`);
        return;
      }
      if (pin && isNotFound(err)) {
        refuse('PLUGIN_VERSION_NOT_FOUND', pinNotFoundMessage(label, pin, err));
        return;
      }
      const msg = errorMessage(err);
      printWarning(`Plugin "${label}" pre-resolution failed (${msg}) — falling back to deploy-time resolution`);
    }
  }));

  if (fatal.length > 0) throw new PluginResolutionError(fatal);
  return resolved;
}
