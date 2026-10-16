// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CI's "Render and schema-check every k8s target" validates what a cluster
 * actually receives only if it renders the manifests the way the deploy scripts
 * apply them: kustomize, THEN the deploy-time `${TOKEN}` substitution.
 *
 * It validated the raw kustomize output instead, so a token in a typed field
 * reached kubeconform as a literal string — `suspend: ${ASK_SCHEDULE_SUSPEND}`
 * is not a boolean — and every change under deploy/ failed that step from the
 * day those tokens landed. deploy/bin/render-for-schema-check.sh now does the
 * substitution with representative values; this holds its token list to the
 * deploy scripts', so a token added to a setup script without CI coverage fails
 * here rather than breaking every later deploy PR.
 */

import { describe, it, expect } from '@jest/globals';
import { read } from '../src/index.js';

const RENDER = 'deploy/bin/render-for-schema-check.sh';

/** The scripts that sed `${TOKEN}`s into a target's manifests at apply time. */
const DEPLOY_SCRIPTS = [
  'deploy/aws/eks/bin/setup.sh',
  'deploy/aws/ec2/bin/startup.sh',
  'deploy/local/minikube/bin/setup.sh',
];

/** Token names a sed script substitutes: `s|[$]{NAME}|…` (any escaping of the `$`). */
function substitutedTokens(src: string): Set<string> {
  return new Set([...src.matchAll(/s\|(?:: )?\[\\?\$\]\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]));
}

describe('render-for-schema-check covers every deploy-time token', () => {
  const rendered = substitutedTokens(read(RENDER));

  it('finds tokens in the render script (guards an empty parse)', () => {
    expect(rendered.size).toBeGreaterThan(10);
  });

  it.each(DEPLOY_SCRIPTS)('substitutes every token %s substitutes', (script) => {
    const deployed = substitutedTokens(read(script));
    expect(deployed.size).toBeGreaterThan(0); // guards an empty parse
    const missing = [...deployed].filter((t) => !rendered.has(t));
    expect({ script, missing }).toEqual({ script, missing: [] });
  });

  it('keeps BACKUP_RETENTION_DAYS a string where it is a whole YAML value, as setup.sh does', () => {
    // kustomize strips the quotes from `value: "${BACKUP_RETENTION_DAYS}"`, so a
    // bare substitution renders `value: 7` — a number, which an env value is not.
    expect(read(RENDER)).toContain('\'s|: [$]{BACKUP_RETENTION_DAYS}$|: "7"|\'');
  });

  it('is what the CI schema-check step renders with', () => {
    expect(read('.github/workflows/test.yml')).toContain(`bash ${RENDER} "$t"`);
  });
});
