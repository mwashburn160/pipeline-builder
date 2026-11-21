// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Version ORDER per package ecosystem, for remediation's fix-version choice and
 * upgrade levels (`GRYPE_PACKAGE_TYPE_CATALOG[type].compare`). One string
 * order cannot serve every ecosystem: `1.0rc1` is BELOW `1.0` in Python but a
 * dpkg-style order puts it above; Maven's `1.0-SNAPSHOT` sorts below `1.0`;
 * RubyGems' `1.0.0.pre` below `1.0.0`; NuGet compares prerelease labels
 * case-insensitively and has a fourth number.
 *
 *  - {@link verrevcmp}            dpkg (deb upstream / revision; apk and rpm as today)
 *  - {@link comparePep440}        Python (PEP 440)
 *  - {@link compareMavenVersions} Maven `ComparableVersion`
 *  - {@link compareGemVersions}   RubyGems `Gem::Version`
 *  - {@link compareNuGetVersions} NuGet (SemVer 2 with a 4th part)
 *
 * Every comparator is total: a value its grammar cannot parse falls back to
 * the dpkg order of the strings, so one odd row never throws. Only the sign of
 * the result is meaningful. Dependency-free (loaded by the browser too).
 */

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** Compare two digit strings numerically, at any length (no Number overflow). */
function compareDigits(a: string, b: string): number {
  const x = a.replace(/^0+/, '');
  const y = b.replace(/^0+/, '');
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// -- dpkg ------------------------------------------------------------------------

/** dpkg's character order: `~` before everything (even the end), letters before other punctuation. */
function charOrder(c: string | undefined): number {
  if (c === undefined || c === '' || isDigit(c)) return 0;
  if (c === '~') return -1;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  return c.charCodeAt(0) + 256;
}

/** dpkg `verrevcmp`: alternating non-digit / digit runs. */
export function verrevcmp(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const ac = charOrder(a[i]);
      const bc = charOrder(b[j]);
      if (ac !== bc) return ac - bc;
      i++; j++;
    }
    while (a[i] === '0') i++;
    while (b[j] === '0') j++;
    let firstDiff = 0;
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (!firstDiff) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
      i++; j++;
    }
    if (isDigit(a[i])) return 1;
    if (isDigit(b[j])) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}

// -- PEP 440 -----------------------------------------------------------------------

/** PEP 440's grammar (packaging's `VERSION_PATTERN`), lowercase input. */
const PEP440 = new RegExp(
  '^v?(?:(\\d+)!)?(\\d+(?:\\.\\d+)*)'
  + '(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\\d+)?)?'
  + '(?:-(\\d+)|[-_.]?(post|rev|r)[-_.]?(\\d+)?)?'
  + '(?:[-_.]?(dev)[-_.]?(\\d+)?)?'
  + '(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$',
);

interface Pep440 {
  epoch: string;
  release: string[];
  /** [phase rank (a=0, b=1, rc=2), n]; null when not a prerelease. */
  pre: [number, string] | null;
  post: string | null;
  dev: string | null;
  local: string[] | null;
}

const PRE_RANK: Record<string, number> = { alpha: 0, a: 0, beta: 1, b: 1, preview: 2, pre: 2, c: 2, rc: 2 };

export function parsePep440(v: string): Pep440 | null {
  const m = PEP440.exec(v.trim().toLowerCase());
  if (!m) return null;
  const release = m[2]!.split('.');
  while (release.length > 1 && /^0+$/.test(release[release.length - 1]!)) release.pop();
  return {
    epoch: m[1] ?? '0',
    release,
    pre: m[3] !== undefined ? [PRE_RANK[m[3]]!, m[4] ?? '0'] : null,
    post: m[5] ?? (m[6] !== undefined ? (m[7] ?? '0') : null),
    dev: m[8] !== undefined ? (m[9] ?? '0') : null,
    local: m[10] !== undefined ? m[10].split(/[-_.]/) : null,
  };
}

/** The epoch and release numbers of a PEP 440 version (for upgrade levels), or null. */
export function pep440Release(v: string): { epoch: string; release: string[] } | null {
  const p = parsePep440(v);
  return p ? { epoch: p.epoch, release: p.release } : null;
}

function compareReleases(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = compareDigits(a[i] ?? '0', b[i] ?? '0');
    if (c) return c;
  }
  return 0;
}

/** PEP 440 local segments: numeric above alphanumeric; a prefix sorts below. */
function compareLocal(a: string[] | null, b: string[] | null): number {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    const c = xn && yn ? compareDigits(x, y) : xn ? 1 : yn ? -1 : compareStrings(x, y);
    if (c) return c;
  }
  return 0;
}

/**
 * PEP 440 order: epoch, release (trailing zeros ignored), then
 * `.devN` < `aN` < `bN` < `rcN` < final < `.postN`, a dev release of a pre or
 * post release below it, and a `+local` version above its public one.
 */
export function comparePep440(a: string, b: string): number {
  const x = parsePep440(a);
  const y = parsePep440(b);
  if (!x || !y) return verrevcmp(a.trim(), b.trim());
  const c = compareDigits(x.epoch, y.epoch) || compareReleases(x.release, y.release);
  if (c) return c;
  // pre: a dev-only release sorts before any prerelease; no prerelease after all of them.
  const preKey = (p: Pep440): [number, string] => (p.pre ? p.pre : p.post === null && p.dev !== null ? [-1, '0'] : [3, '0']);
  const [xp, xn] = preKey(x);
  const [yp, yn] = preKey(y);
  if (xp !== yp) return xp - yp;
  const cp = compareDigits(xn, yn);
  if (cp) return cp;
  // post: none sorts before any.
  if (x.post !== y.post) {
    if (x.post === null) return -1;
    if (y.post === null) return 1;
    const c2 = compareDigits(x.post, y.post);
    if (c2) return c2;
  }
  // dev: none sorts after any.
  if (x.dev !== y.dev) {
    if (x.dev === null) return 1;
    if (y.dev === null) return -1;
    const c3 = compareDigits(x.dev, y.dev);
    if (c3) return c3;
  }
  return compareLocal(x.local, y.local);
}

// -- Maven ComparableVersion -------------------------------------------------------

type MavenItem =
  | { kind: 'int'; value: string }
  | { kind: 'str'; value: string }
  | { kind: 'list'; items: MavenItem[] };

const MAVEN_QUALIFIERS = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];
const MAVEN_ALIASES: Record<string, string> = { ga: '', final: '', release: '', cr: 'rc' };
const MAVEN_RELEASE_INDEX = String(MAVEN_QUALIFIERS.indexOf(''));

function mavenQualifier(value: string): string {
  const i = MAVEN_QUALIFIERS.indexOf(value);
  return i >= 0 ? String(i) : `${MAVEN_QUALIFIERS.length}-${value}`;
}

function mavenString(value: string, followedByDigit: boolean): MavenItem {
  let v = value;
  if (followedByDigit && v.length === 1) v = v === 'a' ? 'alpha' : v === 'b' ? 'beta' : v === 'm' ? 'milestone' : v;
  return { kind: 'str', value: MAVEN_ALIASES[v] ?? v };
}

const mavenParseItem = (isDigitRun: boolean, buf: string): MavenItem =>
  (isDigitRun ? { kind: 'int', value: buf.replace(/^0+(?=\d)/, '') } : mavenString(buf, false));

function mavenIsNull(item: MavenItem): boolean {
  if (item.kind === 'int') return /^0+$/.test(item.value);
  if (item.kind === 'str') return mavenQualifier(item.value) === MAVEN_RELEASE_INDEX;
  return item.items.length === 0;
}

/** Drop trailing null items, looking past nested lists (ComparableVersion.ListItem.normalize). */
function mavenNormalize(list: MavenItem[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]!;
    if (mavenIsNull(item)) list.splice(i, 1);
    else if (item.kind !== 'list') break;
  }
}

function parseMaven(version: string): MavenItem[] {
  const v = version.trim().toLowerCase();
  const root: MavenItem[] = [];
  let list = root;
  const stack: MavenItem[][] = [root];
  let isDigitRun = false;
  let start = 0;
  const openSublist = (): void => {
    const next: MavenItem[] = [];
    list.push({ kind: 'list', items: next });
    list = next;
    stack.push(next);
  };
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === '.') {
      list.push(i === start ? { kind: 'int', value: '0' } : mavenParseItem(isDigitRun, v.slice(start, i)));
      start = i + 1;
    } else if (c === '-') {
      list.push(i === start ? { kind: 'int', value: '0' } : mavenParseItem(isDigitRun, v.slice(start, i)));
      start = i + 1;
      openSublist();
    } else if (isDigit(c)) {
      if (!isDigitRun && i > start) {
        list.push(mavenString(v.slice(start, i), true));
        start = i;
        openSublist();
      }
      isDigitRun = true;
    } else {
      if (isDigitRun && i > start) {
        list.push(mavenParseItem(true, v.slice(start, i)));
        start = i;
        openSublist();
      }
      isDigitRun = false;
    }
  }
  if (v.length > start) list.push(mavenParseItem(isDigitRun, v.slice(start)));
  while (stack.length) mavenNormalize(stack.pop()!);
  return root;
}

/** ComparableVersion's Item.compareTo; `b` null is "nothing there". */
function mavenCompareItem(a: MavenItem, b: MavenItem | null): number {
  if (a.kind === 'int') {
    if (b === null) return mavenIsNull(a) ? 0 : 1;
    return b.kind === 'int' ? compareDigits(a.value, b.value) : 1;
  }
  if (a.kind === 'str') {
    if (b === null) return compareStrings(mavenQualifier(a.value), MAVEN_RELEASE_INDEX);
    return b.kind === 'str' ? compareStrings(mavenQualifier(a.value), mavenQualifier(b.value)) : -1;
  }
  if (b === null) return a.items.length === 0 ? 0 : mavenCompareItem(a.items[0]!, null);
  if (b.kind === 'int') return -1;
  if (b.kind === 'str') return 1;
  return mavenCompareLists(a.items, b.items);
}

function mavenCompareLists(a: MavenItem[], b: MavenItem[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const l = a[i] ?? null;
    const r = b[i] ?? null;
    const c = l === null ? (r === null ? 0 : -mavenCompareItem(r, null)) : mavenCompareItem(l, r);
    if (c) return c;
  }
  return 0;
}

/**
 * Maven `ComparableVersion` order: `.` / `-` / digit-letter transitions split
 * items, trailing zeros and release qualifiers are padding (`1.0` = `1` =
 * `1.0.0` = `1.0-final`), and qualifiers order
 * `alpha` < `beta` < `milestone` < `rc` (= `cr`) < `snapshot` < release < `sp`,
 * then any other qualifier lexically (`a1` / `b1` / `m1` abbreviate the first three).
 */
export function compareMavenVersions(a: string, b: string): number {
  return sign(mavenCompareLists(parseMaven(a), parseMaven(b)));
}

// -- RubyGems Gem::Version ---------------------------------------------------------

const GEM_VERSION = /^[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A RubyGems segment: a number (its digit string, leading zeros dropped) or a letter run. */
type GemSegment = { num: string } | string;
const GEM_ZERO: GemSegment = { num: '0' };
const isGemZero = (x: GemSegment | undefined): boolean => typeof x === 'object' && x.num === '0';

function gemSegments(version: string): GemSegment[] | null {
  const v = version.trim().replace(/^v(?=\d)/i, '');
  if (!GEM_VERSION.test(v)) return null;
  const s = v.replace(/-/g, '.pre.');
  // Numbers stay digit strings: Ruby's Integer is arbitrary precision, and a JS
  // Number would round long (date-like) segments into one another.
  const segs: GemSegment[] = (s.match(/[0-9]+|[a-z]+/gi) ?? [])
    .map((x) => (/^\d+$/.test(x) ? { num: x.replace(/^0+(?=\d)/, '') } : x));
  // canonical_segments: drop trailing zeros from the numeric part and from the prerelease part.
  const firstStr = segs.findIndex((x) => typeof x === 'string');
  const nums = firstStr < 0 ? segs : segs.slice(0, firstStr);
  const strs = firstStr < 0 ? [] : segs.slice(firstStr);
  const trim = (xs: GemSegment[]) => { const out = [...xs]; while (out.length && isGemZero(out[out.length - 1])) out.pop(); return out; };
  return [...trim(nums), ...trim(strs)];
}

/**
 * RubyGems `Gem::Version#<=>`: number and letter segments; a letter segment
 * marks a prerelease and sorts below any number (`1.0.0.rc1` < `1.0.0`),
 * trailing zeros are ignored (`1.0` = `1`), and `-` reads as `.pre.`.
 */
export function compareGemVersions(a: string, b: string): number {
  const x = gemSegments(a);
  const y = gemSegments(b);
  if (!x || !y) return verrevcmp(a.trim(), b.trim());
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const l = x[i] ?? GEM_ZERO;
    const r = y[i] ?? GEM_ZERO;
    if (typeof l === 'string' && typeof r === 'string') {
      if (l !== r) return compareStrings(l, r);
    } else if (typeof l === 'string') {
      return -1;
    } else if (typeof r === 'string') {
      return 1;
    } else {
      const c = compareDigits(l.num, r.num);
      if (c) return sign(c);
    }
  }
  return 0;
}

// -- NuGet -----------------------------------------------------------------------

const NUGET = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]*)?$/i;

/**
 * NuGet order (SemVer 2 with an optional 4th part): missing parts are zero
 * (`1.0` = `1.0.0.0`), a prerelease sorts below its release, prerelease
 * labels compare per dot segment — numeric numerically and below
 * alphanumeric, alphanumeric case-insensitively — and build metadata is ignored.
 */
export function compareNuGetVersions(a: string, b: string): number {
  const x = NUGET.exec(a.trim());
  const y = NUGET.exec(b.trim());
  if (!x || !y) return verrevcmp(a.trim(), b.trim());
  for (let i = 1; i <= 4; i++) {
    const c = compareDigits(x[i] ?? '0', y[i] ?? '0');
    if (c) return c;
  }
  const xp = x[5];
  const yp = y[5];
  if (!xp || !yp) return (xp ? -1 : 0) - (yp ? -1 : 0);
  const xs = xp.toLowerCase().split('.');
  const ys = yp.toLowerCase().split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const l = xs[i];
    const r = ys[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    const c = ln && rn ? compareDigits(l, r) : ln ? -1 : rn ? 1 : compareStrings(l, r);
    if (c) return c;
  }
  return 0;
}
