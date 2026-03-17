# max-pipeline-stages

Warns when a pipeline has more than 20 stages. Overly complex pipelines are harder to debug, slower to execute, and have a larger blast radius when things go wrong.

**Target:** pipeline
**Severity:** warning
**Scope:** published (opt-in via subscription)
**Priority:** 15

## Rule Logic

| Field | Operator | Value |
|-------|----------|-------|
| `$count(stages)` | `lte` | `20` |

Uses the `$count()` computed field to count the number of elements in the `stages` array.

## Rationale

Pipelines with many stages often indicate that work should be split into multiple pipelines or that stages should be consolidated. This keeps individual pipelines focused and reduces deployment risk.

## Remediation

Consider splitting the pipeline into smaller, focused pipelines (e.g. separate build, test, and deploy pipelines) or combining related stages.

## Tags

`complexity`, `quality`, `maintainability`
