# CIS Benchmark (Starter)

Advanced content add-on — `set:advanced`, `framework:cis`.

> ⚠ **STARTER SET — REQUIRES COMPLIANCE-EXPERT REVIEW BEFORE PRODUCTION USE.**
>
> These 25 rules map each control id to ONE concrete, CI/CD-enforceable
> check over plugin/pipeline attributes. They are a plausible scaffold, NOT a
> certified control implementation. A real audit needs a compliance expert to
> (a) confirm each control→check mapping, (b) add controls that cannot be enforced
> from build/pipeline metadata alone, and (c) tune severities. Several checks
> reference attribute fields (e.g. `runAsRoot`, `signed`, `hasSecurityScan`) that
> your plugin/pipeline payloads must actually populate for the rule to be meaningful.

Each `rules/<name>/rule.json` is a `scope: "published"` rule tagged
`set:advanced` + `framework:cis` + `control:<id>`. The framework policy under
`policies/cis/policy.json` groups them all.
