# production-readiness

A comprehensive policy that combines critical rules from security, cost, and quality domains. Designed for organizations that want a single policy covering all production-grade requirements.

**Version:** 1.0.0
**Template:** yes (available for cloning)
**Tags:** `production`, `comprehensive`, `governance`

## Included Rules

| Rule | Target | Severity | Purpose |
|------|--------|----------|---------|
| `block-latest-image-tag` | plugin | error | Pin image versions for reproducible builds |
| `restrict-public-access` | plugin | error | Prevent unreviewed public plugin exposure |
| `block-privileged-plugins` | plugin | error | Block elevated container privileges |
| `enforce-pipeline-timeout` | pipeline | error | Cap execution at 120 minutes |
| `require-plugin-description` | plugin | warning | Ensure documentation exists |
| `require-plugin-version-semver` | plugin | error | Enforce semantic versioning |
| `require-pipeline-naming-convention` | pipeline | warning | Standardize pipeline naming |

## When to Use

Apply this policy when:
- Promoting pipelines and plugins to a production environment
- An organization needs a single all-in-one compliance policy
- Setting up governance for teams without dedicated compliance staff

## Customization

After cloning, organizations can:
- Remove rules that overlap with existing org-specific policies
- Add domain-specific rules (e.g. data residency, encryption requirements)
- Split into smaller focused policies as the org matures
