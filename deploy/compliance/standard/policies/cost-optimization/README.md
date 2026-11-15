# cost-optimization

A policy focused on controlling infrastructure costs by limiting stage counts and recommending cost-effective compute types.

**Version:** 1.0.0
**Template:** yes (available for cloning)
**Tags:** `cost`, `reliability`, `compute`

## Included Rules

| Rule | Target | Severity | Purpose |
|------|--------|----------|---------|
| `max-pipeline-stages` | pipeline | warning | Limit the number of stages per pipeline |
| `recommended-compute-type` | plugin | warning | Guide teams toward cost-effective compute types |

## When to Use

Apply this policy when:
- Cloud costs are growing faster than expected
- Teams are deploying long-running or oversized pipelines
- You need guardrails before enabling self-service pipeline creation

## Customization

After cloning, organizations can:
- Adjust the stage-count threshold to match your delivery model
- Change compute type recommendations to match available instance types
- Promote warnings to errors for stricter enforcement
