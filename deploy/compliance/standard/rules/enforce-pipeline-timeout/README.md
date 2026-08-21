# enforce-pipeline-timeout

Blocks pipelines with a timeout greater than 120 minutes. Long-running builds often indicate a problem (infinite loops, stuck tests, oversized artifacts) and waste compute resources.

**Target:** pipeline
**Severity:** error (blocking)
**Scope:** published (opt-in via subscription)
**Priority:** 70

## Rule Logic

| Field | Operator | Value |
|-------|----------|-------|
| `timeoutInMinutes` | `lte` | `120` |

## Rationale

AWS CodeBuild charges by the minute. A pipeline stuck in an infinite loop at 480 minutes (the CodeBuild max) can cost significantly more than a normal build. The 120-minute cap catches these cases while still allowing long-running integration test suites.

## Remediation

If your pipeline legitimately needs more than 120 minutes:
1. Split it into multiple smaller pipelines
2. Parallelize test stages
3. Request an exemption from your compliance admin

## Tags

`cost`, `reliability`, `timeout`
