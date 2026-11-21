#!/usr/bin/env python3
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
"""load-plugins.sh's build verdict, scoped to what THIS run uploaded.

Usage:
  plugin-build-verdict.py counts UPLOADED LIST_JSON TRIAGE_JSON
      prints "<built> <failed> <ignored>":
        built   - uploaded name+version rows that have an image digest, or are
                  metadata_only (an approval step produces no image by design)
        failed  - uploaded name+version rows the build queue reports FAILED and
                  that have not since built
        ignored - failed jobs in the queue for plugins this run did not upload
                  (e.g. the plugin service's own remediation-canary-* plugins)
  plugin-build-verdict.py groups UPLOADED LIST_JSON TRIAGE_JSON
      prints the per-category breakdown of this run's failures only.

UPLOADED is the loader's `name<TAB>version` file; LIST_JSON is the body of
GET /api/plugins?limit=500, TRIAGE_JSON the body of GET /api/plugins/queue/triage.
An unreadable body reads as empty: the verdict is never a crash.
"""

import json
import sys


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def data(body):
    return (body.get("data") or {}) if isinstance(body, dict) else {}


def main(argv):
    if len(argv) != 5 or argv[1] not in ("counts", "groups"):
        sys.stderr.write(__doc__)
        return 2
    mode, uploaded_path, list_path, triage_path = argv[1:]

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
    failed_versions = {}
    ignored = 0
    for g in groups:
        names = g.get("pluginNames") or []
        ours = [n for n in names if n in want_names]
        ignored += len([n for n in names if n not in want_names])
        for n in ours:
            failed_versions.setdefault(n, set())
        for s in g.get("samples") or []:
            n, v = s.get("pluginName"), s.get("version")
            if n in want_names and v:
                failed_versions[n].add(v)

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
