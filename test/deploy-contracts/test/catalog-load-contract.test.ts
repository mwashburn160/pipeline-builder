// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guards for the catalogue LOAD — the three ways a fresh install reported
 * a clean 119/119 while most of the catalogue was missing.
 *
 * These are structural assertions on scripts and Dockerfiles rather than
 * behavioural tests: the load needs a cluster, and the properties worth keeping
 * are the ones a later edit would quietly remove.
 */

import { describe, it, expect } from '@jest/globals';
import { read } from '../src/index.js';

describe('load-plugins.sh verifies the builds, with three outcomes', () => {
  const sh = read('deploy/bin/load-plugins.sh');

  it('waits for the accepted builds rather than counting upload acceptances', () => {
    // The upload answers 202; the build, signature, scan and vuln gate all run
    // afterwards. Counting 202s alone is what reported 119/119 for an install
    // in which 80 builds failed terminally.
    expect(sh).toContain('Verifying');
    expect(sh).toMatch(/VERIFY_BUILDS/);
  });

  it('distinguishes FAILED from STILL BUILDING — the reason the old version was removed', () => {
    // The previous verify polled until every plugin had a version and reported
    // FAILED otherwise, so a cold cluster's in-progress builds were declared
    // failures (~100 of them, blamed on PLUGIN_VULN_GATE). Both signals have to
    // appear for the three-outcome version to be possible at all.
    expect(sh).toContain('still building');
    expect(sh).toContain('/api/plugins/queue/triage');
  });

  it('counts a build as done on an image digest OR metadata_only', () => {
    // An approval step produces no image by design, so a null digest is not a
    // failure for it — treating it as one would make the catalogue permanently
    // one short of green.
    expect(sh).toContain('metadata_only');
    expect(sh).toContain('imageDigest');
  });

  it('only a reported FAILURE makes the run red; a deadline does not', () => {
    // The deadline bounds how long it WAITS, never the verdict: an absence of
    // news is not a failure. `FAILED` is incremented from the queue's failure
    // count alone.
    expect(sh).toMatch(/FAILED=\$\(\(FAILED \+ _failed\)\)/);
    const timeoutBranch = sh.slice(sh.indexOf('_timed_out" = true'));
    expect(timeoutBranch).toContain('NOT a failure');
    expect(timeoutBranch.slice(0, 400)).not.toMatch(/FAILED=/);
  });

  it('is skippable and bounded, so it cannot hang an install', () => {
    expect(sh).toContain('--no-verify');
    expect(sh).toMatch(/VERIFY_TIMEOUT:-\d+/);
    expect(sh).toMatch(/VERIFY_POLL:-\d+/);
  });

  it('checks the versions THIS run uploaded, not a total', () => {
    // A catalogue that already holds most of its plugins makes a total
    // meaningless, and --rebuild re-uploads versions that already exist.
    expect(sh).toContain('$COUNTER_DIR/uploaded');
    expect(read('deploy/bin/load-plugin-worker.sh')).toContain('COUNTER_DIR/uploaded');
  });
});

describe('gitleaks is built with a patched x/crypto', () => {
  const df = read('deploy/plugins/security/git-secrets/Dockerfile');

  it('compiles from source instead of copying the published binary', () => {
    // gitleaks' own go.mod pins golang.org/x/crypto v0.35.0 (indirect), which
    // carries fixable Criticals, and 8.30.1 is upstream's LATEST release — so
    // there is nothing to bump to and no waiver would be honest.
    expect(df).toContain('git clone --depth 1 --branch');
    // The published IMAGE, not the Go module path: the version stamp names
    // github.com/zricethezav/gitleaks/v8/version.Version, as upstream's
    // goreleaser does.
    expect(df).not.toMatch(/^FROM\s+(docker\.io\/)?zricethezav\/gitleaks/m);
    expect(df).toContain('-X=github.com/zricethezav/gitleaks/v8/version.Version=${GITLEAKS_VERSION}');
  });

  it('raises brotli too: gitleaks bundles the KEV-listed GO-2026-6888', () => {
    // gitleaks' go.mod pins github.com/andybalholm/brotli at a 2025
    // pseudo-version below the 1.2.7 fix. Without the raise the rebuilt binary
    // still fails PLUGIN_VULN_GATE (a KEV Critical is never package-waivable).
    expect(df).toMatch(/^ARG BROTLI_VERSION=\d+\.\d+\.\d+$/m);
    expect(df).toContain('github.com/andybalholm/brotli@v${BROTLI_VERSION}');
  });

  it('pins the x/crypto it raises to, rather than taking @latest', () => {
    // Everything else in deploy/plugins is pinned; an unpinned `@latest` here
    // would make the image's dependency set drift between builds.
    expect(df).toMatch(/^ARG XCRYPTO_VERSION=\d+\.\d+\.\d+$/m);
    expect(df).toContain('golang.org/x/crypto@v${XCRYPTO_VERSION}');
    expect(df).not.toContain('golang.org/x/crypto@latest');
  });

  it('FAILS the build if the override did not reach the binary', () => {
    // The point of the stage is the module version baked into the binary, and a
    // transitive requirement can silently win over `go get`. Without this check
    // the image would merely LOOK fixed and fail the vuln gate again.
    expect(df).toContain('go version -m /out/gitleaks');
    expect(df).toMatch(/exit 1/);
  });

  it('compares the VERSION FIELD, as >= the pin — never a `$`-anchored grep', () => {
    // `go version -m` prints the module's h1: checksum AFTER the version, so a
    // `grep "…v<pin>$"` can never match: it failed every build even with the
    // raise in place, which is why git-secrets was never in the catalogue.
    // And MVS may resolve higher than the pin, so equality is wrong too.
    expect(df).not.toMatch(/grep -qE "golang\.org\/x\/crypto\[\[:space:\]\]\+v\$\{XCRYPTO_VERSION\}\\\$"/);
    expect(df).toContain('awk -v m="$1" \'$1 == "dep" && $2 == m { print $3 }\'');
    expect(df).toContain('sort -V | head -1');
  });

  it('retries the clone and the build, like every other network step here', () => {
    // A cold catalogue load does this a hundred times over, through github.com
    // and proxy.golang.org.
    expect(df).toMatch(/for attempt in 1 2 3 4 5/);
  });
});

describe('k6 is built from source with the vulnerable modules raised', () => {
  const df = read('deploy/plugins/testing/k6/Dockerfile');

  it('builds from the module cache, not the committed vendor/ tree', () => {
    // k6 commits vendor/. Once `go get` raises a requirement, the default
    // vendor mode refuses ("inconsistent vendoring") on every attempt, so the
    // stage never produced a binary.
    expect(df).toMatch(/go build -mod=mod /);
  });
});

describe('the per-org build cap is stated the same way in every target', () => {
  const TARGETS = [
    'deploy/local/docker/.env.example',
    'deploy/local/minikube/.env.example',
    'deploy/aws/ec2/.env.example',
    'deploy/aws/eks/.env.example',
  ];

  it.each(TARGETS)('%s offers both per-class baselines at their defaults', (target) => {
    const env = read(target);
    expect(env).toContain('# PLUGIN_ORG_BUILD_SLOTS_STANDARD=5');
    expect(env).toContain('# PLUGIN_ORG_BUILD_SLOTS_FLEXIBLE=8');
  });

  it.each(TARGETS)('%s does not offer the RETIRED flat name as a setting', (target) => {
    // Three of the four carried a DEAD `PLUGIN_MAX_BUILDS_PER_ORG=3` long after
    // the code stopped reading it, so reviving that name would have silently
    // applied the figure that starved the catalogue load. The name is retired
    // rather than reused, and must not come back as an assignable line — the
    // prose may still mention it to explain why.
    expect(read(target)).not.toMatch(/^#?\s*PLUGIN_MAX_BUILDS_PER_ORG=/m);
  });

  it('is retired from the CODE entirely, with no alias', () => {
    // No compat alias: a fresh name is the only way to tell a value set
    // deliberately from one set while the variable did nothing.
    const src = read('packages/pipeline-core/src/config/infrastructure-config.ts');
    expect(src).not.toContain("envInt('PLUGIN_MAX_BUILDS_PER_ORG'");
  });

  it('is plumbed to the container on the compose target', () => {
    // k8s targets build app-env from the whole .env, so they need no
    // per-variable plumbing; compose names each one explicitly, and the old
    // name was still the one being passed through.
    const compose = read('deploy/local/docker/docker-compose.yml');
    expect(compose).toContain('PLUGIN_ORG_BUILD_SLOTS_STANDARD:');
    expect(compose).toContain('PLUGIN_ORG_BUILD_SLOTS_FLEXIBLE:');
    expect(compose).not.toContain('PLUGIN_MAX_BUILDS_PER_ORG:');
  });

  it.each(TARGETS)('%s says the system org is exempt', (target) => {
    // The exemption is why a fresh install can load the whole catalogue under
    // one org; an operator reading only the cap would conclude otherwise.
    expect(read(target).toLowerCase()).toContain('system org is exempt');
  });

  it('agrees with the code defaults', () => {
    const src = read('packages/pipeline-core/src/config/infrastructure-config.ts');
    expect(/envInt\('PLUGIN_ORG_BUILD_SLOTS_STANDARD',\s*(\d+)/.exec(src)?.[1]).toBe('5');
    expect(/envInt\('PLUGIN_ORG_BUILD_SLOTS_FLEXIBLE',\s*(\d+)/.exec(src)?.[1]).toBe('8');
  });

  it('keeps flexible ABOVE standard, or the classes collapse again', () => {
    // A single baseline flattened the two below it. If these two ever meet, the
    // cheap class buys a later start and nothing else on every low tier.
    const src = read('packages/pipeline-core/src/config/infrastructure-config.ts');
    const std = Number(/envInt\('PLUGIN_ORG_BUILD_SLOTS_STANDARD',\s*(\d+)/.exec(src)?.[1]);
    const flex = Number(/envInt\('PLUGIN_ORG_BUILD_SLOTS_FLEXIBLE',\s*(\d+)/.exec(src)?.[1]);
    expect(flex).toBeGreaterThan(std);
  });

  it('is a BASELINE in the code, not a ceiling', () => {
    // max(baseline, ladder): a `min` here would cap enterprise DOWN to the
    // baseline and make the paid ladder meaningless in the other direction.
    const src = read('api/plugin/src/queue/slot-manager.ts');
    expect(src).toContain('Math.max(getBuildCfg().orgBuildSlots[buildClass], buildSlotsFor(tier, buildClass))');
  });

  it('warns when WORKER concurrency is the binding limit instead', () => {
    // The per-org cap looks like a throughput knob and is not one: it is a
    // fairness device between tenants sharing a tier queue, and raising it does
    // nothing while the worker still takes fewer jobs at a time. That is the
    // shape of a setting that appears to work, so the worker says so.
    const src = read('api/plugin/src/queue/plugin-build-queue.ts');
    expect(src).toContain('warnIfConcurrencyBinds');
    expect(src).toContain('Worker concurrency binds below the per-org build cap');
    // And the effective caps are logged beside the concurrency on every start,
    // so a stale override is readable rather than inferred from failed builds.
    expect(src).toMatch(/orgSlots: \{ standard:/);
  });

  it('is documented, and the README agrees', () => {
    const docs = read('docs/environment-variables.md');
    expect(docs).toContain('| `PLUGIN_ORG_BUILD_SLOTS_STANDARD` | `5` |');
    expect(docs).toContain('| `PLUGIN_ORG_BUILD_SLOTS_FLEXIBLE` | `8` |');
    const readme = read('api/plugin/README.md');
    expect(readme).toMatch(/PLUGIN_ORG_BUILD_SLOTS_STANDARD.*\| `5` \|/);
    expect(readme).toMatch(/PLUGIN_ORG_BUILD_SLOTS_FLEXIBLE.*\| `8` \|/);
  });
});

describe('the registry can sign a vendored-SDK image', () => {
  it('STREAMS the SBOM to disk instead of parsing it into memory', () => {
    // gar-push and gcloud-deploy install google-cloud-cli; their SPDX documents
    // went over a hard-coded 32mb and the refusal arrived as a bare 413 with no
    // reason. The document's only destination is the file cosign attests from,
    // so buffering it, parsing it to an object and serializing it back was three
    // copies of a multi-megabyte string to move bytes already on disk.
    const src = read('api/image-registry/src/routes/internal.ts');
    expect(src).toContain('streamBodyToFile');
    expect(src).toContain("envInt('REGISTRY_SBOM_MAX_BYTES'");
    // The metadata is in headers so the repository and digest can be refused
    // BEFORE a byte of the document is read.
    expect(src).toContain("req.header('x-pb-repository')");
    expect(src).toContain("req.header('x-pb-digest')");
    // No JSON parser on this route any more.
    expect(src).not.toContain('SBOM_BODY_LIMIT');
  });

  it('hands cosign a PATH, so nothing re-serializes the document', () => {
    expect(read('api/image-registry/src/services/plugin-signing.ts')).toContain('sbomPath: string;');
    expect(read('api/plugin/src/helpers/supply-chain.ts')).toContain("'x-pb-repository'");
  });

  it('MEASURES every SBOM, so the ceiling can be set from evidence', () => {
    // The size was recorded nowhere, so an operator raising the ceiling was
    // guessing and nobody could tell how close any other plugin was.
    const src = read('api/plugin/src/helpers/supply-chain.ts');
    expect(src).toContain('plugin_sbom_bytes');
    expect(src).toContain('fs.statSync(sbomFile).size');
  });

  it('documents the knob, so the 413 message points somewhere real', () => {
    expect(read('docs/environment-variables.md')).toContain('`REGISTRY_SBOM_MAX_BYTES`');
  });

  it('exposes the per-org slot state, so a leak is readable not inferred', () => {
    // A counter above its owner records is capacity that has silently gone
    // missing. Until this it was visible nowhere — no gauge, not on the queue
    // status route — so the only symptom was a build failing after thirty
    // minutes and the only diagnosis was archaeology.
    expect(read('api/plugin/src/queue/slot-manager.ts')).toContain('export async function orgSlotSnapshot');
    const worker = read('api/plugin/src/queue/plugin-build-queue.ts');
    expect(worker).toContain('plugin_build_slots_leaked');
    expect(read('api/plugin/src/routes/queue-status.ts')).toContain('orgSlots: slots');
  });

  it('retires the GLOBAL build-concurrency knob that was read and discarded', () => {
    // `PLUGIN_BUILD_CONCURRENCY` was read and then voided while the docs called
    // it "the default for every tier's worker below" — so an operator could set
    // it to 1, believe the service built one plugin at a time, and be running
    // four. That belief shaped the diagnosis of a real incident.
    expect(read('packages/pipeline-core/src/config/infrastructure-config.ts'))
      .not.toContain("envInt('PLUGIN_BUILD_CONCURRENCY'");
    // The STATEMENT, not any mention: the comment above it explains the bug
    // and names it deliberately.
    expect(read('api/plugin/src/queue/plugin-build-queue.ts')).not.toMatch(/^\s*void concurrency;/m);
    for (const t of ['deploy/local/docker', 'deploy/local/minikube', 'deploy/aws/ec2', 'deploy/aws/eks']) {
      expect(read(`${t}/.env.example`)).not.toMatch(/^PLUGIN_BUILD_CONCURRENCY=/m);
    }
    expect(read('deploy/local/docker/docker-compose.yml')).not.toContain('PLUGIN_BUILD_CONCURRENCY:');
  });

  it('keeps the per-tier concurrency in the CATALOG, keyed not copy-pasted', () => {
    // It was the only tier-keyed build figure still a bare literal in a worker
    // file, which is how the docs drifted away from it.
    expect(read('packages/api-core/src/types/build-catalog.ts')).toContain('BUILD_TIER_CONCURRENCY');
    const worker = read('api/plugin/src/queue/plugin-build-queue.ts');
    expect(worker).toContain('buildConcurrencyEnvVar(tier)');
    expect(worker).not.toMatch(/PLUGIN_BUILD_CONCURRENCY_DEVELOPER/);
  });
});
