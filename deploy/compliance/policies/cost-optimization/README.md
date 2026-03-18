# cost-optimization

A policy focused on controlling infrastructure costs by enforcing timeout limits, stage counts, and compute type recommendations.

**Version:** 1.0.0
**Template:** yes (available for cloning)
**Tags:** `cost`, `reliability`, `compute`

## Included Rules

| Rule | Target | Severity | Purpose |
|------|--------|----------|---------|
| `enforce-pipeline-timeout` | pipeline | error | Cap pipeline execution at 120 minutes |
| `max-pipeline-stages` | pipeline | warning | Limit the number of stages per pipeline |
| `recommended-compute-type` | pipeline | warning | Guide teams toward cost-effective compute types |

## When to Use

Apply this policy when:
- Cloud costs are growing faster than expected
- Teams are deploying long-running or oversized pipelines
- You need guardrails before enabling self-service pipeline creation

## Customization

After cloning, organizations can:
- Adjust the timeout threshold (e.g. 60 minutes for dev, 120 for production)
- Change compute type recommendations to match available instance types
- Promote warnings to errors for stricter enforcement
