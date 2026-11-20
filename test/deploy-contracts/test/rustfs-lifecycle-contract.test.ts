// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * rustfs-init must converge every bucket to EXACTLY ONE copy of each lifecycle
 * rule it owns.
 *
 * `rc bucket lifecycle rule add` (rc v0.1.36) is not idempotent: each call adds
 * another copy under a fresh random id, and rustfs-init runs on every provision.
 * Verified live: a `plugins` bucket provisioned 8 times held 8 identical 7-day
 * expiry rules. So every rule goes through one helper, `ensure_rule`, which
 *  - adds the rule only when no equivalent copy exists,
 *  - removes surplus copies an older init left behind (an existing install
 *    converges), and
 *  - recognises "ours" by the rule's WHOLE content (enabled, this one action,
 *    this day count, nothing else), so a hand-added rule — a prefix, another
 *    day count, a disabled copy — is never removed.
 *
 * The static checks pin that shape on all four targets; the behaviour check
 * runs each target's real `ensure_rule` under /bin/sh against a stub `rc` that
 * keeps rules the way RustFS reports them (needs `jq`, which the rc image ships).
 */

import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { ALL_TARGETS, read, yamlDocs } from '../src/index.js';

type Doc = Record<string, any>;

/** The rustfs-init script on a target, with compose's `$$` escapes undone. */
function initScript(target: string): string {
  if (target === 'deploy/local/docker') {
    const compose = read('deploy/local/docker/docker-compose.yml');
    const svc = compose.slice(compose.indexOf('\n  rustfs-init:\n    image:'));
    const start = svc.indexOf('      - |\n');
    return svc.slice(start, svc.indexOf('\n  # ', start)).replace(/\$\$/g, '$');
  }
  const job = yamlDocs<Doc>(`${target}/k8s/rustfs.yaml`).find((d) => d.kind === 'Job' && d.metadata?.name === 'rustfs-init');
  expect(job).toBeDefined();
  return job!.spec.template.spec.containers[0].args[0] as string;
}

/** The rules each target's init owns: `<bucket> <kind> <days>`. */
const OWNED: Record<string, string[]> = {
  common: [
    'message-attachments noncurrent 30',
    'plugins expiry 7',
    'plugin-quarantine expiry 30',
    'plugin-sources noncurrent 1',
  ],
  // ec2/eks also own the nightly database-backup bucket.
  backups: ['db-backups expiry "${BACKUP_RETENTION_DAYS:-7}"', 'db-backups noncurrent "${BACKUP_RETENTION_DAYS:-7}"'],
};
const owned = (target: string): string[] => (/aws\/(ec2|eks)$/.test(target) ? [...OWNED.common, ...OWNED.backups] : OWNED.common);

/** The `ensure_rule` function body, as text runnable by /bin/sh. */
function helper(script: string): string {
  const m = /^([ \t]*)ensure_rule\(\) \{\n[\s\S]*?\n\1\}\n/m.exec(script);
  expect(m).not.toBeNull();
  return m![0];
}

describe.each(ALL_TARGETS)('rustfs-init lifecycle rules converge — %s', (target) => {
  const script = initScript(target);

  it('adds a lifecycle rule in exactly ONE place: inside ensure_rule', () => {
    const adds = [...script.matchAll(/rc bucket lifecycle rule add /g)];
    expect(adds).toHaveLength(1);
    expect(helper(script)).toContain('rc bucket lifecycle rule add "local/$er_b" "$er_flag" "$er_days"');
  });

  it('defines ensure_rule once, before the first call', () => {
    expect(script.split('ensure_rule() {').length - 1).toBe(1);
    expect(script.indexOf('ensure_rule() {')).toBeLessThan(script.search(/^\s*ensure_rule [a-z]/m));
  });

  it('routes every rule it owns through ensure_rule, once each', () => {
    const calls = [...script.matchAll(/^\s*ensure_rule (\S+ \S+ \S+)$/gm)].map((m) => m[1]);
    expect(calls.sort()).toEqual(owned(target).sort());
  });

  it('matches on the whole rule, removes surplus copies by id, and asserts exactly one', () => {
    const h = helper(script);
    // Whole-content match with only the random id neutralised: a prefix, a
    // transition, another day count or a Disabled status is a different rule.
    expect(h).toContain('select((.id = "x") == $w)');
    expect(h).toContain('\\"status\\":\\"Enabled\\"');
    expect(h).toContain('rc bucket lifecycle rule remove "local/$er_b" --id "$er_id"');
    expect(h).not.toContain('--all');
    expect(h).toMatch(/\[ "\$er_n" = 1 \] \|\| die /);
    // A failed list must not read as "no rule yet" and add another copy.
    expect(h).toContain('|| return 1');
    expect(h).toContain('er_found=$(er_ids) || die');
  });
});

/** A stub `rc` that stores each bucket's rules as RustFS's `--format json` list. */
const STUB_RC = `#!/bin/sh
set -e
[ "$1 $2 $3" = "bucket lifecycle rule" ] || { echo "stub rc: unexpected $*" >&2; exit 2; }
verb="$4"; b="\${5#local/}"; f="$STATE/$b.json"; [ -f "$f" ] || echo '{"rules":[]}' > "$f"
case "$verb" in
  list) cat "$f" ;;
  add)
    n=$(cat "$STATE/seq" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STATE/seq"
    case "$6" in
      --expiry-days) r="{\\"id\\":\\"rule-$n\\",\\"status\\":\\"Enabled\\",\\"expiration\\":{\\"days\\":$7}}" ;;
      --noncurrent-expiry-days) r="{\\"id\\":\\"rule-$n\\",\\"status\\":\\"Enabled\\",\\"noncurrentVersionExpiration\\":{\\"noncurrentDays\\":$7}}" ;;
      *) echo "stub rc: bad add $*" >&2; exit 2 ;;
    esac
    jq --argjson r "$r" '.rules += [$r]' "$f" > "$f.t" && mv "$f.t" "$f" ;;
  remove)
    [ "$6" = "--id" ] || { echo "stub rc: remove without --id" >&2; exit 2; }
    jq --arg id "$7" '.rules |= map(select(.id != $id))' "$f" > "$f.t" && mv "$f.t" "$f" ;;
  *) echo "stub rc: bad verb $verb" >&2; exit 2 ;;
esac
`;

const hasJq = spawnSync('jq', ['--version']).status === 0;

describe.each(ALL_TARGETS)('ensure_rule behaviour against a stub rc — %s', (target) => {
  const fn = helper(initScript(target));

  (hasJq ? it : it.skip)('adds once, converges duplicates to one, and never touches a hand-added rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-rules-'));
    try {
      const bin = join(dir, 'bin');
      spawnSync('mkdir', ['-p', bin, join(dir, 'state')]);
      writeFileSync(join(bin, 'rc'), STUB_RC);
      chmodSync(join(bin, 'rc'), 0o755);
      const state = join(dir, 'state');
      // Seed: 3 copies of ours plus three rules the init did not create.
      const mine = (id: string) => ({ id, status: 'Enabled', expiration: { days: 7 } });
      const foreign = [
        { id: 'hand-prefix', status: 'Enabled', prefix: 'keep/', expiration: { days: 7 } },
        { id: 'hand-14', status: 'Enabled', expiration: { days: 14 } },
        { id: 'hand-off', status: 'Disabled', expiration: { days: 7 } },
      ];
      writeFileSync(join(state, 'plugins.json'), JSON.stringify({ rules: [mine('old-1'), foreign[0], mine('old-2'), foreign[1], mine('old-3'), foreign[2]] }));
      const sh = `die() { echo "die: $1" >&2; exit 1; }\n${fn}
ensure_rule plugins expiry 7
ensure_rule plugins expiry 7
ensure_rule fresh noncurrent 30
ensure_rule fresh noncurrent 30
ensure_rule fresh noncurrent 30
`;
      const r = spawnSync('/bin/sh', ['-c', sh], { encoding: 'utf-8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE: state } });
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      const plugins = JSON.parse(readFileSync(join(state, 'plugins.json'), 'utf-8')).rules;
      // The FIRST copy is the one kept; the two surplus copies are gone; every foreign rule survives.
      expect(plugins.map((x: Doc) => x.id)).toEqual(['old-1', 'hand-prefix', 'hand-14', 'hand-off']);
      expect(r.stdout.match(/removed duplicate/g)).toHaveLength(2);
      const fresh = JSON.parse(readFileSync(join(state, 'fresh.json'), 'utf-8')).rules;
      expect(fresh).toEqual([{ id: 'rule-1', status: 'Enabled', noncurrentVersionExpiration: { noncurrentDays: 30 } }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  (hasJq ? it : it.skip)('fails rather than adding a copy when the rule list itself fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-rules-'));
    try {
      writeFileSync(join(dir, 'rc'), '#!/bin/sh\necho "boom" >&2\nexit 1\n');
      chmodSync(join(dir, 'rc'), 0o755);
      const sh = `die() { echo "die: $1" >&2; exit 1; }\n${fn}\nensure_rule plugins expiry 7\necho reached\n`;
      const r = spawnSync('/bin/sh', ['-c', sh], { encoding: 'utf-8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('die: lifecycle list plugins failed');
      expect(r.stdout).not.toContain('reached');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
