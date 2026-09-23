// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The quarantine gate pipeline for a verified anonymous submission
 * (docs/plugin-publishing.md steps 2–4). Every gate is
 * fail-closed and recorded as a `Gate { id, ok, message }` in
 * `gate_report.gates`; the heuristics detail goes to `heuristics` (moderators
 * only). In order:
 *
 *  1. STATIC — `spec` (parse, contract, templates, build args), `license`
 *     (an allowed SPDX id), `lint` (catalog Dockerfile + spec rules),
 *     `heuristics` (no `high` finding), `env_secrets` (no secret-looking
 *     `env` defaults), `smoke_test_declared`, `name` (re-judged now);
 *  2. BUILD on the ISOLATED quarantine buildkitd (`PLUGIN_QUARANTINE_BUILDKIT_ADDR`,
 *     never the tenant one) into `quarantine/<id>`, pushed with a registry-only
 *     credential scoped to that one repository, SBOM'd and signed under the system org;
 *  3. IMAGE — `scanned`, `vuln` (grype over the signed SBOM: FIXABLE criticals
 *     against the ecosystem threshold `ECOSYSTEM_VULN_GATE_MAX_CRITICAL`),
 *     `vuln_floor` (the platform floor `PLUGIN_VULN_MAX_CRITICAL`, the same
 *     helper the build worker uses), `non_root`;
 *  4. SMOKE — the spec's `smokeTest`, run as a second NO-PUSH build
 *     (`FROM <image@digest>`, `RUN --network=none`).
 *
 * A static failure skips the build. All green → the `submission` publish
 * request (moderation). Anything red → `gate_failed`, N3 to the submitter,
 * `plugin.submission.gate-fail`, `plugin_submission_gate_failures_total{gate}`.
 * NEVER writes a `plugins` row and never touches a tenant or `public/*`
 * namespace.
 */

import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  blockingHeuristics,
  createLogger,
  errorMessage,
  isAllowedSpdxId,
  scanPluginSourceHeuristics,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
  type HeuristicsReport,
} from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { isUniqueViolation, type PluginSubmission } from '@pipeline-builder/pipeline-data';

import { ecosystemAudit } from './audit.js';
import { recordSubmission, recordSubmissionGateFailures } from './metrics.js';
import { notifySubmissionGateFailed } from './notify.js';
import { vulnGateMaxCritical, type Gate } from './policy.js';
import { mintQuarantineCredential } from './registry.js';
import { atomically } from './store.js';
import { preparedAnonymousExtract, statusUrl, submissionConfig } from './submission-config.js';
import { statusTokenFor, submitterEmail } from './submission-guards.js';
import {
  announceSubmissionRequest, hasOpenSubmissionRequest, insertSubmissionRequest, type SubmissionFacts, type SubmissionGateReport,
} from './submission-moderation.js';
import { submissions } from './submissions-store.js';
import { communityPublisher, dropQuarantineArtifacts, lintPackage, submissionNameGate } from './submissions.js';
import { emailPurgeAt, iso } from './util.js';
import { buildAndPushQuarantine, runQuarantineSmokeTest, type QuarantineBuildOptions } from '../../helpers/docker-build.js';
import { readPackageFiles } from '../../helpers/package-files.js';
import { parsePluginZip, validateBuildArgs, type ParsedPlugin } from '../../helpers/plugin-spec.js';
import { writeDockerConfig, type RegistryInfo } from '../../helpers/registry-auth.js';
import { vulnGateError } from '../../helpers/scan-gates.js';
import { inspectRunAsRoot, scanColumns, scanPluginImage, type VulnFinding } from '../../helpers/vuln-scan.js';
import { getPluginArtifactToFile, pluginQuarantineBucket } from '../plugin-artifact-storage.js';

const logger = createLogger('ecosystem-submission-pipeline');


/** What the build + image checks produced. */
export interface QuarantineBuildOutcome {
  /** `quarantine/<submissionId>` */
  imageRepository: string;
  digest: string;
  scan: ReturnType<typeof scanColumns>;
  /** Critical/high findings with their fixed versions (empty when unscanned). */
  findings: VulnFinding[];
  runAsRoot: boolean | null;
}

/** The I/O the pipeline needs, swappable in tests (no buildkitd / registry / S3 there). */
export interface SubmissionPipelineDeps {
  /** Download the quarantined zip to a local file; returns its path. */
  fetchPackage(s: PluginSubmission): Promise<string>;
  /** Build + push + sign on the quarantine buildkitd, then scan and inspect the image. */
  build(s: PluginSubmission, plugin: ParsedPlugin): Promise<QuarantineBuildOutcome>;
  /** Run the smoke test against the built digest (throws when it fails). */
  smokeTest(outcome: QuarantineBuildOutcome, command: string): Promise<void>;
}

function registry(): RegistryInfo {
  return Config.get('registry') as RegistryInfo;
}

/**
 * A fresh `$DOCKER_CONFIG` for ONE submission's build: a registry-only
 * credential image-registry mints for `quarantine/<submissionId>` — push/pull
 * there, pull on the base-image namespaces, nothing else, and accepted by no
 * platform service. Never a service-principal JWT: the quarantine buildkitd
 * runs untrusted code and sees whatever credential the build carries.
 */
async function quarantineCredential(submissionId: string, ttlMs: number): Promise<string> {
  const cred = await mintQuarantineCredential(submissionId, Math.ceil(ttlMs / 1000) + 600);
  return writeDockerConfig(registry(), cred.username, cred.password);
}

function buildOptions(dockerConfigDir: string): QuarantineBuildOptions {
  const cfg = submissionConfig();
  if (!cfg.quarantineBuildkitAddr) throw new Error('PLUGIN_QUARANTINE_BUILDKIT_ADDR is not set; refusing to build a submission anywhere else');
  return { buildkitAddr: cfg.quarantineBuildkitAddr, timeoutMs: cfg.buildTimeoutMs, dockerConfigDir };
}

const liveDeps: SubmissionPipelineDeps = {
  async fetchPackage(s) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-submission-'));
    const zipPath = path.join(dir, 'package.zip');
    await getPluginArtifactToFile(s.artifactKey ?? '', zipPath, pluginQuarantineBucket());
    return zipPath;
  },

  async build(s, plugin) {
    const reg = registry();
    const dockerConfigDir = await quarantineCredential(s.id, submissionConfig().buildTimeoutMs * 2);
    try {
      const built = await buildAndPushQuarantine({
        contextDir: plugin.extractDir,
        dockerfile: plugin.dockerfile,
        version: s.version,
        buildArgs: plugin.pluginSpec.buildArgs,
        registry: reg,
        repository: `quarantine/${s.id}`,
      }, buildOptions(dockerConfigDir));
      const ref = { orgId: SYSTEM_ORG_ID, name: s.name, imageDigest: built.digest, imageRepository: built.repository };
      const { scan } = await scanPluginImage(ref, reg, 'build', { refreshDb: true });
      const runAsRoot = await inspectRunAsRoot(ref, reg).catch((err) => {
        logger.warn('Quarantined image config unreadable; runAsRoot unknown (the gate fails closed)', { submissionId: s.id, error: errorMessage(err) });
        return null;
      });
      return { imageRepository: built.repository, digest: built.digest, scan: scanColumns(scan), findings: scan?.findings ?? [], runAsRoot };
    } finally {
      await fs.rm(dockerConfigDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },

  async smokeTest(outcome, command) {
    const reg = registry();
    const dockerConfigDir = await quarantineCredential(outcome.imageRepository.slice('quarantine/'.length), submissionConfig().buildTimeoutMs);
    try {
      await runQuarantineSmokeTest({ imageRef: `${reg.host}:${reg.port}/${outcome.imageRepository}@${outcome.digest}`, command }, buildOptions(dockerConfigDir));
    } finally {
      await fs.rm(dockerConfigDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

let deps: SubmissionPipelineDeps = liveDeps;

/** Test hook: replace the pipeline I/O (pass nothing to restore the live one). */
export function setSubmissionPipelineDepsForTests(d?: SubmissionPipelineDeps): void {
  deps = d ?? liveDeps;
}

const gate = (id: string, ok: boolean, okMessage: string, failMessage: string): Gate => ({ id, ok, message: ok ? okMessage : failMessage });

/** A secret-looking `env` default: a literal on a secret-like name, or a credential-shaped value. */
export function secretEnvDefaults(env: Record<string, unknown> | undefined): string[] {
  const bad: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string' || value.trim() === '' || /\$|\{\{/.test(value)) continue;
    const secretName = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)$/i.test(key);
    const secretValue = scanPluginSourceHeuristics([{ path: 'plugin-spec.yaml', content: `${key}=${value}` }])
      .findings.some((f) => f.id === 'secret-literal' || f.id === 'secret-default');
    if (secretName || secretValue) bad.push(key);
  }
  return bad;
}

/** The static gates (no build). */
async function staticGates(s: PluginSubmission, plugin: ParsedPlugin, heuristics: HeuristicsReport): Promise<Gate[]> {
  const spec = plugin.pluginSpec;
  const license = typeof s.catalog?.values?.license === 'string' ? s.catalog.values.license : null;
  const lintErrors = (await lintPackage(plugin)).filter((f) => f.level === 'error');
  const blocking = blockingHeuristics(heuristics);
  const envSecrets = secretEnvDefaults(spec.env);
  const smoke = typeof spec.smokeTest === 'string' ? spec.smokeTest.trim() : '';
  const name = await submissionNameGate(s.name, s.emailHash);
  const sameAsSubmitted = spec.name === s.name && spec.version === s.version;
  return [
    gate('spec', sameAsSubmitted && plugin.buildType === 'build_image' && !!plugin.dockerfileContent,
      'Spec, contract and templates are valid', 'The package no longer matches what was submitted'),
    gate('license', !!license && isAllowedSpdxId(license), `License: ${license}`, license ? `"${license}" is not an allowed SPDX license id` : 'Declare an SPDX license'),
    gate('lint', lintErrors.length === 0, 'Dockerfile and spec follow the catalog rules', lintErrors.slice(0, 5).map((f) => f.message).join('; ')),
    gate('heuristics', blocking.length === 0, 'No malware heuristics matched',
      `Heuristics matched: ${[...new Set(blocking.map((f) => `${f.message} (${f.path}:${f.line})`))].slice(0, 5).join('; ')}`),
    gate('env_secrets', envSecrets.length === 0, 'No secret-looking env defaults', `Secret-looking env defaults: ${envSecrets.join(', ')} (declare them under \`secrets\` instead)`),
    gate('smoke_test_declared', smoke !== '', 'smokeTest declared', 'Declare a smokeTest in plugin-spec.yaml'),
    { id: name.id, ok: name.ok, message: name.message },
  ];
}

/** Record a red run: `gate_failed`, audit, metric, N3. */
async function failSubmission(s: PluginSubmission, gates: Gate[], heuristics: HeuristicsReport | null, facts?: SubmissionFacts): Promise<void> {
  const failed = gates.filter((g) => !g.ok);
  const now = new Date();
  const report: SubmissionGateReport = { gates, ...(facts ? { facts } : {}), completedAt: now.toISOString() };
  const done = await submissions.transition(s.id, 'pending_review', {
    status: 'gate_failed',
    gateReport: report as unknown as Record<string, unknown>,
    ...(heuristics ? { heuristics: heuristics as unknown as Record<string, unknown> } : {}),
    ...(facts ? { quarantineImageRef: `${facts.imageRepository}@${facts.digest}` } : {}),
    reason: failed.map((g) => g.message).join('; ').slice(0, 2000),
    decidedBy: SYSTEM_ACTOR_ID,
    decidedAt: now,
    emailPurgeAfter: emailPurgeAt(now),
  });
  if (!done) return;
  ecosystemAudit({ action: 'plugin.submission.gate-fail', actor: SYSTEM_ACTOR_ID, targetType: 'plugin-submission', targetId: s.id, details: { submissionId: s.id, name: s.name, version: s.version, gates: failed.map((g) => g.id) } });
  recordSubmission('gate_failed');
  recordSubmissionGateFailures(failed.map((g) => g.id));
  // A failed submission is final: nothing reads its package or build again.
  await dropQuarantineArtifacts(s).catch((err) =>
    logger.warn('Dropping a failed submission\'s quarantine artifacts failed', { submissionId: s.id, error: errorMessage(err) }));
  const email = await submitterEmail(s);
  if (email) {
    await notifySubmissionGateFailed({ email, name: s.name, version: s.version, failures: failed.map((g) => g.message), statusUrl: statusUrl(statusTokenFor(s.id)) });
  }
}

export type GateRunOutcome = 'queued' | 'gate_failed' | 'skipped';

/**
 * Whether a gate run still has work to do: the submission waits in
 * `pending_review` and has no OPEN moderation request yet. The report and
 * the request are written together, so "a report but no request" can't strand
 * a submission any more — and if one ever exists, the gates simply run again.
 */
async function needsGates(s: PluginSubmission): Promise<boolean> {
  return s.status === 'pending_review' && !(await hasOpenSubmissionRequest(s.id));
}

/**
 * Run every gate for one verified submission (the submission build worker).
 * Idempotent (see needsGates). Throws on an INFRASTRUCTURE failure (storage,
 * database) so the queue can retry; a gate failure is an outcome, not an error.
 */
export async function runSubmissionGates(submissionId: string): Promise<GateRunOutcome> {
  const s = await submissions.byId(submissionId);
  if (!s || !await needsGates(s)) return 'skipped';

  const zipPath = await deps.fetchPackage(s);
  let plugin: ParsedPlugin;
  try {
    try {
      // The worker parses the untrusted package under the SAME anonymous caps
      // and directory as the submit route, never the tenant-upload ones.
      plugin = await parsePluginZip(zipPath, await preparedAnonymousExtract());
      validateBuildArgs(plugin.pluginSpec.buildArgs);
    } catch (err) {
      await failSubmission(s, [{ id: 'spec', ok: false, message: errorMessage(err).slice(0, 500) }], null);
      return 'gate_failed';
    }
  } finally {
    await fs.rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => undefined);
  }

  try {
    const heuristics = scanPluginSourceHeuristics(await readPackageFiles(plugin.extractDir));
    const gates = await staticGates(s, plugin, heuristics);
    if (gates.some((g) => !g.ok)) {
      await failSubmission(s, gates, heuristics);
      return 'gate_failed';
    }

    let outcome: QuarantineBuildOutcome;
    try {
      outcome = await deps.build(s, plugin);
      gates.push({ id: 'build', ok: true, message: 'Built on the isolated build pool, signed with an SBOM' });
    } catch (err) {
      logger.warn('Submission build failed', { submissionId: s.id, error: errorMessage(err) });
      gates.push({ id: 'build', ok: false, message: `The image did not build: ${errorMessage(err).slice(0, 300)}` });
      await failSubmission(s, gates, heuristics);
      return 'gate_failed';
    }

    const facts: SubmissionFacts = {
      imageRepository: outcome.imageRepository,
      digest: outcome.digest,
      vulnCritical: outcome.scan.vulnCritical,
      vulnHigh: outcome.scan.vulnHigh,
      vulnMedium: outcome.scan.vulnMedium,
      vulnLow: outcome.scan.vulnLow,
      vulnCriticalFixable: outcome.scan.vulnCriticalFixable,
      vulnHighFixable: outcome.scan.vulnHighFixable,
      scannedAt: iso(outcome.scan.scannedAt),
      runAsRoot: outcome.runAsRoot,
    };
    const scanned = facts.scannedAt !== null;
    const maxCritical = vulnGateMaxCritical();
    const floor = scanned ? vulnGateError({ ...facts, findings: outcome.findings }) : null;
    gates.push(
      gate('scanned', scanned, 'Image scanned', 'The image could not be scanned for vulnerabilities'),
      gate('vuln', scanned && (facts.vulnCriticalFixable ?? 0) <= maxCritical,
        `${facts.vulnCritical ?? 0} critical (${facts.vulnCriticalFixable ?? 0} fixable), ${facts.vulnHigh ?? 0} high (${facts.vulnHighFixable ?? 0} fixable) vulnerabilities`,
        scanned ? `${facts.vulnCriticalFixable} fixable critical vulnerabilities (at most ${maxCritical} allowed)` : 'No vulnerability scan'),
      gate('vuln_floor', scanned && floor === null, 'Within the platform vulnerability floor',
        floor ? floor.message.replace(/^PLUGIN_VULN_GATE: /, '') : 'No vulnerability scan'),
      gate('non_root', facts.runAsRoot === false, 'Runs as a non-root user',
        facts.runAsRoot === null ? 'Could not tell which user the image runs as' : 'The image runs as root'),
    );

    const smoke = String(plugin.pluginSpec.smokeTest ?? '').trim();
    try {
      await deps.smokeTest(outcome, smoke);
      gates.push({ id: 'smoke_test', ok: true, message: 'smokeTest passed (no network)' });
    } catch (err) {
      gates.push({ id: 'smoke_test', ok: false, message: `smokeTest failed: ${errorMessage(err).slice(0, 300)}` });
    }

    if (gates.some((g) => !g.ok)) {
      await failSubmission(s, gates, heuristics, facts);
      return 'gate_failed';
    }

    const community = await communityPublisher();
    const name = await submissionNameGate(s.name, s.emailHash);
    const report: SubmissionGateReport = { gates, facts, completedAt: new Date().toISOString() };
    // The report and the moderation request commit TOGETHER: a crash
    // between them can no longer leave a reported submission with no request.
    let queued: { recorded: PluginSubmission; request: Awaited<ReturnType<typeof insertSubmissionRequest>> } | null;
    try {
      queued = await atomically(async () => {
        const recorded = await submissions.transition(s.id, 'pending_review', {
          gateReport: report as unknown as Record<string, unknown>,
          heuristics: heuristics as unknown as Record<string, unknown>,
          quarantineImageRef: `${facts.imageRepository}@${facts.digest}`,
        });
        if (!recorded) return null;
        return { recorded, request: await insertSubmissionRequest(recorded, community, name.listing, facts.digest) };
      });
    } catch (err) {
      // The one-open-request index: an identical submission already waits.
      const duplicate = isUniqueViolation(err);
      if (!duplicate) throw err;
      await failSubmission(s, [...gates, { id: 'queue', ok: false, message: `community/${s.name} ${s.version} is already waiting for moderation` }], heuristics, facts);
      return 'gate_failed';
    }
    if (!queued) return 'skipped';
    await announceSubmissionRequest(queued.recorded, queued.request, name.listing, facts.digest);
    return 'queued';
  } finally {
    await fs.rm(plugin.extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The queue gave up on a submission (infrastructure kept failing): fail it
 * closed with a `pipeline` gate, so it never sits in `pending_review` forever.
 */
export async function failSubmissionPipeline(submissionId: string, error: string): Promise<void> {
  const s = await submissions.byId(submissionId);
  if (!s || !await needsGates(s)) return;
  logger.error('Submission gates could not run; failing closed', { submissionId, error });
  await failSubmission(s, [{ id: 'pipeline', ok: false, message: 'The automated checks could not complete; please submit again later' }], null);
}
