# naming-conventions

A lightweight policy that enforces consistent naming and labeling across pipelines and plugins. Helps with automation, searchability, and team-wide consistency.

**Version:** 1.0.0
**Template:** yes (available for cloning)
**Tags:** `naming`, `convention`, `consistency`

## Included Rules

| Rule | Target | Severity | Purpose |
|------|--------|----------|---------|
| `require-pipeline-naming-convention` | pipeline | warning | Enforce lowercase alphanumeric names with hyphens |
| `require-plugin-keywords` | plugin | warning | Require searchable keywords for catalog organization |

## When to Use

Apply this policy when:
- Standardizing naming across a growing number of pipelines
- Enabling automation that depends on predictable resource names
- Improving search and filtering in the plugin catalog

## Customization

After cloning, organizations can:
- Adjust the naming regex to match org-specific conventions (e.g. require team prefix)
- Promote warnings to errors once teams have migrated existing resources
- Add additional naming rules for specific resource types
