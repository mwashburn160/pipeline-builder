#!/usr/bin/env python3
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
"""load-plugins.sh's build verdict, scoped to what THIS run uploaded.

Usage:
  plugin-build-verdict.py counts UPLOADED LIST_JSON TRIAGE_JSON [SINCE]
      prints "<built> <failed> <ignored>":
        built   - uploaded name+version rows that have an image digest, or are
                  metadata_only (an approval step produces no image by design)
        failed  - uploaded name+version rows the build queue reports FAILED and
                  that have not since built
        ignored - failed jobs in the queue for plugins this run did not upload
                  (e.g. the plugin service's own remediation-canary-* plugins)
  plugin-build-verdict.py groups UPLOADED LIST_JSON TRIAGE_JSON [SINCE]
      prints the per-category breakdown of this run's failures only.

SINCE (optional) is when the run started, as ISO-8601 UTC. A sampled failure
that finished BEFORE it is an earlier run's: re-uploading the same version after
a failed load re-queues its build, and the old failed job must not count against
the new build while that build is still pending.

UPLOADED is the loader's `name<TAB>version` file; LIST_JSON is the body of
GET /api/plugins?limit=500, TRIAGE_JSON the body of GET /api/plugins/queue/triage.
An unreadable body reads as empty: the verdict is never a crash.
"""

import json
import sys
from datetime import datetime, timezone


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def data(body):
    return (body.get("data") or {}) if isinstance(body, dict) else {}


def parse_time(value):
    """An ISO-8601 instant as an aware datetime, or None when absent/unreadable."""
    if not isinstance(value, str) or not value:
        return None
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def main(argv):
    if len(argv) not in (5, 6) or argv[1] not in ("counts", "groups"):
        sys.stderr.write(__doc__)
        return 2
    mode, uploaded_path, list_path, triage_path = argv[1:5]
    since = parse_time(argv[5]) if len(argv) == 6 else None

    want = []
    with open(uploaded_path, encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2 and parts[0]:
                want.append((parts[0], parts[1]))
    want_set = set(want)
    want_names = {n for n, _ in want}

    built = set()
    for r in data(load(list_path)).get("plugins") or []:
        key = (r.get("name"), r.get("version"))
        if key in want_set and (r.get("buildType") == "metadata_only" or r.get("imageDigest")):
            built.add(key)

    groups = data(load(triage_path)).get("groups") or []
    # Failed names, and the versions the samples name for them. A sample list is
    # bounded server-side, so a name with NO versioned sample still counts for
    # every uploaded version of it; one whose samples name versions counts only
    # for those (an older version's failed job is not this upload's failure).
    # With SINCE, a sample that failed before the run started is dropped, and a
    # name is cleared only when EVERY group naming it sampled it and every one of
    # those samples is that old: a group that names it without a sample (samples
    # are capped per group) may hold a recent failure, so it still counts.
    failed_versions = {}
    sampled, fresh, unsampled = set(), set(), set()
    ignored = 0
    for g in groups:
        names = g.get("pluginNames") or []
        ours = [n for n in names if n in want_names]
        ignored += len([n for n in names if n not in want_names])
        for n in ours:
            failed_versions.setdefault(n, set())
        in_samples = {s.get("pluginName") for s in g.get("samples") or []}
        unsampled.update(n for n in ours if n not in in_samples)
        for s in g.get("samples") or []:
            n, v = s.get("pluginName"), s.get("version")
            if n not in want_names:
                continue
            sampled.add(n)
            failed_at = parse_time(s.get("failedAt"))
            if since and failed_at and failed_at < since:
                continue
            fresh.add(n)
            if v:
                failed_versions[n].add(v)
    if since:
        for n in sampled - fresh - unsampled:
            failed_versions.pop(n, None)
            ignored += 1

    def is_failed(key):
        n, v = key
        if key in built or n not in failed_versions:
            return False
        versions = failed_versions[n]
        return not versions or v in versions

    failed = [k for k in want if is_failed(k)]
    # An uploaded NAME whose failed jobs are all for versions this run did not
    # upload is someone else's failure too: say so rather than drop it silently.
    failed_names = {n for n, _ in failed}
    ours = {n for n, v in want if n in failed_versions and (not failed_versions[n] or v in failed_versions[n])}
    ignored += len([n for n in failed_versions if n not in ours])

    if mode == "counts":
        print(len(built), len(failed), ignored)
        return 0

    for g in groups:
        names = [n for n in (g.get("pluginNames") or []) if n in failed_names]
        if not names:
            continue
        print("    {0}x {1} - {2}".format(len(names), g.get("category"), ", ".join(names[:8])))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
