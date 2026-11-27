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
 *    (default critical; high is an explicit opt-in; an invalid value warns once
 *    and falls back). KEV-listed findings are always targeted whatever this says.
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
  BUILD_LADDER_CONCURRENCY_SUM,
  buildConcurrencyEnvVar,
  buildWorkerConcurrencyFor,
  createLogger,
  DEFAULT_LEADER_LOCK_TTL_MS,
  envBool,
  envInt,
  envStr,
  parseRemediationEnabled,
  parseRemediationSeverities,
  parseRemediationToolchains,
  TOOLCHAIN_FIX_RESUME_INTERVAL,
  type PlanTier,
  type PluginRemediationConfig,
  type RemediationToolchainMode,
} from '@pipeline-builder/api-core';
import { retentionConfig, type RetentionConfig } from './services/retention/config.js';

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

// ---------------------------------------------------------------------------
// The service's operational knobs
// ---------------------------------------------------------------------------

/** `true` unless the value is exactly `false` (any case) — the rescan / grype switches' historical parse. */
function onUnlessFalse(value: string): boolean {
  return value.toLowerCase() !== 'false';
}

/** Org-slot TTL, shared by `orgSlots.ttlSeconds` and the derived heartbeat / scrub defaults. */
function orgSlotTtlSeconds(): number {
  return envInt('PLUGIN_ORG_SLOT_TTL_SECONDS', 900, { min: 1 });
}

/** A third of the slot TTL (at least 1 s): how often a running build refreshes its slot. */
function orgSlotHeartbeatMs(): number {
  return Math.max(1_000, Math.floor((orgSlotTtlSeconds() * 1000) / 3));
}

/**
 * The plugin service's operational configuration.
 *
 * Every field is a GETTER that reads the environment on access, so each caller
 * keeps the read timing it had before this object existed: a module-level
 * `const X = config.foo.bar` still reads once at import, and a per-call read
 * (a scheduler factory, a per-request limit) still reads per call — which is
 * what lets a suite set `process.env` between cases. Every read is a LITERAL
 * envInt / envBool / envStr call so the env-documented guard sees the names.
 *
 * Not here, on purpose:
 *  - names BUILT from a key (`PLUGIN_MAX_BUILDS_<TIER>_<CLASS>`, `REDIS_DB_<TIER>`,
 *    the sized buildkit pools, `PLUGIN_BUILDKIT_ADDR_<TIER>`) — read where the
 *    key is known (`build.tierConcurrency` is the one exception);
 *  - the anonymous-submission path's own object (`submissionConfig`).
 */
export const config = {
  /** The nightly CVE remediation (read once, cached — see {@link remediationConfig}). */
  get remediation(): PluginRemediationServiceConfig { return remediationConfig(); },
  /** The superseded-version retention pass (read per call). */
  get retention(): RetentionConfig { return retentionConfig(); },

  /** Operator switches and cadences read per call (unlike the cached `remediation` section). */
  operator: {
    /** PLUGIN_REMEDIATION_ENABLED, read live: gates remediation notices. */
    get remediationEnabled(): boolean { return parseRemediationEnabled(envStr('PLUGIN_REMEDIATION_ENABLED', 'true')); },
    /** PLUGIN_AUTO_TIDY_ENABLED: whether the daily tidy job may run. */
    get autoTidyEnabled(): boolean { return parseRemediationEnabled(envStr('PLUGIN_AUTO_TIDY_ENABLED', 'true')); },
    /** How often (ms) stuck managed-toolchain fix publishes are resumed (at least 30 s). */
    get toolchainFixResumeIntervalMs(): number {
      return envInt('TOOLCHAIN_FIX_RESUME_INTERVAL_MS', TOOLCHAIN_FIX_RESUME_INTERVAL.default, { min: TOOLCHAIN_FIX_RESUME_INTERVAL.min });
    },
  },

  build: {
    /** Builds one replica may run at once across every tier (defaults to the ladder sum). */
    get maxPerReplica(): number { return envInt('PLUGIN_MAX_BUILDS_PER_REPLICA', BUILD_LADDER_CONCURRENCY_SUM, { min: 1 }); },
    /** Builds that may run ABOVE their tier's floor at once on a replica (0 = no borrowing). */
    get borrowMax(): number { return envInt('PLUGIN_BUILD_BORROW_MAX', 0, { min: 0 }); },
    /** The buildkit sidecar's CPU limit in milli-vCPU; the credit ladder is derived from it. */
    get buildkitMilliVcpu(): number { return envInt('PLUGIN_BUILDKIT_MILLI_VCPU', 1500, { min: 1 }); },
    /** The platform the plugin image is published for. */
    get publishPlatform(): string { return envStr('PUBLISH_PLATFORM', 'linux/amd64'); },
    /** Persist a version whose build-time scan could not run. */
    get allowUnscanned(): boolean { return envBool('PLUGIN_ALLOW_UNSCANNED', false); },
    /**
     * A tier's build-worker concurrency: `PLUGIN_BUILD_CONCURRENCY_<TIER>` over
     * the catalog's ladder row. A key-built name, so a function rather than a
     * field; one definition for the worker and the status route that reports it.
     */
    tierConcurrency(tier: PlanTier): number {
      return envInt(buildConcurrencyEnvVar(tier), buildWorkerConcurrencyFor(tier), { min: 1 });
    },
  },

  orgSlots: {
    /** Concurrent builds the system org may hold (it waits rather than fails past it). */
    get systemOrgMaxBuilds(): number { return envInt('PLUGIN_SYSTEM_ORG_MAX_BUILDS', 12, { min: 1 }); },
    /** First wait (ms) before a denied build retries; doubles up to `maxDelayMs`. */
    get delayMs(): number { return envInt('PLUGIN_ORG_SLOT_DELAY_MS', 10000, { min: 1 }); },
    /** Slot counter TTL (s): a crash-recovery window, not a build-duration cap. */
    get ttlSeconds(): number { return orgSlotTtlSeconds(); },
    /** Derived from `ttlSeconds` (a third, at least 1 s) so the two cannot drift. Not an env var. */
    get heartbeatMs(): number { return orgSlotHeartbeatMs(); },
    /** Longest wait (ms) between slot retries. */
    get maxDelayMs(): number { return envInt('PLUGIN_ORG_SLOT_MAX_DELAY_MS', 60_000, { min: 1 }); },
    /** Elapsed time (ms) a tenant build may wait for a slot before failing terminally. */
    get maxWaitMs(): number { return envInt('PLUGIN_ORG_SLOT_MAX_WAIT_MS', 1_800_000, { min: 1 }); },
    /** Reconciliation interval (ms) for the slot scrub; defaults to the heartbeat. */
    get scrubMs(): number { return envInt('PLUGIN_ORG_SLOT_SCRUB_MS', orgSlotHeartbeatMs(), { min: 1_000 }); },
  },

  queue: {
    /** Minimum gap (ms) between DLQ max-size enforcement scans. */
    get dlqScanIntervalMs(): number { return envInt('PLUGIN_DLQ_SCAN_INTERVAL_MS', 5000, { min: 1 }); },
    /** Queue-depth gauge scrape interval (ms). */
    get metricsIntervalMs(): number { return envInt('PLUGIN_QUEUE_METRICS_INTERVAL_MS', 15000, { min: 1 }); },
    /** How long (ms) an org's resolved tier is cached for queue routing. */
    get tierCacheTtlMs(): number { return envInt('PLUGIN_TIER_CACHE_TTL_MS', 300000, { min: 1 }); },
    /** TTL (ms) of the `/triage` summary memo. */
    get triageCacheTtlMs(): number { return envInt('PLUGIN_TRIAGE_CACHE_TTL_MS', 5000, { min: 1 }); },
    /** Distinct `/triage` memo keys kept before the oldest is evicted. */
    get triageCacheMaxEntries(): number { return envInt('PLUGIN_TRIAGE_CACHE_MAX_ENTRIES', 500, { min: 1 }); },
    /** Deepest row a caller may page to on GET /failed and GET /dlq. */
    get maxPageDepth(): number { return envInt('PLUGIN_QUEUE_MAX_PAGE_DEPTH', 5000, { min: 1 }); },
    /** Deepest row a tenant-scoped queue read scans per source. */
    get tenantScanMaxRows(): number { return envInt('PLUGIN_QUEUE_TENANT_SCAN_MAX_ROWS', 10000, { min: 1 }); },
  },

  rescan: {
    /** The nightly vulnerability rescan (on unless exactly `false`). */
    get enabled(): boolean { return onUnlessFalse(envStr('PLUGIN_RESCAN_ENABLED', 'true')); },
    get intervalMs(): number { return envInt('PLUGIN_RESCAN_INTERVAL_MS', 24 * 60 * 60 * 1000, { min: 1 }); },
    get startupDelayMs(): number { return envInt('PLUGIN_RESCAN_STARTUP_DELAY_MS', 120_000, { min: 1 }); },
    get lockTtlMs(): number { return envInt('PLUGIN_RESCAN_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1 }); },
  },

  vulnScan: {
    get scanTimeoutMs(): number { return envInt('PLUGIN_VULN_SCAN_TIMEOUT_MS', 300_000, { min: 1 }); },
    get dbUpdateTimeoutMs(): number { return envInt('PLUGIN_GRYPE_DB_UPDATE_TIMEOUT_MS', 600_000, { min: 1 }); },
    get dbUpdateIntervalMs(): number { return envInt('PLUGIN_GRYPE_DB_UPDATE_INTERVAL_MS', 3_600_000, { min: 1 }); },
    /** In-process `grype db update` (on unless exactly `false`). */
    get dbAutoUpdate(): boolean { return onUnlessFalse(envStr('PLUGIN_GRYPE_DB_AUTO_UPDATE', 'true')); },
    /** Oldest grype DB a scan result is trusted from, in ms (env is hours). */
    get dbMaxAgeMs(): number { return envInt('PLUGIN_VULN_DB_MAX_AGE_HOURS', 36, { min: 1 }) * 3_600_000; },
    /** Where grype keeps its DB; empty = a temp dir chosen by the caller. */
    get dbCacheDir(): string { return envStr('GRYPE_DB_CACHE_DIR', ''); },
    /** The grype-DB volume's declared size limit in bytes (0 = not declared; no gauge). */
    get dbCacheLimitBytes(): number { return envInt('PLUGIN_GRYPE_DB_CACHE_LIMIT_BYTES', 0); },
    /** Directory of operator OpenVEX documents; empty = none. */
    get vexDir(): string { return envStr('PLUGIN_VULN_VEX_DIR', ''); },
    /** Longest a risk acceptance may run, in days (1..365; anything else is 90). */
    get riskAcceptanceMaxDays(): number {
      const n = envInt('PLUGIN_RISK_ACCEPTANCE_MAX_DAYS', 90);
      return n >= 1 && n <= 365 ? n : 90;
    },
  },

  upload: {
    /** Multer's staging directory for the incoming ZIP. */
    get dir(): string { return envStr('PLUGIN_UPLOAD_DIR', '/opt/pipeline/pipeline-data/plugins-data'); },
    /** Socket timeout (ms) on the upload and inspect routes. */
    get timeoutMs(): number { return envInt('PLUGIN_UPLOAD_TIMEOUT_MS', 900_000, { min: 1 }); },
    get maxUploadMb(): number { return envInt('PLUGIN_MAX_UPLOAD_MB', 4096, { min: 1 }); },
    get maxExtractRatio(): number { return envInt('PLUGIN_MAX_EXTRACT_RATIO', 50, { min: 1 }); },
    /** Defaults to `maxUploadMb` MiB × `maxExtractRatio`. */
    get maxExtractBytes(): number {
      return envInt('PLUGIN_MAX_EXTRACT_BYTES', this.maxUploadMb * 1024 * 1024 * this.maxExtractRatio, { min: 1 });
    },
    get maxExtractEntries(): number { return envInt('PLUGIN_MAX_EXTRACT_ENTRIES', 10000, { min: 1 }); },
    /** Max bytes of config.yaml / plugin-spec.yaml accepted before parsing. */
    get maxYamlBytes(): number { return envInt('PLUGIN_MAX_YAML_BYTES', 1_048_576, { min: 1 }); },
  },

  storage: {
    /** The bucket every plugin build context lives in. */
    get artifactBucket(): string { return envStr('S3_BUCKET', 'plugins'); },
    /** The separate bucket anonymous submissions are staged in. */
    get quarantineBucket(): string { return envStr('PLUGIN_QUARANTINE_BUCKET', 'plugin-quarantine'); },
    /** How long (days) a kept setup image waits for promotion. */
    get keptSetupImageTtlDays(): number { return envInt('PLUGIN_KEPT_SETUP_IMAGE_TTL_DAYS', 30, { min: 1 }); },
  },

  registry: {
    /** image-registry's token TTL (s); where a blob-GC push freeze begins. */
    get tokenExpiresInSeconds(): number { return envInt('REGISTRY_TOKEN_EXPIRES_IN', 300, { min: 1 }); },
    /** The registry's advertised token realm, else PLATFORM_BASE_URL's; undefined when neither is set. */
    get tokenRealmUrl(): string | undefined {
      const realm = envStr('IMAGE_REGISTRY_TOKEN_REALM', '');
      if (realm) return realm;
      const base = envStr('PLATFORM_BASE_URL', '');
      return base ? `${base}/image-registry/token` : undefined;
    },
  },

  rateLimits: {
    get generatePerMin(): number { return envInt('PLUGIN_GENERATE_RATE_LIMIT_PER_MIN', 20, { min: 1 }); },
    get publicDirectoryPerMin(): number { return envInt('PUBLIC_DIRECTORY_RATE_LIMIT_PER_MIN', 120, { min: 1 }); },
    get reviewWritePerUserPerMin(): number { return envInt('REVIEW_WRITE_RATE_LIMIT_PER_MIN', 30, { min: 1 }); },
    get reviewWritePerOrgPerMin(): number { return envInt('REVIEW_ORG_WRITE_RATE_LIMIT_PER_MIN', 120, { min: 1 }); },
    get reviewCreatePerIpPerDay(): number { return envInt('REVIEW_IP_DAILY_LIMIT', 20, { min: 1 }); },
  },

  ecosystem: {
    /** The public directory flag (it also needs the reader login configured to serve). */
    get publicDirectoryEnabled(): boolean { return envBool('PUBLIC_DIRECTORY_ENABLED', true); },
    /** Fixable findings at/above the fail-on floor a version may carry to be requested. */
    get vulnGateMaxFindings(): number { return envInt('ECOSYSTEM_VULN_GATE_MAX_FINDINGS', 0, { min: 0 }); },
    /** How long (ms) the Official-request bootstrap window stays open (env is hours). */
    get bootstrapWindowMs(): number { return envInt('ECOSYSTEM_BOOTSTRAP_WINDOW_HOURS', 24, { min: 1 }) * 3_600_000; },
    /** Pipelines re-resolved per declared-resolution refresh trigger. */
    get resolutionRefreshMax(): number { return envInt('PLUGIN_RESOLUTION_REFRESH_MAX', 500, { min: 1 }); },
    /** Per-org cap on NEW reviews in a rolling day. */
    get reviewOrgDailyLimit(): number { return envInt('REVIEW_ORG_DAILY_LIMIT', 20, { min: 1 }); },
    /** Distinct open reports (from outside the listing owner's org) that auto-hold a review. */
    get reviewAutoHoldReports(): number { return envInt('REVIEW_AUTO_HOLD_REPORTS', 3, { min: 1 }); },
  },
};

export type PluginConfig = typeof config;
