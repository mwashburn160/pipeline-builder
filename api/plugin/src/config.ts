// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin service's own configuration object. Read from the environment ONCE
 * per call to {@link loadPluginServiceConfig} (the module-level
 * {@link pluginServiceConfig} is that call at import); every env read is a
 * LITERAL envInt / envStr call so the env-documented guard sees the names.
 *
 * `remediation` — the nightly plugin CVE remediation
 * (docs/plugin-publishing.md "Scan gates"):
 *  - enabled: PLUGIN_REMEDIATION_ENABLED, on unless the value is exactly `false`.
 *    Off → nothing is queued or run, nothing published or rolled out, no notice
 *    sent; the routes answer `enabled: false`. Org settings stay editable.
 *  - severities: PLUGIN_REMEDIATION_SEVERITIES, a comma list of critical / high
 *    (default both; an invalid value warns once and falls back). KEV-listed
 *    findings are always targeted whatever this says.
 *  - concurrency / baseConcurrency: tenant remediations and the system-org
 *    shared-base pass running at once (fleet-wide, Redis semaphores).
 *  - maxPerOrgPerDay: remediations queued per org in any 24 h.
 *  - sourcesBucket: the RustFS bucket holding kept sources and remediation artifacts.
 *  - toolchains: PLUGIN_REMEDIATION_TOOLCHAINS, propose (default) | off. A flagged
 *    managed toolchain release gets a verified release candidate a system-org
 *    admin approves (propose), or only the owner request (off). Never published
 *    automatically; an invalid value warns once and falls back to propose.
 */

import {
  createLogger,
  envInt,
  envStr,
  parseRemediationEnabled,
  parseRemediationSeverities,
  parseRemediationToolchains,
  type PluginRemediationConfig,
  type RemediationToolchainMode,
} from '@pipeline-builder/api-core';

const logger = createLogger('plugin-config');

export interface PluginRemediationServiceConfig extends PluginRemediationConfig {
  concurrency: number;
  baseConcurrency: number;
  maxPerOrgPerDay: number;
  sourcesBucket: string;
  toolchains: RemediationToolchainMode;
}

export interface PluginServiceConfig {
  remediation: PluginRemediationServiceConfig;
}

/** Read the configuration from the environment now. */
export function loadPluginServiceConfig(warn: (message: string) => void = (m) => logger.warn(m)): PluginServiceConfig {
  return {
    remediation: {
      enabled: parseRemediationEnabled(envStr('PLUGIN_REMEDIATION_ENABLED', 'true')),
      severities: parseRemediationSeverities(envStr('PLUGIN_REMEDIATION_SEVERITIES', 'critical'), warn),
      concurrency: envInt('PLUGIN_REMEDIATION_CONCURRENCY', 2, { min: 1 }),
      baseConcurrency: envInt('PLUGIN_REMEDIATION_BASE_CONCURRENCY', 4, { min: 1 }),
      maxPerOrgPerDay: envInt('PLUGIN_REMEDIATION_MAX_PER_ORG_PER_DAY', 20, { min: 0 }),
      sourcesBucket: envStr('PLUGIN_SOURCES_BUCKET', 'plugin-sources'),
      toolchains: parseRemediationToolchains(envStr('PLUGIN_REMEDIATION_TOOLCHAINS', 'propose'), warn),
    },
  };
}

let current: PluginServiceConfig | null = null;

/** The configuration (read once, lazily). */
export function pluginServiceConfig(): PluginServiceConfig {
  current ??= loadPluginServiceConfig();
  return current;
}

/** Shorthand for `pluginServiceConfig().remediation`. */
export function remediationConfig(): PluginRemediationServiceConfig {
  return pluginServiceConfig().remediation;
}

/** Test hook: replace (or, with nothing, re-read) the configuration. */
export function setPluginServiceConfigForTests(cfg?: Partial<PluginRemediationServiceConfig>): void {
  current = cfg ? { remediation: { ...loadPluginServiceConfig(() => undefined).remediation, ...cfg } } : null;
}
