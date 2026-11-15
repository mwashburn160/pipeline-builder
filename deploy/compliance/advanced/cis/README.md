# CIS Benchmark (Starter)

Advanced content add-on — `set:advanced`, `framework:cis`.

> ⚠ **STARTER SET — REQUIRES COMPLIANCE-EXPERT REVIEW BEFORE PRODUCTION USE.**
>
> These 15 rules map each control id to ONE concrete, CI/CD-enforceable
> check over plugin/pipeline attributes. They are a plausible scaffold, NOT a
> certified control implementation. A real audit needs a compliance expert to
> (a) confirm each control→check mapping, (b) add controls that cannot be enforced
> from build/pipeline metadata alone, and (c) tune severities.
>
> Every check reads a field the platform itself establishes: a plugin row or
> its image facts (`signed`, `scanned`, `runAsRoot`, `packages`, `tags`), a
> pipeline row or its `props`, or the derived pipeline `stepFacts`
> (`securityScanSteps`, `testSteps`, `approvalBeforeProduction`). Controls the
> platform has no data for (container resource limits, host mounts, TLS,
> encryption at rest, pipeline-level timeouts) are deliberately not included.

Each `rules/<name>/rule.json` is a `scope: "published"` rule tagged
`set:advanced` + `framework:cis` + `control:<id>`. The framework policy under
`policies/cis/policy.json` groups them all.
