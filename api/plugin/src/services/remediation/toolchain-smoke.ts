// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The toolchain candidate's synth smoke check: a REAL `cdk synth` of a small
 * fixture app, run inside the candidate image (the remediation ports'
 * smokeTest: `RUN --network=none` in a throwaway build FROM the candidate, as
 * its default user). The toolchain build has no synth smoke of its own
 * (build-plugin-images.sh only builds and grype-gates the bootstrap), so this
 * is it.
 *
 * The fixture is a CDK app in plain Node — no aws-cdk-lib, no network: it
 * writes a one-stack cloud assembly (schema 36.0.0, which every supported CDK
 * CLI reads) to `$CDK_OUTDIR`, so `cdk synth` exercises the image's Node, the
 * pinned aws-cdk CLI reading and validating an assembly, and the CLI's own
 * output path. pipeline-manager and cdk-assets must be on PATH too (the synth
 * step and the Assets stage call them). Any non-zero exit fails the check.
 */

/** The fixture app (`node app.js`): writes the assembly the CLI then synthesizes. */
export const TOOLCHAIN_SMOKE_APP = [
  "const fs = require('fs');",
  "const path = require('path');",
  'const out = process.env.CDK_OUTDIR;',
  "if (!out) { console.error('CDK_OUTDIR is not set'); process.exit(2); }",
  "const template = { Resources: { FixtureTopic: { Type: 'AWS::SNS::Topic' } } };",
  "fs.writeFileSync(path.join(out, 'Fixture.template.json'), JSON.stringify(template));",
  "const manifest = { version: '36.0.0', artifacts: { Fixture: { type: 'aws:cloudformation:stack', environment: 'aws://unknown-account/unknown-region', properties: { templateFile: 'Fixture.template.json' } } } };",
  "fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest));",
].join('\n');

/** The shell command the smokeTest port runs in each candidate image. */
export const TOOLCHAIN_SYNTH_SMOKE_COMMAND = [
  'set -eu',
  'd=$(mktemp -d)',
  'export HOME="$d" CDK_DISABLE_VERSION_CHECK=true CDK_DISABLE_CLI_TELEMETRY=true',
  'command -v pipeline-manager >/dev/null',
  'command -v cdk-assets >/dev/null',
  `cat > "$d/app.js" <<'PB_FIXTURE_APP'\n${TOOLCHAIN_SMOKE_APP}\nPB_FIXTURE_APP`,
  'cd "$d"',
  'cdk synth --app "node app.js" --output "$d/cdk.out" --no-notices --no-version-reporting --quiet Fixture',
  'test -s "$d/cdk.out/manifest.json"',
  'grep -q FixtureTopic "$d/cdk.out/Fixture.template.json"',
].join('\n');
