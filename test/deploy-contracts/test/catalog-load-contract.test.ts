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
    expect(df).not.toContain('zricethezav/gitleaks');
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

  it('retries the clone and the build, like every other network step here', () => {
    // A cold catalogue load does this a hundred times over, through github.com
    // and proxy.golang.org.
    expect(df).toMatch(/for attempt in 1 2 3 4 5/);
  });
});

describe('the registry can sign a vendored-SDK image', () => {
  it('sizes the SBOM limit by env, not by a literal', () => {
    // gar-push and gcloud-deploy install google-cloud-cli; their SPDX documents
    // went over the previous hard-coded 32mb and the refusal arrived as a bare
    // 413 with no reason.
    const src = read('api/image-registry/src/routes/internal.ts');
    expect(src).toContain("envStr('REGISTRY_SBOM_BODY_LIMIT'");
    expect(src).toContain('entity.too.large');
  });

  it('documents the knob, so the 413 message points somewhere real', () => {
    expect(read('docs/environment-variables.md')).toContain('`REGISTRY_SBOM_BODY_LIMIT`');
  });
});
